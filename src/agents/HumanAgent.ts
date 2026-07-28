// Human player agent, waits for UI input
import type { PlayerAgent } from './PlayerAgent'
import type { PlayerAction, Pos, WallDir } from '@/lib/types'

export class HumanAgent implements PlayerAgent {
  private actionResolver: ((action: PlayerAction) => void) | null = null
  private waiting = false
  private selectedFrom?: Pos
  private movedTo?: Pos
  private selectionStartedAt?: number
  private lastDecisionDurationMs?: number
  private readonly partiallyAppliedActions = new WeakSet<PlayerAction>()

  // Called by UI to submit player action
  submitAction(action: PlayerAction) {
    if (this.waiting && this.actionResolver) {
      this.actionResolver(action)
      this.actionResolver = null
      this.waiting = false
    }
  }

  beginSelection(from: Pos): void {
    if (!this.waiting) return
    this.selectedFrom = { ...from }
    this.movedTo = undefined
    this.selectionStartedAt = performance.now()
  }

  submitMove(to: Pos): void {
    if (!this.waiting || !this.selectedFrom) return
    this.movedTo = { ...to }
  }

  submitWall(pos: Pos, dir: WallDir): void {
    if (!this.waiting || !this.actionResolver || !this.selectedFrom) return
    const action: PlayerAction = this.movedTo
      ? {
          type: 'move',
          from: { ...this.selectedFrom },
          pos: { ...this.movedTo },
          followUp: { type: 'wall', pos: { ...pos }, dir },
        }
      : {
          type: 'wall',
          from: { ...this.selectedFrom },
          pos: { ...pos },
          dir,
        }
    if (this.movedTo) this.partiallyAppliedActions.add(action)
    this.lastDecisionDurationMs =
      this.selectionStartedAt === undefined
        ? undefined
        : performance.now() - this.selectionStartedAt
    this.resolve(action)
  }

  submitMoveWithoutWall(): void {
    if (!this.waiting || !this.actionResolver || !this.selectedFrom || !this.movedTo) return
    const action: PlayerAction = {
      type: 'move',
      from: { ...this.selectedFrom },
      pos: { ...this.movedTo },
    }
    this.partiallyAppliedActions.add(action)
    this.lastDecisionDurationMs =
      this.selectionStartedAt === undefined
        ? undefined
        : performance.now() - this.selectionStartedAt
    this.resolve(action)
  }

  consumePartiallyAppliedAction(action: PlayerAction): boolean {
    if (!this.partiallyAppliedActions.has(action)) return false
    this.partiallyAppliedActions.delete(action)
    return true
  }

  getDecisionDurationMs(): number | undefined {
    return this.lastDecisionDurationMs
  }

  private resolve(action: PlayerAction): void {
    this.actionResolver?.(action)
    this.actionResolver = null
    this.waiting = false
    this.selectedFrom = undefined
    this.movedTo = undefined
    this.selectionStartedAt = undefined
  }

  // Called by main game loop, waits for player action
  getAction(): Promise<PlayerAction> {
    this.waiting = true
    this.lastDecisionDurationMs = undefined
    return new Promise<PlayerAction>((resolve) => {
      this.actionResolver = resolve
    })
  }

  cancel() {
    if (this.waiting) {
      this.actionResolver = null
      this.waiting = false
      this.selectedFrom = undefined
      this.movedTo = undefined
      this.selectionStartedAt = undefined
    }
  }
}
