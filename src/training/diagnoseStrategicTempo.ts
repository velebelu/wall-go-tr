import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  deserializeGameSnapshot,
  type HumanMCTSTraceDecisionV1,
  type HumanMCTSTraceV1,
} from '@/utils/humanMCTSTrace'
import {
  analyzeStrategicTempoDecision,
  type StrategicTempoAnalysis,
} from './strategicTempoDiagnostics'

const diagnosticRoot = resolve('data/diagnostics/secured-territory-behaviour')
const outputRoot = resolve('data/diagnostics/strategic-tempo-v1')
const humanTracePaths = [
  'data/human-experiment/final-2026/participants/P01/traces/game-1.json',
  'data/human-experiment/final-2026/participants/P01/traces/game-2.json',
  'data/human-experiment/final-2026/participants/P02/traces/game-1.json',
  'data/human-experiment/final-2026/participants/P02/traces/game-2.json',
]

interface Case {
  id: string
  source: string
  sourceKind: 'diagnostic' | 'reviewed-human-v2'
  gameId: string
  turnIndex: number
  player: 'R' | 'B'
  action: HumanMCTSTraceDecisionV1['action']
  analysis: StrategicTempoAnalysis
  decision: HumanMCTSTraceDecisionV1
}

const diagnosticNames = (await readdir(diagnosticRoot))
  .filter((name) => /^trace-\d+\.json$/.test(name))
  .sort((left, right) => Number(left.match(/\d+/)![0]) - Number(right.match(/\d+/)![0]))
const sources = [
  ...humanTracePaths.map((path) => ({ path, kind: 'reviewed-human-v2' as const })),
  ...diagnosticNames.map((name) => ({
    path: resolve(diagnosticRoot, name),
    kind: 'diagnostic' as const,
  })),
]

const cases: Case[] = []
let decisionsExamined = 0
for (const source of sources) {
  const trace = JSON.parse(await readFile(source.path, 'utf8')) as HumanMCTSTraceV1
  for (let index = 0; index < trace.decisions.length; index++) {
    const decision = trace.decisions[index]!
    if (decision.actor !== 'mcts') continue
    decisionsExamined++
    const futureStates = trace.decisions
      .slice(index + 1, index + 5)
      .map((future) => deserializeGameSnapshot(future.stateAfter))
    const analysis = analyzeStrategicTempoDecision(
      {
        stateBefore: deserializeGameSnapshot(decision.stateBefore),
        stateAfter: deserializeGameSnapshot(decision.stateAfter),
        legalActions: decision.legalActions,
        action: decision.action,
        endedGame: decision.endedGame,
        mcts: decision.mcts,
      },
      futureStates,
    )
    if (!analysis.suspicious) continue
    const id = createHash('sha256')
      .update(JSON.stringify([decision.stateBefore, decision.action]))
      .digest('hex')
      .slice(0, 12)
    cases.push({
      id,
      source: relative(process.cwd(), resolve(source.path)).replace(/\\/g, '/'),
      sourceKind: source.kind,
      gameId: trace.metadata.gameId,
      turnIndex: decision.turnIndex,
      player: decision.player,
      action: decision.action,
      analysis,
      decision,
    })
  }
}

const uniqueCases = Array.from(
  new Map<string, Case>(cases.map((entry) => [entry.id, entry])).values(),
)
const counts = Object.fromEntries(
  [
    'productive',
    'strategic-repositioning',
    'defensive',
    'mobility-improving',
    'future-wall-preparation',
    'redundant',
    'ambiguous',
  ].map((classification) => [
    classification,
    uniqueCases.filter((entry) => entry.analysis.classification === classification).length,
  ]),
)
const fixtureCases = [
  ...uniqueCases.filter((entry) => entry.sourceKind === 'reviewed-human-v2'),
  ...uniqueCases.filter((entry) => entry.analysis.classification === 'ambiguous'),
  ...uniqueCases
    .filter((entry) => entry.analysis.classification === 'mobility-improving')
    .slice(0, 4),
  ...uniqueCases
    .filter((entry) => entry.analysis.classification === 'future-wall-preparation')
    .slice(0, 4),
  ...uniqueCases
    .filter((entry) => entry.analysis.classification === 'strategic-repositioning')
    .slice(0, 1),
].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
const nearTiedCases = uniqueCases.filter(
  (entry) => entry.analysis.statisticallyNearTied === true,
).length
const betterImmediateAlternativeCases = uniqueCases.filter(
  (entry) => entry.analysis.bestAlternativeImmediateAdvantage > 0,
).length
const nonPositiveSelectedValueCases = uniqueCases.filter(
  (entry) => (entry.analysis.selectedValue ?? 0) <= 0,
).length

