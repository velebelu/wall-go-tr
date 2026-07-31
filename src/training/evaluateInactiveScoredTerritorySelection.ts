import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chooseHumanChallengeMCTSDecision } from '@/agents/humanChallengeMCTS'
import {
  analyzeInactiveScoredMovement,
  chooseInactiveScoredTerritoryCandidate,
} from '@/agents/inactiveScoredTerritorySelection'
import { createPlayableMCTSRng } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import { evaluatePositionWithBreakdown } from '@/engine/evaluatePosition'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { getLegalActions, getLegalDestinations, scoreHeuristicAction } from '@/utils/ai'
import { floodRegions } from '@/utils/region'
import { getTerritoryMap } from '@/utils/territory'
import { deserializeGameSnapshot, parseHumanMCTSTrace } from '@/utils/humanMCTSTrace'

const sourceDirectory = resolve('data/diagnostics/secured-territory-behaviour')
const outputDirectory = resolve('data/diagnostics/inactive-scored-territory-selection-v3-r2')
const continuations = Math.max(0, Number(process.env.INACTIVE_TERRITORY_CONTINUATIONS ?? 5))
const interventions: Intervention[] = []
const controls: Control[] = []
const seen = new Set<string>()
await mkdir(outputDirectory, { recursive: true })

const traceNames = (await readdir(sourceDirectory)).filter((name) => /^trace-\d+\.json$/.test(name))
for (const name of traceNames) {
  const trace = parseHumanMCTSTrace(await readFile(resolve(sourceDirectory, name), 'utf8'))
  for (const decision of trace.decisions.filter((entry) => entry.actor === 'mcts' && entry.mcts)) {
    inspectDecision(
      `${trace.metadata.sessionId}:${decision.turnIndex}`,
      decision,
      trace.metadata.mctsColor,
    )
  }
}

const p01 = parseHumanMCTSTrace(
  await readFile(
    resolve('data/human-experiment/final-2026-v3-r1/participants/P01/traces/game-2.json'),
    'utf8',
  ),
)
const p01Decision = p01.decisions.find((decision) => decision.turnIndex === 40)!
inspectDecision('v3-r1:p01:game-2:turn-40', p01Decision, p01.metadata.mctsColor, true)

const evaluatedInterventions = selectEvaluationCorpus(interventions)
const rows: CounterfactualRow[] = []
for (const intervention of evaluatedInterventions) {
  const paired = []
  for (let index = 0; index < continuations; index++) {
    const seed = (intervention.seed + 0x6d2b79f5 * (index + 1)) >>> 0
    const original = playContinuation(
      applyFullAction(intervention.state, intervention.originalAction).state,
      intervention.aiColor,
      seed,
    )
    const corrected = playContinuation(
      applyFullAction(intervention.state, intervention.correctedAction).state,
      intervention.aiColor,
      seed,
    )
    paired.push({
      seed,
      original,
      corrected,
      territoryEffect:
        corrected.territory[intervention.aiColor] - original.territory[intervention.aiColor],
      evaluationEffect: corrected.evaluation - original.evaluation,
      outcomeEffect: outcomeValue(corrected.outcome) - outcomeValue(original.outcome),
    })
  }
  const territoryEffects = paired.map(({ territoryEffect }) => territoryEffect)
  const outcomeEffects = paired.map(({ outcomeEffect }) => outcomeEffect)
  const meanTerritoryEffect = mean(territoryEffects)
  const meanOutcomeEffect = mean(outcomeEffects)
  rows.push({
    id: intervention.id,
    source: intervention.source,
    aiColor: intervention.aiColor,
    originalAction: intervention.originalAction,
    correctedAction: intervention.correctedAction,
    filterEvidence: intervention.evidence,
    immediateOriginal: immediate(
      intervention.state,
      intervention.originalAction,
      intervention.aiColor,
    ),
    immediateCorrected: immediate(
      intervention.state,
      intervention.correctedAction,
      intervention.aiColor,
    ),
    continuations: paired,
    meanTerritoryEffect,
    meanOutcomeEffect,
    classification:
      meanOutcomeEffect > 0 || (meanOutcomeEffect === 0 && meanTerritoryEffect > 0)
        ? 'beneficial'
        : meanOutcomeEffect < 0 || (meanOutcomeEffect === 0 && meanTerritoryEffect < 0)
          ? 'harmful'
          : 'neutral',
  })
}

