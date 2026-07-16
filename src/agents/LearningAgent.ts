import type { PlayerAgent } from './PlayerAgent'
import type { GameSnapshot, PlayerAction, Player } from '@/lib/types'
import { getTerritoryMap } from '@/utils/territory'
import { toSerializableSnapshot } from './serialize'
import { sleep } from '@/utils/sleep'
import { getLearningActionKey, getLearningStateKey, type QTableSnapshot } from './learningPolicy'

function createAIWorker(): Worker {
  return new Worker(new URL('./AIWorker.ts', import.meta.url), { type: 'module' })
}

export function calculateFinalReward(
  result: 'win' | 'loss' | 'draw',
  territoryAprendiz: number,
  territoryRival: number,
): number {
  const baseReward = result === 'win' ? 1 : result === 'loss' ? -1 : 0.3
  const territoryDiff = territoryAprendiz - territoryRival
  const normalizedDiff = territoryDiff / 49
  const finalReward = baseReward + normalizedDiff
  return Math.max(-1.5, Math.min(1.5, finalReward))
}

/**
 * LearningAgent: Un agente que aprende mediante una tabla Q simplificada.
 *
 * - Inicialmente se comporta como una IA aleatoria (exploración)
 * - Mantiene una tabla Q: estado + acción -> valor de acción
 * - Puede actualizar sus valores después de cada partida
 * - Diseñado para ser simple sin dependencias externas
 */
export class LearningAgent implements PlayerAgent {
  private worker: Worker
  // Tabla Q simplificada: mapeo de "stateKey + actionKey" -> valor
  private qTable: Map<string, number> = new Map()
  // Registro de acciones durante la partida actual
  private gameTrace: Array<{ state: GameSnapshot; action: PlayerAction; reward: number }> = []
  // Parámetros de aprendizaje
  private learningRate: number = 0.1
  private discountFactor: number = 0.9
  private epsilon: number = 0.3 // Probabilidad de exploración (acción aleatoria)
  private decayEpsilon: number = 0.995 // Reducir epsilon gradualmente
  // Identificador único para localStorage
  private readonly storageKey = 'wall-go-learning-agent-q-table'

  constructor(
    options: {
      loadFromLocalStorage?: boolean
      initialQTable?: QTableSnapshot
    } = {},
  ) {
    this.worker = createAIWorker()
    if (options.initialQTable) {
      this.loadQTable(options.initialQTable)
    } else if (options.loadFromLocalStorage !== false) {
      // Cargar tabla Q de localStorage si existe
      this.loadFromLocalStorage()
    }
  }

  /**
   * Obtiene una clave que representa el estado actual del juego.
   * Simplificada: usa fase, turno, número de piedras colocadas y posiciones aproximadas.
   */
  private getStateKey(gameState: GameSnapshot): string {
    return getLearningStateKey(gameState)
  }

  /**
   * Obtiene una clave que representa una acción.
   */
  private getActionKey(action: PlayerAction): string {
    return getLearningActionKey(action)
  }

  private static calculateTerritoryCounts(gameState: GameSnapshot): Record<Player, number> {
    const territory = getTerritoryMap(gameState.board)
    const totals: Record<Player, number> = { R: 0, B: 0 }
    for (let y = 0; y < territory.length; y++) {
      for (let x = 0; x < territory[y].length; x++) {
        const owner = territory[y][x]
        if (owner) totals[owner]++
      }
    }
    return totals
  }

  private calculateIntermediateReward(
    prevState: GameSnapshot,
    nextState: GameSnapshot,
    playerSide: Player,
  ): number {
    const opponent: Player = playerSide === 'R' ? 'B' : 'R'
    const prevTerritory = LearningAgent.calculateTerritoryCounts(prevState)
    const nextTerritory = LearningAgent.calculateTerritoryCounts(nextState)
    const prevDiff = prevTerritory[playerSide] - prevTerritory[opponent]
    const nextDiff = nextTerritory[playerSide] - nextTerritory[opponent]
    const delta = nextDiff - prevDiff
    return Math.max(-0.1, Math.min(0.1, delta * 0.05))
  }

  public recordTransition(
    prevState: GameSnapshot,
    action: PlayerAction,
    nextState: GameSnapshot,
  ): void {
    const reward = this.calculateIntermediateReward(prevState, nextState, prevState.turn)
    this.gameTrace.push({ state: prevState, action, reward })
  }

  /**
   * Obtiene el valor Q para un par estado-acción.
   * Si no existe, retorna 0 (optimista).
   */
  private getQValue(stateKey: string, actionKey: string): number {
    const key = `${stateKey}|||${actionKey}`
    return this.qTable.get(key) ?? 0
  }

  /**
   * Actualiza el valor Q para un par estado-acción.
   */
  private setQValue(stateKey: string, actionKey: string, value: number): void {
    const key = `${stateKey}|||${actionKey}`
    this.qTable.set(key, value)
  }

