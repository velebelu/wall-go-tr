import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Player, PlayerAction } from '@/lib/types'
import {
  extractHumanMCTSDecisionFixture,
  parseHumanMCTSTrace,
  replayHumanMCTSTrace,
  type HumanMCTSTraceDecisionV1,
  type HumanMCTSTraceV1,
  type TracePositionMetrics,
} from '@/utils/humanMCTSTrace'

export type HumanMCTSDecisionCategory =
  | 'tactical-change'
  | 'low-confidence'
  | 'large-score-change'
  | 'territory-swing'
  | 'mobility-risk'
  | 'high-cost'
  | 'possible-critical-decision'

export interface HumanMCTSAnalysisThresholds {
  lowConfidenceMaxVisitGap: number
  lowConfidenceMaxValueGap: number
  lowConfidenceMaxSelectedVisitShare: number
  largeScoreChange: number
  territorySwing: number
  accessibleTerritorySwing: number
  ownMobilityDrop: number
  opponentMobilityGain: number
  trappedPiecesIncrease: number
  highSearchTimeMs: number
  highVerificationTimeMs: number
  criticalSignalCount: number
}

export const DEFAULT_HUMAN_MCTS_ANALYSIS_THRESHOLDS: Readonly<HumanMCTSAnalysisThresholds> =
  Object.freeze({
    lowConfidenceMaxVisitGap: 1,
    lowConfidenceMaxValueGap: 0.1,
    lowConfidenceMaxSelectedVisitShare: 0.12,
    largeScoreChange: 10,
    territorySwing: 5,
    accessibleTerritorySwing: 5,
    ownMobilityDrop: 4,
    opponentMobilityGain: 4,
    trappedPiecesIncrease: 1,
    highSearchTimeMs: 750,
    highVerificationTimeMs: 125,
    criticalSignalCount: 2,
  })

export interface HumanMCTSDecisionAnalysis {
  turnIndex: number
  actorDecisionIndex: number
  phase: HumanMCTSTraceDecisionV1['phase']
  actionOriginal?: PlayerAction
  actionFinal: PlayerAction
  tacticalSelectionChanged: boolean
  selectedVisits: number
  selectedValue: number
  rootVisits: number
  selectedVisitShare: number
  topCandidateVisits: number
  secondCandidateVisits?: number
  visitGap: number | null
  topCandidateValue: number
  secondCandidateValue?: number
  valueGap: number | null
  originalScore?: number
  verifiedScore?: number
  scoreChange: number | null
  worstOpponentReplyScore?: number
  immediateTerminalLossAvoided: boolean
  territoryBefore: Record<Player, number>
  territoryAfter: Record<Player, number>
  territoryDelta: Record<Player, number>
  accessibleBefore: Record<Player, number>
  accessibleAfter: Record<Player, number>
  accessibleDelta: Record<Player, number>
  mobilityBefore: TracePositionMetrics['mobility']
  mobilityAfter: TracePositionMetrics['mobility']
  ownMobilityDelta: number
  opponentMobilityDelta: number
  ownTrappedPiecesDelta: number
  searchTimeMs?: number
  verificationTimeMs?: number
  legalActionCount: number
  rootCandidateCount: number
  categories: HumanMCTSDecisionCategory[]
  relevanceScore: number
  rankReasons: string[]
}

export interface HumanMCTSTraceAnalysis {
  schema: 'HumanMCTSTraceAnalysisV1'
  gameId: string
  thresholds: HumanMCTSAnalysisThresholds
  replay: ReturnType<typeof replayHumanMCTSTrace>
  game: {
    result?: NonNullable<HumanMCTSTraceV1['final']>['result']
    territory?: Record<Player, number>
    totalDecisions: number
    humanDecisions: number
    mctsDecisions: number
    mctsColor: Player
    humanColor: Player
  }
  summary: {
    averageMCTSTimeMs: number
    maximumMCTSTimeMs: number
    tacticalChanges: number
    lowConfidenceDecisions: number
    possibleCriticalDecisions: number
  }
  decisions: HumanMCTSDecisionAnalysis[]
  ranking: HumanMCTSDecisionAnalysis[]
}

