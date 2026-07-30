import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Navbar from './Navbar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

describe('Navbar official-session controls', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => container.remove())

  it('disables undo and redo even when history is available', () => {
    const root = createRoot(container)
    act(() => {
      root.render(
        <Navbar
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          canUndo
          canRedo
          historyDisabled
          onHome={vi.fn()}
          phase="playing"
          dark={false}
          setDark={vi.fn()}
        />,
      )
    })

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(
      true,
    )
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled).toBe(
      true,
    )
    act(() => root.unmount())
  })
})
