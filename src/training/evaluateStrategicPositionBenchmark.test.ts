import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  findDuplicateFingerprints,
  loadSmokeFixtures,
  loadPilotFixtures,
  stateActionFingerprint,
  stateFingerprint,
  validateStrategicFixture,
} from './evaluateStrategicPositionBenchmark'

describe('strategic fixture canonical fingerprints', () => {
  const actionA = { type: 'place', pos: { x: 1, y: 2 } } as const
  const actionB = { type: 'place', pos: { x: 2, y: 1 } } as const

  it('sorts object keys recursively but preserves array order', () => {
    expect(canonicalize({ z: [{ b: 2, a: 1 }], a: 0 })).toBe(
      canonicalize({ a: 0, z: [{ a: 1, b: 2 }] }),
    )
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }))
  })

  it('ignores volatile state fields', () => {
    expect(stateFingerprint({ board: [1], result: { winner: 'R' }, timestamp: 1 })).toBe(
      stateFingerprint({ board: [1], result: { winner: 'B' }, timestamp: 2 }),
    )
  })

  it('distinguishes different states and actions', () => {
    expect(stateFingerprint({ board: [1] })).not.toBe(stateFingerprint({ board: [2] }))
    expect(stateActionFingerprint({ board: [1] }, actionA)).toBe(
      stateActionFingerprint({ board: [1] }, actionA),
    )
    expect(stateActionFingerprint({ board: [1] }, actionA)).not.toBe(
      stateActionFingerprint({ board: [1] }, actionB),
    )
  })

  it('detects duplicate fingerprints', () => {
    expect(
      findDuplicateFingerprints([{ fingerprint: 'b' }, { fingerprint: 'a' }, { fingerprint: 'b' }]),
    ).toEqual(['b'])
  })

  it('loads exactly four persisted, valid smoke fixtures', () => {
    const fixtures = loadSmokeFixtures()
    expect(fixtures).toHaveLength(4)
    for (const fixture of fixtures) {
      expect(validateStrategicFixture(fixture).turn).toBe(fixture.player)
    }
  })

  it('loads exactly 27 unique, valid pilot fixtures', () => {
    const fixtures = loadPilotFixtures()
    expect(fixtures).toHaveLength(27)
    const fingerprints = fixtures.map((fixture) => {
      expect(validateStrategicFixture(fixture).turn).toBe(fixture.player)
      return stateFingerprint(fixture.state)
    })
    expect(new Set(fingerprints).size).toBe(27)
  })
})