const fixtureRoot = resolve(outputRoot, 'fixtures')
await rm(fixtureRoot, { recursive: true, force: true })
await mkdir(fixtureRoot, { recursive: true })
for (const entry of fixtureCases) {
  await writeFile(
    resolve(fixtureRoot, `${entry.id}.fixture.json`),
    `${JSON.stringify(
      {
        schema: 'StrategicTempoFixtureV1',
        source: {
          path: entry.source,
          kind: entry.sourceKind,
          gameId: entry.gameId,
          turnIndex: entry.turnIndex,
        },
        player: entry.player,
        stateBefore: entry.decision.stateBefore,
        legalActions: entry.decision.legalActions,
        action: entry.action,
        stateAfter: entry.decision.stateAfter,
        mcts: {
          simulations: entry.decision.mcts?.simulations,
          baseSeed: entry.decision.mcts?.baseSeed,
          decisionSeed: entry.decision.mcts?.decisionSeed,
          rootVisits: entry.decision.mcts?.rootVisits,
          selectedVisits: entry.decision.mcts?.selectedVisits,
          selectedValue: entry.decision.mcts?.selectedValue,
          rootCandidates: entry.decision.mcts?.rootCandidates,
          effectiveConfig: entry.decision.mcts?.effectiveConfig,
        },
        analysis: entry.analysis,
      },
      null,
      2,
    )}\n`,
  )
}

const report = {
  schema: 'StrategicTempoDiagnosticReportV1',
  generatedAt: new Date().toISOString(),
  scope: {
    diagnosticTraces: diagnosticNames.length,
    reviewedHumanTraces: humanTracePaths.length,
    v3ReadOrModified: false,
    decisionsExamined,
  },
  constraints: {
    decisionPolicyChanged: false,
    frozenConfigurationChanged: false,
    securedTerritoryPolicyEnabled: false,
    qPriorWeight: 0,
  },
  dataLimitations: {
    maxDepthReached: 'not recorded by the historical HumanMCTSTraceV1 decision diagnostics',
    rolloutOutcomes:
      'individual rollout outcomes are not recorded; only aggregate candidate values are available',
    humanReviewScope:
      'four attributable pre-V3 human traces; V3 traces were intentionally excluded',
  },
  suspiciousOccurrences: cases.length,
  independentCases: uniqueCases.length,
  classifications: counts,
  causeIndicators: {
    nearTiedCases,
    betterImmediateAlternativeCases,
    nonPositiveSelectedValueCases,
    meanVisitGap:
      uniqueCases.reduce((sum, entry) => sum + (entry.analysis.visitGap ?? 0), 0) /
      Math.max(1, uniqueCases.length),
    meanValueGap:
      uniqueCases.reduce((sum, entry) => sum + (entry.analysis.valueGap ?? 0), 0) /
      Math.max(1, uniqueCases.length),
  },
  provisionalConclusion: {
    primaryCause:
      'near ties and saturated aggregate values hide differences in immediate strategic progress',
    confirmedRedundantCases: counts.redundant,
    recommendation:
      'continue investigating with paired counterfactual continuations before testing any tie-break signal',
  },
  fixtures: fixtureCases.map((entry) => `${entry.id}.fixture.json`),
  cases: uniqueCases.map(({ decision: _decision, ...entry }) => entry),
}
await writeFile(
  resolve(outputRoot, 'diagnostic-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
)
await writeFile(
  resolve(outputRoot, 'README.md'),
  [
    '# Diagnóstico de tempo estratégico MCTS',
    '',
    'Análisis pasivo: no modifica la selección de MCTS ni la configuración humana congelada.',
    '',
    `- Trazas diagnósticas: ${diagnosticNames.length}`,
    `- Trazas humanas pre-V3 revisadas: ${humanTracePaths.length}`,
    `- Decisiones MCTS examinadas: ${decisionsExamined}`,
    `- Ocurrencias sospechosas: ${cases.length}`,
    `- Casos independientes: ${uniqueCases.length}`,
    `- Fixtures mínimos: ${fixtureCases.length}`,
    `- Empates estadísticos próximos: ${nearTiedCases}`,
    `- Casos redundantes confirmados: ${counts.redundant}`,
    '',
    'Las etiquetas son diagnósticas. `redundant` exige una ventana posterior medible y una',
    'alternativa con ventaja inmediata; no se utiliza todavía para modificar decisiones.',
    '',
    'Las trazas V3 no se leen ni se modifican.',
    '',
  ].join('\n'),
)

console.log(
  JSON.stringify(
    {
      diagnosticTraces: diagnosticNames.length,
      reviewedHumanTraces: humanTracePaths.length,
      decisionsExamined,
      suspiciousOccurrences: cases.length,
      independentCases: uniqueCases.length,
      classifications: counts,
      nearTiedCases,
      fixtures: fixtureCases.length,
      output: outputRoot.replace(/\\/g, '/'),
    },
    null,
    2,
  ),
)
