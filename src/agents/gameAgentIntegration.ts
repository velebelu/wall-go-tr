import type { PlayerAction, Pos, WallDir } from '@/lib/types'

export interface GameActionHandlers {
  placeStone: (pos: Pos) => void
  selectStone: (pos: Pos) => void
  moveTo: (pos: Pos) => void
  buildWall: (pos: Pos, direction: WallDir) => void
}

function assertPosition(value: unknown, field: string): asserts value is Pos {
  const position = value as Partial<Pos> | undefined
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error(`Acción de agente incompleta: falta una posición válida en ${field}.`)
  }
}

export function applyAgentActionToGame(action: PlayerAction, handlers: GameActionHandlers): void {
  switch (action.type) {
    case 'place':
      assertPosition(action.pos, 'pos')
      handlers.placeStone(action.pos)
      return
    case 'move':
      assertPosition(action.pos, 'pos')
      if (action.from) {
        assertPosition(action.from, 'from')
        handlers.selectStone(action.from)
      }
      handlers.moveTo(action.pos)
      return
    case 'wall':
      assertPosition(action.pos, 'pos')
      if (action.from) {
        assertPosition(action.from, 'from')
        handlers.selectStone(action.from)
      }
      if (!action.dir) {
        throw new Error('Acción de agente incompleta: una acción wall requiere dirección.')
      }
      handlers.buildWall(action.pos, action.dir)
      return
    default:
      throw new Error(
        `Tipo de acción de agente no soportado: ${String((action as { type?: unknown }).type)}`,
      )
  }
}
