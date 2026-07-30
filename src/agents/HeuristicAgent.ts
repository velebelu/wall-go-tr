import type { PlayerAgent } from './PlayerAgent'
import type { GameSnapshot, PlayerAction, HeuristicMode } from '@/lib/types'
import { toSerializableSnapshot } from './serialize'
import { sleep } from '@/utils/sleep'

function createAIWorker(): Worker {
  return new Worker(new URL('./AIWorker.ts', import.meta.url), { type: 'module' })
}

export class HeuristicAgent implements PlayerAgent {
  private worker: Worker
  private readonly mode: HeuristicMode

  constructor(mode: HeuristicMode = 'default') {
    this.mode = mode
    this.worker = createAIWorker()
  }

  /** Aborta el cálculo en curso (timeout del TurnManager) y deja el agente listo para el siguiente turno. */
  public cancel(): void {
    this.worker.terminate()
    this.worker = createAIWorker()
  }

  async getAction(gameState: GameSnapshot): Promise<PlayerAction> {
    await sleep(250 + Math.floor(Math.random() * 100))

    return new Promise((resolve, reject) => {
      this.worker.onmessage = (
        event: MessageEvent<{
          action?: PlayerAction | null
          error?: string
          stack?: string
          info?: string
        }>,
      ) => {
        this.worker.onmessage = null
        this.worker.onerror = null
        if (event.data.error) {
          let errMsg = 'Worker error (HeuristicAgent): ' + event.data.error
          if (event.data.stack) errMsg += '\nStack: ' + event.data.stack
          reject(new Error(errMsg))
        } else if (event.data.action) {
          resolve(event.data.action)
        } else {
          reject(
            new Error(
              'Unknown or missing action from AIWorker for HeuristicAgent. Info: ' +
                event.data.info,
            ),
          )
        }
      }

      this.worker.onerror = (error: ErrorEvent) => {
        this.worker.onmessage = null
        this.worker.onerror = null
        reject(new Error(`AIWorker onerror (HeuristicAgent): ${error.message}`))
      }

      this.worker.postMessage({
        aiType: 'heuristic',
        gameState: toSerializableSnapshot(gameState),
        config: {
          policy: this.mode,
        },
      })
    })
  }

  public terminate(): void {
    if (this.worker) {
      this.worker.terminate()
    }
  }
}
