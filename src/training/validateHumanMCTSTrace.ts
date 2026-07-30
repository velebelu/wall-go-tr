import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  extractHumanMCTSDecisionFixture,
  finalizeHumanMCTSTrace,
  replayHumanMCTSTrace,
  serializeHumanMCTSTrace,
} from '@/utils/humanMCTSTrace'

export const HUMAN_MCTS_TRACE_VALIDATION_DIR = path.join(
  'data/entrenamiento/mcts/validacion_trazabilidad_humano_mcts_v1',
)

function validationState(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'B'
  state.stonesPlaced = { R: 4, B: 4 }
  state.board[2][5].stone = 'R'
  state.board[4][5].stone = 'R'
  state.board[3][3].stone = 'B'
  state.board[1][1].stone = 'B'
  for (let y = 0; y < state.board.length; y++) {
    if (y !== 3) state.board[y][4].wallLeft = 'B'
  }
  return state
}

export function validateHumanMCTSTrace(outputDir = HUMAN_MCTS_TRACE_VALIDATION_DIR) {
  const action: PlayerAction = {
    type: 'wall',
    from: { x: 3, y: 3 },
    pos: { x: 3, y: 3 },
    dir: 'right',
  }
  const before = validationState()
  const after = applyFullAction(before, action).state
  const trace = createHumanMCTSTrace({
    gameId: 'synthetic-closure-v1',
    createdAt: '2026-07-24T00:00:00.000Z',
    humanColor: 'R',
    mctsColor: 'B',
    seed: 123,
    mctsConfig: FINAL_MCTS_CONFIG,
    initialState: before,
  })
  const decision: TurnDecisionTrace = {
    turnNumber: 0,
    player: 'B',
    stateBefore: before,
    stateAfter: after,
    action,
    legalActionCount: getLegalActions(before).length,
    decisionMs: 12.5,
    agentDiagnostics: { baseSeed: 123, decisionIndex: 0, decisionSeed: 123 },
  }
  const recordStartedAt = performance.now()
  appendHumanMCTSDecision(trace, decision, 'B')
  finalizeHumanMCTSTrace(trace, 'synthetic-closure-v1', after)
  const recordingMs = performance.now() - recordStartedAt
  const replay = replayHumanMCTSTrace(trace)
  if (!replay.ok) throw new Error(replay.divergence?.message ?? 'Synthetic replay failed')
  const fixture = extractHumanMCTSDecisionFixture(trace, 0)
  const json = serializeHumanMCTSTrace(trace)
  const fixtureJson = `${JSON.stringify(fixture, null, 2)}\n`
  const containsPrivatePath = /(?:[A-Za-z]:\\Users\\|\/Users\/|dagar)/i.test(json)
  if (containsPrivatePath) throw new Error('Synthetic trace contains a personal path')

  const resolvedDir = path.resolve(outputDir)
  mkdirSync(resolvedDir, { recursive: true })
  const tracePath = path.join(resolvedDir, 'synthetic_closure_trace_v1.json')
  const fixturePath = path.join(resolvedDir, 'synthetic_closure_turn_0.fixture.json')
  const reportPath = path.join(resolvedDir, 'validation_report.json')
  const traceBytes = Buffer.byteLength(json, 'utf8')
  writeFileSync(tracePath, json, 'utf8')
  writeFileSync(fixturePath, fixtureJson, 'utf8')
  const report = {
    schema: trace.schema,
    replay,
    fixtureTurn: fixture.source.turnIndex,
    traceBytes,
    fixtureBytes: Buffer.byteLength(fixtureJson, 'utf8'),
    recordingMs: Number(recordingMs.toFixed(4)),
    containsPrivatePath,
    finalResultMatches: JSON.stringify(after.result) === JSON.stringify(trace.final?.result),
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { tracePath, fixturePath, reportPath, report }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(validateHumanMCTSTrace(), null, 2))
}
