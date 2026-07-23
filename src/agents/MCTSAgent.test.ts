import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createHumanVsMCTSAgents, FINAL_MCTS_CONFIG, MCTSAgent } from './MCTSAgent'
import { HumanAgent } from './HumanAgent'
import { choosePlayableMCTSAction, type MCTSWorkerGameState } from './mctsWorkerDecision'

type WorkerRequest = {
  aiType: string
  gameState: GameSnapshot & { legal: unknown }
  config: { mcts: typeof FINAL_MCTS_CONFIG; seed: number }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: WorkerRequest
  private readonly response: PlayerAction | Error
  constructor(response: PlayerAction | Error) {
    this.response = response
  }
  postMessage(request: WorkerRequest) {
    this.request = request
    queueMicrotask(() =>
      this.onmessage?.({
        data:
          this.response instanceof Error
            ? { error: this.response.message }
            : { action: this.response },
      } as MessageEvent),
    )
  }
  terminate() {}
}

class InProcessMCTSWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request?: WorkerRequest

  postMessage(request: WorkerRequest) {
    this.request = request
    queueMicrotask(() => {
      try {
        const action = choosePlayableMCTSAction({
          gameState: request.gameState as MCTSWorkerGameState,
          config: request.config.mcts,
          seed: request.config.seed,
        })
        this.onmessage?.({ data: { action } } as MessageEvent)
      } catch (error) {
        this.onmessage?.({
          data: { error: error instanceof Error ? error.message : String(error) },
        } as MessageEvent)
      }
    })
  }

  terminate() {}
}

function makeFixedPlayingState(): GameSnapshot {
  const state = makeInitialState()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  state.board = createEmptyBoard()
  state.board[0][0].stone = 'R'
  state.board[1][0].stone = 'B'
  return state
}

describe('MCTSAgent final', () => {
  it('envia exactamente la configuracion confirmada y devuelve una accion legal', async () => {
    const state = makeInitialState()
    const legalAction = getLegalActions(state)[0]
    const worker = new FakeWorker(legalAction)
    const agent = new MCTSAgent({ seed: 123, workerFactory: () => worker as unknown as Worker })
    await expect(agent.getAction(state)).resolves.toEqual(legalAction)
    expect(worker.request?.aiType).toBe('mcts-final')
    expect(worker.request?.config).toEqual({ mcts: FINAL_MCTS_CONFIG, seed: 123 })
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

  it.each(['R', 'B'] as const)(
    'funciona cuando el turno es %s sin modificar el estado',
    async (turn) => {
      const state = { ...makeInitialState(), turn }
      const before = structuredClone(state)
      const action = getLegalActions(state)[0]
      const worker = new FakeWorker(action)
      const agent = new MCTSAgent({ workerFactory: () => worker as unknown as Worker })
      await expect(agent.getAction(state)).resolves.toEqual(action)
      expect(state).toEqual(before)
      expect(worker.request?.gameState.turn).toBe(turn)
    },
  )

  it('asigna MCTS al color elegido y humano al contrario', () => {
    const mcts = new MCTSAgent({
      workerFactory: () => new FakeWorker(new Error()) as unknown as Worker,
    })
    const human = new HumanAgent()
    expect(createHumanVsMCTSAgents('R', mcts, human)).toEqual({ R: mcts, B: human })
    expect(createHumanVsMCTSAgents('B', mcts, human)).toEqual({ R: human, B: mcts })
  })

  it('propaga un error controlado y comprensible', async () => {
    const worker = new FakeWorker(new Error('fallo simulado'))
    const agent = new MCTSAgent({ workerFactory: () => worker as unknown as Worker })
    await expect(agent.getAction(makeInitialState())).rejects.toThrow(
      'La IA MCTS final no pudo elegir una acción: fallo simulado',
    )
  })

  it('rechaza de forma controlada una respuesta ilegal del worker', async () => {
    const worker = new FakeWorker({ type: 'place', pos: { x: -1, y: -1 } })
    const agent = new MCTSAgent({ workerFactory: () => worker as unknown as Worker })
    await expect(agent.getAction(makeInitialState())).rejects.toThrow(
      'La IA MCTS final no devolvió una acción legal.',
    )
  })

  it('no carga ni referencia recursos Q5', () => {
    expect(readFileSync('src/agents/MCTSAgent.ts', 'utf8')).not.toMatch(/Q5|q5/)
    expect(readFileSync('src/agents/AIWorker.ts', 'utf8')).not.toMatch(/Q5|q5/)
  })

  it('integra de forma determinista MCTSAgent con la logica jugable compartida', async () => {
    // Certifica el protocolo jugable; evaluateMCTS.ts conserva otro protocolo de RNG.
    const seed = 0x12345678
    const state = makeFixedPlayingState()
    const before = structuredClone(state)
    const legalActions = getLegalActions(state)
    const worker = new InProcessMCTSWorker()
    const agent = new MCTSAgent({ seed, workerFactory: () => worker as unknown as Worker })

    expect(legalActions.length).toBeGreaterThan(1)
    const action = await agent.getAction(state)

    expect(worker.request).toBeDefined()
    expect(worker.request?.aiType).toBe('mcts-final')
    expect(worker.request?.gameState).toEqual({
      ...state,
      legal: Array.from(state.legal),
    })
    expect(worker.request?.config).toEqual({ mcts: FINAL_MCTS_CONFIG, seed })
    expect(legalActions).toContainEqual(action)
    expect(state).toEqual(before)
  })

  it('elige la misma accion con el mismo estado, configuracion y semilla jugables', () => {
    const seed = 0x12345678
    const state = makeFixedPlayingState()
    const before = structuredClone(state)
    const serialized = {
      ...state,
      legal: Array.from(state.legal),
    }
    const serializedBefore = structuredClone(serialized)

    const first = choosePlayableMCTSAction({
      gameState: serialized,
      config: FINAL_MCTS_CONFIG,
      seed,
    })
    const second = choosePlayableMCTSAction({
      gameState: serialized,
      config: FINAL_MCTS_CONFIG,
      seed,
    })

    expect(first).toEqual(second)
    expect(getLegalActions(state)).toContainEqual(first)
    expect(serialized).toEqual(serializedBefore)
    expect(state).toEqual(before)
  })
})
