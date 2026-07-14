import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Q5_CHECKPOINT_SHA256, Q5_CHECKPOINT_SOURCE } from '@/agents/Q5LearningAgent'
import type { PlayerAction } from '@/lib/types'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import {
  auditQ5Confidence,
  calculateKeyCoverage,
  distribution,
  getFinalQ5Key,
  getMCTSQ5Key,
  getTrainingQ5Key,
  percentile,
} from './auditQ5Confidence'

describe('auditQ5Confidence', () => {
  it('calcula percentiles interpolados y umbrales correctamente', () => {
    expect(percentile([0, 10, 20, 30, 40], 75)).toBe(30)
    expect(percentile([0, 10, 20, 30], 50)).toBe(15)
    const result = distribution([0, 1, 2, 3, 10])
    expect(result.median).toBe(2)
    expect(result.percentiles).toEqual({ p50: 2, p75: 3, p90: 7.2, p95: 8.6, p99: 9.72 })
    expect(result.thresholds['3']).toEqual({ count: 2, percentage: 40 })
  })

  it('calcula intersecciones y ausencias entre los tres mapas', () => {
    expect(calculateKeyCoverage({
      qTableKeys: new Set(['a', 'b', 'c']),
      confidenceKeys: new Set(['b', 'c', 'd']),
      updateKeys: new Set(['c', 'd', 'e']),
    })).toEqual({
      qTable: 3,
      confidenceMap: 3,
      qLearningUpdateCounts: 3,
      qTableAndConfidenceMap: 2,
      qTableAndUpdateCounts: 1,
      confidenceMapAndUpdateCounts: 2,
      allThree: 1,
      qTableWithoutConfidenceMap: 1,
      confidenceMapWithoutQTable: 1,
      qTableWithoutEffectiveConfidence: 1,
      effectiveConfidenceWithoutQTable: 2,
    })
  })

  it.each([
    { type: 'place', pos: { x: 2, y: 3 } },
    { type: 'move', from: { x: 1, y: 1 }, pos: { x: 2, y: 2 } },
    { type: 'move', from: { x: 1, y: 1 }, pos: { x: 2, y: 2 }, followUp: { type: 'wall', pos: { x: 2, y: 2 }, dir: 'top' } },
    { type: 'wall', pos: { x: 3, y: 3 }, dir: 'left' },
  ] satisfies PlayerAction[])('mantiene paridad de claves para $type', (action) => {
    const state = snapshotFromState(makeInitialState())
    expect(getTrainingQ5Key(state, action)).toBe(getFinalQ5Key(state, action))
    expect(getFinalQ5Key(state, action)).toBe(getMCTSQ5Key(state, action))
  })

  it('es determinista y no escribe cuando writeOutputs=false', async () => {
    const observedKeys = ['missing', 'missing', 'also-missing']
    const first = await auditQ5Confidence({ writeOutputs: false, observedKeys })
    const second = await auditQ5Confidence({ writeOutputs: false, observedKeys })
    expect(first.confidenceDistribution.total).toBeGreaterThan(0)
    expect(first.confidenceDistribution.max).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it('no modifica el checkpoint y conserva el SHA-256 aprobado', async () => {
    const qPath = path.resolve(Q5_CHECKPOINT_SOURCE)
    const before = readFileSync(qPath)
    const beforeHash = createHash('sha256').update(before).digest('hex')
    await auditQ5Confidence({ writeOutputs: false, observedKeys: [] })
    const after = readFileSync(qPath)
    expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash)
    expect(beforeHash).toBe(Q5_CHECKPOINT_SHA256)
    expect(after.equals(before)).toBe(true)
  })
})
