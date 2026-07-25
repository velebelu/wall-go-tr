import { afterEach, describe, expect, it, vi } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { choosePlayableMCTSAction, choosePlayableMCTSDecision } from '@/agents/mctsWorkerDecision'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  downloadPreparedHumanMCTSTrace,
  extractHumanMCTSDecisionFixture,
  finalizeHumanMCTSTrace,
  parseHumanMCTSTrace,
  prepareHumanMCTSTraceFile,
  recordHumanMCTSDecision,
  replayHumanMCTSTrace,
  serializeHumanMCTSTrace,
} from './humanMCTSTrace'

const CLOSING_ACTION: PlayerAction = {
  type: 'wall',
  from: { x: 3, y: 3 },
  pos: { x: 3, y: 3 },
  dir: 'right',
}

function closingState(): GameSnapshot {
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

function completeSyntheticTrace() {
  const before = closingState()
  const after = applyFullAction(before, CLOSING_ACTION).state
  const decision: TurnDecisionTrace = {
    turnNumber: 0,
    player: 'B',
    stateBefore: before,
    stateAfter: after,
    action: structuredClone(CLOSING_ACTION),
    legalActionCount: getLegalActions(before).length,
    decisionMs: 12.5,
    agentDiagnostics: {
      baseSeed: 123,
      decisionIndex: 0,
      decisionSeed: 123,
    },
  }
  const trace = createHumanMCTSTrace({
    gameId: 'synthetic-v1',
    createdAt: '2026-07-24T00:00:00.000Z',
    humanColor: 'R',
    mctsColor: 'B',
    seed: 123,
    mctsConfig: FINAL_MCTS_CONFIG,
    initialState: before,
  })
  appendHumanMCTSDecision(trace, decision, 'B')
  finalizeHumanMCTSTrace(trace, 'synthetic-v1', after)
  return { trace, before, after, decision }
}

describe('HumanMCTSTraceV1', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('registra la configuración definitiva completa en la traza del desafío humano', () => {
    const trace = createHumanMCTSTrace({
      humanColor: 'R',
      mctsColor: 'B',
      seed: 7,
      mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
      finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
      initialState: closingState(),
    })
    expect(trace.metadata.mctsConfig).toEqual(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts)
    expect(trace.metadata.finalHumanChallengeConfig).toEqual(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
    expect(trace.metadata.finalHumanChallengeConfig?.budget.enable750).toBe(false)
    expect(trace.metadata.finalHumanChallengeConfig?.endgame.enabled).toBe(false)
  })

  it('crea cada partida con una traza nueva, vacía y sin versión inventada', () => {
    const first = createHumanMCTSTrace({
      humanColor: 'R',
      mctsColor: 'B',
      seed: 1,
      mctsConfig: FINAL_MCTS_CONFIG,
      initialState: closingState(),
    })
    const second = createHumanMCTSTrace({
      humanColor: 'B',
      mctsColor: 'R',
      seed: 2,
      mctsConfig: FINAL_MCTS_CONFIG,
      initialState: closingState(),
    })
    expect(first).not.toBe(second)
    expect(first.decisions).toEqual([])
    expect(second.decisions).toEqual([])
    expect(first.metadata.projectVersion).toBeUndefined()
  })

  it('mantiene aisladas dos partidas consecutivas', () => {
    const { trace: first, decision } = completeSyntheticTrace()
    const second = createHumanMCTSTrace({
      gameId: 'second',
      humanColor: 'R',
      mctsColor: 'B',
      seed: 456,
      mctsConfig: FINAL_MCTS_CONFIG,
      initialState: closingState(),
    })
    expect(first.decisions).toHaveLength(1)
    expect(first.final).toBeDefined()
    expect(second.decisions).toEqual([])
    expect(second.final).toBeUndefined()
    recordHumanMCTSDecision(second, decision, 'B')
    expect(first.decisions).toHaveLength(1)
    expect(second.decisions).toHaveLength(1)
  })

  it('serializa y deserializa sin pérdida', () => {
    const { trace } = completeSyntheticTrace()
    expect(parseHumanMCTSTrace(serializeHumanMCTSTrace(trace))).toEqual(trace)
  })

  it('guarda copias profundas de estados, acciones y configuración', () => {
    const { trace, before, decision } = completeSyntheticTrace()
    before.board[0][0].stone = 'R'
    decision.action.pos.x = 0
    expect(trace.metadata.initialState.board[0][0].stone).toBe(null)
    expect(trace.decisions[0].action).toEqual(CLOSING_ACTION)
    expect(trace.metadata.mctsConfig).toEqual(FINAL_MCTS_CONFIG)
  })

  it('reproduce exactamente la partida sintética y el resultado final', () => {
    const { trace } = completeSyntheticTrace()
    expect(replayHumanMCTSTrace(trace)).toEqual({ ok: true, decisionsReplayed: 1 })
    expect(trace.final?.result).toMatchObject({ finished: true, winner: 'B' })
  })

  it('rechaza de forma controlada una segunda finalización', () => {
    const { trace, after } = completeSyntheticTrace()
    expect(() => finalizeHumanMCTSTrace(trace, 'synthetic-v1', after)).toThrow('already finalized')
  })

  it('no permite finalizar ni preparar una partida no terminada', () => {
    const trace = createHumanMCTSTrace({
      humanColor: 'R',
      mctsColor: 'B',
      seed: 1,
      mctsConfig: FINAL_MCTS_CONFIG,
      initialState: closingState(),
    })
    expect(() => finalizeHumanMCTSTrace(trace, 'unfinished', closingState())).toThrow(
      'without a game result',
    )
    expect(trace.final).toBeUndefined()
    expect(() => prepareHumanMCTSTraceFile(trace)).toThrow('unfinished trace')
  })

  it('preparar nombre y tamaño es puro y no provoca efectos del navegador', () => {
    const { trace } = completeSyntheticTrace()
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    const prepared = prepareHumanMCTSTraceFile(trace)
    expect(prepared.fileName).toBe('traza_humano_mcts_synthetic-v1.json')
    expect(prepared.bytes).toBe(new TextEncoder().encode(prepared.json).length)
    expect(appendSpy).not.toHaveBeenCalled()
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('solo descarga tras una llamada explícita', () => {
    const { trace } = completeSyntheticTrace()
    const prepared = prepareHumanMCTSTraceFile(trace)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const createUrl = vi.fn(() => 'blob:trace')
    const revokeUrl = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
    expect(clickSpy).not.toHaveBeenCalled()

    expect(downloadPreparedHumanMCTSTrace(prepared)).toEqual({
      fileName: prepared.fileName,
      bytes: prepared.bytes,
    })
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(createUrl).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:trace')
  })

  it('detecta una acción registrada alterada', () => {
    const { trace } = completeSyntheticTrace()
    trace.decisions[0].action = {
      type: 'wall',
      from: { x: 3, y: 3 },
      pos: { x: 3, y: 3 },
      dir: 'left',
    }
    expect(replayHumanMCTSTrace(trace)).toMatchObject({
      ok: false,
      divergence: { turnIndex: 0, kind: 'state-after' },
    })
  })

  it('detecta el snapshot posterior alterado', () => {
    const { trace } = completeSyntheticTrace()
    trace.decisions[0].stateAfter.board[0][0].stone = 'R'
    expect(replayHumanMCTSTrace(trace)).toMatchObject({
      ok: false,
      divergence: { turnIndex: 0, kind: 'state-after' },
    })
  })

  it('extrae un fixture compacto y profundamente independiente', () => {
    const { trace } = completeSyntheticTrace()
    const fixture = extractHumanMCTSDecisionFixture(trace, 0)
    expect(fixture).toMatchObject({
      schema: 'HumanMCTSDecisionFixtureV1',
      source: { gameId: 'synthetic-v1', turnIndex: 0 },
      player: 'B',
      actor: 'mcts',
      action: CLOSING_ACTION,
    })
    expect(fixture.legalActions).toContainEqual(CLOSING_ACTION)
    fixture.stateBefore.board[0][0].stone = 'R'
    expect(trace.decisions[0].stateBefore.board[0][0].stone).toBe(null)
  })

  it('no hace nada cuando el registro está desactivado', () => {
    const { decision } = completeSyntheticTrace()
    expect(() => recordHumanMCTSDecision(null, decision, 'B')).not.toThrow()
  })

  it('no cambia la acción jugable al obtener diagnósticos para la traza', () => {
    const state = makeInitialState()
    const config = {
      simulations: 8,
      explorationConstant: Math.SQRT2,
      maxDepth: 2,
      rolloutPolicy: 'random' as const,
    }
    const plain = choosePlayableMCTSAction({ gameState: state, config, seed: 77 })
    const traced = choosePlayableMCTSDecision({ gameState: state, config, seed: 77 })
    expect(traced.action).toEqual(plain)
  })

  it('mantiene FINAL_MCTS_CONFIG exactamente intacta', () => {
    expect(FINAL_MCTS_CONFIG).toEqual({
      simulations: 50,
      explorationConstant: Math.SQRT2,
      maxDepth: 60,
      rolloutPolicy: 'mixed',
      heuristicProbability: 0.8,
      expansionPolicy: 'heuristic',
      progressiveWidening: true,
      wideningConstant: 2,
      wideningExponent: 0.5,
      qPriorWeight: 0,
      tacticalVerification: true,
      tacticalCandidateCount: 2,
    })
  })
})