export interface AnalyzeHumanMCTSTraceOptions {
  thresholds?: Partial<HumanMCTSAnalysisThresholds>
  outputDir?: string
  createdAt?: string
}

export function analyzeHumanMCTSTrace(
  trace: HumanMCTSTraceV1,
  thresholdOverrides: Partial<HumanMCTSAnalysisThresholds> = {},
): HumanMCTSTraceAnalysis {
  const replay = replayHumanMCTSTrace(trace)
  if (!replay.ok) {
    throw new Error(
      `Human-MCTS trace replay diverged at turn ${replay.divergence?.turnIndex}: ${replay.divergence?.kind}`,
    )
  }
  const thresholds = { ...DEFAULT_HUMAN_MCTS_ANALYSIS_THRESHOLDS, ...thresholdOverrides }
  validateThresholds(thresholds)
  const decisions = trace.decisions
    .filter(
      (
        decision,
      ): decision is HumanMCTSTraceDecisionV1 & {
        mcts: NonNullable<HumanMCTSTraceDecisionV1['mcts']>
      } => decision.actor === 'mcts' && decision.mcts !== undefined,
    )
    .map((decision) => analyzeDecision(decision, trace.metadata.mctsColor, thresholds))
  const ranking = [...decisions].sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      right.categories.length - left.categories.length ||
      left.turnIndex - right.turnIndex,
  )
  const times = decisions.map(
    (decision) => (decision.searchTimeMs ?? 0) + (decision.verificationTimeMs ?? 0),
  )
  return {
    schema: 'HumanMCTSTraceAnalysisV1',
    gameId: trace.metadata.gameId,
    thresholds,
    replay,
    game: {
      result: trace.final?.result,
      territory: trace.final?.territory,
      totalDecisions: trace.decisions.length,
      humanDecisions: trace.decisions.filter((decision) => decision.actor === 'human').length,
      mctsDecisions: decisions.length,
      mctsColor: trace.metadata.mctsColor,
      humanColor: trace.metadata.humanColor,
    },
    summary: {
      averageMCTSTimeMs: round(
        times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : 0,
      ),
      maximumMCTSTimeMs: round(times.length ? Math.max(...times) : 0),
      tacticalChanges: countCategory(decisions, 'tactical-change'),
      lowConfidenceDecisions: countCategory(decisions, 'low-confidence'),
      possibleCriticalDecisions: countCategory(decisions, 'possible-critical-decision'),
    },
    decisions,
    ranking,
  }
}

