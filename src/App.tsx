import { useEffect, useState } from 'react'
import Game from './components/Game'
import Footer from './components/ui/Footer'
import GameModeMenu from './components/ui/GameModeMenu'
import RuleDialog from './components/ui/RuleDialog'
import SeoHelmet from './components/SeoHelmet'
import type { AiLevel, GameMode, AiSide } from './lib/types'
import { makeNonTerminalWallOnlyTurnFixture } from './fixtures/wallOnlyTurn'

export default function App() {
  const wallOnlyFixtureEnabled =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('fixture') === 'wall-only-turn'
  const [showRule, setShowRule] = useState(false)
  const [mode, setMode] = useState<GameMode | null>(wallOnlyFixtureEnabled ? 'pvp' : null)
  const [aiSide, setAiSide] = useState<AiSide>('B')
  const [aiLevel, setAiLevel] = useState<AiLevel>('middle')
  const [dark, setDark] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('theme')
      if (stored === 'dark') return true
      if (stored === 'light') return false
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) {
      root.classList.add('dark')
      localStorage.setItem('theme', 'dark')
    } else {
      root.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }, [dark])

  return (
    <>
      <SeoHelmet />
      {mode === null || mode === undefined ? (
        <GameModeMenu
          setMode={(m) => {
            setMode(m)
          }}
          setAiSide={setAiSide}
          setAiLevel={setAiLevel}
          setShowRule={setShowRule}
        />
      ) : (
        <Game
          gameMode={mode}
          aiSide={aiSide}
          aiLevel={aiLevel}
          setGameMode={setMode}
          setShowRule={setShowRule}
          dark={dark}
          setDark={setDark}
          developmentFixture={
            wallOnlyFixtureEnabled ? makeNonTerminalWallOnlyTurnFixture('B') : undefined
          }
        />
      )}
      <Footer />
      <RuleDialog open={showRule} onClose={() => setShowRule(false)} />
    </>
  )
}
