import { beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import {
  makeNoActionFixture,
  makeNonTerminalWallOnlyTurnFixture,
  makeWallOnlyTurnFixture,
} from '@/fixtures/wallOnlyTurn'
import { choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import { applyFullAction } from '@/engine/gameSimulator'
import { snapshotFromState } from '@/store/gameState'
import { useGame } from '@/store'
import { getLegalActions } from './ai'
import { checkGameEnd } from './game'
import { getTerritoryMap } from './territory'

describe('wall-only turns', () => {
  beforeEach(() => {
    const state = makeNonTerminalWallOnlyTurnFixture()
    useGame.setState({
      ...state,
      _history: [snapshotFromState(state)],
      _future: [],
      canUndo: false,
      canRedo: false,
    })
  })

  it('generates walls for an immobile piece in a non-terminal disputed position', () => {
    const state = makeNonTerminalWallOnlyTurnFixture('B')
    const legal = getLegalActions(state)

    expect(legal.filter((action) => action.type === 'move')).toHaveLength(0)
    expect(
      legal.some((action) => action.type === 'wall' && action.from?.x === 0 && action.from.y === 0),
    ).toBe(true)
    expect(checkGameEnd(state.board, state.players).finished).toBe(false)
    expect(
      getTerritoryMap(state.board)
        .flat()
        .some((owner) => owner === null),
    ).toBe(true)
  })

  it('lets the human select and place a wall without moving', () => {
    act(() => useGame.getState().selectStone({ x: 0, y: 0 }))
    expect(useGame.getState().legal).toContain('wall:0,0:right')
    act(() => useGame.getState().buildWall({ x: 0, y: 0 }, 'right'))
    expect(useGame.getState().board[0][1].wallLeft).toBe('B')
  })

  it('lets MCTS select a legal wall action', () => {
    const state = makeNonTerminalWallOnlyTurnFixture('B')
    const action = choosePlayableMCTSAction({
      gameState: state,
      config: { ...FINAL_MCTS_CONFIG, simulations: 4, tacticalVerification: false },
      seed: 123,
    })
    expect(action.type).toBe('wall')
    expect(getLegalActions(state)).toContainEqual(action)
  })

  it('preserves the original terminal fixture behavior', () => {
    const state = makeWallOnlyTurnFixture('B')
    expect(checkGameEnd(state.board, state.players).finished).toBe(true)
    const action = getLegalActions(state).find((candidate) => candidate.type === 'wall')!
    const next = applyFullAction(state, action).state
    expect(next.phase).toBe('finished')
    expect(next.result?.finished).toBe(true)
  })

  it('finishes when neither player can move nor place a wall', () => {
    const state = makeNoActionFixture()
    expect(getLegalActions(state)).toHaveLength(0)
    expect(checkGameEnd(state.board, state.players).finished).toBe(true)
  })

  it('uses the same legal wall list for UI selection and agents', () => {
    const state = makeNonTerminalWallOnlyTurnFixture('B')
    const agentWalls = getLegalActions(state)
      .filter((action) => action.type === 'wall' && action.from?.x === 0 && action.from.y === 0)
      .map((action) => `wall:${action.pos.x},${action.pos.y}:${action.dir}`)
      .sort()
    act(() => useGame.getState().selectStone({ x: 0, y: 0 }))
    const uiWalls = [...useGame.getState().legal].filter((key) => key.startsWith('wall:')).sort()
    expect(uiWalls).toEqual(agentWalls)
  })
})