export function analyzeHumanMCTSTraceFile(
  tracePath: string,
  options: AnalyzeHumanMCTSTraceOptions = {},
): {
  analysis: HumanMCTSTraceAnalysis
  outputDir: string
  fixtureFiles: string[]
} {
  const resolvedTrace = path.resolve(tracePath)
  const source = readFileSync(resolvedTrace, 'utf8')
  const trace = parseHumanMCTSTrace(source)
  const analysis = analyzeHumanMCTSTrace(trace, options.thresholds)
  const outputDir = path.resolve(
    options.outputDir ??
      path.join('data/entrenamiento/mcts', `analisis_partida_humana_${trace.metadata.gameId}`),
  )
  const fixturesDir = path.join(outputDir, 'fixtures')
  mkdirSync(fixturesDir, { recursive: true })
  for (const existing of readdirSync(fixturesDir)) {
    if (existing.endsWith('.fixture.json')) unlinkSync(path.join(fixturesDir, existing))
  }
  const topThree = analysis.ranking.slice(0, 3)
  const fixtureFiles = topThree.map((decision, index) => {
    const fixture = extractHumanMCTSDecisionFixture(trace, decision.turnIndex)
    const fileName = `${index + 1}_turn_${decision.turnIndex}_mcts_${decision.actorDecisionIndex}.fixture.json`
    writeJson(path.join(fixturesDir, fileName), fixture)
    return path.join('fixtures', fileName)
  })
  writeJson(path.join(outputDir, 'human_mcts_trace_analysis.json'), analysis)
  writeFileSync(
    path.join(outputDir, 'human_mcts_decisions.csv'),
    `${decisionsCsv(analysis.decisions)}\n`,
    'utf8',
  )
  writeJson(path.join(outputDir, 'critical_decisions.json'), {
    gameId: analysis.gameId,
    note: 'Ranked diagnostic candidates; classification does not establish that an action was erroneous.',
    decisions: analysis.ranking.filter((decision) =>
      decision.categories.includes('possible-critical-decision'),
    ),
    topFixtureTurns: topThree.map((decision) => decision.turnIndex),
  })
  writeFileSync(path.join(outputDir, 'analysis_report.md'), analysisReport(analysis), 'utf8')
  writeJson(path.join(outputDir, 'metadata.json'), {
    schema: 'HumanMCTSTraceAnalysisMetadataV1',
    createdAt: options.createdAt ?? new Date().toISOString(),
    source: {
      fileName: path.basename(resolvedTrace),
      bytes: statSync(resolvedTrace).size,
      sha256: createHash('sha256').update(source).digest('hex'),
      traceSchema: trace.schema,
      gameId: trace.metadata.gameId,
    },
    replay: analysis.replay,
    thresholds: analysis.thresholds,
    rankingMethod:
      'Weighted non-exclusive signals; deterministic tie-breakers: category count descending, turnIndex ascending.',
    fixtureFiles,
    git: {
      branch: gitValue(['branch', '--show-current']),
      commit: gitValue(['rev-parse', 'HEAD']),
    },
    disclaimer:
      'Signals identify candidates for later comparison; they do not prove that an MCTS action was wrong.',
  })
  return { analysis, outputDir, fixtureFiles }
}

