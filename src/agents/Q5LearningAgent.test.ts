import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HumanAgent } from './HumanAgent'
import {
  Q5_CHECKPOINT_ENTRIES,
  Q5_CHECKPOINT_SHA256,
  Q5_CHECKPOINT_SOURCE,
  Q5LearningAgent,
  Q5ModelLoadError,
  combineQ5Confidence,
  createFrozenQ5ModelLoader,
  createHumanVsQ5Agents,
  type FrozenQ5Model,
} from './Q5LearningAgent'
import { chooseFrozenQ5Action, Q5_EPSILON, Q5_MIN_CONFIDENCE, Q5_Q_MARGIN } from './q5Policy'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  chooseThresholdHybridQ5Action,
  type Q5StateActionConfidence,
} from '@/training/trainLearningAgentQ5'
import type { GameSnapshot } from '@/lib/types'

const checkpointPath = resolve(Q5_CHECKPOINT_SOURCE)

function loadFrozenFixture(): {
  model: FrozenQ5Model
  inherited: Map<string, Q5StateActionConfidence>
  updates: Map<string, number>
} {
  const qTable = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Record<string, number>
  const summary = JSON.parse(
    readFileSync(
      resolve('data/entrenamiento/q5/heuristic_initial_qtable/build_summary.json'),
      'utf8',
    ),
  ) as { entries: Array<{ stateActionKey: string; observations: number }> }
  const inherited = new Map<string, Q5StateActionConfidence>()
  for (const entry of summary.entries) {
    inherited.set(entry.stateActionKey, {
      observations: entry.observations,
      confidence: 'new',
      alpha: 0,
    })
  }

  const updates = new Map<string, number>()
  for (const path of [
    'data/entrenamiento/q5/hybrid/final_checkpoint_500/q_update_log.jsonl',
    'data/entrenamiento/q5/hybrid/final_checkpoint_1000/q_update_log.jsonl',
  ]) {
    for (const line of readFileSync(resolve(path), 'utf8').trim().split(/\r?\n/)) {
      const entry = JSON.parse(line) as { stateActionKey: string }
      updates.set(entry.stateActionKey, (updates.get(entry.stateActionKey) ?? 0) + 1)
    }
  }

  const inheritedObservations = new Map(
    Array.from(inherited.entries(), ([key, value]) => [key, value.observations]),
  )
  const { confidence } = combineQ5Confidence(inheritedObservations, updates)

  return {
    model: Object.freeze({
      qTable: Object.freeze(qTable),
      confidence,
      source: Q5_CHECKPOINT_SOURCE,
      sha256: Q5_CHECKPOINT_SHA256,
    }),
    inherited,
    updates,
  }
}

describe('Q5LearningAgent congelado', () => {
  it('combina confianza con Array.from y max sin perder iteradores Map', () => {
    const inherited = new Map([['a', 3], ['b', 12]])
    const updates = new Map([['b', 2], ['c', 15]])
    const arrayFromKeys = new Set([
      ...Array.from(inherited.keys()),
      ...Array.from(updates.keys()),
    ])
    const result = combineQ5Confidence(inherited, updates)
    expect(new Set(result.confidence.keys())).toEqual(arrayFromKeys)
    expect(Object.fromEntries(result.confidence)).toEqual({ a: 3, b: 12, c: 15 })
  })

  it('inicia una sola carga y devuelve un error controlado si falla', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('sin acceso al recurso')
    }) as unknown as typeof fetch
    const load = createFrozenQ5ModelLoader(fetcher)
    const first = load()
    const second = load()
    expect(second).toBe(first)
    await expect(first).rejects.toBeInstanceOf(Q5ModelLoadError)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('apunta al checkpoint Q5-1000 correcto y verifica su contenido', () => {
    const bytes = readFileSync(checkpointPath)
    const table = JSON.parse(bytes.toString('utf8')) as Record<string, number>
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(Q5_CHECKPOINT_SHA256)
    expect(Object.keys(table)).toHaveLength(Q5_CHECKPOINT_ENTRIES)
    expect(Q5_CHECKPOINT_SOURCE).toContain('final_checkpoint_1000/qtable_q5_hybrid_final_1000.json')
    expect(Q5_CHECKPOINT_SOURCE).not.toContain('1500')
    expect({ epsilon: Q5_EPSILON, minConfidence: Q5_MIN_CONFIDENCE, qMargin: Q5_Q_MARGIN }).toEqual(
      {
        epsilon: 0,
        minConfidence: 10,
        qMargin: 0.5,
      },
    )
  })

  it('no modifica ni persiste la tabla al jugar', async () => {
    const { model } = loadFrozenFixture()
    const before = JSON.stringify(model.qTable)
    const agent = new Q5LearningAgent({ modelLoader: async () => model, rng: () => 0.25 })
    await agent.getAction(makeInitialState())
    expect(JSON.stringify(model.qTable)).toBe(before)
    expect(Object.isFrozen(model.qTable)).toBe(true)
    expect('updateAfterGame' in agent).toBe(false)
    expect('saveToLocalStorage' in agent).toBe(false)
  })

  it('puede ocupar y jugar el lado rojo o azul frente a un humano', async () => {
    const { model } = loadFrozenFixture()
    const q5 = new Q5LearningAgent({ modelLoader: async () => model, rng: () => 0.25 })
    const human = new HumanAgent()
    const red = createHumanVsQ5Agents('R', q5, human)
    const blue = createHumanVsQ5Agents('B', q5, human)
    expect(red).toEqual({ R: q5, B: human })
    expect(blue).toEqual({ R: human, B: q5 })

    const redState = makeInitialState()
    const blueState: GameSnapshot = { ...makeInitialState(), turn: 'B' }
    expect(getLegalActions(redState)).toContainEqual(await q5.getAction(redState))
    expect(getLegalActions(blueState)).toContainEqual(await q5.getAction(blueState))
  })

  it('mantiene paridad de acción con el evaluador congelado Q5-1000', () => {
    const { model, inherited, updates } = loadFrozenFixture()
    const states: GameSnapshot[] = [
      makeInitialState(),
      { ...makeInitialState(), turn: 'B', stonesPlaced: { R: 3, B: 2 } },
    ]

    for (const state of states) {
      const legalActions = getLegalActions(state)
      const runtime = chooseFrozenQ5Action({
        state,
        legalActions,
        qTable: model.qTable,
        confidence: model.confidence,
        rng: () => 0.375,
      })
      const evaluator = chooseThresholdHybridQ5Action({
        state,
        legalActions,
        qTable: model.qTable as Record<string, number>,
        confidenceMap: inherited,
        qLearningUpdateCounts: updates,
        variant: { id: 'E', minConfidence: 10, minMargin: 0.5 },
        rng: () => 0.375,
      })
      expect(runtime.action).toEqual(evaluator.action)
      expect(runtime.mechanism).toBe(evaluator.mechanism)
    }
  })
})
