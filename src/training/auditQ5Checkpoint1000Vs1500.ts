import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Player, PlayerAction } from '@/lib/types'

type FlatQTable = Record<string, number>

export const Q5_AUDIT_1000_VS_1500_DIR = path.join(
  'data/entrenamiento/q5/hybrid/auditoria_q5_1000_vs_1500',
)

const Q5_1000_QTABLE_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json'
const Q5_1500_QTABLE_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1500/qtable_q5_hybrid_final_1500.json'
const Q5_INITIAL_BUILD_SUMMARY_PATH =
  'data/entrenamiento/q5/heuristic_initial_qtable/build_summary.json'
const Q5_500_UPDATE_LOG_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_500/q_update_log.jsonl'
const Q5_1000_UPDATE_LOG_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1000/q_update_log.jsonl'
const Q5_1500_UPDATE_LOG_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1500/q_update_log.jsonl'
const Q5_1500_METADATA_PATH = 'data/entrenamiento/q5/hybrid/final_checkpoint_1500/metadata.json'
const Q5_VS_HEURISTIC_LOG_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1500/q_vs_heuristic_decision_log.jsonl'
const Q5_EVAL_SUMMARY_PATH =
  'data/entrenamiento/q5/hybrid/evaluacion_checkpoint_1000_vs_1500/q5_1000_vs_1500_summary.json'

interface BuildSummaryEntry {
  stateActionKey: string
  observations: number
}

interface QUpdateLogEntry {
  game: number
  stateActionKey: string
  oldQ: number
  newQ: number
  reward: number
  appliedDelta: number
  opponent: 'random' | 'heuristic'
  color: Player
  terminal: boolean
  rewardComponent: 'intermediate' | 'final'
}

interface QVsHeuristicLogEntry {
  game: number
  opponent: 'random' | 'heuristic'
  color: Player
  heuristicAction: PlayerAction
  qAction: PlayerAction
  executedAction: PlayerAction
  heuristicKey: string
  qKey: string
  heuristicQ: number
  qValue: number
  qConfidence: number
  margin: number
  finalResultForQ5?: 'win' | 'loss' | 'tie'
  finalTerritoryDiff?: number
}

interface GameMetadata {
  game: number
  opponent: 'random' | 'heuristic'
  learningColor: Player
  resultForQ5: 'win' | 'loss' | 'tie'
  territoryDiff: number
}

interface KeyUpdateStats {
  updates: number
  positiveUpdates: number
  negativeUpdates: number
  zeroUpdates: number
  randomUpdates: number
  heuristicUpdates: number
  finalRewardUpdates: number
  intermediateRewardUpdates: number
  winUpdates: number
  lossUpdates: number
  tieUpdates: number
}

interface QValueChangeRow {
  stateActionKey: string
  stateKey: string
  actionKey: string
  q1000: number | null
  q1500: number | null
  status: 'common' | 'new' | 'disappeared'
  delta: number | null
  absDelta: number | null
  signChange: 'positive_to_negative' | 'negative_to_positive' | 'none' | 'not_applicable'
  confidence1000: number
  confidence1500: number
  updates1500: number
  positiveUpdates1500: number
  negativeUpdates1500: number
  randomUpdates1500: number
  heuristicUpdates1500: number
  finalRewardUpdates1500: number
  intermediateRewardUpdates1500: number
  winUpdates1500: number
  lossUpdates1500: number
  tieUpdates1500: number
}

interface ThresholdTransitionRow {
  qKey: string
  heuristicKey: string
  opponent: 'random' | 'heuristic'
  color: Player
  game: number
  q1000: number
  q1500: number
  heuristic1000: number
  heuristic1500: number
  qDelta: number
  heuristicDelta: number
  margin1000: number
  margin1500: number
  confidence1000: number
  confidence1500: number
  passC1000: boolean
  passC1500: boolean
  passE1000: boolean
  passE1500: boolean
  transitionC: 'kept' | 'lost' | 'gained' | 'never'
  transitionE: 'kept' | 'lost' | 'gained' | 'never'
  likelyLossCause: string
  finalResultForQ5?: 'win' | 'loss' | 'tie'
  finalTerritoryDiff?: number
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(path.resolve(filePath), 'utf8')) as T
}