  async getAction(gameState: GameSnapshot): Promise<PlayerAction> {
    await sleep(200 + Math.floor(Math.random() * 200)) // Simular tiempo de "pensamiento" 200~400ms

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
          let errMsg = 'Worker error (LearningAgent): ' + event.data.error
          if (event.data.stack) errMsg += '\nStack: ' + event.data.stack
          reject(new Error(errMsg))
        } else if (event.data.action) {
          const action = event.data.action
          resolve(action)
        } else {
          reject(
            new Error(
              'Unknown or missing action from AIWorker for LearningAgent. Info: ' + event.data.info,
            ),
          )
        }
      }

      this.worker.onerror = (error: ErrorEvent) => {
        this.worker.onmessage = null
        this.worker.onerror = null
        reject(new Error(`AIWorker onerror (LearningAgent): ${error.message}`))
      }

      this.worker.postMessage({
        aiType: 'learning',
        gameState: toSerializableSnapshot(gameState),
        config: {
          epsilon: this.epsilon,
          qTable: Array.from(this.qTable.entries()),
        },
      })
    })
  }

  /**
   * Actualiza los valores Q después de finalizar una partida.
   * Parámetros:
   * - result: resultado de la partida ('win' | 'loss' | 'draw')
   * - playerSide: lado del jugador ('R' | 'B')
   * - territoryAprendiz: territorio final del agente aprendiz
   * - territoryRival: territorio final del rival
   */
  public updateAfterGame(
    result: 'win' | 'loss' | 'draw',
    playerSide: 'R' | 'B',
    territoryAprendiz = 0,
    territoryRival = 0,
  ): void {
    if (this.gameTrace.length === 0) {
      console.log('[LearningAgent] No game trace to learn from')
      return
    }

    const finalReward = calculateFinalReward(result, territoryAprendiz, territoryRival)
    const territoryDiff = territoryAprendiz - territoryRival

    console.log('[LearningAgent] territorioAprendiz:', territoryAprendiz)
    console.log('[LearningAgent] territorioRival:', territoryRival)
    console.log('[LearningAgent] diferencia de territorio:', territoryDiff)
    console.log('[LearningAgent] recompensa final aplicada:', finalReward)

    // Retropropagación simple: ajustar valores Q de atrás hacia adelante
    let nextValue = 0
    for (let i = this.gameTrace.length - 1; i >= 0; i--) {
      const { state, action, reward: stepReward } = this.gameTrace[i]!
      // Solo actualizar si es turno del agente
      if (state.turn === playerSide) {
        const stateKey = this.getStateKey(state)
        const actionKey = this.getActionKey(action)
        const currentQ = this.getQValue(stateKey, actionKey)
        const totalReward = stepReward + (i === this.gameTrace.length - 1 ? finalReward : 0)
        const newQ =
          currentQ + this.learningRate * (totalReward + this.discountFactor * nextValue - currentQ)
        this.setQValue(stateKey, actionKey, newQ)
        nextValue = newQ
      }
    }

    // Reducir epsilon gradualmente para pasar de exploración a explotación
    this.epsilon *= this.decayEpsilon
    if (this.epsilon < 0.05) {
      this.epsilon = 0.05 // Mantener mínimo de exploración
    }

    // Guardar tabla Q en localStorage automáticamente después de aprender
    this.saveToLocalStorage()

    // Limpiar historial de la partida
    this.gameTrace = []
  }

  /**
   * Guarda la tabla Q en localStorage y muestra contador en consola.
   */
  public saveToLocalStorage(): void {
    try {
      const snapshot = this.getQTableSnapshot()
      localStorage.setItem(this.storageKey, JSON.stringify(snapshot))
      const entryCount = Object.keys(snapshot).length
      console.log(`[LearningAgent] Tabla Q guardada. Entradas aprendidas: ${entryCount}`)
    } catch (e) {
      console.error('[LearningAgent] Error guardando tabla Q:', e)
    }
  }

  /**
   * Carga la tabla Q desde localStorage y muestra contador.
   */
  private loadFromLocalStorage(): void {
    try {
      const stored = localStorage.getItem(this.storageKey)
      if (stored) {
        const snapshot = JSON.parse(stored)
        this.loadQTable(snapshot)
        const entryCount = Object.keys(snapshot).length
        console.log(`[LearningAgent] Tabla Q cargada. Entradas aprendidas: ${entryCount}`)
      }
    } catch (e) {
      console.error('[LearningAgent] Error cargando tabla Q:', e)
    }
  }

  /**
   * Retorna el estado actual de la tabla Q (para debugging/persistencia).
   */
  public getQTableSnapshot(): QTableSnapshot {
    const snapshot: QTableSnapshot = {}
    for (const [key, value] of this.qTable.entries()) {
      snapshot[key] = value
    }
    return snapshot
  }

  /**
   * Carga un estado de tabla Q previamente guardado.
   */
  public loadQTable(snapshot: QTableSnapshot): void {
    this.qTable.clear()
    for (const [key, value] of Object.entries(snapshot)) {
      this.qTable.set(key, value)
    }
  }

  /**
   * Retorna el número de entradas aprendidas en la tabla Q.
   */
  public getQTableSize(): number {
    return this.qTable.size
  }

  /**
   * Muestra estadísticas del agente en consola.
   */
  public logStats(): void {
    console.group('[LearningAgent] Estadísticas')
    console.log(`Entradas Q-table: ${this.qTable.size}`)
    console.log(`Epsilon (exploración): ${this.epsilon.toFixed(4)}`)
    console.log(`Learning Rate: ${this.learningRate}`)
    console.log(`Discount Factor: ${this.discountFactor}`)
    console.groupEnd()
  }

  public terminate(): void {
    if (this.worker) {
      this.worker.terminate()
    }
  }

  /** Aborta el cálculo en curso (timeout del TurnManager) y deja el agente listo para el siguiente turno. */
  public cancel(): void {
    this.worker.terminate()
    this.worker = createAIWorker()
  }
}
