import { PLAYER_LIST, type AiLevel, type PlayerAction, type State } from '@/lib/types'
import GameButton from './ui/GameButton'
import Navbar from './ui/Navbar'
import Board from './Board/Board'
import { useTranslation } from 'react-i18next'
import { useGame } from '@/store/index'
import { checkGameEnd } from '@/utils/game'
import { saveGameResult } from '@/utils/saveGame'
import { useRef, useEffect, useCallback, useState } from 'react'
import { TurnManager } from '@/agents/TurnManager'
import { HumanAgent, RandomAgent, HeuristicAgent, MinimaxAgent } from '@/agents'
import { snapshotFromState } from '@/store/gameState'
import ConfirmDialog from './ui/ConfirmDialog'
import TurnTimer from './ui/TurnTimer'

export default function Game({
  gameMode,
  aiSide,
  aiLevel,
  setGameMode,
  setShowRule,
  dark,
  setDark,
}: {
  gameMode: 'pvp' | 'ai' | 'ai-vs-ai'
  aiSide: 'R' | 'B'
  aiLevel: AiLevel
  setGameMode: (m: 'pvp' | 'ai' | 'ai-vs-ai' | null) => void
  setShowRule: (b: boolean) => void
  dark: boolean
  setDark: (d: boolean | ((d: boolean) => boolean)) => void
}) {
  // 內部自行管理 useGame 狀態與 AI 流程
  const {
    board,
    turn,
    phase,
    result,
    selected,
    legal,
    placeStone,
    selectStone,
    moveTo,
    buildWall,
    setPhase,
    resetGame,
    undo,
    redo,
    canUndo,
    canRedo,
    players,
    humanSide,
  } = useGame()
  const live = checkGameEnd(board, [...PLAYER_LIST])
  const { t } = useTranslation()
  const [showConfirm, setShowConfirm] = useState(false)
  const [timeLeft, setTimeLeft] = useState(90_000)
  const turnTimeLimit = 90_000
  const [turnStart, setTurnStart] = useState<number | null>(null)

  // --- 代理主流程整合 ---
  const turnManagerRef = useRef<TurnManager | null>(null)
  const humanAgentRef = useRef<HumanAgent | null>(null)
  // 直接用 useGame() 的完整 state 當 snapshot
  const latestStateRef = useRef<State | null>(null)
  useEffect(() => {
    latestStateRef.current = useGame.getState()
  }, [board, turn, selected, legal, phase, result])

  const turnManagerStartedRef = useRef(false)

  const setupTurnManager = useCallback(() => {
    if (!gameMode) return
    
    // Para modo ai-vs-ai: rojo = aleatoria, azul = heurística
    if (gameMode === 'ai-vs-ai') {
      const agents = {
        R: new RandomAgent(),
        B: new HeuristicAgent(),
      }
      turnManagerRef.current = new TurnManager({
        agents,
        getGameState: () => snapshotFromState(latestStateRef.current!),
        applyAction: async (action: PlayerAction) => {
          if (action.type === 'place') {
            placeStone(action.pos)
          } else if (action.type === 'move') {
            if (action.from) selectStone(action.from)
            moveTo(action.pos)
          } else if (action.type === 'wall' && action.dir) {
            if (action.from) selectStone(action.from)
            buildWall(action.pos, action.dir)
          }
        },
        isGameOver: (state) => state.phase === 'finished' || !!state.result || (state.stepsTaken > 200),
        turnTimeLimit: 5_000, // Más rápido para IA vs IA
        onTurnStart: (state) => {
          if (state.phase !== 'playing') return
          setTurnStart(Date.now())
          setTimeLeft(5_000)
        },
      })
      turnManagerStartedRef.current = false
      return
    }

    // Para modo pvp y ai: lógica original con HumanAgent
    const human = new HumanAgent()
    humanAgentRef.current = human
    const aiMap = {
      practice: new RandomAgent(),
      heuristic: new HeuristicAgent(),
      easy: new MinimaxAgent(2),
      middle: new MinimaxAgent(4),
      hard: new MinimaxAgent(6),
    }
    const ai = aiMap[aiLevel]
    const agents =
      gameMode === 'ai'
        ? aiSide === 'R'
          ? { R: ai, B: human }
          : { R: human, B: ai }
        : { R: human, B: human }
    turnManagerRef.current = new TurnManager({
      agents,
      getGameState: () => snapshotFromState(latestStateRef.current!),
      applyAction: async (action: PlayerAction) => {
        if (action.type === 'place') {
          placeStone(action.pos)
        } else if (action.type === 'move') {
          if (action.from) selectStone(action.from)
          moveTo(action.pos)
        } else if (action.type === 'wall' && action.dir) {
          if (action.from) selectStone(action.from)
          buildWall(action.pos, action.dir)
        }
      },
      isGameOver: (state) => state.phase === 'finished' || !!state.result,
      turnTimeLimit,
      onTurnStart: (state) => {
        if (state.phase !== 'playing') return
        setTurnStart(Date.now())
        setTimeLeft(turnTimeLimit)
      },
    })
    turnManagerStartedRef.current = false
  }, [gameMode, aiSide, aiLevel, buildWall, moveTo, placeStone, selectStone])

  useEffect(() => {
    if (!gameMode) {
      useGame.getState().setHumanSide(null)
      return
    }
    if (gameMode === 'ai') {
      useGame.getState().setHumanSide(aiSide === 'R' ? 'B' : 'R')
    } else if (gameMode === 'ai-vs-ai') {
      useGame.getState().setHumanSide(null)
    } else {
      useGame.getState().setHumanSide(null)
    }
  }, [gameMode, aiSide])

  useEffect(() => {
    if (!gameMode) return
    setPhase('placing')
    setupTurnManager()
  }, [gameMode, aiSide, setPhase, setupTurnManager])

  useEffect(() => {
    if (!turnManagerRef.current) return
    if ((phase === 'placing' || phase === 'playing') && !turnManagerStartedRef.current) {
      turnManagerRef.current.startLoop()
      turnManagerStartedRef.current = true
    }
  }, [phase])

  const handlePlayerAction = useCallback((action: PlayerAction) => {
    humanAgentRef.current?.submitAction(action)
  }, [])

  const isHumanTurn = turnManagerRef.current?.['agents']?.[turn] instanceof HumanAgent

  const onTurnEnd = useCallback(() => {
    if (phase !== 'playing') return
    setTimeout(() => {
      if (live.finished) setPhase('finished')
    }, 0)
  }, [phase, live, setPhase])

  // Turn timer update
  useEffect(() => {
    if (turnStart === null) return
    let frame: number
    let stopped = false
    const update = () => {
      if (stopped) return
      setTimeLeft(Math.max(0, turnTimeLimit - (Date.now() - turnStart)))
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
    }
  }, [turnStart])

  // 只要 phase 進入 playing（不論是 redo/undo 或正常下棋），timer 就 reset
  useEffect(() => {
    if (phase === 'finished') {
      setTurnStart(null)
      setTimeLeft(0)
    }
  }, [phase])

  // 每當遊戲狀態變化時檢查是否需要結束回合
  useEffect(() => {
    onTurnEnd()
  }, [onTurnEnd, turn, phase, result, live])

  // Guard to avoid saving multiple times if the finished screen re-renders
  const savedRef = useRef(false)
  useEffect(() => {
    if (phase !== 'finished' || !result) return
    if (savedRef.current) return

    // Compute a deterministic id for this finished state to prevent duplicates
    const hashStr = JSON.stringify({ board, result, players })
    let h = 0
    for (let i = 0; i < hashStr.length; i++) {
      h = (h * 31 + hashStr.charCodeAt(i)) | 0
    }
    const id = `g_${(h >>> 0).toString(16)}`

    // Count walls placed
    let walls = 0
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board.length; x++) {
        if (board[y][x].wallLeft) walls++
        if (board[y][x].wallTop) walls++
      }
    }

    // Approximate turns as number of history entries - 1
    const historyLen = useGame.getState()._history?.length ?? 1
    const turnos = Math.max(0, historyLen - 1)

    // Map AI level to human-readable CSV strings
    const aiTipoMap: Record<string, string> = {
      practice: 'humano_vs_ia_aleatoria',
      heuristic: 'humano_vs_ia_heuristica',
      easy: 'humano_vs_ia_facil',
      middle: 'humano_vs_ia_media',
      hard: 'humano_vs_ia_dificil',
    }
    const aiPlayerMap: Record<string, string> = {
      practice: 'ia_aleatoria',
      heuristic: 'ia_heuristica',
      easy: 'ia_facil',
      middle: 'ia_media',
      hard: 'ia_dificil',
    }

    let tipo_partida = 'pvp'
    if (gameMode === 'ai') tipo_partida = aiTipoMap[aiLevel] ?? 'humano_vs_ia'
    if (gameMode === 'ai-vs-ai') tipo_partida = 'ia_vs_ia_automatico'

    const playerLabel = (side: 'R' | 'B') => {
      if (gameMode === 'ai-vs-ai') {
        return side === 'R' ? 'ia_aleatoria' : 'ia_heuristica'
      }
      if (gameMode !== 'ai') return 'humano'
      // If humanSide is null (shouldn't happen), assume players[0] is human
      if (!humanSide) return 'humano'
      if (humanSide === side) return 'humano'
      return aiPlayerMap[aiLevel] ?? 'ia'
    }

    const jugador_rojo = playerLabel('R')
    const jugador_azul = playerLabel('B')

    const ganador = result.tie ? 'empate' : result.winner === 'R' ? 'rojo' : result.winner === 'B' ? 'azul' : 'desconocido'

    const payload = {
      id_partida: id,
      fecha: new Date().toISOString(),
      tipo_partida,
      jugador_rojo,
      jugador_azul,
      ganador,
      turnos,
      territorio_rojo: result.score?.R ?? 0,
      territorio_azul: result.score?.B ?? 0,
      muros_colocados: walls,
      observaciones: 'Guardado automático para recogida de datos TR',
    }

    saveGameResult(payload)
    savedRef.current = true
  }, [phase, result, board, players, gameMode, aiLevel, humanSide])

  return (
    <div
      className={[
        'flex flex-col items-center gap-4 py-4 min-h-dvh min-w-0',
        'bg-gradient-to-br from-rose-50 via-indigo-50 to-amber-50 dark:from-zinc-900 dark:via-zinc-700 dark:to-zinc-900',
        'transition-color',
        'box-border',
        'p-4 pb-12',
      ].join(' ')}
    >
      <TurnTimer timeLeft={timeLeft} timeLimit={turnTimeLimit} turn={turn} phase={phase} />
      <Navbar
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        phase={phase}
        onHome={() => {
          const inProgress =
            phase !== 'finished' && board.some((row) => row.some((c) => c.stone !== null))
          if (inProgress) setShowConfirm(true)
          else {
            setGameMode(null)
            resetGame()
          }
        }}
        dark={dark}
        setDark={setDark}
      />
      <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-zinc-800 dark:text-zinc-100 drop-shadow animate-fade-in flex items-center gap-2">
        {phase === 'finished' && result ? (
          result.tie ? (
            <>{t('game.tie', '🤜🤛 Draw!')}</>
          ) : result.winner ? (
            <>
              {t('game.winner', '🥇 Winner:')}
              <span
                className={
                  result.winner === 'R'
                    ? 'inline-block w-6 h-6 rounded-full bg-rose-500 dark:bg-rose-400 border-2 border-rose-300 dark:border-rose-500 shadow-sm mx-1 align-middle'
                    : 'inline-block w-6 h-6 rounded-full bg-indigo-500 dark:bg-indigo-400 border-2 border-indigo-300 dark:border-indigo-500 shadow-sm mx-1 align-middle'
                }
                aria-label={result.winner === 'R' ? t('game.red', 'Red') : t('game.blue', 'Blue')}
              />
            </>
          ) : null
        ) : (
          <>
            Wall Go ·{' '}
            {phase === 'placing'
              ? t('game.phase.placing', 'Placement Phase')
              : phase === 'playing'
                ? t('game.phase.playing', 'Action Phase')
                : t('game.phase.finished', 'Scoring Phase')}
          </>
        )}
      </h1>
      <div className="flex gap-4 animate-fade-in items-center">
        {(phase === 'placing'
          ? PLAYER_LIST.map((p) => [p, 0])
          : Object.entries(live.score ?? {})
        ).map(([p, s]) => (
          <span
            key={p}
            className="flex items-center gap-2 font-mono text-lg px-2 py-1 rounded bg-white/70 dark:bg-zinc-800/80 shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-100 transition-all duration-300"
          >
            <span
              className={
                p === 'R'
                  ? 'inline-block w-5 h-5 rounded-full bg-rose-500 dark:bg-rose-400 border-2 border-rose-300 dark:border-rose-500 shadow-sm mr-1'
                  : 'inline-block w-5 h-5 rounded-full bg-indigo-500 dark:bg-indigo-400 border-2 border-indigo-300 dark:border-indigo-500 shadow-sm mr-1'
              }
              aria-label={p === 'R' ? t('game.red', 'Red') : t('game.blue', 'Blue')}
            />
            {s}
          </span>
        ))}
        {phase === 'finished' && (
          <GameButton
            onClick={() => {
              setGameMode(null)
              resetGame()
              setPhase('selecting')
            }}
            ariaLabel={t('game.again', 'Play Again')}
            variant="success"
          >
            {t('game.again', 'Play Again')}
          </GameButton>
        )}
      </div>
      <div className="board-container flex flex-col aspect-ratio-1 items-center w-[min(800px,100dvh-280px)] max-w-[calc(100dvw-32px)] transition-all">
        <Board
          board={board}
          phase={phase}
          turn={turn}
          selected={selected ?? null}
          legal={legal}
          placeStone={
            phase === 'placing' || isHumanTurn
              ? (pos) => handlePlayerAction({ type: 'place', pos })
              : undefined
          }
          selectStone={isHumanTurn && phase === 'playing' ? (pos) => selectStone(pos) : undefined}
          moveTo={
            isHumanTurn && phase === 'playing'
              ? (pos) => handlePlayerAction({ type: 'move', pos })
              : undefined
          }
          buildWall={
            isHumanTurn && phase === 'playing'
              ? (pos, dir) => handlePlayerAction({ type: 'wall', pos, dir })
              : undefined
          }
        />
      </div>
      <div className="w-full flex justify-center mt-3 animate-fade-in">
        <GameButton onClick={() => setShowRule(true)} text ariaLabel={t('menu.rule', 'Game Rules')}>
          {t('menu.rule', 'Game Rules')}
        </GameButton>
      </div>
      <ConfirmDialog
        open={showConfirm}
        title={t('menu.home', 'Home')}
        message={t(
          'menu.confirmHome',
          'The game is not finished. Are you sure you want to return to the home screen?\nYour current progress will be lost.',
        )}
        confirmText={t('common.confirm', 'Confirm')}
        cancelText={t('common.cancel', 'Cancel')}
        onConfirm={() => {
          setShowConfirm(false)
          setGameMode(null)
          resetGame()
        }}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}
