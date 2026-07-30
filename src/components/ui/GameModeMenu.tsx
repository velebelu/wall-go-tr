import LanguageThemeSwitcher from './LanguageThemeSwitcher'
import { useState, useRef, useEffect } from 'react'
import GameButton from './GameButton'
import { useTranslation } from 'react-i18next'
import type { AiLevel, GameMode, AiSide } from '@/lib/types'

const AI_LEVELS: AiLevel[] = ['practice', 'heuristic', 'easy', 'middle', 'hard']

export default function GameModeMenu({
  setMode,
  setAiSide,
  setAiLevel,
  setShowRule,
}: {
  setMode: (m: GameMode) => void
  setAiSide: (s: AiSide) => void
  setAiLevel: (l: AiLevel) => void
  setShowRule: (show: boolean) => void
}) {
  const { t } = useTranslation()
  const [showAiSelect, setShowAiSelect] = useState(false)
  const [showQ5Select, setShowQ5Select] = useState(false)
  const [showMctsSelect, setShowMctsSelect] = useState(false)
  const [showFastMctsSelect, setShowFastMctsSelect] = useState(false)
  const [selectedLevel, setSelectedLevel] = useState<AiLevel>('middle')
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
  // Language switcher dropdown
  const [open, setOpen] = useState(false)
  const selectRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (selectRef.current && !selectRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])
  // Removed the original toggle button and language dropdown, replaced with a shared component
  return (
    <div className="flex flex-col items-center justify-center min-h-dvh bg-gradient-to-br from-rose-50 via-indigo-50 to-amber-50 dark:from-zinc-900 dark:via-zinc-800 dark:to-zinc-900 p-4">
      <div className="fixed top-0 w-full flex justify-end gap-2 mb-2 p-4">
        <LanguageThemeSwitcher dark={dark} setDark={setDark} />
      </div>
      <h1 className="text-3xl font-extrabold mb-6 text-zinc-800 dark:text-zinc-100 drop-shadow animate-fade-in">
        {t('menu.title', 'Wall Go')}
      </h1>
      <div className="flex flex-col gap-4 w-full max-w-xs animate-fade-in min-h-[120px] transition-all duration-500">
        <GameButton onClick={() => setMode('pvp')} className="text-lg py-3">
          {t('menu.mode.pvp')}
        </GameButton>
        <GameButton
          onClick={() => setShowAiSelect(true)}
          className="text-lg py-3"
          active={showAiSelect}
        >
          {t('menu.mode.ai')}
        </GameButton>
        <GameButton
          onClick={() => setShowQ5Select((show) => !show)}
          className="text-lg py-3"
          active={showQ5Select}
        >
          {t('menu.mode.q5_learning', 'IA aprendiz Q5')}
        </GameButton>
        {showQ5Select && (
          <div className="flex flex-col gap-3 items-center p-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
            <span className="text-sm text-zinc-700 dark:text-zinc-200">
              {t('menu.q5.select_side', 'Elige el color de la IA aprendiz Q5:')}
            </span>
            <div className="flex gap-3 justify-center w-full">
              <GameButton
                onClick={() => {
                  setAiSide('R')
                  setMode('q5-learning')
                }}
                className="!bg-rose-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.q5.red', 'Rojo')}
              </GameButton>
              <GameButton
                onClick={() => {
                  setAiSide('B')
                  setMode('q5-learning')
                }}
                className="!bg-indigo-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.q5.blue', 'Azul')}
              </GameButton>
            </div>
          </div>
        )}
        <GameButton
          onClick={() => setShowFastMctsSelect((show) => !show)}
          className="text-lg py-3"
          active={showFastMctsSelect}
        >
          {t('menu.mode.mcts_fast', 'MCTS actual / modo rápido')}
        </GameButton>
        {showFastMctsSelect && (
          <div className="flex flex-col gap-3 items-center p-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
            <span className="text-sm text-zinc-700 dark:text-zinc-200">
              {t('menu.mcts_fast.select_side', 'Elige el color del MCTS rápido:')}
            </span>
            <div className="flex gap-3 justify-center w-full">
              <GameButton
                onClick={() => {
                  setAiSide('R')
                  setMode('mcts-fast')
                }}
                className="!bg-rose-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.mcts.red', 'Rojo')}
              </GameButton>
              <GameButton
                onClick={() => {
                  setAiSide('B')
                  setMode('mcts-fast')
                }}
                className="!bg-indigo-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.mcts.blue', 'Azul')}
              </GameButton>
            </div>
          </div>
        )}
        <GameButton
          onClick={() => setShowMctsSelect((show) => !show)}
          className="text-lg py-3"
          active={showMctsSelect}
        >
          {t('menu.mode.mcts_final', 'IA final / Desafío MCTS')}
        </GameButton>
        {showMctsSelect && (
          <div className="flex flex-col gap-3 items-center p-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
            <span className="text-sm text-zinc-700 dark:text-zinc-200">
              {t('menu.mcts.select_side', 'Elige el color de la IA final:')}
            </span>
            <div className="flex gap-3 justify-center w-full">
              <GameButton
                onClick={() => {
                  setAiSide('R')
                  setMode('mcts-final')
                }}
                className="!bg-rose-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.mcts.red', 'Rojo')}
              </GameButton>
              <GameButton
                onClick={() => {
                  setAiSide('B')
                  setMode('mcts-final')
                }}
                className="!bg-indigo-500 !text-white px-4 py-2 text-base font-semibold"
              >
                {t('menu.mcts.blue', 'Azul')}
              </GameButton>
            </div>
          </div>
        )}
        <GameButton
          onClick={() => {
            setMode('ai-vs-ai')
          }}
          className="text-lg py-3 !bg-emerald-500 !dark:!bg-emerald-600 !text-white !shadow-lg hover:!bg-emerald-600 hover:!dark:bg-emerald-500"
        >
          {t('menu.mode.ai-vs-ai', '🤖 IA vs IA')}
        </GameButton>
        <div className="mt-4 p-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
          <div className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
            {t('menu.mode.experimentalTitle', 'Experimental modes')}
          </div>
          <GameButton
            onClick={() => {
              setMode('random-vs-heuristic')
            }}
            className="text-base py-3"
          >
            {t('menu.mode.random_vs_heuristic', 'IA aleatoria vs IA heurística')}
          </GameButton>
          <GameButton
            onClick={() => {
              setMode('learning-vs-random')
            }}
            className="text-base py-3"
          >
            {t('menu.mode.learning_vs_random', 'IA aprendiz vs IA aleatoria')}
          </GameButton>
          <GameButton
            onClick={() => {
              setMode('learning-vs-heuristic')
            }}
            className="text-base py-3"
          >
            {t('menu.mode.learning_vs_heuristic', 'IA aprendiz vs IA heurística')}
          </GameButton>
          <GameButton
            onClick={() => {
              setMode('heuristic-training')
            }}
            className="text-base py-3"
          >
            {t('menu.mode.heuristic_training', 'Entrenamiento heurístico automático')}
          </GameButton>
        </div>
      </div>
      {/* AI difficulty and turn order selection merged (difficulty is a dropdown menu) */}
      <div
        style={{ transition: 'opacity 0.3s, max-height 0.3s, margin 0.3s' }}
        className={
          'w-full flex justify-center' +
          (showAiSelect
            ? ' opacity-100 max-h-60 mt-6 flex-col gap-2 items-center animate-fade-in transition-all duration-500'
            : ' opacity-0 max-h-0 overflow-hidden pointer-events-none flex-col gap-2 items-center transition-all duration-500')
        }
      >
        <div className="flex flex-col items-center w-full">
          <span className="text-zinc-700 dark:text-zinc-200 mb-3">
            {t('menu.ai.select', 'Select AI level and side:')}
          </span>
          <div className="flex flex-col gap-3 w-full mb-2 items-center">
            <label className="mb-2 text-base text-zinc-700 dark:text-zinc-200">
              <span className="mr-2">{t('menu.ai.level', 'AI Level:')}</span>
              <select
                value={selectedLevel}
                onChange={(e) => setSelectedLevel(e.target.value as AiLevel)}
                className="rounded border border-zinc-300 dark:border-zinc-600 px-2 py-1 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-indigo-400 cursor-pointer"
              >
                {AI_LEVELS.map((l) => (
                  <option className="cursor-pointer" key={l} value={l}>
                    {t(`menu.ai.levels.${l}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-4 justify-center w-full">
              <GameButton
                onClick={() => {
                  setAiLevel(selectedLevel)
                  setAiSide('B')
                  setMode('ai')
                }}
                className="!bg-rose-400 !dark:!bg-rose-500 !text-white !shadow-lg hover:!bg-rose-500 hover:!dark:bg-rose-400 focus:!ring-rose-400 focus:!dark:ring-rose-300 transition-colors px-4 py-2 text-base font-semibold"
              >
                {t('menu.ai.first', '🐰 First')}
              </GameButton>
              <GameButton
                onClick={() => {
                  const side = Math.random() < 0.5 ? 'B' : 'R'
                  setAiLevel(selectedLevel)
                  setAiSide(side)
                  setMode('ai')
                }}
                className="px-4 py-2 text-base font-semibold"
                ariaLabel={t('menu.ai.random', '🎲 Random')}
              >
                {t('menu.ai.random', '🎲 Random')}
              </GameButton>
              <GameButton
                onClick={() => {
                  setAiLevel(selectedLevel)
                  setAiSide('R')
                  setMode('ai')
                }}
                className="!bg-indigo-500 !dark:!bg-indigo-400 !text-white !shadow-lg hover:!bg-indigo-600 hover:!dark:bg-indigo-300 focus:!ring-indigo-400 focus:!dark:ring-indigo-300 transition-colors px-4 py-2 text-base font-semibold"
              >
                {t('menu.ai.second', '🐢 Second')}
              </GameButton>
            </div>
          </div>
          <GameButton
            onClick={() => setShowAiSelect(false)}
            className="mt-2 !bg-transparent !shadow-none !border-0 text-sm text-zinc-500 hover:underline hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors cursor-pointer"
            text
          >
            {t('menu.ai.back', 'Back')}
          </GameButton>
        </div>
      </div>
      <div className="w-full flex justify-center mt-6 animate-fade-in">
        <GameButton onClick={() => setShowRule(true)} text ariaLabel={t('menu.rule', 'Game Rules')}>
          {t('menu.rule', 'Game Rules')}
        </GameButton>
      </div>
    </div>
  )
}