function analyzeDecision(
  decision: HumanMCTSTraceDecisionV1 & {
    mcts: NonNullable<HumanMCTSTraceDecisionV1['mcts']>
  },
  mctsColor: Player,
  thresholds: HumanMCTSAnalysisThresholds,
): HumanMCTSDecisionAnalysis {
  const mcts = decision.mcts
  const opponent = mctsColor === 'R' ? 'B' : 'R'
  const candidates = [...mcts.rootCandidates].sort(
    (left, right) =>
      right.visits - left.visits ||
      right.value - left.value ||
      JSON.stringify(left.action).localeCompare(JSON.stringify(right.action)),
  )
  const top = candidates[0]
  const second = candidates[1]
  const visitGap = top && second ? top.visits - second.visits : null
  const valueGap = top && second ? top.value - second.value : null
  const selectedVisitShare = mcts.rootVisits ? mcts.selectedVisits / mcts.rootVisits : 0
  const originalScore = finiteNumber(mcts.originalScore)
  const verifiedScore = finiteNumber(mcts.verifiedScore)
  const worstOpponentReplyScore = finiteNumber(mcts.worstOpponentReplyScore)
  const scoreChange =
    originalScore !== undefined && verifiedScore !== undefined
      ? verifiedScore - originalScore
      : null
  const territoryDelta = deltaRecord(
    decision.metricsBefore.territory,
    decision.metricsAfter.territory,
  )
  const accessibleDelta = deltaRecord(
    decision.metricsBefore.accessibleTerritory,
    decision.metricsAfter.accessibleTerritory,
  )
  const ownMobilityDelta =
    decision.metricsAfter.mobility[mctsColor].totalDestinations -
    decision.metricsBefore.mobility[mctsColor].totalDestinations
  const opponentMobilityDelta =
    decision.metricsAfter.mobility[opponent].totalDestinations -
    decision.metricsBefore.mobility[opponent].totalDestinations
  const ownTrappedPiecesDelta =
    decision.metricsAfter.mobility[mctsColor].trapPieces -
    decision.metricsBefore.mobility[mctsColor].trapPieces
  const categories: HumanMCTSDecisionCategory[] = []
  const reasons: string[] = []
  if (mcts.tacticalSelectionChanged) {
    categories.push('tactical-change')
    reasons.push('La verificación táctica cambió la acción inicialmente seleccionada.')
  }
  const lowConfidence =
    (visitGap !== null && visitGap <= thresholds.lowConfidenceMaxVisitGap) ||
    (valueGap !== null && Math.abs(valueGap) <= thresholds.lowConfidenceMaxValueGap) ||
    selectedVisitShare <= thresholds.lowConfidenceMaxSelectedVisitShare
  if (lowConfidence) {
    categories.push('low-confidence')
    reasons.push(
      `Margen reducido: visitas=${formatNullable(visitGap)}, valor=${formatNullable(valueGap)}, cuota elegida=${round(selectedVisitShare)}.`,
    )
  }
  if (scoreChange !== null && Math.abs(scoreChange) >= thresholds.largeScoreChange) {
    categories.push('large-score-change')
    reasons.push(`La puntuación verificada cambió ${round(scoreChange)} puntos.`)
  }
  const territoryMagnitude = Math.max(
    Math.abs(territoryDelta[mctsColor]),
    Math.abs(territoryDelta[opponent]),
  )
  const accessibleMagnitude = Math.max(
    Math.abs(accessibleDelta[mctsColor]),
    Math.abs(accessibleDelta[opponent]),
  )
  if (
    territoryMagnitude >= thresholds.territorySwing ||
    accessibleMagnitude >= thresholds.accessibleTerritorySwing
  ) {
    categories.push('territory-swing')
    reasons.push(
      `Cambio territorial máximo=${territoryMagnitude}; accesible máximo=${accessibleMagnitude}.`,
    )
  }
  if (
    ownMobilityDelta <= -thresholds.ownMobilityDrop ||
    opponentMobilityDelta >= thresholds.opponentMobilityGain ||
    ownTrappedPiecesDelta >= thresholds.trappedPiecesIncrease
  ) {
    categories.push('mobility-risk')
    reasons.push(
      `Movilidad propia Δ=${ownMobilityDelta}, rival Δ=${opponentMobilityDelta}, bloqueadas propias Δ=${ownTrappedPiecesDelta}.`,
    )
  }
  if (
    (mcts.searchTimeMs ?? 0) >= thresholds.highSearchTimeMs ||
    (mcts.verificationTimeMs ?? 0) >= thresholds.highVerificationTimeMs
  ) {
    categories.push('high-cost')
    reasons.push(
      `Coste alto: búsqueda=${round(mcts.searchTimeMs ?? 0)} ms, verificación=${round(mcts.verificationTimeMs ?? 0)} ms.`,
    )
  }
  const baseSignalCount = categories.length
  if (baseSignalCount >= thresholds.criticalSignalCount || mcts.immediateTerminalLossAvoided) {
    categories.push('possible-critical-decision')
    reasons.push(
      `Combina ${baseSignalCount} señales diagnósticas${mcts.immediateTerminalLossAvoided ? ' y evitó una pérdida terminal inmediata' : ''}.`,
    )
  }
  const relevanceScore = round(
    Number(mcts.tacticalSelectionChanged) * 3 +
      Number(categories.includes('low-confidence')) +
      Number(categories.includes('large-score-change')) * 2 +
      Number(categories.includes('territory-swing')) * 2 +
      Number(categories.includes('mobility-risk')) * 2 +
      Number(categories.includes('high-cost')) +
      Number(mcts.immediateTerminalLossAvoided) * 3 +
      Math.min(2, Math.abs(scoreChange ?? 0) / Math.max(1, thresholds.largeScoreChange)) +
      Math.min(1, territoryMagnitude / Math.max(1, thresholds.territorySwing)) +
      Math.min(1, accessibleMagnitude / Math.max(1, thresholds.accessibleTerritorySwing)),
  )
  return {
    turnIndex: decision.turnIndex,
    actorDecisionIndex: decision.actorDecisionIndex,
    phase: decision.phase,
    actionOriginal: mcts.originalAction,
    actionFinal: mcts.finalAction,
    tacticalSelectionChanged: mcts.tacticalSelectionChanged ?? false,
    selectedVisits: mcts.selectedVisits,
    selectedValue: mcts.selectedValue,
    rootVisits: mcts.rootVisits,
    selectedVisitShare: round(selectedVisitShare),
    topCandidateVisits: top?.visits ?? 0,
    secondCandidateVisits: second?.visits,
    visitGap,
    topCandidateValue: top?.value ?? 0,
    secondCandidateValue: second?.value,
    valueGap: valueGap === null ? null : round(valueGap),
    originalScore,
    verifiedScore,
    scoreChange: scoreChange === null ? null : round(scoreChange),
    worstOpponentReplyScore,
    immediateTerminalLossAvoided: mcts.immediateTerminalLossAvoided ?? false,
    territoryBefore: decision.metricsBefore.territory,
    territoryAfter: decision.metricsAfter.territory,
    territoryDelta,
    accessibleBefore: decision.metricsBefore.accessibleTerritory,
    accessibleAfter: decision.metricsAfter.accessibleTerritory,
    accessibleDelta,
    mobilityBefore: decision.metricsBefore.mobility,
    mobilityAfter: decision.metricsAfter.mobility,
    ownMobilityDelta,
    opponentMobilityDelta,
    ownTrappedPiecesDelta,
    searchTimeMs: mcts.searchTimeMs,
    verificationTimeMs: mcts.verificationTimeMs,
    legalActionCount: decision.legalActions.length,
    rootCandidateCount: mcts.rootCandidates.length,
    categories,
    relevanceScore,
    rankReasons: reasons,
  }
}

