import {
  PLAYER_LIST,
  type AiLevel,
  type GameMode,
  type GameSnapshot,
  type PlayerAction,
} from '@/lib/types'
import GameButton from './ui/GameButton'
import Navbar from './ui/Navbar'
import Board from './Board/Board'
import { useTranslation } from 'react-i18next'
import { useGame } from '@/store/index'
import { checkGameEnd } from '@/utils/game'
import {
  saveFinishedGameArtifacts,
  saveMCTSGameTrace,
  type MCTSGameTraceSaveResult,
  type MCTSGameTurnTrace,
} from '@/utils/saveGame'
import { useRef, useEffect, useCallback, useState } from 'react'
import { TurnManager } from '@/agents/TurnManager'
import { applyAgentActionToGame } from '@/agents/gameAgentIntegration'
import {
  HumanAgent,
  RandomAgent,
  HeuristicAgent,
  MinimaxAgent,
  LearningAgent,
  Q5LearningAgent,
  createHumanVsQ5Agents,
  MCTSAgent,
  createHumanVsMCTSAgents,
  type PlayerAgent,
} from '@/agents'
import { snapshotFromState } from '@/store/gameState'
import { runHeuristicTraining } from '@/training/TrainingRunner'
import ConfirmDialog from './ui/ConfirmDialog'
import TurnTimer from './ui/TurnTimer'
import { getGameParticipantMetadata } from '@/utils/gameModeMetadata'
import { appendMCTSGameTurnTrace } from '@/utils/mctsGameTrace'
import {
  createHumanMCTSTrace,
  downloadPreparedHumanMCTSTrace,
  finalizeHumanMCTSTrace,
  markHumanMCTSTraceStarted,
  markHumanMCTSTurnForReview,
  prepareHumanMCTSTraceDiagnosticFile,
  prepareHumanMCTSTraceFile,
  recordHumanMCTSDecision,
  type HumanMCTSTraceV1,
  type PreparedHumanMCTSTraceFile,
} from '@/utils/humanMCTSTrace'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { CURRENT_HUMAN_EXPERIMENT_ID } from '@/experiments/humanExperimentConfig'
import { sessionContextFromEnvironment } from '@/experiments/humanExperimentSession'
import { verifyCommittedTransition } from '@/experiments/humanExperimentTransitionDiagnostics'

