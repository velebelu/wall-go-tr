import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from '@/agents/humanChallengeMCTS'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import {
  analyzeSecuredTerritory,
  isClearlyUselessSecuredMovement,
} from '@/agents/securedTerritoryPolicy'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  finalizeHumanMCTSTrace,
  markHumanMCTSTraceFinished,
  markHumanMCTSTraceStarted,
  markHumanMCTSTurnForReview,
  serializeHumanMCTSTrace,
} from '@/utils/humanMCTSTrace'

const outputDirectory = resolve('data/diagnostics/secured-territory-behaviour')
const games = Math.min(30, Number(process.env.DIAGNOSTIC_GAMES ?? 30))
const maxTurns = 100
const runtimeCommit = process.env.VITE_GIT_COMMIT ?? '0000000000000000000000000000000000000000'
const existingNames = (await readdir(outputDirectory).catch(() => [] as string[])).filter((name) =>
  /^trace-\d+\.json$/.test(name),
)
const startIndex =
  existingNames.reduce((maximum, name) => Math.max(maximum, Number(name.match(/\d+/)?.[0])), 0) + 1
const previousReport = await readPreviousReport()
const report: Array<Record<string, unknown>> = [...previousReport.suspiciousTurns]
const independenceGroups = new Set<string>()
let previousFiltered: { sessionId: string; turnIndex: number; group: string } | undefined
for (const row of report.filter((entry) => entry.candidateWouldFilter === true)) {
  const sessionId = String(row.sessionId)
  const turnIndex = Number(row.turnIndex)
  const group = row.independenceGroup
    ? String(row.independenceGroup)
    : previousFiltered?.sessionId === sessionId && turnIndex - previousFiltered.turnIndex <= 2
      ? previousFiltered.group
      : String(row.fingerprint)
  row.independenceGroup = group
  independenceGroups.add(group)
  previousFiltered = { sessionId, turnIndex, group }
}
const campaignStarted = performance.now()
let decisionsExamined = 0
let gamesCompleted = 0

await mkdir(outputDirectory, { recursive: true })
for (let offset = 0; offset < games && independenceGroups.size < 20; offset++) {
  const gameIndex = startIndex + offset
  const aiColor: Player = gameIndex % 2 === 1 ? 'R' : 'B'
  const humanColor: Player = aiColor === 'R' ? 'B' : 'R'
  const seed = (0x5ec00000 + (gameIndex - 1) * 997) >>> 0
  let state = makeInitialState()
  const trace = createHumanMCTSTrace({
    experimentId: 'WGTR-DIAGNOSTIC-SECURED-TERRITORY',
    sessionType: 'diagnostic',
    sessionId: `secured-territory-${gameIndex}-${seed}`,
    projectCommit: runtimeCommit,
    humanColor,
    mctsColor: aiColor,
    seed,
    mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    initialState: state,
  })
  markHumanMCTSTraceStarted(trace, new Date(Date.UTC(2026, 6, 30, 12, offset)).toISOString())
  let turn = 0
  while (state.phase !== 'finished' && !state.result && turn < maxTurns) {
    const before = state
    const decisionSeed = (seed + turn * 0x9e3779b9) >>> 0
    const started = performance.now()
    let action: PlayerAction
    let diagnostics
    if (state.turn === aiColor) {
      const decision = chooseHumanChallengeMCTSDecision({ gameState: state, seed: decisionSeed })
      action = decision.action
      diagnostics = {
        baseSeed: seed,
        decisionIndex: turn,
        decisionSeed,
        mcts: {
          result: decision.mcts,
          effectiveConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
          searchTimeMs: decision.decisionMs,
        },
      }
    } else {
      action = heuristicAction(state, decisionSeed)
    }
    state = applyFullAction(state, action).state
    appendHumanMCTSDecision(
      trace,
      {
        turnNumber: turn,
        player: before.turn,
        stateBefore: before,
        stateAfter: state,
        action,
        legalActionCount: getLegalActions(before).length,
        decisionMs: performance.now() - started,
        agentDiagnostics: diagnostics,
      },
      aiColor,
    )
    if (before.turn === aiColor && suspiciousInternalMove(before, action)) {
      markHumanMCTSTurnForReview(trace, turn, 'automatic-secured-component-candidate')
      const wouldFilter = isClearlyUselessSecuredMovement(before, action)
      const group = independenceGroup(before, action)
      if (wouldFilter) independenceGroups.add(group)
      report.push({
        sessionId: trace.metadata.sessionId,
        aiColor,
        turnIndex: turn,
        action,
        fingerprint: fingerprint(before, action),
        independenceGroup: group,
        candidateWouldFilter: wouldFilter,
      })
    }
    turn++
    decisionsExamined++
  }
  if (!state.result) continue
  markHumanMCTSTraceFinished(
    trace,
    new Date(Date.parse(trace.metadata.startedAt!) + Math.ceil(turn * 250)).toISOString(),
  )
  finalizeHumanMCTSTrace(trace, `diagnostic-${gameIndex}`, state)
  await writeFile(
    resolve(outputDirectory, `trace-${gameIndex}.json`),
    serializeHumanMCTSTrace(trace),
  )
  gamesCompleted++
  console.log(
    `diagnostic ${gamesCompleted}/${games}: ${turn} turns, independent=${independenceGroups.size}`,
  )
}
await writeFile(
  resolve(outputDirectory, 'capture-report.json'),
  `${JSON.stringify(
    {
      gamesRequested: games,
      totalTraceFiles: existingNames.length + gamesCompleted,
      lastCampaign: {
        startIndex,
        gamesCompleted,
        decisionsExamined,
        elapsedMs: performance.now() - campaignStarted,
        stoppedAtTwentyIndependent: independenceGroups.size >= 20,
      },
      independentGroups: independenceGroups.size,
      suspiciousTurns: report,
    },
    null,
    2,
  )}\n`,
)