function decisionsCsv(decisions: readonly HumanMCTSDecisionAnalysis[]): string {
  const headers = [
    'turnIndex',
    'actorDecisionIndex',
    'phase',
    'actionOriginal',
    'actionFinal',
    'tacticalSelectionChanged',
    'selectedVisits',
    'selectedValue',
    'rootVisits',
    'selectedVisitShare',
    'visitGap',
    'valueGap',
    'originalScore',
    'verifiedScore',
    'scoreChange',
    'worstOpponentReplyScore',
    'immediateTerminalLossAvoided',
    'territoryRBefore',
    'territoryRAfter',
    'territoryBBefore',
    'territoryBAfter',
    'accessibleRBefore',
    'accessibleRAfter',
    'accessibleBBefore',
    'accessibleBAfter',
    'mobilityRBefore',
    'mobilityRAfter',
    'mobilityBBefore',
    'mobilityBAfter',
    'searchTimeMs',
    'verificationTimeMs',
    'legalActionCount',
    'rootCandidateCount',
    'categories',
    'relevanceScore',
  ]
  const rows = decisions.map((decision) => [
    decision.turnIndex,
    decision.actorDecisionIndex,
    decision.phase,
    JSON.stringify(decision.actionOriginal),
    JSON.stringify(decision.actionFinal),
    decision.tacticalSelectionChanged,
    decision.selectedVisits,
    decision.selectedValue,
    decision.rootVisits,
    decision.selectedVisitShare,
    decision.visitGap ?? '',
    decision.valueGap ?? '',
    decision.originalScore ?? '',
    decision.verifiedScore ?? '',
    decision.scoreChange ?? '',
    decision.worstOpponentReplyScore ?? '',
    decision.immediateTerminalLossAvoided,
    decision.territoryBefore.R,
    decision.territoryAfter.R,
    decision.territoryBefore.B,
    decision.territoryAfter.B,
    decision.accessibleBefore.R,
    decision.accessibleAfter.R,
    decision.accessibleBefore.B,
    decision.accessibleAfter.B,
    decision.mobilityBefore.R.totalDestinations,
    decision.mobilityAfter.R.totalDestinations,
    decision.mobilityBefore.B.totalDestinations,
    decision.mobilityAfter.B.totalDestinations,
    decision.searchTimeMs ?? '',
    decision.verificationTimeMs ?? '',
    decision.legalActionCount,
    decision.rootCandidateCount,
    decision.categories.join('|'),
    decision.relevanceScore,
  ])
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n')
}

