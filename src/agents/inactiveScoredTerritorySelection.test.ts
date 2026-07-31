import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  analyzeInactiveScoredMovement,
  chooseInactiveScoredTerritoryCandidate,
} from './inactiveScoredTerritorySelection'

function playing(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function closeTopLeft(state: GameSnapshot, width: number, height: number): void {
  for (let y = 0; y < height; y++) state.board[y][width].wallLeft = 'R'
  for (let x = 0; x < width; x++) state.board[height][x].wallTop = 'R'
}

function p01Turn40() {
  const trace = JSON.parse(
    readFileSync(
      'data/human-experiment/final-2026-v3-r1/participants/P01/traces/game-2.json',
      'utf8',
    ),
  ) as { decisions: Array<Record<string, unknown>> }
  const decision = trace.decisions.find(({ turnIndex }) => turnIndex === 40) as {
    stateBefore: GameSnapshot & { legal: string[] }
    action: PlayerAction
    legalActions: PlayerAction[]
    mcts: {
      originalAction: PlayerAction
      finalAction: PlayerAction
      rootCandidates: Array<{ action: PlayerAction; visits: number; value: number }>
    }
  }
  return {
    decision,
    state: { ...decision.stateBefore, legal: new Set(decision.stateBefore.legal) },
  }
}

describe('inactive scored territory final selection', () => {
  it('replaces the exact defective P01 game 2 turn 40 movement with an active legal candidate', () => {
    const { state, decision } = p01Turn40()
    const result = chooseInactiveScoredTerritoryCandidate({
      state,
      selected: decision.mcts.finalAction,
      candidates: decision.mcts.rootCandidates,
    })

    expect(result).toMatchObject({
      changed: true,
      intervention: true,
      usedFallback: false,
    })
    expect(result.action).not.toEqual(decision.action)
    expect(decision.legalActions).toContainEqual(result.action)
    expect(analyzeInactiveScoredMovement(state, result.action)).toBeUndefined()
  })

  it('does not create artificial movement preference in a one-stone closed component', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    closeTopLeft(state, 1, 2)
    state.board[4][4].stone = 'R'
    state.board[6][6].stone = 'B'
    const legal = getLegalActions(state)
    const internal = legal.find(
      (action) => action.type === 'move' && action.from?.x === 0 && action.from.y === 0,
    )!
    const active = legal.find(
      (action) => action.type === 'move' && action.from?.x === 4 && action.from.y === 4,
    )!
    const result = chooseInactiveScoredTerritoryCandidate({
      state,
      selected: internal,
      candidates: [
        { action: internal, visits: 20, value: 1 },
        { action: active, visits: 10, value: 0 },
      ],
    })
    expect(result.action).toEqual(active)
  })

  it('also removes neutral internal mobility with several own stones', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[1][1].stone = 'R'
    closeTopLeft(state, 3, 3)
    state.board[5][4].stone = 'R'
    state.board[5][5].stone = 'B'
    const internal = getLegalActions(state).find(
      (action) =>
        action.type === 'move' &&
        action.from?.x === 0 &&
        action.from.y === 0 &&
        analyzeInactiveScoredMovement(state, action)?.classification === 'neutral-internal',
    )
    expect(internal).toBeDefined()
  })

  it('keeps movements from an apparently own area connected to active play', () => {
    const state = playing()
    state.board[1][1].stone = 'R'
    state.board[5][5].stone = 'B'
    const movement = getLegalActions(state).find((action) => action.type === 'move')!
    expect(analyzeInactiveScoredMovement(state, movement)).toBeUndefined()
  })

  it('does not classify a closed mixed component as inactive', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    state.board[1][1].stone = 'B'
    closeTopLeft(state, 3, 3)
    const movement = getLegalActions(state).find(
      (action) => action.type === 'move' && action.from?.x === 0 && action.from.y === 0,
    )!
    expect(analyzeInactiveScoredMovement(state, movement)).toBeUndefined()
  })

  it('counterfactually classifies a legitimate territorial loss as harmful, not neutral', () => {
    const state = playing()
    state.board[0][0].stone = 'R'
    closeTopLeft(state, 1, 2)
    state.board[5][4].stone = 'R'
    state.board[5][5].stone = 'B'
    const harmful = getLegalActions(state).find(
      (action) =>
        action.type === 'move' &&
        action.pos.x === 0 &&
        action.pos.y === 1 &&
        action.followUp?.type === 'wall' &&
        action.followUp.dir === 'top',
    )!
    expect(analyzeInactiveScoredMovement(state, harmful)).toMatchObject({
      classification: 'harmful-internal',
      territoryDelta: { R: -1, B: 0 },
    })
  })

  it('keeps actions that can affect defence, threats or terminal play through an active component', () => {
    const state = playing()
    state.board[2][2].stone = 'R'
    state.board[2][4].stone = 'B'
    const defensive = getLegalActions(state).find(
      (action) =>
        action.type === 'move' &&
        action.from?.x === 2 &&
        action.from.y === 2 &&
        action.followUp?.type === 'wall',
    )!
    expect(analyzeInactiveScoredMovement(state, defensive)).toBeUndefined()
  })

  it('uses a deterministic territory-preserving fallback when every candidate is internal', () => {
    const { state } = p01Turn40()
    const internals = getLegalActions(state)
      .filter((action) => analyzeInactiveScoredMovement(state, action))
      .slice(0, 3)
    const candidates = internals.map((action) => ({ action, visits: 5, value: 1 }))
    const first = chooseInactiveScoredTerritoryCandidate({
      state,
      selected: internals[0]!,
      candidates,
    })
    const second = chooseInactiveScoredTerritoryCandidate({
      state,
      selected: internals[0]!,
      candidates,
    })
    expect(first.usedFallback).toBe(true)
    expect(first.action).toEqual(second.action)
    expect(getLegalActions(state)).toContainEqual(first.action)
  })

  it('never returns an illegal action and is deterministic for fixed candidate statistics', () => {
    const { state, decision } = p01Turn40()
    const input = {
      state,
      selected: decision.mcts.finalAction,
      candidates: decision.mcts.rootCandidates,
    }
    const first = chooseInactiveScoredTerritoryCandidate(input)
    const second = chooseInactiveScoredTerritoryCandidate(input)
    expect(first.action).toEqual(second.action)
    expect(getLegalActions(state)).toContainEqual(first.action)
  })

  it('does not change global legal action generation used by other agents and modes', () => {
    const { state } = p01Turn40()
    const before = getLegalActions(state)
    chooseInactiveScoredTerritoryCandidate({
      state,
      selected: before[0]!,
      candidates: before.map((action) => ({ action, visits: 1, value: 0 })),
    })
    expect(getLegalActions(state)).toEqual(before)
  })
})