export default function Game({
  gameMode,
  aiSide,
  aiLevel,
  setGameMode,
  setShowRule,
  dark,
  setDark,
  developmentFixture,
}: {
  gameMode: GameMode
  aiSide: 'R' | 'B'
  aiLevel: AiLevel
  setGameMode: (m: GameMode | null) => void
  setShowRule: (b: boolean) => void
  dark: boolean
  setDark: (d: boolean | ((d: boolean) => boolean)) => void
  developmentFixture?: GameSnapshot
}) {
  // Estado del juego y flujo de agentes.
  const {
    board,
    turn,
    phase,
    result,
    selected,
    legal,
    stepsTaken,
    placeStone,
    selectStone,
    moveTo,
    finishMove,
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
  const [aiError, setAiError] = useState<string | null>(null)
  const officialSession = import.meta.env.VITE_SESSION_TYPE === 'official'
  const officialSessionInvalidRef = useRef(false)
  const [mctsTraceSaveResult, setMctsTraceSaveResult] = useState<MCTSGameTraceSaveResult | null>(
    null,
  )
  const [mctsTraceComplete, setMctsTraceComplete] = useState(false)
  const [fullTraceDownload, setFullTraceDownload] = useState<{
    fileName: string
    bytes: number
    error?: string
    diagnostic?: boolean
  } | null>(null)
  const [timeLeft, setTimeLeft] = useState(90_000)
  const turnTimeLimit = 90_000
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [markedTurns, setMarkedTurns] = useState<number[]>([])

  // Integración del bucle principal de agentes.
  const turnManagerRef = useRef<TurnManager | null>(null)
  const humanAgentRef = useRef<HumanAgent | null>(null)
  const learningAgentRef = useRef<LearningAgent | null>(null)
  // Diagnóstico completo de cada decisión en partidas humano contra MCTS.
  const mctsTraceRef = useRef<MCTSGameTurnTrace[]>([])
  const fullMctsTraceRef = useRef<HumanMCTSTraceV1 | null>(null)
  const finalizedFullMctsTraceRef = useRef<HumanMCTSTraceV1 | null>(null)
  const preparedFullTraceRef = useRef<PreparedHumanMCTSTraceFile | null>(null)
  const savedRef = useRef(false)

  const turnManagerStartedRef = useRef(false)
  const trainingStartedRef = useRef(false)
  const [trainingProgress, setTrainingProgress] = useState<{
    current: number
    total: number
  } | null>(null)

  const setupTurnManager = useCallback(() => {
    if (!gameMode) return

    fullMctsTraceRef.current = null
    finalizedFullMctsTraceRef.current = null
    preparedFullTraceRef.current = null
    savedRef.current = false
    officialSessionInvalidRef.current = false
    setFullTraceDownload(null)

    if (gameMode === 'heuristic-training') {
      learningAgentRef.current = null
      turnManagerRef.current = null
      return
    }

    const isExperimentalAiVsAi =
      gameMode === 'ai-vs-ai' ||
      gameMode === 'random-vs-heuristic' ||
      gameMode === 'learning-vs-random' ||
      gameMode === 'learning-vs-heuristic'

    if (isExperimentalAiVsAi) {
      learningAgentRef.current = null
      let agents: Record<'R' | 'B', PlayerAgent>

      if (gameMode === 'random-vs-heuristic') {
        agents = {
          R: new RandomAgent(),
          B: new HeuristicAgent(),
        }
      } else if (gameMode === 'learning-vs-random') {
        const learningAgent = new LearningAgent()
        learningAgentRef.current = learningAgent
        agents = {
          R: learningAgent,
          B: new RandomAgent(),
        }
      } else if (gameMode === 'learning-vs-heuristic') {
        const learningAgent = new LearningAgent()
        learningAgentRef.current = learningAgent
        agents = {
          R: learningAgent,
          B: new HeuristicAgent(),
        }
      } else if (gameMode === 'ai-vs-ai') {
        agents = {
          R: new RandomAgent(),
          B: new HeuristicAgent(),
        }
      } else {
        const learningAgent = new LearningAgent()
        learningAgentRef.current = learningAgent
        agents = {
          R: learningAgent,
          B: new RandomAgent(),
        }
      }

      turnManagerRef.current = new TurnManager({
        agents,
        getGameState: () => snapshotFromState(useGame.getState()),
        applyAction: async (action: PlayerAction, transition) => {
          const prevState = snapshotFromState(useGame.getState())
          assertUnchangedState(prevState, transition.stateBefore)
          applyCompleteAgentAction(action, {
            placeStone,
            selectStone,
            moveTo,
            finishMove,
            buildWall,
          })
          const committed = snapshotFromState(useGame.getState())
          assertCommittedState(committed, transition.stateAfter)

          if (learningAgentRef.current && prevState.turn === 'R') {
            learningAgentRef.current.recordTransition(prevState, action, committed)
          }
          return committed
        },
        isGameOver: (state) =>
          state.phase === 'finished' || !!state.result || state.stepsTaken > 200,
        turnTimeLimit: 5_000,
        onTurnStart: (state) => {
          if (state.phase !== 'playing') return
          setTurnStart(Date.now())
          setTimeLeft(5_000)
        },
      })
      turnManagerStartedRef.current = false
      return
    }

    // Modos con una persona: se conserva HumanAgent para el lado humano.
    const human = new HumanAgent()
    humanAgentRef.current = human
    let agents
    if (gameMode === 'q5-learning') {
      agents = createHumanVsQ5Agents(aiSide, new Q5LearningAgent(), human)
    } else if (gameMode === 'mcts-final') {
      mctsTraceRef.current = []
      setMctsTraceSaveResult(null)
      setMctsTraceComplete(false)
      const mcts = new MCTSAgent({ profile: 'human-challenge' })
      const session = import.meta.env.VITE_SESSION_TYPE
        ? sessionContextFromEnvironment(import.meta.env)
        : {
            experimentId: CURRENT_HUMAN_EXPERIMENT_ID,
            sessionType: 'diagnostic' as const,
            sessionId: crypto.randomUUID(),
            runtimeCommit: '0000000000000000000000000000000000000000',
            humanColor: (aiSide === 'R' ? 'B' : 'R') as 'R' | 'B',
            aiColor: aiSide,
          }
      if (session.aiColor !== aiSide)
        throw new Error(
          `La sesión asigna la IA a ${session.aiColor}, pero se intentó iniciar como ${aiSide}`,
        )
      fullMctsTraceRef.current = createHumanMCTSTrace({
        experimentId: session.experimentId ?? CURRENT_HUMAN_EXPERIMENT_ID,
        participantId: session.participantId,
        gameNumber: session.gameNumber,
        sessionType: session.sessionType,
        sessionId: session.sessionId,
        projectCommit: session.runtimeCommit,
        implementationCommit: session.implementationCommit,
        experimentPreparationCommit: session.experimentPreparationCommit,
        codeFreezeBindingCommit: session.codeFreezeBindingCommit,
        humanColor: session.humanColor,
        mctsColor: session.aiColor,
        seed: mcts.getBaseSeed(),
        mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
        finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
        initialState: snapshotFromState(useGame.getState()),
      })
      agents = createHumanVsMCTSAgents(aiSide, mcts, human)
    } else if (gameMode === 'mcts-fast') {
      agents = createHumanVsMCTSAgents(aiSide, new MCTSAgent({ profile: 'fast' }), human)
    } else if (gameMode === 'ai') {
      const aiMap = {
        practice: new RandomAgent(),
        heuristic: new HeuristicAgent(),
        easy: new MinimaxAgent(2),
        middle: new MinimaxAgent(4),
        hard: new MinimaxAgent(6),
      }
      const ai = aiMap[aiLevel]
      agents = aiSide === 'R' ? { R: ai, B: human } : { R: human, B: ai }
    } else {
      agents = { R: human, B: human }
    }
    turnManagerRef.current = new TurnManager({
      agents,
      getGameState: () => snapshotFromState(useGame.getState()),
      applyAction: async (action: PlayerAction, transition) => {
        const partiallyApplied = transition.stateChangeWhileDeciding === 'move'
        if (!transition.stateChangeWhileDeciding)
          assertUnchangedState(snapshotFromState(useGame.getState()), transition.stateBefore)
        if (partiallyApplied) {
          if (action.followUp) {
            applyAgentActionToGame(action.followUp, {
              placeStone,
              selectStone,
              moveTo,
              finishMove,
              buildWall,
            })
          } else {
            finishMove()
          }
        } else {
          applyCompleteAgentAction(action, {
            placeStone,
            selectStone,
            moveTo,
            finishMove,
            buildWall,
          })
        }
        const committed = snapshotFromState(useGame.getState())
        verifyCommittedTransition({
          stateBefore: transition.stateBefore,
          action,
          expectedState: transition.stateAfter,
          committedState: committed,
          trace: fullMctsTraceRef.current,
        })
        return committed
      },
      isGameOver: (state) => state.phase === 'finished' || !!state.result,
      allowStateChangeWhileDeciding: (action) => human.consumeStateChangeKind(action),
      turnTimeLimit,
      onTurnStart: (state) => {
        if (state.phase !== 'playing') return
        setTurnStart(Date.now())
        setTimeLeft(turnTimeLimit)
      },
      onDecision: (trace) => {
        if (gameMode !== 'mcts-final') return
        appendMCTSGameTurnTrace(mctsTraceRef.current, trace, aiSide)
        recordHumanMCTSDecision(fullMctsTraceRef.current, trace, aiSide)
      },
    })
    turnManagerStartedRef.current = false
  }, [gameMode, aiSide, aiLevel, buildWall, finishMove, moveTo, placeStone, selectStone])

  useEffect(() => {
    if (!gameMode) {
      useGame.getState().setHumanSide(null)
      return
    }
    const isAiVsAiMode =
      gameMode === 'ai-vs-ai' ||
      gameMode === 'random-vs-heuristic' ||
      gameMode === 'learning-vs-random' ||
      gameMode === 'learning-vs-heuristic'

    if (
      gameMode === 'ai' ||
      gameMode === 'q5-learning' ||
      gameMode === 'mcts-final' ||
      gameMode === 'mcts-fast'
    ) {
      useGame.getState().setHumanSide(aiSide === 'R' ? 'B' : 'R')
    } else if (isAiVsAiMode) {
      useGame.getState().setHumanSide(null)
    } else {
      useGame.getState().setHumanSide(null)
    }
  }, [gameMode, aiSide])

  useEffect(() => {
    if (!gameMode) return
    if (developmentFixture) {
      const fixture = snapshotFromState(developmentFixture)
      useGame.setState({
        ...fixture,
        _history: [snapshotFromState(fixture)],
        _future: [],
        canUndo: false,
        canRedo: false,
      })
    } else {
      setPhase('placing')
    }
    setupTurnManager()
    return () => {
      turnManagerRef.current?.stop()
      turnManagerRef.current = null
      humanAgentRef.current = null
      turnManagerStartedRef.current = false
      fullMctsTraceRef.current = null
      finalizedFullMctsTraceRef.current = null
      preparedFullTraceRef.current = null
    }
  }, [gameMode, aiSide, developmentFixture, setPhase, setupTurnManager])

  useEffect(() => {
    if (gameMode !== 'heuristic-training') {
      trainingStartedRef.current = false
      setTrainingProgress(null)
      return
    }

    if (trainingStartedRef.current) return

    trainingStartedRef.current = true
    setTrainingProgress({ current: 0, total: 20 })

    runHeuristicTraining(20, (current, total) => {
      setTrainingProgress({ current, total })
    })
      .then(() => {
        setTrainingProgress({ current: 20, total: 20 })
      })
      .catch((error) => {
        console.error('[Game] Error en entrenamiento heurístico:', error)
      })
  }, [gameMode])

  useEffect(() => {
    if (!turnManagerRef.current) return
    if ((phase === 'placing' || phase === 'playing') && !turnManagerStartedRef.current) {
      setAiError(null)
      const manager = turnManagerRef.current
      if (gameMode === 'mcts-final' && fullMctsTraceRef.current) {
        markHumanMCTSTraceStarted(fullMctsTraceRef.current)
      }
      void manager
        .startLoop()
        .then(() => {
          if (turnManagerRef.current === manager && gameMode === 'mcts-final') {
            setMctsTraceComplete(true)
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : t('game.ai_error', 'Error de IA')
          console.error('[Game] Error de IA:', error)
          if (officialSession) officialSessionInvalidRef.current = true
          setAiError(message)
        })
      turnManagerStartedRef.current = true
    }
  }, [phase, t, gameMode, officialSession])

  const handlePlayerAction = useCallback((action: PlayerAction) => {
    humanAgentRef.current?.submitAction(action)
  }, [])

  const isHumanTurn = turnManagerRef.current?.['agents']?.[turn] instanceof HumanAgent
  const isAIThinking =
    (gameMode === 'mcts-final' || gameMode === 'mcts-fast') &&
    (phase === 'placing' || phase === 'playing') &&
    !isHumanTurn

  const onTurnEnd = useCallback(() => {
    if (phase !== 'playing') return
    setTimeout(() => {
      if (live.finished) setPhase('finished')
    }, 0)
  }, [phase, live, setPhase])

  // Actualiza el temporizador del turno.
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

  // Detiene el temporizador cuando termina la partida.
  useEffect(() => {
    if (phase === 'finished') {
      setTurnStart(null)
      setTimeLeft(0)
    }
  }, [phase])

  // Comprueba el final de la partida después de cada cambio de estado.
  useEffect(() => {
    onTurnEnd()
  }, [onTurnEnd, turn, phase, result, live])

  // Evita guardar varias veces si se vuelve a renderizar la pantalla final.
  useEffect(() => {
    if (phase !== 'finished' || !result) return
    if (savedRef.current) return
    if (gameMode === 'mcts-final' && !mctsTraceComplete) return

    // Identificador determinista del estado final para evitar duplicados.
    const hashStr = JSON.stringify({ board, result, players })
    let h = 0
    for (let i = 0; i < hashStr.length; i++) {
      h = (h * 31 + hashStr.charCodeAt(i)) | 0
    }
    const id = `g_${(h >>> 0).toString(16)}`

    // Cuenta los muros colocados.
    let walls = 0
    for (let y = 0; y < board.length; y++) {
      for (let x = 0; x < board.length; x++) {
        if (board[y][x].wallLeft) walls++
        if (board[y][x].wallTop) walls++
      }
    }

    // Aproxima los turnos mediante el historial del store.
    const historyLen = useGame.getState()._history?.length ?? 1
    const turnos =
      gameMode === 'mcts-final' ? mctsTraceRef.current.length : Math.max(0, historyLen - 1)

    const { tipo_partida, jugador_rojo, jugador_azul } = getGameParticipantMetadata({
      gameMode,
      aiSide,
      aiLevel,
      humanSide,
    })

    const ganador = result.tie
      ? 'empate'
      : result.winner === 'R'
        ? 'rojo'
        : result.winner === 'B'
          ? 'azul'
          : 'desconocido'

    // Actualizar LearningAgent si existe (para modos con agente aprendiz)
    if (learningAgentRef.current) {
      const learningResult = result.tie ? 'draw' : result.winner === 'R' ? 'win' : 'loss'
      const territoryAprendiz = result.score?.R ?? 0
      const territoryRival = result.score?.B ?? 0
      learningAgentRef.current.updateAfterGame(
        learningResult,
        'R',
        territoryAprendiz,
        territoryRival,
      )
      learningAgentRef.current.logStats()
    }

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

    let fullTraceValid = true
    if (gameMode === 'mcts-final' && fullMctsTraceRef.current) {
      try {
        if (officialSessionInvalidRef.current)
          throw new Error('Official trace download blocked: the session was invalidated.')
        const trace = fullMctsTraceRef.current
        finalizeHumanMCTSTrace(trace, id, snapshotFromState(useGame.getState()))
        finalizedFullMctsTraceRef.current = trace
        const prepared = prepareHumanMCTSTraceFile(trace)
        preparedFullTraceRef.current = prepared
        setFullTraceDownload({ fileName: prepared.fileName, bytes: prepared.bytes })
      } catch (error) {
        fullTraceValid = false
        const message = error instanceof Error ? error.message : String(error)
        finalizedFullMctsTraceRef.current = fullMctsTraceRef.current
        preparedFullTraceRef.current = prepareHumanMCTSTraceDiagnosticFile(
          fullMctsTraceRef.current,
          message,
        )
        setFullTraceDownload({
          fileName: preparedFullTraceRef.current.fileName,
          bytes: preparedFullTraceRef.current.bytes,
          error: message,
          diagnostic: true,
        })
      }
    }
    if (gameMode !== 'mcts-final' || fullTraceValid) {
      const saved = saveFinishedGameArtifacts(payload, gameMode, mctsTraceRef.current)
      if (saved.traceResult.status !== 'not_applicable') {
        setMctsTraceSaveResult(saved.traceResult)
      }
    }
    savedRef.current = true
  }, [phase, result, board, players, gameMode, aiLevel, aiSide, humanSide, mctsTraceComplete])

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
        onUndo={officialSession ? () => undefined : undo}
        onRedo={officialSession ? () => undefined : redo}
        canUndo={canUndo}
        canRedo={canRedo}
        historyDisabled={officialSession}
        phase={phase}
        onHome={() => {
          if (officialSession) {
            turnManagerRef.current?.stop()
            if (phase !== 'finished') officialSessionInvalidRef.current = true
            setAiError(
              phase === 'finished'
                ? 'Official session closed: close this tab instead of starting another game.'
                : 'Official session cancelled: leaving the game is not permitted.',
            )
            return
          }
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
      {aiError && (
        <div
          role="alert"
          className="w-full max-w-xl rounded-xl border border-red-300 bg-red-50 p-3 text-center text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
        >
          {aiError}
        </div>
      )}
      {isAIThinking && !aiError && (
        <div
          role="status"
          aria-live="polite"
          className="w-full max-w-xl rounded-xl border border-indigo-200 bg-indigo-50 p-2 text-center text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200"
        >
          La IA está pensando…
        </div>
      )}
      {gameMode === 'mcts-final' && fullMctsTraceRef.current && (
        <div className="w-full max-w-xl rounded-xl border border-zinc-300 bg-white/80 p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900/80">
          <div>
            Sesión: {fullMctsTraceRef.current.metadata.sessionId} · Turno:{' '}
            {fullMctsTraceRef.current.decisions.length} · Jugador activo: {turn}
          </div>
          {fullMctsTraceRef.current.metadata.gameId !== 'pending' && (
            <div>Trace ID: {fullMctsTraceRef.current.metadata.gameId}</div>
          )}
          {fullMctsTraceRef.current.decisions[fullMctsTraceRef.current.decisions.length - 1] && (
            <div>
              Última acción:{' '}
              {JSON.stringify(
                fullMctsTraceRef.current.decisions[fullMctsTraceRef.current.decisions.length - 1]!
                  .action,
              )}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  const trace = fullMctsTraceRef.current
                  const decision = trace?.decisions[(trace?.decisions.length ?? 0) - 1]
                  if (!trace || !decision) return
                  markHumanMCTSTurnForReview(trace, decision.turnIndex)
                  setMarkedTurns((current) =>
                    current.includes(decision.turnIndex)
                      ? current
                      : [...current, decision.turnIndex],
                  )
                }}
              >
                Marcar turno para revisión
              </button>
            </div>
          )}
          {markedTurns.length > 0 && <div>Turnos marcados: {markedTurns.join(', ')}</div>}
        </div>
      )}
      {gameMode === 'mcts-final' && phase === 'finished' && (
        <div
          role="status"
          className="w-full max-w-xl rounded-xl border border-indigo-300 bg-indigo-50 p-3 text-center text-indigo-900 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-100"
        >
          {!mctsTraceSaveResult
            ? 'La función de descarga de la traza MCTS todavía no se ha ejecutado.'
            : mctsTraceSaveResult.status === 'empty'
              ? 'La traza MCTS está vacía; no se solicitó ninguna descarga.'
              : mctsTraceSaveResult.status === 'failed'
                ? `Falló la descarga de ${mctsTraceSaveResult.fileName}: ${mctsTraceSaveResult.error}`
                : `Se solicitó ${mctsTraceSaveResult.fileName} con ${mctsTraceSaveResult.rowCount} filas. Si no aparece, el navegador bloqueó la segunda descarga.`}
          {mctsTraceSaveResult && mctsTraceSaveResult.status !== 'empty' && (
            <button
              type="button"
              className="ml-2 underline"
              onClick={() =>
                setMctsTraceSaveResult(
                  saveMCTSGameTrace(
                    mctsTraceSaveResult.fileName.replace(/^traza_partida_mcts_|\.csv$/g, ''),
                    mctsTraceRef.current,
                  ),
                )
              }
            >
              Descargar traza
            </button>
          )}
          <div className="mt-2">
            {!fullTraceDownload
              ? 'La traza JSON reproducible todavía no se ha generado.'
              : fullTraceDownload.error
                ? `Falló la traza JSON ${fullTraceDownload.fileName}: ${fullTraceDownload.error}`
                : `Traza reproducible preparada: ${fullTraceDownload.fileName} (${fullTraceDownload.bytes} bytes).`}
            {preparedFullTraceRef.current && finalizedFullMctsTraceRef.current && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  try {
                    setFullTraceDownload(
                      downloadPreparedHumanMCTSTrace(preparedFullTraceRef.current!),
                    )
                  } catch (error) {
                    setFullTraceDownload({
                      fileName: preparedFullTraceRef.current!.fileName,
                      bytes: 0,
                      error: error instanceof Error ? error.message : String(error),
                    })
                  }
                }}
              >
                {fullTraceDownload?.diagnostic
                  ? 'Descargar diagnÃ³stico no oficial'
                  : 'Descargar JSON reproducible'}
              </button>
            )}
          </div>
        </div>
      )}
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
      {developmentFixture && (
        <p
          className="rounded bg-amber-100 px-3 py-2 text-sm text-amber-950"
          data-testid="development-fixture"
        >
          {board[3]?.[3]?.stone === 'B'
            ? 'Development fixture: select blue D4, move once, then finish or build one wall.'
            : 'Development fixture: blue A7 cannot move; select it and build its right wall.'}
        </p>
      )}
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
            disabled={officialSession}
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
      {trainingProgress && (
        <div className="w-full max-w-xl text-center py-3 rounded-2xl bg-amber-100/80 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-700 mb-4">
          <p className="font-semibold text-zinc-800 dark:text-zinc-100">
            Entrenamiento heurístico automático: {trainingProgress.current} /{' '}
            {trainingProgress.total}
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Se ejecutan partidas automáticas y se descargarán los resultados en CSV al finalizar.
          </p>
        </div>
      )}
      <div className="board-container flex flex-col aspect-ratio-1 items-center w-[min(800px,100dvh-280px)] max-w-[calc(100dvw-32px)] transition-all">
        <Board
          board={board}
          phase={phase}
          turn={turn}
          selected={selected ?? null}
          legal={legal}
          placeStone={
            isHumanTurn && !isAIThinking && !officialSessionInvalidRef.current
              ? (pos) => handlePlayerAction({ type: 'place', pos })
              : undefined
          }
          selectStone={
            isHumanTurn &&
            !isAIThinking &&
            !officialSessionInvalidRef.current &&
            phase === 'playing' &&
            stepsTaken === 0
              ? (pos) => {
                  humanAgentRef.current?.beginSelection(pos)
                  selectStone(pos)
                }
              : undefined
          }
          moveTo={
            isHumanTurn &&
            !isAIThinking &&
            !officialSessionInvalidRef.current &&
            phase === 'playing' &&
            stepsTaken === 0
              ? (pos) => {
                  moveTo(pos)
                  humanAgentRef.current?.submitMove(pos)
                }
              : undefined
          }
          buildWall={
            isHumanTurn &&
            !isAIThinking &&
            !officialSessionInvalidRef.current &&
            phase === 'playing'
              ? (pos, dir) => humanAgentRef.current?.submitWall(pos, dir)
              : undefined
          }
        />
      </div>
      {isHumanTurn &&
        !isAIThinking &&
        !officialSessionInvalidRef.current &&
        phase === 'playing' &&
        stepsTaken > 0 && (
          <GameButton
            onClick={() => humanAgentRef.current?.submitMoveWithoutWall()}
            ariaLabel="Finish turn without wall"
          >
            Finish turn without wall
          </GameButton>
        )}
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

function sameGameSnapshot(left: GameSnapshot, right: GameSnapshot): boolean {
  const serializable = (state: GameSnapshot) => {
    const snapshot = snapshotFromState(state)
    return { ...snapshot, legal: [...snapshot.legal].sort() }
  }
  return JSON.stringify(serializable(left)) === JSON.stringify(serializable(right))
}

function assertUnchangedState(current: GameSnapshot, expected: GameSnapshot): void {
  if (!sameGameSnapshot(current, expected))
    throw new Error(
      'Official session stopped: the game state changed while the agent was deciding.',
    )
}

function assertCommittedState(current: GameSnapshot, expected: GameSnapshot): void {
  if (!sameGameSnapshot(current, expected))
    throw new Error(
      'Official session stopped: the committed state does not match the engine transition.',
    )
}

function applyCompleteAgentAction(
  action: PlayerAction,
  handlers: Parameters<typeof applyAgentActionToGame>[1],
): void {
  applyAgentActionToGame(action, handlers)
  if (action.followUp) applyAgentActionToGame(action.followUp, handlers)
}