function analysisReport(analysis: HumanMCTSTraceAnalysis): string {
  const result = analysis.game.result
  const resultText = result
    ? result.tie
      ? 'empate'
      : `ganador ${result.winner ?? 'no indicado'}`
    : 'sin resultado final'
  const territory = analysis.game.territory
    ? `R ${analysis.game.territory.R} – B ${analysis.game.territory.B}`
    : 'no disponible'
  const topFive = analysis.ranking.slice(0, 5)
  return `# Análisis diagnóstico humano–MCTS: ${analysis.gameId}

> Las señales identifican decisiones para revisión posterior. No demuestran que una acción sea errónea.

## Replay

- Correcto: **sí**
- Decisiones reproducidas: ${analysis.replay.decisionsReplayed}

## Resultado

- Resultado: ${resultText}
- Territorio final: ${territory}
- Decisiones totales: ${analysis.game.totalDecisions}
- Decisiones humanas: ${analysis.game.humanDecisions}
- Decisiones MCTS: ${analysis.game.mctsDecisions}
- Tiempo MCTS medio: ${analysis.summary.averageMCTSTimeMs} ms
- Tiempo MCTS máximo: ${analysis.summary.maximumMCTSTimeMs} ms
- Cambios tácticos: ${analysis.summary.tacticalChanges}
- Baja confianza: ${analysis.summary.lowConfidenceDecisions}
- Posibles decisiones críticas: ${analysis.summary.possibleCriticalDecisions}

## Umbrales

\`\`\`json
${JSON.stringify(analysis.thresholds, null, 2)}
\`\`\`

## Cinco decisiones mejor clasificadas

${topFive
  .map(
    (
      decision,
      index,
    ) => `### ${index + 1}. Turno ${decision.turnIndex} (decisión MCTS ${decision.actorDecisionIndex})

- Relevancia: ${decision.relevanceScore}
- Categorías: ${decision.categories.join(', ') || 'ninguna'}
- Motivos:
${decision.rankReasons.map((reason) => `  - ${reason}`).join('\n') || '  - Sin señales por encima de los umbrales.'}`,
  )
  .join('\n\n')}
`
}

function validateThresholds(thresholds: HumanMCTSAnalysisThresholds): void {
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid analysis threshold: ${name}`)
  }
  if (!Number.isInteger(thresholds.criticalSignalCount) || thresholds.criticalSignalCount < 1) {
    throw new Error('criticalSignalCount must be a positive integer')
  }
}

function deltaRecord(
  before: Record<Player, number>,
  after: Record<Player, number>,
): Record<Player, number> {
  return { R: after.R - before.R, B: after.B - before.B }
}

function countCategory(
  decisions: readonly HumanMCTSDecisionAnalysis[],
  category: HumanMCTSDecisionCategory,
): number {
  return decisions.filter((decision) => decision.categories.includes(category)).length
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatNullable(value: number | null): string {
  return value === null ? 'n/a' : String(round(value))
}

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function gitValue(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

function main(): void {
  const tracePath = process.argv[2]
  if (!tracePath) throw new Error('Usage: npm run analyze:human-mcts -- <trace.json>')
  const result = analyzeHumanMCTSTraceFile(tracePath)
  console.log(
    JSON.stringify(
      {
        outputDir: result.outputDir,
        replay: result.analysis.replay,
        decisions: result.analysis.decisions.length,
        topFiveTurns: result.analysis.ranking.slice(0, 5).map((row) => row.turnIndex),
        fixtureFiles: result.fixtureFiles,
      },
      null,
      2,
    ),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
