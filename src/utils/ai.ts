import type { PlayerAction, GameSnapshot, Cell, Player, Pos, WallDir } from '@/lib/types'
import { isLegalMove } from './move'
import { getLegalWallActions } from './wall'

export function getRandomAction(actions: PlayerAction[] = []): PlayerAction | null {
  if (actions.length === 0) return null
  return actions[Math.floor(Math.random() * actions.length)]
}

export function getRandomWallActionForPlayer(
  state: GameSnapshot,
  player: Player,
): PlayerAction | null {
  const actions: PlayerAction[] = []
  const { board } = state
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (board[y][x].stone !== player) continue
      actions.push(...getLegalWallActions(board, x, y))
    }
  }
  return getRandomAction(actions)
}

export function getLegalDestinations(gameState: GameSnapshot, from: Pos): Pos[] {
  const { board } = gameState
  const destinations: Pos[] = []
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board.length; x++) {
      if (isLegalMove(from, { x, y }, board)) {
        destinations.push({ x, y })
      }
    }
  }
  return destinations
}

export function getLegalActions(gameState: GameSnapshot): PlayerAction[] {
  const { board, turn, phase } = gameState
  const legalActions: PlayerAction[] = []
  if (phase === 'placing') {
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board.length; x++) {
        if (!board[y][x].stone) legalActions.push({ type: 'place', pos: { x, y } })
      }
    }
  } else if (phase === 'playing') {
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board.length; x++) {
        if (board[y][x].stone !== turn) continue // 只考慮自己的棋子
        // 移動+建牆

        getLegalDestinations(gameState, { x, y }).forEach((pos) => {
          for (const wallAction of getLegalWallActions(board, pos.x, pos.y)) {
            legalActions.push({
              type: 'move',
              from: { x, y },
              pos: { x: pos.x, y: pos.y },
              followUp: wallAction,
            })
          }
        })
        // 原地建牆
        legalActions.push(...getLegalWallActions(board, x, y))
      }
    }
  }
  return legalActions
}

export function placeScore(board: Cell[][], x: number, y: number, me: Player): number {
  const opp = me === 'R' ? 'B' : 'R'

  // 1. 中心
  const central = 3 - Math.max(Math.abs(x - 3), Math.abs(y - 3))

  // 2. 與己子形成短牆
  let cut = 0
  let oppBlock = 0
  board.forEach((row, yy) =>
    row.forEach((c, xx) => {
      if (c.stone === me) {
        if ((xx === x && Math.abs(yy - y) <= 2) || (yy === y && Math.abs(xx - x) <= 2)) cut = 2
      } else if (c.stone === opp) {
        if ((xx === x && Math.abs(yy - y) <= 2) || (yy === y && Math.abs(xx - x) <= 2)) oppBlock = 2
      }
    }),
  )

  // 3. Edge penalty (自己)
  const edge = -(Number(x === 0 || x === 6) + Number(y === 0 || y === 6))

  // 4. CornerPressure：如果對手子距角≤2，我放在同角方向+分
  let cornerP = 0
  board.forEach((row, yy) =>
    row.forEach((c, xx) => {
      if (c.stone === opp) {
        const d = Math.min(xx + yy, xx + 6 - yy, 6 - xx + yy, 12 - xx - yy)
        cornerP += Math.max(0, 2 - d) // 角=2, 邊下一格=1, 其他=0
      }
    }),
  )
  // scale down
  cornerP = Math.min(2, cornerP)

  return 3 * central + 4 * cut + 2 * oppBlock + 1 * cornerP + 1 * edge
}

export function getBestPlacement(state: GameSnapshot): PlayerAction {
  const { board, turn } = state
  let best = -Infinity
  const cands: { x: number; y: number }[] = []

  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if (board[y][x].stone) continue // 已佔
      const s = placeScore(board, x, y, turn)
      if (s > best) {
        best = s
        cands.length = 0
        cands.push({ x, y })
      } else if (s === best) cands.push({ x, y })
    }
  }
  // 同分隨機
  const pick = cands[Math.floor(Math.random() * cands.length)]
  return { type: 'place', pos: pick }
}

// 行動
// 複製遊戲狀態（淺拷貝，僅用於模擬）
export function getBestHeuristicAction(state: GameSnapshot): PlayerAction | null {
  const actions = getLegalActions(state)
  if (actions.length === 0) return null

  let best = -Infinity
  const bestActions: PlayerAction[] = []

  for (const action of actions) {
    const score = scoreHeuristicAction(state, action)
    if (score > best) {
      best = score
      bestActions.length = 0
      bestActions.push(action)
    } else if (score === best) {
      bestActions.push(action)
    }
  }

  return getRandomAction(bestActions)
}