function readQTable(filePath: string): FlatQTable {
  return readJson<FlatQTable>(filePath)
}

function readJsonl<T>(filePath: string): T[] {
  const text = readFileSync(path.resolve(filePath), 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line) => JSON.parse(line) as T)
}

function hashFile(filePath: string): string {
  return createHash('sha256')
    .update(readFileSync(path.resolve(filePath)))
    .digest('hex')
}

function splitStateActionKey(key: string): { stateKey: string; actionKey: string } {
  const [stateKey, actionKey] = key.split('|||')
  return { stateKey: stateKey ?? '', actionKey: actionKey ?? '' }
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function stats(values: number[]) {
  if (values.length === 0)
    return { count: 0, mean: 0, median: 0, min: 0, max: 0, standardDeviation: 0 }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return {
    count: values.length,
    mean: round(mean),
    median: round(median(values)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    standardDeviation: round(Math.sqrt(variance)),
  }
}

function valueBucket(value: number): string {
  if (value < -2) return '< -2'
  if (value < -1) return '[-2, -1)'
  if (value < -0.5) return '[-1, -0.5)'
  if (value < 0) return '[-0.5, 0)'
  if (value === 0) return '0'
  if (value <= 0.5) return '(0, 0.5]'
  if (value <= 1) return '(0.5, 1]'
  if (value <= 2) return '(1, 2]'
  return '> 2'
}

function histogram(values: number[]): Record<string, number> {
  const buckets = [
    '< -2',
    '[-2, -1)',
    '[-1, -0.5)',
    '[-0.5, 0)',
    '0',
    '(0, 0.5]',
    '(0.5, 1]',
    '(1, 2]',
    '> 2',
  ]
  const result = Object.fromEntries(buckets.map((bucket) => [bucket, 0])) as Record<string, number>
  for (const value of values) result[valueBucket(value)]++
  return result
}

function confidenceBucket(value: number): string {
  if (value === 0) return '0'
  if (value === 1) return '1'
  if (value <= 5) return '2-5'
  if (value <= 20) return '6-20'
  return '>20'
}

function countConfidence(values: number[]): Record<string, number> {
  const result = { '0': 0, '1': 0, '2-5': 0, '6-20': 0, '>20': 0 }
  for (const value of values) result[confidenceBucket(value) as keyof typeof result]++
  return result
}

function addCount(map: Map<string, number>, key: string, count = 1): void {
  map.set(key, (map.get(key) ?? 0) + count)
}

function buildObservationMap(entries: BuildSummaryEntry[]): Map<string, number> {
  return new Map(entries.map((entry) => [entry.stateActionKey, entry.observations]))
}

function buildUpdateCountMap(logs: QUpdateLogEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const log of logs) addCount(counts, log.stateActionKey)
  return counts
}

function getConfidence(
  key: string,
  observations: Map<string, number>,
  updates: Map<string, number>,
): number {
  return Math.max(observations.get(key) ?? 0, updates.get(key) ?? 0)
}

function buildUpdateStats(
  logs: QUpdateLogEntry[],
  games: Map<number, GameMetadata>,
): Map<string, KeyUpdateStats> {
  const result = new Map<string, KeyUpdateStats>()
  for (const log of logs) {
    const current = result.get(log.stateActionKey) ?? {
      updates: 0,
      positiveUpdates: 0,
      negativeUpdates: 0,
      zeroUpdates: 0,
      randomUpdates: 0,
      heuristicUpdates: 0,
      finalRewardUpdates: 0,
      intermediateRewardUpdates: 0,
      winUpdates: 0,
      lossUpdates: 0,
      tieUpdates: 0,
    }
    current.updates++
    if (log.appliedDelta > 0) current.positiveUpdates++
    else if (log.appliedDelta < 0) current.negativeUpdates++
    else current.zeroUpdates++
    if (log.opponent === 'random') current.randomUpdates++
    else current.heuristicUpdates++
    if (log.rewardComponent === 'final') current.finalRewardUpdates++
    else current.intermediateRewardUpdates++
    const game = games.get(log.game)
    if (game?.resultForQ5 === 'win') current.winUpdates++
    else if (game?.resultForQ5 === 'loss') current.lossUpdates++
    else if (game?.resultForQ5 === 'tie') current.tieUpdates++
    result.set(log.stateActionKey, current)
  }
  return result
}

function emptyUpdateStats(): KeyUpdateStats {
  return {
    updates: 0,
    positiveUpdates: 0,
    negativeUpdates: 0,
    zeroUpdates: 0,
    randomUpdates: 0,
    heuristicUpdates: 0,
    finalRewardUpdates: 0,
    intermediateRewardUpdates: 0,
    winUpdates: 0,
    lossUpdates: 0,
    tieUpdates: 0,
  }
}

function buildChangeRows(params: {
  q1000: FlatQTable
  q1500: FlatQTable
  confidence1000: Map<string, number>
  confidence1500: Map<string, number>
  updateStats1500: Map<string, KeyUpdateStats>
}): QValueChangeRow[] {
  const keys = new Set([...Object.keys(params.q1000), ...Object.keys(params.q1500)])
  const rows: QValueChangeRow[] = []
  keys.forEach((key) => {
    const q1000 = params.q1000[key]
    const q1500 = params.q1500[key]
    const status = q1000 === undefined ? 'new' : q1500 === undefined ? 'disappeared' : 'common'
    const delta = q1000 !== undefined && q1500 !== undefined ? q1500 - q1000 : null
    const signChange =
      q1000 === undefined || q1500 === undefined
        ? 'not_applicable'
        : q1000 > 0 && q1500 < 0
          ? 'positive_to_negative'
          : q1000 < 0 && q1500 > 0
            ? 'negative_to_positive'
            : 'none'
    const split = splitStateActionKey(key)
    const updateStats = params.updateStats1500.get(key) ?? emptyUpdateStats()
    rows.push({
      stateActionKey: key,
      stateKey: split.stateKey,
      actionKey: split.actionKey,
      q1000: q1000 ?? null,
      q1500: q1500 ?? null,
      status,
      delta,
      absDelta: delta === null ? null : Math.abs(delta),
      signChange,
      confidence1000: params.confidence1000.get(key) ?? 0,
      confidence1500: params.confidence1500.get(key) ?? 0,
      updates1500: updateStats.updates,
      positiveUpdates1500: updateStats.positiveUpdates,
      negativeUpdates1500: updateStats.negativeUpdates,
      randomUpdates1500: updateStats.randomUpdates,
      heuristicUpdates1500: updateStats.heuristicUpdates,
      finalRewardUpdates1500: updateStats.finalRewardUpdates,
      intermediateRewardUpdates1500: updateStats.intermediateRewardUpdates,
      winUpdates1500: updateStats.winUpdates,
      lossUpdates1500: updateStats.lossUpdates,
      tieUpdates1500: updateStats.tieUpdates,
    })
  })
  return rows
}

function thresholdPass(
  confidence: number,
  margin: number,
  minConfidence: number,
  minMargin: number,
): boolean {
  return confidence >= minConfidence && margin >= minMargin
}

function transition(before: boolean, after: boolean): 'kept' | 'lost' | 'gained' | 'never' {
  if (before && after) return 'kept'
  if (before && !after) return 'lost'
  if (!before && after) return 'gained'
  return 'never'
}

function likelyLossCause(row: {
  passC1000: boolean
  passC1500: boolean
  confidence1500: number
  margin1500: number
  qDelta: number
  heuristicDelta: number
}): string {
  if (!row.passC1000 || row.passC1500) return 'not_lost_c'
  if (row.confidence1500 < 5) return 'lack_confidence'
  if (row.margin1500 >= 0.25) return 'unknown'
  if (row.qDelta < 0 && row.heuristicDelta > 0) return 'lower_q_and_higher_heuristic'
  if (row.qDelta < 0) return 'lower_q'
  if (row.heuristicDelta > 0) return 'higher_heuristic'
  return 'margin_insufficient_without_lower_q_or_higher_heuristic'
}

function buildThresholdRows(params: {
  q1000: FlatQTable
  q1500: FlatQTable
  confidence1000: Map<string, number>
  confidence1500: Map<string, number>
  substitutions: QVsHeuristicLogEntry[]
}): ThresholdTransitionRow[] {
  return params.substitutions.map((entry) => {
    const q1000 = params.q1000[entry.qKey] ?? 0
    const q1500 = params.q1500[entry.qKey] ?? 0
    const heuristic1000 = params.q1000[entry.heuristicKey] ?? 0
    const heuristic1500 = params.q1500[entry.heuristicKey] ?? 0
    const confidence1000 = getConfidence(entry.qKey, new Map(), params.confidence1000)
    const confidence1500 = getConfidence(entry.qKey, new Map(), params.confidence1500)
    const margin1000 = q1000 - heuristic1000
    const margin1500 = q1500 - heuristic1500
    const passC1000 = thresholdPass(confidence1000, margin1000, 5, 0.25)
    const passC1500 = thresholdPass(confidence1500, margin1500, 5, 0.25)
    const passE1000 = thresholdPass(confidence1000, margin1000, 10, 0.5)
    const passE1500 = thresholdPass(confidence1500, margin1500, 10, 0.5)
    const base = {
      qKey: entry.qKey,
      heuristicKey: entry.heuristicKey,
      opponent: entry.opponent,
      color: entry.color,
      game: entry.game,
      q1000,
      q1500,
      heuristic1000,
      heuristic1500,
      qDelta: q1500 - q1000,
      heuristicDelta: heuristic1500 - heuristic1000,
      margin1000,
      margin1500,
      confidence1000,
      confidence1500,
      passC1000,
      passC1500,
      passE1000,
      passE1500,
      transitionC: transition(passC1000, passC1500),
      transitionE: transition(passE1000, passE1500),
      finalResultForQ5: entry.finalResultForQ5,
      finalTerritoryDiff: entry.finalTerritoryDiff,
    }
    return {
      ...base,
      likelyLossCause: likelyLossCause(base),
    }
  })
}

function summarizeThresholdRows(rows: ThresholdTransitionRow[]) {
  const count = (predicate: (row: ThresholdTransitionRow) => boolean) =>
    rows.filter(predicate).length
  const byCause = new Map<string, number>()
  for (const row of rows) addCount(byCause, row.likelyLossCause)
  const byOpponent = {
    random: {
      rows: count((row) => row.opponent === 'random'),
      lostC: count((row) => row.opponent === 'random' && row.transitionC === 'lost'),
      gainedC: count((row) => row.opponent === 'random' && row.transitionC === 'gained'),
    },
    heuristic: {
      rows: count((row) => row.opponent === 'heuristic'),
      lostC: count((row) => row.opponent === 'heuristic' && row.transitionC === 'lost'),
      gainedC: count((row) => row.opponent === 'heuristic' && row.transitionC === 'gained'),
    },
  }
  return {
    observedCandidateRows: rows.length,
    passC1000: count((row) => row.passC1000),
    passC1500: count((row) => row.passC1500),
    passE1000: count((row) => row.passE1000),
    passE1500: count((row) => row.passE1500),
    transitionC: {
      kept: count((row) => row.transitionC === 'kept'),
      lost: count((row) => row.transitionC === 'lost'),
      gained: count((row) => row.transitionC === 'gained'),
      never: count((row) => row.transitionC === 'never'),
    },
    transitionE: {
      kept: count((row) => row.transitionE === 'kept'),
      lost: count((row) => row.transitionE === 'lost'),
      gained: count((row) => row.transitionE === 'gained'),
      never: count((row) => row.transitionE === 'never'),
    },
    likelyLossCauses: Object.fromEntries(byCause),
    byOpponent,
    marginStats: {
      q1000: stats(rows.map((row) => row.margin1000)),
      q1500: stats(rows.map((row) => row.margin1500)),
      delta: stats(rows.map((row) => row.margin1500 - row.margin1000)),
    },
  }
}

function summarizeUpdates(logs: QUpdateLogEntry[], games: Map<number, GameMetadata>) {
  const groups = {
    positive: logs.filter((log) => log.appliedDelta > 0),
    negative: logs.filter((log) => log.appliedDelta < 0),
    zero: logs.filter((log) => log.appliedDelta === 0),
  }
  const summarize = (rows: QUpdateLogEntry[]) => ({
    updates: rows.length,
    random: rows.filter((row) => row.opponent === 'random').length,
    heuristic: rows.filter((row) => row.opponent === 'heuristic').length,
    intermediate: rows.filter((row) => row.rewardComponent === 'intermediate').length,
    final: rows.filter((row) => row.rewardComponent === 'final').length,
    winGame: rows.filter((row) => games.get(row.game)?.resultForQ5 === 'win').length,
    lossGame: rows.filter((row) => games.get(row.game)?.resultForQ5 === 'loss').length,
    tieGame: rows.filter((row) => games.get(row.game)?.resultForQ5 === 'tie').length,
    appliedDelta: stats(rows.map((row) => row.appliedDelta)),
    reward: stats(rows.map((row) => row.reward)),
  })
  return {
    positive: summarize(groups.positive),
    negative: summarize(groups.negative),
    zero: summarize(groups.zero),
  }
}

function summarizeSubstitutions(rows: QVsHeuristicLogEntry[]) {
  const summarize = (selected: QVsHeuristicLogEntry[]) => ({
    count: selected.length,
    wins: selected.filter((row) => row.finalResultForQ5 === 'win').length,
    losses: selected.filter((row) => row.finalResultForQ5 === 'loss').length,
    ties: selected.filter((row) => row.finalResultForQ5 === 'tie').length,
    qValue: stats(selected.map((row) => row.qValue)),
    heuristicQ: stats(selected.map((row) => row.heuristicQ)),
    margin: stats(selected.map((row) => row.margin)),
    finalTerritoryDiff: stats(selected.map((row) => row.finalTerritoryDiff ?? 0)),
  })
  return {
    all: summarize(rows),
    winning: summarize(rows.filter((row) => row.finalResultForQ5 === 'win')),
    losing: summarize(rows.filter((row) => row.finalResultForQ5 === 'loss')),
    byOpponent: {
      random: summarize(rows.filter((row) => row.opponent === 'random')),
      heuristic: summarize(rows.filter((row) => row.opponent === 'heuristic')),
    },
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n'))
    return `"${text.replace(/"/g, '""')}"`
  return text
}

function rowsToCsv<T extends Record<string, unknown>>(rows: T[], headers: string[]): string {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n')
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function writeCsv<T extends Record<string, unknown>>(
  filePath: string,
  rows: T[],
  headers: string[],
): void {
  writeFileSync(filePath, `${rowsToCsv(rows, headers)}\n`, 'utf8')
}

// Solo los campos del summary que aparecen en el informe de texto.
interface AuditReportSummary {
  qTable: {
    entries: { common: number; new: number; disappeared: number }
    valueDirection: { increased: number; decreased: number; unchanged: number }
    signChanges: { positiveToNegative: number; negativeToPositive: number }
  }
  thresholdTransitions: {
    passC1000: number
    passC1500: number
    transitionC: { lost: number; gained: number }
  }
  conclusion: { primaryInterventionDropCause: string; text: string }
}

function writeReport(filePath: string, summary: AuditReportSummary): void {
  const lines = [
    '# Auditoria Q5 1000 vs 1500',
    '',
    '## Resumen',
    `- Entradas comunes: ${summary.qTable.entries.common}`,
    `- Entradas nuevas en Q5-1500: ${summary.qTable.entries.new}`,
    `- Entradas desaparecidas: ${summary.qTable.entries.disappeared}`,
    `- Cambios: ${summary.qTable.valueDirection.increased} suben, ${summary.qTable.valueDirection.decreased} bajan, ${summary.qTable.valueDirection.unchanged} iguales`,
    `- Cambios de signo: ${summary.qTable.signChanges.positiveToNegative} positivo->negativo, ${summary.qTable.signChanges.negativeToPositive} negativo->positivo`,
    '',
    '## Filtros observados Q vs heuristica',
    `- C (confianza 5, margen 0.25) en Q5-1000: ${summary.thresholdTransitions.passC1000}`,
    `- C (confianza 5, margen 0.25) en Q5-1500: ${summary.thresholdTransitions.passC1500}`,
    `- Perdidos C: ${summary.thresholdTransitions.transitionC.lost}`,
    `- Ganados C: ${summary.thresholdTransitions.transitionC.gained}`,
    `- Causa dominante de perdida: ${summary.conclusion.primaryInterventionDropCause}`,
    '',
    '## Conclusion',
    summary.conclusion.text,
    '',
    '## Limitaciones',
    'Los margenes contra la accion heuristica solo se pueden auditar directamente en estados presentes en q_vs_heuristic_decision_log.jsonl, porque ese log contiene heuristicKey y qKey comparables.',
  ]
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

export async function auditQ5Checkpoint1000Vs1500(
  options: { outputDir?: string; overwrite?: boolean } = {},
) {
  const outputDir = path.resolve(options.outputDir ?? Q5_AUDIT_1000_VS_1500_DIR)
  mkdirSync(outputDir, { recursive: true })
  const hash1000Before = hashFile(Q5_1000_QTABLE_PATH)
  const hash1500Before = hashFile(Q5_1500_QTABLE_PATH)
  const q1000 = readQTable(Q5_1000_QTABLE_PATH)
  const q1500 = readQTable(Q5_1500_QTABLE_PATH)
  const buildSummary = readJson<{ entries: BuildSummaryEntry[] }>(Q5_INITIAL_BUILD_SUMMARY_PATH)
  const observations = buildObservationMap(buildSummary.entries)
  const updateLogs500 = readJsonl<QUpdateLogEntry>(Q5_500_UPDATE_LOG_PATH)
  const updateLogs1000 = readJsonl<QUpdateLogEntry>(Q5_1000_UPDATE_LOG_PATH)
  const updateLogs1500 = readJsonl<QUpdateLogEntry>(Q5_1500_UPDATE_LOG_PATH)
  const metadata1500 = readJson<{ games: GameMetadata[] }>(Q5_1500_METADATA_PATH)
  const games1500 = new Map(metadata1500.games.map((game) => [game.game, game]))
  const substitutions1500 = readJsonl<QVsHeuristicLogEntry>(Q5_VS_HEURISTIC_LOG_PATH)
  const evaluationSummary = readJson<unknown>(Q5_EVAL_SUMMARY_PATH)
  const updateCounts1000 = buildUpdateCountMap([...updateLogs500, ...updateLogs1000])
  const updateCounts1500 = buildUpdateCountMap([
    ...updateLogs500,
    ...updateLogs1000,
    ...updateLogs1500,
  ])
  const confidence1000 = new Map<string, number>()
  const confidence1500 = new Map<string, number>()
  const confidenceKeys = new Set([
    ...Object.keys(q1000),
    ...Object.keys(q1500),
    ...observations.keys(),
    ...updateCounts1500.keys(),
  ])
  confidenceKeys.forEach((key) => {
    confidence1000.set(key, getConfidence(key, observations, updateCounts1000))
    confidence1500.set(key, getConfidence(key, observations, updateCounts1500))
  })
  const updateStats1500 = buildUpdateStats(updateLogs1500, games1500)
  const changeRows = buildChangeRows({
    q1000,
    q1500,
    confidence1000,
    confidence1500,
    updateStats1500,
  })
  const commonRows = changeRows.filter((row) => row.status === 'common' && row.delta !== null)
  const thresholdRows = buildThresholdRows({
    q1000,
    q1500,
    confidence1000,
    confidence1500,
    substitutions: substitutions1500,
  })
  const largestDecreases = [...commonRows]
    .filter((row) => row.delta !== null)
    .sort((left, right) => (left.delta ?? 0) - (right.delta ?? 0))
    .slice(0, 100)
  const largestIncreases = [...commonRows]
    .filter((row) => row.delta !== null)
    .sort((left, right) => (right.delta ?? 0) - (left.delta ?? 0))
    .slice(0, 100)
  const highUpdateDeterioration = commonRows
    .filter(
      (row) => (row.updates1500 >= 5 || row.heuristicUpdates1500 >= 3) && (row.delta ?? 0) < 0,
    )
    .sort(
      (left, right) =>
        right.updates1500 - left.updates1500 || (left.delta ?? 0) - (right.delta ?? 0),
    )
    .slice(0, 50)
  const valueDirection = {
    increased: commonRows.filter((row) => (row.delta ?? 0) > 0).length,
    decreased: commonRows.filter((row) => (row.delta ?? 0) < 0).length,
    unchanged: commonRows.filter((row) => (row.delta ?? 0) === 0).length,
  }
  const thresholdSummary = summarizeThresholdRows(thresholdRows)
  const lossCauseEntries = Object.entries(thresholdSummary.likelyLossCauses).filter(
    ([cause]) => cause !== 'not_lost_c',
  )
  const primaryInterventionDropCause =
    lossCauseEntries.sort((left, right) => Number(right[1]) - Number(left[1]))[0]?.[0] ??
    'no_lost_candidates'
  const summary = {
    createdAt: new Date().toISOString(),
    inputs: {
      q1000: Q5_1000_QTABLE_PATH,
      q1500: Q5_1500_QTABLE_PATH,
      qUpdateLog1500: Q5_1500_UPDATE_LOG_PATH,
      qVsHeuristicLog1500: Q5_VS_HEURISTIC_LOG_PATH,
      evaluationSummary: Q5_EVAL_SUMMARY_PATH,
    },
    hashes: {
      q1000Before: hash1000Before,
      q1000After: hashFile(Q5_1000_QTABLE_PATH),
      q1500Before: hash1500Before,
      q1500After: hashFile(Q5_1500_QTABLE_PATH),
      qTablesChangedDuringAudit:
        hash1000Before !== hashFile(Q5_1000_QTABLE_PATH) ||
        hash1500Before !== hashFile(Q5_1500_QTABLE_PATH),
    },
    qTable: {
      entries: {
        q1000: Object.keys(q1000).length,
        q1500: Object.keys(q1500).length,
        common: commonRows.length,
        new: changeRows.filter((row) => row.status === 'new').length,
        disappeared: changeRows.filter((row) => row.status === 'disappeared').length,
      },
      valueDirection,
      changeStats: stats(commonRows.map((row) => row.delta ?? 0)),
      absChangeStats: stats(commonRows.map((row) => row.absDelta ?? 0)),
      signChanges: {
        positiveToNegative: commonRows.filter((row) => row.signChange === 'positive_to_negative')
          .length,
        negativeToPositive: commonRows.filter((row) => row.signChange === 'negative_to_positive')
          .length,
      },
      valueDistribution: {
        q1000: histogram(Object.values(q1000)),
        q1500: histogram(Object.values(q1500)),
      },
      confidenceDistribution: {
        q1000: countConfidence([...confidence1000.values()]),
        q1500: countConfidence([...confidence1500.values()]),
      },
    },
    updates1500: summarizeUpdates(updateLogs1500, games1500),
    substitutions1500: summarizeSubstitutions(substitutions1500),
    thresholdTransitions: thresholdSummary,
    highUpdateDeterioration: highUpdateDeterioration.slice(0, 20),
    evaluationSummary,
    conclusion: {
      primaryInterventionDropCause,
      text:
        primaryInterventionDropCause.includes('lower_q') ||
        primaryInterventionDropCause.includes('higher_heuristic')
          ? 'Q5-1500 reduce intervenciones porque varios candidatos observados pierden margen frente a la heuristica; la perdida se explica principalmente por cambios relativos entre el valor Q aprendido y el valor de la accion heuristica, no por falta de confianza.'
          : 'Q5-1500 reduce intervenciones en los candidatos observados por margen insuficiente; no hay evidencia de que la confianza sea la causa principal.',
      recommendedSingleVariable:
        'reducir alpha efectivo o el clamp de actualizacion para estados/acciones heredados con confianza media-alta',
      recommendedRestartPoint: 'q5_1000',
    },
  }
  if (summary.hashes.qTablesChangedDuringAudit) throw new Error('Q-table changed during audit')

  const changeHeaders = [
    'stateActionKey',
    'stateKey',
    'actionKey',
    'q1000',
    'q1500',
    'status',
    'delta',
    'absDelta',
    'signChange',
    'confidence1000',
    'confidence1500',
    'updates1500',
    'positiveUpdates1500',
    'negativeUpdates1500',
    'randomUpdates1500',
    'heuristicUpdates1500',
    'finalRewardUpdates1500',
    'intermediateRewardUpdates1500',
    'winUpdates1500',
    'lossUpdates1500',
    'tieUpdates1500',
  ]
  const thresholdHeaders = [
    'qKey',
    'heuristicKey',
    'opponent',
    'color',
    'game',
    'q1000',
    'q1500',
    'heuristic1000',
    'heuristic1500',
    'qDelta',
    'heuristicDelta',
    'margin1000',
    'margin1500',
    'confidence1000',
    'confidence1500',
    'passC1000',
    'passC1500',
    'passE1000',
    'passE1500',
    'transitionC',
    'transitionE',
    'likelyLossCause',
    'finalResultForQ5',
    'finalTerritoryDiff',
  ]
  writeJson(path.join(outputDir, 'audit_summary.json'), summary)
  writeCsv(
    path.join(outputDir, 'q_value_changes.csv'),
    changeRows as unknown as Record<string, unknown>[],
    changeHeaders,
  )
  writeCsv(
    path.join(outputDir, 'threshold_transitions.csv'),
    thresholdRows as unknown as Record<string, unknown>[],
    thresholdHeaders,
  )
  writeCsv(
    path.join(outputDir, 'largest_decreases.csv'),
    largestDecreases as unknown as Record<string, unknown>[],
    changeHeaders,
  )
  writeCsv(
    path.join(outputDir, 'largest_increases.csv'),
    largestIncreases as unknown as Record<string, unknown>[],
    changeHeaders,
  )
  writeReport(path.join(outputDir, 'audit_report.md'), summary)
  return { summary, changeRows, thresholdRows }
}

async function main(): Promise<void> {
  const result = await auditQ5Checkpoint1000Vs1500()
  console.log(`[auditQ5Checkpoint1000Vs1500] changed rows: ${result.changeRows.length}`)
  console.log(`[auditQ5Checkpoint1000Vs1500] threshold rows: ${result.thresholdRows.length}`)
  console.log(`[auditQ5Checkpoint1000Vs1500] output: ${Q5_AUDIT_1000_VS_1500_DIR}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
