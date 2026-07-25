import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GameModeMenu from './GameModeMenu'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

describe('GameModeMenu Q5', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    })
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => container.remove())

  it('muestra IA aprendiz Q5 en el menú y permite elegir ambos colores', () => {
    const setMode = vi.fn()
    const setAiSide = vi.fn()
    const root = createRoot(container)
    act(() => {
      root.render(
        <GameModeMenu
          setMode={setMode}
          setAiSide={setAiSide}
          setAiLevel={vi.fn()}
          setShowRule={vi.fn()}
        />,
      )
    })

    const button = (name: string) =>
      [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name)!

    act(() => button('IA aprendiz Q5').click())
    act(() => button('Rojo').click())
    expect(setAiSide).toHaveBeenLastCalledWith('R')
    expect(setMode).toHaveBeenLastCalledWith('q5-learning')

    act(() => button('Azul').click())
    expect(setAiSide).toHaveBeenLastCalledWith('B')
    expect(setMode).toHaveBeenLastCalledWith('q5-learning')
    act(() => root.unmount())
  })

  it('distingue el desafío MCTS final y permite elegir ambos colores', () => {
    const setMode = vi.fn()
    const setAiSide = vi.fn()
    const root = createRoot(container)
    act(() => {
      root.render(
        <GameModeMenu
          setMode={setMode}
          setAiSide={setAiSide}
          setAiLevel={vi.fn()}
          setShowRule={vi.fn()}
        />,
      )
    })

    const button = (name: string) =>
      [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === name)!

    act(() => button('IA final / Desafío MCTS').click())
    act(() => button('Rojo').click())
    expect(setAiSide).toHaveBeenLastCalledWith('R')
    expect(setMode).toHaveBeenLastCalledWith('mcts-final')

    act(() => button('Azul').click())
    expect(setAiSide).toHaveBeenLastCalledWith('B')
    expect(setMode).toHaveBeenLastCalledWith('mcts-final')

    act(() => button('MCTS actual / modo rápido').click())
    act(() => button('Rojo').click())
    expect(setMode).toHaveBeenLastCalledWith('mcts-fast')
    act(() => root.unmount())
  })
})