function scoreHeuristicAction(state: GameSnapshot, action: PlayerAction): number {
  if (action.type === 'place') {
    return placeScore(state.board, action.pos.x, action.pos.y, state.turn)
  }

  const nextBoard = applyActionToBoard(state.board, state.turn, action)
  const activePos = action.type === 'move' ? action.pos : (action.from ?? action.pos)
  const freeAround = countFreeAdjacentSpaces(nextBoard, activePos)
  const wallAction =
    action.type === 'wall' ? action : action.followUp?.type === 'wall' ? action.followUp : null

  let score = freeAround * 7 + centrality(nextBoard.length, activePos) * 1.5

  if (freeAround === 0) score -= 35
  else if (freeAround === 1) score -= 14

  if (wallAction?.dir) {
    const distance = nearestOpponentDistance(nextBoard, state.turn, wallAction.pos)
    score += Math.max(0, 8 - distance * 2)
    score -= distance
    if (wallTouchesOpponent(nextBoard, state.turn, wallAction.pos, wallAction.dir)) score += 10
  }

  return score
}

function applyActionToBoard(board: Cell[][], player: Player, action: PlayerAction): Cell[][] {
  const nextBoard = board.map((row) => row.map((cell) => ({ ...cell })))

  const apply = (current: PlayerAction) => {
    if (current.type === 'place') {
      nextBoard[current.pos.y][current.pos.x].stone = player
    } else if (current.type === 'move' && current.from) {
      nextBoard[current.from.y][current.from.x].stone = null
      nextBoard[current.pos.y][current.pos.x].stone = player
    } else if (current.type === 'wall' && current.dir) {
      placeWallOnBoard(nextBoard, current.pos, current.dir, player)
    }

    if (current.followUp) apply(current.followUp)
  }

  apply(action)
  return nextBoard
}

function placeWallOnBoard(board: Cell[][], pos: Pos, dir: WallDir, player: Player): void {
  if (dir === 'top') board[pos.y][pos.x].wallTop = player
  if (dir === 'left') board[pos.y][pos.x].wallLeft = player
  if (dir === 'right') board[pos.y][pos.x + 1].wallLeft = player
  if (dir === 'bottom') board[pos.y + 1][pos.x].wallTop = player
}

function countFreeAdjacentSpaces(board: Cell[][], pos: Pos): number {
  return getAdjacentPositions(board, pos).filter(
    (next) => !board[next.y][next.x].stone && !hasWallBetween(board, pos, next),
  ).length
}

function getAdjacentPositions(board: Cell[][], pos: Pos): Pos[] {
  const size = board.length
  return [
    { x: pos.x + 1, y: pos.y },
    { x: pos.x - 1, y: pos.y },
    { x: pos.x, y: pos.y + 1 },
    { x: pos.x, y: pos.y - 1 },
  ].filter((next) => next.x >= 0 && next.y >= 0 && next.x < size && next.y < size)
}

function hasWallBetween(board: Cell[][], from: Pos, to: Pos): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y

  if (dx === 1) return board[from.y][from.x + 1].wallLeft !== null
  if (dx === -1) return board[from.y][from.x].wallLeft !== null
  if (dy === 1) return board[from.y + 1][from.x].wallTop !== null
  if (dy === -1) return board[from.y][from.x].wallTop !== null
  return true
}

function centrality(size: number, pos: Pos): number {
  const center = (size - 1) / 2
  return center - Math.max(Math.abs(pos.x - center), Math.abs(pos.y - center))
}

function nearestOpponentDistance(board: Cell[][], me: Player, pos: Pos): number {
  let nearest = board.length * 2

  board.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell.stone && cell.stone !== me) {
        nearest = Math.min(nearest, Math.abs(pos.x - x) + Math.abs(pos.y - y))
      }
    }),
  )

  return nearest
}

function wallTouchesOpponent(board: Cell[][], me: Player, pos: Pos, dir: WallDir): boolean {
  const target =
    dir === 'right'
      ? { x: pos.x + 1, y: pos.y }
      : dir === 'left'
        ? { x: pos.x - 1, y: pos.y }
        : dir === 'bottom'
          ? { x: pos.x, y: pos.y + 1 }
          : { x: pos.x, y: pos.y - 1 }

  return board[target.y]?.[target.x]?.stone !== null && board[target.y]?.[target.x]?.stone !== me
}
export function cloneGameState(state: GameSnapshot): GameSnapshot {
  return JSON.parse(JSON.stringify(state))
}

// 模擬執行 action，回傳新狀態（僅處理棋子/牆，忽略複雜規則）
export function applyAction(state: GameSnapshot, action: PlayerAction): GameSnapshot {
  const newState = cloneGameState(state)
  const { board, turn } = newState
  if (action.type === 'place') {
    board[action.pos.y][action.pos.x].stone = turn
  } else if (action.type === 'move' && action.from) {
    board[action.from.y][action.from.x].stone = null
    board[action.pos.y][action.pos.x].stone = turn
    if (action.followUp) {
      return applyAction(newState, action.followUp)
    }
  } else if (action.type === 'wall' && action.dir) {
    if (action.dir === 'top') board[action.pos.y][action.pos.x].wallTop = turn
    if (action.dir === 'left') board[action.pos.y][action.pos.x].wallLeft = turn
    if (action.dir === 'right') board[action.pos.y][action.pos.x + 1].wallLeft = turn
    if (action.dir === 'bottom') board[action.pos.y + 1][action.pos.x].wallTop = turn
  }
  // 換手
  newState.turn = turn === 'R' ? 'B' : 'R'
  return newState
}
