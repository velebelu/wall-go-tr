import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Player } from '@/lib/types'
import type { TrainingTraceGameRecord } from '@/utils/trainingTrace'

export const DEFAULT_TRACE_INPUT_DIR = 'data/entrenamiento/heuristicas'
export const DEFAULT_QTABLE_OUTPUT_PATH = 'data/entrenamiento/qtable/qtable_from_heuristics.json'
export const LARGE_TERRITORY_DIFFERENCE = 15
export const NORMAL_VICTORY_REWARD = 0.3
export const LARGE_VICTORY_REWARD = 0.5

type QTableSnapshot = Record<string, number>

function getOpponent(player: Player): Player {
  return player === 'R' ? 'B' : 'R'
}

function getRewardForVictory(territoryDiff: number): number {
  return territoryDiff >= LARGE_TERRITORY_DIFFERENCE ? LARGE_VICTORY_REWARD : NORMAL_VICTORY_REWARD
}

export function buildQTableFromWinningTraces(
  traces: TrainingTraceGameRecord[],
): QTableSnapshot {
  const qTable: QTableSnapshot = {}

  for (const trace of traces) {
    if (!trace.winner || trace.winner === 'tie') continue

    const winner = trace.winner as Player
    const loser = getOpponent(winner)
    const winnerScore = trace.finalScore[winner] ?? 0
    const loserScore = trace.finalScore[loser] ?? 0
    const territoryDiff = winnerScore - loserScore
    const reward = getRewardForVictory(territoryDiff)

    for (const action of trace.actions) {
      if (action.player !== winner) continue
      const key = `${action.stateKey}|||${action.actionKey}`
      qTable[key] = (qTable[key] ?? 0) + reward
    }
  }

  return qTable
}

export function importWinningTracesToQTable(
  inputDir = DEFAULT_TRACE_INPUT_DIR,
  outputPath = DEFAULT_QTABLE_OUTPUT_PATH,
): QTableSnapshot {
  const absoluteInputDir = path.resolve(inputDir)
  const absoluteOutputPath = path.resolve(outputPath)

  const traceFiles = readdirSync(absoluteInputDir)
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(absoluteInputDir, file))

  const traces = traceFiles.map((file) => JSON.parse(readFileSync(file, 'utf8')) as TrainingTraceGameRecord)
  const qTable = buildQTableFromWinningTraces(traces)

  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true })
  writeFileSync(absoluteOutputPath, `${JSON.stringify(qTable, null, 2)}\n`, 'utf8')

  return qTable
}

function isDirectExecution(): boolean {
  if (typeof process === 'undefined' || !process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectExecution()) {
  const result = importWinningTracesToQTable()
  console.log(`[importWinningTracesToQTable] Q-table generated with ${Object.keys(result).length} entries.`)
  console.log(`[importWinningTracesToQTable] Output: ${DEFAULT_QTABLE_OUTPUT_PATH}`)
}
