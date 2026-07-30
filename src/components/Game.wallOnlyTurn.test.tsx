import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Game from './Game'
import {
  makeNonTerminalWallOnlyTurnFixture,
  makeSingleActionTurnFixture,
} from '@/fixtures/wallOnlyTurn'
import { makeInitialState } from '@/store/gameState'
import { useGame } from '@/store'
import { checkGameEnd } from '@/utils/game'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOptions?: string | { defaultValue?: string }) =>
      typeof fallbackOrOptions === 'string'
        ? fallbackOrOptions
        : (fallbackOrOptions?.defaultValue ?? _key),
  }),
}))

describe('Game wall-only UI flow', () => {
  beforeEach(() => {
    const initial = makeInitialState()
    useGame.setState({
      ...initial,
      _history: [],
      _future: [],
      canUndo: false,
      canRedo: false,
      humanSide: null,
    })
    Element.prototype.animate = vi.fn()
  })

  afterEach(() => {
    useGame.getState().resetGame()
  })

  it('selects an immobile blue stone and builds a wall through real UI clicks', async () => {
    const fixture = makeNonTerminalWallOnlyTurnFixture('B')
    const view = render(
      <Game
        gameMode="pvp"
        aiSide="R"
        aiLevel="practice"
        setGameMode={vi.fn()}
        setShowRule={vi.fn()}
        dark={false}
        setDark={vi.fn()}
        developmentFixture={fixture}
      />,
    )
    await act(async () => {
      await Promise.resolve()
    })

    const stone = await screen.findByRole('button', { name: 'Blue stone at A7' })
    await act(async () => fireEvent.click(stone))

    expect(useGame.getState().selected).toEqual({ x: 0, y: 0 })
    expect(stone.getAttribute('aria-pressed')).toBe('true')
    const wall = await screen.findByRole('button', { name: 'Build right wall at (0,0)' })

    await act(async () => fireEvent.click(wall))

    await waitFor(() => {
      expect(useGame.getState().board[0][1].wallLeft).toBe('B')
      expect(useGame.getState().turn).toBe('R')
    })
    expect(useGame.getState().phase).toBe('playing')
    expect(useGame.getState().selected).toBeUndefined()
    expect(screen.queryByRole('button', { name: /^Move to / })).toBeNull()
    await act(async () => view.unmount())
  })

  it('allows exactly one move, removes every destination, and finishes a simple move', async () => {
    const fixture = makeSingleActionTurnFixture('B')
    const view = render(
      <Game
        gameMode="pvp"
        aiSide="R"
        aiLevel="practice"
        setGameMode={vi.fn()}
        setShowRule={vi.fn()}
        dark={false}
        setDark={vi.fn()}
        developmentFixture={fixture}
      />,
    )
    await act(async () => Promise.resolve())

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Blue stone at D4' })))
    const staleSecondDestination = screen.getByRole('button', { name: 'Move to E4' })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move to D3' })))

    expect(useGame.getState().board[4][3].stone).toBe('B')
    expect(screen.queryByRole('button', { name: /^Move to / })).toBeNull()
    await act(async () => {
      fireEvent.click(staleSecondDestination)
      fireEvent.click(staleSecondDestination)
    })
    expect(useGame.getState().board[4][3].stone).toBe('B')

    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Finish turn without wall' })),
    )
    await waitFor(() => expect(useGame.getState().turn).toBe('R'))
    expect(useGame.getState().selected).toBeUndefined()
    expect(useGame.getState().stepsTaken).toBe(0)
    await act(async () => view.unmount())
  })

  it('allows only walls after one move and ends the turn after the wall', async () => {
    const fixture = makeSingleActionTurnFixture('B')
    const view = render(
      <Game
        gameMode="pvp"
        aiSide="R"
        aiLevel="practice"
        setGameMode={vi.fn()}
        setShowRule={vi.fn()}
        dark={false}
        setDark={vi.fn()}
        developmentFixture={fixture}
      />,
    )
    await act(async () => Promise.resolve())

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Blue stone at D4' })))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move to D3' })))

    expect(screen.queryByRole('button', { name: /^Move to / })).toBeNull()
    const wall = screen.getByRole('button', { name: 'Build right wall at (3,4)' })
    await act(async () => {
      fireEvent.click(wall)
      fireEvent.click(wall)
    })

    await waitFor(() => expect(useGame.getState().turn).toBe('R'))
    expect(useGame.getState().board[4][4].wallLeft).toBe('B')
    expect(useGame.getState().selected).toBeUndefined()
    expect(useGame.getState().legal.size).toBe(0)
    await act(async () => view.unmount())
  })

  it('does not accept clicks in a terminal position', async () => {
    const fixture = makeNonTerminalWallOnlyTurnFixture('B')
    fixture.phase = 'finished'
    fixture.result = { ...checkGameEnd(fixture.board, fixture.players), finished: true, tie: true }
    const before = structuredClone(fixture.board)
    const view = render(
      <Game
        gameMode="pvp"
        aiSide="R"
        aiLevel="practice"
        setGameMode={vi.fn()}
        setShowRule={vi.fn()}
        dark={false}
        setDark={vi.fn()}
        developmentFixture={fixture}
      />,
    )
    await act(async () => Promise.resolve())

    fireEvent.click(screen.getByRole('button', { name: 'Blue stone at A7' }))
    expect(useGame.getState().board).toEqual(before)
    expect(useGame.getState().selected).toBeUndefined()
    expect(screen.queryByRole('button', { name: /^Move to / })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Build / })).toBeNull()
    await act(async () => view.unmount())
  })
})
