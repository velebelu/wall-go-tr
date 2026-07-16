import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import type { PlayerAgent } from './PlayerAgent'
import { HumanAgent } from './HumanAgent'
import { chooseFrozenQ5Action, type FrozenQ5Confidence, type FrozenQ5Table } from './q5Policy'

export const Q5_CHECKPOINT_SOURCE =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json'
export const Q5_CHECKPOINT_SHA256 =
  'cd3dff73d54b8b3cd0a225ebecebc82e66b4bf61cbdb9b710597ceaf15e396a2'
export const Q5_CHECKPOINT_ENTRIES = 27_815

const Q5_ASSET_URLS = {
  qTable: new URL(
    '../../data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json',
    import.meta.url,
  ).href,
  confidence: new URL(
    '../../data/entrenamiento/q5/heuristic_initial_qtable/build_summary.json',
    import.meta.url,
  ).href,
  updates500: new URL(
    '../../data/entrenamiento/q5/hybrid/final_checkpoint_500/q_update_log.jsonl',
    import.meta.url,
  ).href,
  updates1000: new URL(
    '../../data/entrenamiento/q5/hybrid/final_checkpoint_1000/q_update_log.jsonl',
    import.meta.url,
  ).href,
} as const

export interface FrozenQ5Model {
  qTable: FrozenQ5Table
  confidence: FrozenQ5Confidence
  source: typeof Q5_CHECKPOINT_SOURCE
  sha256: typeof Q5_CHECKPOINT_SHA256
}

export interface Q5ConfidenceLoadStats {
  confidenceMapEntries: number
  qLearningUpdateCountsEntries: number
  effectiveConfidenceEntries: number
  maxEffectiveConfidence: number
  effectiveEntriesAtLeast10: number
}

export function combineQ5Confidence(
  inherited: ReadonlyMap<string, number>,
  updates: ReadonlyMap<string, number>,
): { confidence: Map<string, number>; stats: Q5ConfidenceLoadStats } {
  const confidence = new Map<string, number>()
  const keys = new Set([...Array.from(inherited.keys()), ...Array.from(updates.keys())])
  let maxEffectiveConfidence = 0
  let effectiveEntriesAtLeast10 = 0
  for (const key of Array.from(keys.values())) {
    const value = Math.max(inherited.get(key) ?? 0, updates.get(key) ?? 0)
    confidence.set(key, value)
    maxEffectiveConfidence = Math.max(maxEffectiveConfidence, value)
    if (value >= 10) effectiveEntriesAtLeast10++
  }
  return {
    confidence,
    stats: {
      confidenceMapEntries: inherited.size,
      qLearningUpdateCountsEntries: updates.size,
      effectiveConfidenceEntries: confidence.size,
      maxEffectiveConfidence,
      effectiveEntriesAtLeast10,
    },
  }
}

export class Q5ModelLoadError extends Error {
  constructor(message: string) {
    super(`No se pudo cargar IA aprendiz Q5: ${message}`)
    this.name = 'Q5ModelLoadError'
  }
}

async function fetchText(url: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} (${url})`)
  return response.text()
}

async function sha256(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 no está disponible en este navegador')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function addUpdateCounts(text: string, counts: Map<string, number>): void {
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line) continue
    const entry = JSON.parse(line) as { stateActionKey?: string }
    if (entry.stateActionKey) {
      counts.set(entry.stateActionKey, (counts.get(entry.stateActionKey) ?? 0) + 1)
    }
  }
}

export function createFrozenQ5ModelLoader(
  fetcher: typeof fetch = fetch,
): () => Promise<FrozenQ5Model> {
  let modelPromise: Promise<FrozenQ5Model> | undefined

  return () => {
    modelPromise ??= (async () => {
      try {
        const [qTableText, confidenceText, updates500Text, updates1000Text] = await Promise.all([
          fetchText(Q5_ASSET_URLS.qTable, fetcher),
          fetchText(Q5_ASSET_URLS.confidence, fetcher),
          fetchText(Q5_ASSET_URLS.updates500, fetcher),
          fetchText(Q5_ASSET_URLS.updates1000, fetcher),
        ])

        const actualHash = await sha256(qTableText)
        if (actualHash !== Q5_CHECKPOINT_SHA256) {
          throw new Error(`hash Q5-1000 inválido: ${actualHash}`)
        }

        const parsedTable = JSON.parse(qTableText) as Record<string, number>
        if (Object.keys(parsedTable).length !== Q5_CHECKPOINT_ENTRIES) {
          throw new Error('el número de entradas del checkpoint Q5-1000 no coincide')
        }

        const summary = JSON.parse(confidenceText) as {
          entries?: Array<{ stateActionKey: string; observations: number }>
        }
        const inherited = new Map<string, number>()
        for (const entry of summary.entries ?? []) {
          inherited.set(entry.stateActionKey, entry.observations)
        }

        const updates = new Map<string, number>()
        addUpdateCounts(updates500Text, updates)
        addUpdateCounts(updates1000Text, updates)
        const { confidence: combined } = combineQ5Confidence(inherited, updates)

        return Object.freeze({
          qTable: Object.freeze(parsedTable),
          confidence: combined as FrozenQ5Confidence,
          source: Q5_CHECKPOINT_SOURCE,
          sha256: Q5_CHECKPOINT_SHA256,
        })
      } catch (error) {
        throw new Q5ModelLoadError(error instanceof Error ? error.message : 'error desconocido')
      }
    })()

    return modelPromise
  }
}

export const loadFrozenQ5Model = createFrozenQ5ModelLoader()

/** Agente de solo inferencia: no registra transiciones, no aprende y no persiste datos. */
export class Q5LearningAgent implements PlayerAgent {
  private readonly modelPromise: Promise<FrozenQ5Model>
  private readonly options: {
    modelLoader?: () => Promise<FrozenQ5Model>
    rng?: () => number
  }

  constructor(options: { modelLoader?: () => Promise<FrozenQ5Model>; rng?: () => number } = {}) {
    this.options = options
    this.modelPromise = (options.modelLoader ?? loadFrozenQ5Model)()
    void this.modelPromise.catch(() => undefined)
  }

  async getAction(gameState: GameSnapshot): Promise<PlayerAction> {
    const model = await this.modelPromise
    return chooseFrozenQ5Action({
      state: gameState,
      qTable: model.qTable,
      confidence: model.confidence,
      rng: this.options.rng,
    }).action
  }
}

export function createHumanVsQ5Agents(
  aiSide: Player,
  q5: Q5LearningAgent = new Q5LearningAgent(),
  human: HumanAgent = new HumanAgent(),
): Record<Player, PlayerAgent> {
  return aiSide === 'R' ? { R: q5, B: human } : { R: human, B: q5 }
}
