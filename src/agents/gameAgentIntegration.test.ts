import { describe, expect, it, vi } from 'vitest'
import type { PlayerAction } from '@/lib/types'
import { applyAgentActionToGame, type GameActionHandlers } from './gameAgentIntegration'

function handlers(): GameActionHandlers {
  return {
    placeStone: vi.fn(),
    selectStone: vi.fn(),
    moveTo: vi.fn(),
    buildWall: vi.fn(),
  }
}

describe('applyAgentActionToGame', () => {
  it('aplica place una sola vez y no llama a otros handlers', () => {
    const target = handlers()
    applyAgentActionToGame({ type: 'place', pos: { x: 1, y: 2 } }, target)
    expect(target.placeStone).toHaveBeenCalledOnce()
    expect(target.placeStone).toHaveBeenCalledWith({ x: 1, y: 2 })
    expect(target.selectStone).not.toHaveBeenCalled()
    expect(target.moveTo).not.toHaveBeenCalled()
    expect(target.buildWall).not.toHaveBeenCalled()
  })

  it('aplica move y llama una sola vez a selección y movimiento', () => {
    const target = handlers()
    applyAgentActionToGame({ type: 'move', from: { x: 1, y: 1 }, pos: { x: 2, y: 1 } }, target)
    expect(target.selectStone).toHaveBeenCalledOnce()
    expect(target.selectStone).toHaveBeenCalledWith({ x: 1, y: 1 })
    expect(target.moveTo).toHaveBeenCalledOnce()
    expect(target.moveTo).toHaveBeenCalledWith({ x: 2, y: 1 })
    expect(target.placeStone).not.toHaveBeenCalled()
    expect(target.buildWall).not.toHaveBeenCalled()
  })

  it('aplica wall y llama una sola vez a selección y construcción', () => {
    const target = handlers()
    applyAgentActionToGame(
      {
        type: 'wall',
        from: { x: 2, y: 1 },
        pos: { x: 2, y: 1 },
        dir: 'bottom',
      },
      target,
    )
    expect(target.selectStone).toHaveBeenCalledOnce()
    expect(target.buildWall).toHaveBeenCalledOnce()
    expect(target.buildWall).toHaveBeenCalledWith({ x: 2, y: 1 }, 'bottom')
    expect(target.placeStone).not.toHaveBeenCalled()
    expect(target.moveTo).not.toHaveBeenCalled()
  })

  it('rechaza acciones incompletas y tipos no soportados sin llamar handlers', () => {
    const target = handlers()
    expect(() => applyAgentActionToGame({ type: 'wall', pos: { x: 2, y: 1 } }, target)).toThrow(
      /wall requiere dirección/,
    )
    expect(() =>
      applyAgentActionToGame({ type: 'move', pos: undefined } as unknown as PlayerAction, target),
    ).toThrow(/posición válida en pos/)
    expect(() =>
      applyAgentActionToGame(
        { type: 'jump', pos: { x: 0, y: 0 } } as unknown as PlayerAction,
        target,
      ),
    ).toThrow(/no soportado: jump/)
    expect(target.placeStone).not.toHaveBeenCalled()
    expect(target.selectStone).not.toHaveBeenCalled()
    expect(target.moveTo).not.toHaveBeenCalled()
    expect(target.buildWall).not.toHaveBeenCalled()
  })
})
