import { describe, expect, it, vi } from 'vitest'
import { HumanAgent } from './HumanAgent'

describe('HumanAgent complete decisions', () => {
  it('resolves an initial placement as one individual decision', async () => {
    const agent = new HumanAgent()
    const pending = agent.getAction()
    agent.submitAction({ type: 'place', pos: { x: 1, y: 2 } })
    await expect(pending).resolves.toEqual({ type: 'place', pos: { x: 1, y: 2 } })
  })

  it('does not resolve a move until its wall completes the human decision', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(175)
    const agent = new HumanAgent()
    const pending = agent.getAction()
    let resolved = false
    void pending.then(() => {
      resolved = true
    })

    agent.beginSelection({ x: 0, y: 0 })
    agent.submitMove({ x: 1, y: 0 })
    await Promise.resolve()
    expect(resolved).toBe(false)

    agent.submitWall({ x: 1, y: 0 }, 'bottom')
    await expect(pending).resolves.toEqual({
      type: 'move',
      from: { x: 0, y: 0 },
      pos: { x: 1, y: 0 },
      followUp: { type: 'wall', pos: { x: 1, y: 0 }, dir: 'bottom' },
    })
    expect(agent.getDecisionDurationMs()).toBe(75)
  })

  it('can explicitly complete a legal move without a wall', async () => {
    const agent = new HumanAgent()
    const pending = agent.getAction()
    agent.beginSelection({ x: 0, y: 0 })
    agent.submitMove({ x: 1, y: 0 })
    agent.submitMoveWithoutWall()
    await expect(pending).resolves.toEqual({
      type: 'move',
      from: { x: 0, y: 0 },
      pos: { x: 1, y: 0 },
    })
  })
})