function suspiciousInternalMove(state: GameSnapshot, action: PlayerAction): boolean {
  if (action.type !== 'move' || !action.from) return false
  const analysis = analyzeSecuredTerritory(state)
  const origin = analysis.componentByPosition.get(`${action.from.x},${action.from.y}`)
  return !!origin && analysis.componentByPosition.get(`${action.pos.x},${action.pos.y}`) === origin
}

function independenceGroup(state: GameSnapshot, action: PlayerAction): string {
  if (action.type !== 'move' || !action.from) return fingerprint(state, action)
  const analysis = analyzeSecuredTerritory(state)
  const component = analysis.componentByPosition.get(`${action.from.x},${action.from.y}`) ?? ''
  const normalized = component.split('|').map((position) => position.split(',').map(Number))
  const minX = Math.min(...normalized.map(([x]) => x))
  const minY = Math.min(...normalized.map(([, y]) => y))
  const shape = normalized
    .map(([x, y]) => `${x - minX},${y - minY}`)
    .sort()
    .join('|')
  return createHash('sha256').update(shape).digest('hex')
}

function heuristicAction(state: GameSnapshot, seed: number): PlayerAction {
  const legal = getLegalActions(state)
  const ranked = legal
    .map((action) => ({ action, score: scoreHeuristicAction(state, action, 'default') }))
    .sort((left, right) => right.score - left.score)
  const best = ranked.filter(({ score }) => score === ranked[0]!.score)
  const rng = createPlayableMCTSRng(seed)
  return best[Math.floor(rng() * best.length)]!.action
}

function fingerprint(state: GameSnapshot, action: PlayerAction): string {
  return createHash('sha256')
    .update(JSON.stringify({ board: state.board, turn: state.turn, action }))
    .digest('hex')
}

async function readPreviousReport(): Promise<{
  suspiciousTurns: Array<Record<string, unknown>>
}> {
  try {
    return JSON.parse(await readFile(resolve(outputDirectory, 'capture-report.json'), 'utf8')) as {
      suspiciousTurns: Array<Record<string, unknown>>
    }
  } catch {
    return { suspiciousTurns: [] }
  }
}
