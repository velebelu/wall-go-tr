import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Game from './Game'
import { makeNonTerminalWallOnlyTurnFixture } from '@/fixtures/wallOnlyTurn'
import { makeInitialState } from '@/store/gameState'
import { useGame } from '@/store'

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
    await act(async () => view.unmount())
  })
})