const classifications = Object.fromEntries(
  ['beneficial', 'harmful', 'neutral'].map((label) => [
    label,
    rows.filter((row) => row.classification === label).length,
  ]),
)
const report = {
  schema: 'InactiveScoredTerritorySelectionEvaluationV1',
  createdAt: new Date().toISOString(),
  continuationsPerIntervention: continuations,
  corpus: {
    diagnosticTraces: traceNames.length,
    p01Turn40Included: rows.some((row) => row.source === 'v3-r1:p01:game-2:turn-40'),
    uniqueInterventions: rows.length,
    screenedInterventions: interventions.length,
    preservedControls: controls.length,
  },
  classifications,
  meanTerritoryEffect: mean(rows.map((row) => row.meanTerritoryEffect)),
  meanOutcomeEffect: mean(rows.map((row) => row.meanOutcomeEffect)),
  illegalCorrectedActions: interventions.filter(
    ({ state, correctedAction }) =>
      !getLegalActions(state).some((action) => sameAction(action, correctedAction)),
  ).length,
  fallbackCount: interventions.filter(({ fallback }) => fallback).length,
  accepted: classifications.harmful === 0,
  acceptanceReason:
    classifications.harmful === 0
      ? 'fixture-eliminated-without-harmful-paired-interventions'
      : 'harmful-paired-interventions-detected',
  rows,
  controls: controls.slice(0, 20),
}
await writeFile(
  resolve(outputDirectory, 'counterfactual-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
)
await writeFile(resolve(outputDirectory, 'README.md'), reportMarkdown(report))
console.log(JSON.stringify({ accepted: report.accepted, classifications, rows: rows.length }))

function inspectDecision(
  source: string,
  decision: ReturnType<typeof parseHumanMCTSTrace>['decisions'][number],
  aiColor: Player,
  required = false,
) {
  if (!decision.mcts) return
  const state = deserializeGameSnapshot(decision.stateBefore)
  const evidence = analyzeInactiveScoredMovement(state, decision.action)
  if (!evidence) {
    if (decision.action.type === 'move' && controls.length < 50)
      controls.push({ source, action: decision.action, preserved: true })
    return
  }
  const selection = chooseInactiveScoredTerritoryCandidate({
    state,
    selected: decision.action,
    candidates: decision.mcts.rootCandidates,
  })
  if (!selection.changed) {
    if (required) throw new Error(`Required intervention was not changed: ${source}`)
    return
  }
  const fingerprint = JSON.stringify([state.board, decision.action, selection.action])
  if (seen.has(fingerprint)) return
  seen.add(fingerprint)
  interventions.push({
    id: interventions.length + 1,
    source,
    state,
    aiColor,
    seed: decision.mcts.decisionSeed,
    originalAction: decision.action,
    correctedAction: selection.action,
    fallback: selection.usedFallback,
    evidence,
  })
}

function selectEvaluationCorpus(all: Intervention[]): Intervention[] {
  const maximum = Math.max(5, Number(process.env.INACTIVE_TERRITORY_MAX_INTERVENTIONS ?? 8))
  const mandatoryFragments = [
    'v3-r1:p01:game-2:turn-40',
    'secured-territory-14-',
    'secured-territory-16-',
    'secured-territory-2-',
    'secured-territory-30-',
  ]
  const selected: Intervention[] = []
  for (const fragment of mandatoryFragments) {
    const match = all.find(({ source }) => source.includes(fragment))
    if (match && !selected.includes(match)) selected.push(match)
  }
  for (const intervention of all) {
    if (selected.length >= maximum) break
    if (!selected.includes(intervention)) selected.push(intervention)
  }
  return selected
}

function immediate(state: GameSnapshot, action: PlayerAction, perspective: Player) {
  const after = applyFullAction(state, action).state
  return {
    territory: territory(after),
    mobility: splitMobility(after, perspective),
    expansion: evaluatePositionWithBreakdown(after, perspective).expansion,
    evaluation: evaluatePositionWithBreakdown(after, perspective).total,
    result: after.result,
  }
}

function playContinuation(state: GameSnapshot, aiColor: Player, seed: number) {
  let current = state
  let turn = 0
  while (current.phase !== 'finished' && !current.result && turn < 100) {
    const action =
      current.turn === aiColor
        ? chooseHumanChallengeMCTSDecision({
            gameState: current,
            seed: (seed + turn * 0x9e3779b9) >>> 0,
          }).action
        : heuristicAction(current, (seed + turn * 17) >>> 0)
    current = applyFullAction(current, action).state
    turn++
  }
  const score = territory(current)
  return {
    territory: score,
    evaluation: evaluatePositionWithBreakdown(current, aiColor).total,
    mobility: splitMobility(current, aiColor),
    outcome:
      score[aiColor] > score[other(aiColor)]
        ? 'win'
        : score[aiColor] < score[other(aiColor)]
          ? 'loss'
          : 'draw',
    turns: turn,
  }
}

function splitMobility(state: GameSnapshot, player: Player) {
  let active = 0
  let internal = 0
  const map = getTerritoryMap(state.board)
  for (const region of floodRegions(state.board)) {
    const ownOnly =
      region.borderingCounts[player] > 0 &&
      region.borderingCounts[other(player)] === 0 &&
      region.cells.every(({ x, y }) => map[y][x] === player)
    for (const position of region.cells) {
      if (state.board[position.y][position.x].stone !== player) continue
      const destinations = getLegalDestinations(state, position).length
      if (ownOnly) internal += destinations
      else active += destinations
    }
  }
  return { active, internal, total: active + internal }
}

function heuristicAction(state: GameSnapshot, seed: number): PlayerAction {
  const ranked = getLegalActions(state)
    .map((action) => ({ action, score: scoreHeuristicAction(state, action, 'default') }))
    .sort((left, right) => right.score - left.score)
  const best = ranked.filter(({ score }) => score === ranked[0]!.score)
  const rng = createPlayableMCTSRng(seed)
  return best[Math.floor(rng() * best.length)]!.action
}

function territory(state: GameSnapshot): Record<Player, number> {
  const totals: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board))
    for (const owner of row) if (owner) totals[owner]++
  return totals
}

