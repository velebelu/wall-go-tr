import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { MCTSConfig } from '@/engine/mcts/types'
import type { AgentDecisionDiagnostics, PlayerAgent } from './PlayerAgent'
import { toSerializableSnapshot } from './serialize'
import { getLegalActions } from '@/utils/ai'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG, type HumanChallengeConfig } from './humanChallengeMCTS'
import { FINAL_MCTS_CONFIG } from './mctsConfig'
export { FINAL_MCTS_CONFIG } from './mctsConfig'

type MCTSWorkerResponse = {
  action?: PlayerAction | null
  error?: string
  stack?: string
  info?: string
  diagnostics?: NonNullable<AgentDecisionDiagnostics['mcts']>
}

export interface MCTSAgentOptions {
  seed?: number
  workerFactory?: () => Worker
  profile?: 'fast' | 'human-challenge'
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
  private readonly profile: 'fast' | 'human-challenge'
  private lastDecisionDiagnostics?: AgentDecisionDiagnostics

  constructor(options: MCTSAgentOptions = {}) {
    this.seed = options.seed ?? createHumanGameSeed()
    this.profile = options.profile ?? 'human-challenge'
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
          if (this.lastDecisionDiagnostics && event.data.diagnostics) {
            this.lastDecisionDiagnostics.mcts = structuredClone(event.data.diagnostics)
          }
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
        aiType: this.profile === 'human-challenge' ? 'mcts-human-challenge' : 'mcts-final',
        gameState: toSerializableSnapshot(gameState),
        config: {
          challenge:
            this.profile === 'human-challenge' ? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG : undefined,
          mcts:
            this.profile === 'human-challenge'
              ? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts
              : FINAL_MCTS_CONFIG,
          seed: requestSeed,
        } satisfies {
          challenge?: Readonly<HumanChallengeConfig>
          mcts: Readonly<MCTSConfig>
          seed: number
        },
      })
    })
  }

  cancel(): void {
    this.worker?.terminate()
    this.worker = undefined
  }

  getDecisionDiagnostics(): AgentDecisionDiagnostics | undefined {
    return this.lastDecisionDiagnostics ? structuredClone(this.lastDecisionDiagnostics) : undefined
  }

  getBaseSeed(): number {
    return this.seed
  }
}

export function createHumanVsMCTSAgents(
  aiSide: Player,
  mcts: MCTSAgent,
  human: PlayerAgent,
): Record<Player, PlayerAgent> {
  return aiSide === 'R' ? { R: mcts, B: human } : { R: human, B: mcts }
}
