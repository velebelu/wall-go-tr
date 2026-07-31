import { describe, expect, it } from 'vitest'
import { getLegalActions } from '@/utils/ai'
import {
  makeInternalWallLossFixture,
  makeInternalWallNeutralFixture,
} from '@/fixtures/internalWall'
import {
  analyzeInternalWallAction,
  chooseImmediateLossSafeWall,
} from './inactiveInternalWallActions'

describe('inactive internal wall diagnostic', () => {
  it('detects a wall that immediately removes own territory', () => {
    const state = makeInternalWallLossFixture()
    const action = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'wall' &&
        candidate.dir === 'right' &&
        candidate.pos.x === 1 &&
        candidate.pos.y === 1,
    )!
    const result = analyzeInternalWallAction(state, action)
    expect(result.strictlyInternal).toBe(true)
    expect(result.immediateTerritoryLoss).toBeGreaterThan(0)
    expect(result.emptySubregionCreated).toBe(true)
    expect(result.reasons).toContain('immediate-own-territory-loss')
  })

  it('keeps a neutral internal wall distinct from an immediately harmful wall', () => {
    const state = makeInternalWallNeutralFixture()
    const action = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'wall' &&
        candidate.dir === 'right' &&
        candidate.pos.x === 1 &&
        candidate.pos.y === 1,
    )!
    const result = analyzeInternalWallAction(state, action)
    expect(result.strictlyInternal).toBe(true)
    expect(result.immediateTerritoryLoss).toBe(0)
    expect(result.territoryPreserved).toBe(true)
  })

  it('uses the restrictive A fallback without removing every wall', () => {
    const state = makeInternalWallLossFixture()
    const walls = getLegalActions(state).filter((action) => action.type === 'wall')
    const choice = chooseImmediateLossSafeWall(state, walls)
    expect(choice.action).toBeDefined()
    expect(choice.fallback).toBe(false)
  })

  it('rejects a visually internal wall when the component contains a rival', () => {
    const state = makeInternalWallNeutralFixture()
    state.board[1][2].stone = 'R'
    const action = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'wall' &&
        candidate.dir === 'right' &&
        candidate.pos.x === 1 &&
        candidate.pos.y === 1,
    )!
    expect(analyzeInternalWallAction(state, action).strictlyInternal).toBe(false)
  })

  it('rejects a visually internal wall at an active frontier', () => {
    const state = makeInternalWallNeutralFixture()
    state.board[0][3].wallLeft = null
    state.board[0][3].stone = 'R'
    const action = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'wall' &&
        candidate.dir === 'right' &&
        candidate.pos.x === 1 &&
        candidate.pos.y === 1,
    )!
    const diagnostic = analyzeInternalWallAction(state, action)
    expect(diagnostic.strictlyInternal).toBe(false)
    expect(diagnostic.reasons).toContain('component-is-not-own-only')
  })

  it('falls back when the only candidate is immediately harmful', () => {
    const state = makeInternalWallLossFixture()
    const harmful = getLegalActions(state).find(
      (candidate) =>
        candidate.type === 'wall' &&
        candidate.dir === 'right' &&
        candidate.pos.x === 1 &&
        candidate.pos.y === 1,
    )!
    const choice = chooseImmediateLossSafeWall(state, [harmful])
    expect(choice.action).toEqual(harmful)
    expect(choice.fallback).toBe(true)
  })
})
