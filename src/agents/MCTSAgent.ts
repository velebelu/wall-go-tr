import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { AgentDecisionDiagnostics, PlayerAgent } from './PlayerAgent'
import { toSerializableSnapshot } from './serialize'
import { getLegalActions } from '@/utils/ai'

// Configuración "tactical-top-2" confirmada en evaluacion_verificacion_tactica_confirmacion
// (340 partidas, semillas emparejadas). El prior de la tabla aprendida permanece desactivado:
// su evaluación de confirmación concluyó no adoptarlo (sin mejora estadística y coste ~2x).
export const FINAL_MCTS_CONFIG = Object.freeze({
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
} satisfies MCTSConfig)

type MCTSWorkerResponse = {
  action?: PlayerAction | null
  error?: string
  stack?: string
  info?: string
}

export interface MCTSAgentOptions {
  seed?: number
  workerFactory?: () => Worker
}

function createHumanGameSeed(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return values[0]!
}

export class MCTSAgent implements PlayerAgent {
  private worker?: Worker
  private decision = 0
  private readonly seed: number
  private readonly workerFactory: () => Worker
  private lastDecisionDiagnostics?: AgentDecisionDiagnostics

  constructor(options: MCTSAgentOptions = {}) {
    this.seed = options.seed ?? createHumanGameSeed()
    this.workerFactory =
      options.workerFactory ??
      (() => new Worker(new URL('./AIWorker.ts', import.meta.url), { type: 'module' }))
    this.worker = this.workerFactory()
  }

  async getAction(gameState: GameSnapshot): Promise<PlayerAction> {
    const worker = this.worker ?? (this.worker = this.workerFactory())
    const decisionIndex = this.decision++
    const requestSeed = (this.seed + decisionIndex) >>> 0
    this.lastDecisionDiagnostics = {
      baseSeed: this.seed,
      decisionIndex,
      decisionSeed: requestSeed,
    }
    const legalActionKeys = new Set(
      getLegalActions(gameState).map((action) => JSON.stringify(action)),
    )
    return new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<MCTSWorkerResponse>) => {
        worker.onmessage = null
        worker.onerror = null
        if (event.data.error) {
          reject(new Error(`La IA MCTS final no pudo elegir una acción: ${event.data.error}`))
        } else if (event.data.action && legalActionKeys.has(JSON.stringify(event.data.action))) {
          resolve(event.data.action)
        } else {
          reject(
            new Error(
              `La IA MCTS final no devolvió una acción legal. ${event.data.info ?? ''}`.trim(),
            ),
          )
        }
      }
      worker.onerror = (error: ErrorEvent) => {
        worker.onmessage = null
        worker.onerror = null
        reject(new Error(`La IA MCTS final falló en el proceso de cálculo: ${error.message}`))
      }
      worker.postMessage({
        aiType: 'mcts-final',
        gameState: toSerializableSnapshot(gameState),
        config: { mcts: FINAL_MCTS_CONFIG, seed: requestSeed },
      })
    })
  }

  cancel(): void {
    this.worker?.terminate()
    this.worker = undefined
  }

  getDecisionDiagnostics(): AgentDecisionDiagnostics | undefined {
    return this.lastDecisionDiagnostics ? { ...this.lastDecisionDiagnostics } : undefined
  }
}

export function createHumanVsMCTSAgents(
  aiSide: Player,
  mcts: MCTSAgent,
  human: PlayerAgent,
): Record<Player, PlayerAgent> {
  return aiSide === 'R' ? { R: mcts, B: human } : { R: human, B: mcts }
}
