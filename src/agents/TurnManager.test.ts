import { describe, expect, it, vi } from 'vitest'
import { createElement, StrictMode, useEffect } from 'react'
import { render, waitFor } from '@testing-library/react'
import { makeInitialState } from '@/store/gameState'
import type { PlayerAction } from '@/lib/types'
import type { PlayerAgent } from './PlayerAgent'
import { TurnManager } from './TurnManager'

const action: PlayerAction = { type: 'place', pos: { x: 0, y: 0 } }

function makePendingManager(agent: PlayerAgent, applyAction: (action: PlayerAction) => void) {
  const state = makeInitialState()
  return new TurnManager({
    agents: { R: agent, B: agent },
    getGameState: () => state,
    applyAction,
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
      applyAction: () => {
        applied++
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
      applyAction: () => {
        replacementApplied++
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