function outcomeValue(outcome: string): number {
  return outcome === 'win' ? 1 : outcome === 'loss' ? -1 : 0
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function other(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function reportMarkdown(report: {
  corpus: {
    diagnosticTraces: number
    uniqueInterventions: number
    screenedInterventions: number
    preservedControls: number
  }
  classifications: Record<string, number>
  meanTerritoryEffect: number
  illegalCorrectedActions: number
  accepted: boolean
  acceptanceReason: string
}): string {
  return `# Evaluación contrafactual: territorio puntuado inactivo

- Trazas naturales: ${report.corpus.diagnosticTraces}
- Intervenciones únicas: ${report.corpus.uniqueInterventions}
- Intervenciones cribadas: ${report.corpus.screenedInterventions}
- Controles preservados: ${report.corpus.preservedControls}
- Beneficiosas: ${report.classifications.beneficial}
- Perjudiciales: ${report.classifications.harmful}
- Neutras: ${report.classifications.neutral}
- Efecto territorial medio: ${report.meanTerritoryEffect}
- Acciones ilegales: ${report.illegalCorrectedActions}
- Aceptada: ${report.accepted ? 'sí' : 'no'}
- Motivo: ${report.acceptanceReason}

La intervención se limita a la selección final del MCTS humano. No cambia reglas, territorio,
marcador, generación global de acciones ni políticas de los demás agentes.
`
}

interface Intervention {
  id: number
  source: string
  state: GameSnapshot
  aiColor: Player
  seed: number
  originalAction: PlayerAction
  correctedAction: PlayerAction
  fallback: boolean
  evidence: NonNullable<ReturnType<typeof analyzeInactiveScoredMovement>>
}

interface Control {
  source: string
  action: PlayerAction
  preserved: boolean
}

interface CounterfactualRow {
  id: number
  source: string
  aiColor: Player
  originalAction: PlayerAction
  correctedAction: PlayerAction
  filterEvidence: NonNullable<ReturnType<typeof analyzeInactiveScoredMovement>>
  immediateOriginal: ReturnType<typeof immediate>
  immediateCorrected: ReturnType<typeof immediate>
  continuations: Array<{
    seed: number
    original: ReturnType<typeof playContinuation>
    corrected: ReturnType<typeof playContinuation>
    territoryEffect: number
    evaluationEffect: number
    outcomeEffect: number
  }>
  meanTerritoryEffect: number
  meanOutcomeEffect: number
  classification: 'beneficial' | 'harmful' | 'neutral'
}
