import { describe, expect, it, vi } from 'vitest'
import { createElement, StrictMode, useEffect } from 'react'
import { render, waitFor } from '@testing-library/react'
import { makeInitialState } from '@/store/gameState'
import type { PlayerAction } from '@/lib/types'
import type { PlayerAgent } from './PlayerAgent'
import { TurnManager, type TurnDecisionTrace } from './TurnManager'
import { applyFullAction } from '@/engine/gameSimulator'

const action: PlayerAction = { type: 'place', pos: { x: 0, y: 0 } }

function makePendingManager(agent: PlayerAgent, applyAction: (action: PlayerAction) => void) {
  const state = makeInitialState()
  return new TurnManager({
    agents: { R: agent, B: agent },
    getGameState: () => state,
    applyAction: (nextAction, transition) => {
      applyAction(nextAction)
      return transition.stateAfter
    },
    isGameOver: () => false,
    turnTimeLimit: 60_000,
  })
}

describe('TurnManager lifecycle', () => {
  it('cleans up the first effect during a real React Strict Mode double mount', async () => {
    const cancelCalls: Array<ReturnType<typeof vi.fn>> = []
    const applyAction = vi.fn()

    function StrictModeHarness() {
      useEffect(() => {
        const cancel = vi.fn()
        cancelCalls.push(cancel)
        const manager = makePendingManager(
          {
            getAction: () => new Promise(() => undefined),
            cancel,
          },
          applyAction,
        )
        void manager.startLoop()
        return () => manager.stop()
      }, [])
      return null
    }

    const mounted = render(createElement(StrictMode, null, createElement(StrictModeHarness)))
    await waitFor(() => expect(cancelCalls).toHaveLength(2))

    expect(cancelCalls[0]).toHaveBeenCalledOnce()
    expect(cancelCalls[1]).not.toHaveBeenCalled()
    expect(applyAction).not.toHaveBeenCalled()

    mounted.unmount()
    expect(cancelCalls[1]).toHaveBeenCalledOnce()
  })

  it('starts only one automatic loop when startLoop is called twice', async () => {
    let applied = 0
    const getAction = vi.fn(async () => action)
    const state = makeInitialState()
    const manager = new TurnManager({
      agents: { R: { getAction }, B: { getAction } },
      getGameState: () => state,
      applyAction: (_nextAction, transition) => {
        applied++
        return transition.stateAfter
      },
      isGameOver: () => applied === 1,
    })

    const first = manager.startLoop()
    const second = manager.startLoop()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(getAction).toHaveBeenCalledOnce()
    expect(applied).toBe(1)
  })

  it('stops the discarded Strict Mode loop before a replacement starts', async () => {
    let resolveDiscarded!: (value: PlayerAction) => void
    const discardedAgent: PlayerAgent = {
      getAction: () =>
        new Promise((resolve) => {
          resolveDiscarded = resolve
        }),
      cancel: vi.fn(),
    }
    const discardedApply = vi.fn()
    const discarded = makePendingManager(discardedAgent, discardedApply)
    const discardedLoop = discarded.startLoop()

    discarded.stop()
    await discardedLoop
    resolveDiscarded(action)
    await Promise.resolve()

    let replacementApplied = 0
    const replacementState = makeInitialState()
    const replacement = new TurnManager({
      agents: {
        R: { getAction: async () => action },
        B: { getAction: async () => action },
      },
      getGameState: () => replacementState,
      applyAction: (_nextAction, transition) => {
        replacementApplied++
        return transition.stateAfter
      },
      isGameOver: () => replacementApplied === 1,
    })
    await replacement.startLoop()

    expect(discardedAgent.cancel).toHaveBeenCalledOnce()
    expect(discardedApply).not.toHaveBeenCalled()
    expect(replacementApplied).toBe(1)
  })

  it('does not apply a pending action after a game is reinitialized and stopped', async () => {
    let resolveAction!: (value: PlayerAction) => void
    const applyAction = vi.fn()
    const manager = makePendingManager(
      {
        getAction: () =>
          new Promise((resolve) => {
            resolveAction = resolve
          }),
      },
      applyAction,
    )
    const loop = manager.startLoop()

    manager.stop()
    resolveAction(action)
    await loop

    expect(applyAction).not.toHaveBeenCalled()
  })
})

describe('TurnManager atomic transitions', () => {
  it('commits and records the same local engine transition when state is unchanged', async () => {
    let state = makeInitialState()
    let recorded: TurnDecisionTrace | undefined
    const manager = new TurnManager({
      agents: { R: { getAction: async () => action }, B: { getAction: async () => action } },
      getGameState: () => state,
      applyAction: (_nextAction, transition) => {
        state = structuredClone(transition.stateAfter)
        state.legal = new Set(transition.stateAfter.legal)
        return state
      },
      isGameOver: () => recorded !== undefined,
      onDecision: (decision) => {
        recorded = decision
      },
    })

    await manager.startLoop()
    expect(recorded).toMatchObject({ stateAfter: state })
    expect(state).toEqual(applyFullAction(makeInitialState(), action).state)
  })

  it.each(['undo', 'redo', 'reset'])(
    'rejects a %s-like state replacement while an agent is awaiting',
    async () => {
      let state = applyFullAction(makeInitialState(), action).state
      let resolveAction!: (value: PlayerAction) => void
      const manager = new TurnManager({
        agents: {
          R: { getAction: async () => action },
          B: { getAction: () => new Promise((resolve) => (resolveAction = resolve)) },
        },
        getGameState: () => state,
        applyAction: vi.fn((_nextAction, transition) => transition.stateAfter),
        isGameOver: () => false,
      })
      const loop = manager.startLoop()
      await Promise.resolve()
      state = makeInitialState()
      resolveAction({ type: 'place', pos: { x: 1, y: 0 } })

      await expect(loop).rejects.toThrow('game state changed while the agent was deciding')
    },
  )

  it('reproduces and rejects the P01-1 interleaving before applying the MCTS action', async () => {
    let state = applyFullAction(makeInitialState(), { type: 'place', pos: { x: 3, y: 1 } }).state
    let resolveAction!: (value: PlayerAction) => void
    const applyAction = vi.fn()
    const onDecision = vi.fn()
    const manager = new TurnManager({
      agents: {
        R: { getAction: async () => action },
        B: { getAction: () => new Promise((resolve) => (resolveAction = resolve)) },
      },
      getGameState: () => state,
      applyAction,
      isGameOver: () => false,
      onDecision,
    })
    const loop = manager.startLoop()
    await Promise.resolve()
    state = applyFullAction(makeInitialState(), { type: 'place', pos: { x: 4, y: 4 } }).state
    resolveAction({ type: 'place', pos: { x: 4, y: 4 } })

    await expect(loop).rejects.toThrow('game state changed while the agent was deciding')
    expect(applyAction).not.toHaveBeenCalled()
    expect(onDecision).not.toHaveBeenCalled()
  })

  it('rejects a commit adapter that turns the selected action into a no-op', async () => {
    const state = makeInitialState()
    const manager = new TurnManager({
      agents: { R: { getAction: async () => action }, B: { getAction: async () => action } },
      getGameState: () => state,
      applyAction: () => state,
      isGameOver: () => false,
    })
    await expect(manager.startLoop()).rejects.toThrow('committed state does not match')
  })

  it('keeps deep immutable snapshots after the store is mutated later', async () => {
    let state = makeInitialState()
    let recorded: TurnDecisionTrace | undefined
    const manager = new TurnManager({
      agents: { R: { getAction: async () => action }, B: { getAction: async () => action } },
      getGameState: () => state,
      applyAction: (_nextAction, transition) => {
        state = transition.stateAfter
        return state
      },
      isGameOver: () => recorded !== undefined,
      onDecision: (decision) => {
        recorded = decision
      },
    })
    await manager.startLoop()
    state.board[0][0].stone = 'B'
    expect(recorded).toBeDefined()
    expect(recorded!.stateBefore.board[0][0].stone).toBe(null)
    expect(recorded!.stateAfter.board[0][0].stone).toBe('R')
  })
})
