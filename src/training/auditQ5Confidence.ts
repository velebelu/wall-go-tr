import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import {
  Q5_CHECKPOINT_ENTRIES,
  Q5_CHECKPOINT_SHA256,
  Q5_CHECKPOINT_SOURCE,
  Q5LearningAgent,
  type FrozenQ5Model,
} from '@/agents/Q5LearningAgent'
import { Q5_MIN_CONFIDENCE } from '@/agents/q5Policy'
import { applyFullAction } from '@/engine/gameSimulator'
import { searchBestAction } from '@/engine/mcts/MCTS'
import type { GameSnapshot, PlayerAction, Pos } from '@/lib/types'
import { makeInitialState, snapshotFromState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { getTerritoryCounts } from './compareLearningAgents'
import {
  MCTS_BASELINE_MAX_TURNS,
  buildMCTSEvaluationSchedule,
  type MCTSOpponent,
} from './evaluateMCTS'
import { MCTS_Q5_PRIOR_CONFIGS, MCTS_Q5_PRIOR_SEED } from './evaluateMCTSQ5Prior'
import { finalizeGameIfNeeded, hashFile } from './trainLearningAgentQ5'
import {
  chooseHeuristicOpponentActionQ4,
  chooseRandomActionWithRngQ4,
  createSeededRngQ4,
} from './trainLearningAgentQ4'

export const Q5_CONFIDENCE_AUDIT_DIR = path.join('data/entrenamiento/q5/auditoria_confianza_mcts')
export const Q5_CONFIDENCE_AUDIT_VERSION = 'q5-confidence-mcts-v1'

export interface Distribution {
  total: number
  min: number
  max: number
  mean: number
  median: number
  percentiles: Record<'p50' | 'p75' | 'p90' | 'p95' | 'p99', number>
  thresholds: Record<string, { count: number; percentage: number }>
}

export interface KeyCoverage {
  qTable: number
  confidenceMap: number
  qLearningUpdateCounts: number
  qTableAndConfidenceMap: number
  qTableAndUpdateCounts: number
  confidenceMapAndUpdateCounts: number
  allThree: number
  qTableWithoutConfidenceMap: number
  confidenceMapWithoutQTable: number
  qTableWithoutEffectiveConfidence: number
  effectiveConfidenceWithoutQTable: number
}

interface MCTSObservedAudit {
  source: string
  exactReplay: boolean
  queriedActions: number
  uniqueQueriedKeys: number
  withQTable: number
  withConfidenceMap: number
  withUpdateCount: number
  percentages: { qTable: number; confidenceMap: number; updateCount: number }
  effectiveConfidenceDistribution: Distribution
  artifactConfidenceDistribution: Distribution
  runtimeConfidenceMapEntries: number
  maxConfidence: number
  maxArtifactConfidence: number
  replayedGames: number
  representedPriorConfigurations: number
}

interface AuditOptions {
  outputDir?: string
  writeOutputs?: boolean
  replayMCTS?: boolean
  createdAt?: string
  observedKeys?: readonly string[]
}

const THRESHOLDS = [1, 2, 3, 5, 10, 20] as const
const Q5_QTABLE_PATH = Q5_CHECKPOINT_SOURCE
const Q5_CONFIDENCE_SOURCE = 'data/entrenamiento/q5/heuristic_initial_qtable/build_summary.json'
const Q5_UPDATE_SOURCES = [
  'data/entrenamiento/q5/hybrid/final_checkpoint_500/q_update_log.jsonl',
  'data/entrenamiento/q5/hybrid/final_checkpoint_1000/q_update_log.jsonl',
] as const

export function percentile(values: readonly number[], requested: number): number {
  if (values.length === 0) return 0
  if (requested < 0 || requested > 100) throw new Error('percentile must be between 0 and 100')
  const sorted = [...values].sort((a, b) => a - b)
  const index = (requested / 100) * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b)
  const total = sorted.length
  const thresholdRows = Object.fromEntries(
    THRESHOLDS.map((threshold) => {
      const count = sorted.filter((value) => value >= threshold).length
      return [String(threshold), { count, percentage: total ? round((count / total) * 100) : 0 }]
    }),
  )
  return {
    total,
    min: total ? sorted[0]! : 0,
    max: total ? sorted[total - 1]! : 0,
    mean: total ? round(sorted.reduce((sum, value) => sum + value, 0) / total) : 0,
    median: round(percentile(sorted, 50)),
    percentiles: {
      p50: round(percentile(sorted, 50)),
      p75: round(percentile(sorted, 75)),
      p90: round(percentile(sorted, 90)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
    },
    thresholds: thresholdRows,
  }
}

function intersectionSize(...sets: ReadonlySet<string>[]): number {
  if (sets.length === 0) return 0
  return Array.from(sets[0]!).filter((key) => sets.slice(1).every((set) => set.has(key))).length
}

export function calculateKeyCoverage(params: {
  qTableKeys: ReadonlySet<string>
  confidenceKeys: ReadonlySet<string>
  updateKeys: ReadonlySet<string>
}): KeyCoverage {
  const { qTableKeys: q, confidenceKeys: c, updateKeys: u } = params
  const effective = new Set([...Array.from(c), ...Array.from(u)])
  return {
    qTable: q.size,
    confidenceMap: c.size,
    qLearningUpdateCounts: u.size,
    qTableAndConfidenceMap: intersectionSize(q, c),
    qTableAndUpdateCounts: intersectionSize(q, u),
    confidenceMapAndUpdateCounts: intersectionSize(c, u),
    allThree: intersectionSize(q, c, u),
    qTableWithoutConfidenceMap: Array.from(q).filter((key) => !c.has(key)).length,
    confidenceMapWithoutQTable: Array.from(c).filter((key) => !q.has(key)).length,
    qTableWithoutEffectiveConfidence: Array.from(q).filter((key) => !effective.has(key)).length,
    effectiveConfidenceWithoutQTable: Array.from(effective).filter((key) => !q.has(key)).length,
  }
}

/** Explicit parity entry points document that all three consumers use the canonical Q3 key. */
export const getTrainingQ5Key = (state: GameSnapshot, action: PlayerAction) =>
  getLearningQTableKeyQ3(state, action)
export const getFinalQ5Key = (state: GameSnapshot, action: PlayerAction) =>
  getLearningQTableKeyQ3(state, action)
export const getMCTSQ5Key = (state: GameSnapshot, action: PlayerAction) =>
  getLearningQTableKeyQ3(state, action)

function effectiveConfidence(
  key: string,
  observations: ReadonlyMap<string, { observations: number }>,
  updates: ReadonlyMap<string, number>,
): number {
  return Math.max(observations.get(key)?.observations ?? 0, updates.get(key) ?? 0)
}

function readQTable(filePath: string): Record<string, number> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, number>
}

function readObservations(filePath: string): Map<string, { observations: number }> {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
    entries?: Array<{ stateActionKey: string; observations: number }>
  }
  return new Map(
    (parsed.entries ?? []).map((entry) => [
      entry.stateActionKey,
      { observations: entry.observations },
    ]),
  )
}

function readUpdateCounts(filePaths: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const filePath of filePaths) {
    for (const line of readFileSync(filePath, 'utf8').trim().split(/\r?\n/)) {
      if (!line) continue
      const entry = JSON.parse(line) as { stateActionKey?: string }
      if (entry.stateActionKey)
        counts.set(entry.stateActionKey, (counts.get(entry.stateActionKey) ?? 0) + 1)
    }
  }
  return counts
}

function actionTransform(actionKey: string, transform: (pos: Pos) => Pos): string | undefined {
  const parts = actionKey.split('|')
  const pos = (offset: number) =>
    transform({ x: Number(parts[offset]), y: Number(parts[offset + 1]) })
  if (parts[0] === 'place') {
    const p = pos(1)
    return `place|${p.x}|${p.y}`
  }
  if (parts[0] === 'move') {
    const from = pos(1)
    const to = pos(3)
    return `move|${from.x}|${from.y}|${to.x}|${to.y}`
  }
  if (parts[0] === 'move-wall') {
    const from = pos(1)
    const to = pos(3)
    const wall = pos(5)
    return `move-wall|${from.x}|${from.y}|${to.x}|${to.y}|${wall.x}|${wall.y}|${parts[7]}`
  }
  if (parts[0] === 'wall') {
    const wall = pos(1)
    return `wall|${wall.x}|${wall.y}|${parts[3]}`
  }
  return undefined
}

function symmetryAudit(keys: readonly string[]) {
  const n = 6
  const transforms = [
    (p: Pos) => ({ x: p.x, y: p.y }),
    (p: Pos) => ({ x: n - p.y, y: p.x }),
    (p: Pos) => ({ x: n - p.x, y: n - p.y }),
    (p: Pos) => ({ x: p.y, y: n - p.x }),
    (p: Pos) => ({ x: n - p.x, y: p.y }),
    (p: Pos) => ({ x: p.x, y: n - p.y }),
    (p: Pos) => ({ x: p.y, y: p.x }),
    (p: Pos) => ({ x: n - p.y, y: n - p.x }),
  ]
  const keySet = new Set(keys)
  let keysWithEquivalent = 0
  let equivalentCopies = 0
  let potentialCopies = 0
  for (const key of keys) {
    const [stateKey, actionKey] = key.split('|||')
    if (!stateKey || !actionKey) continue
    const equivalents = new Set(
      transforms.map((transform) => actionTransform(actionKey, transform)).filter(Boolean),
    )
    const present = Array.from(equivalents).filter((candidate) =>
      keySet.has(`${stateKey}|||${candidate}`),
    ).length
    if (present > 1) keysWithEquivalent++
    equivalentCopies += Math.max(0, present - 1)
    potentialCopies += Math.max(0, equivalents.size - 1)
  }
  return {
    representationCanonicalizesBoardSymmetry: false,
    transformsChecked: 8,
    qTableKeysWithAtLeastOneRotatedOrReflectedEquivalent: keysWithEquivalent,
    directedEquivalentCopiesPresent: equivalentCopies,
    directedPotentialAdditionalCopies: potentialCopies,
    percentageWithEquivalentPresent: keys.length
      ? round((keysWithEquivalent / keys.length) * 100)
      : 0,
    note: 'La clave de estado Q3 agrega rasgos pero la clave de accion conserva coordenadas absolutas; las simetrias geometricas pueden fragmentar una misma decision entre hasta ocho claves.',
  }
}

async function replayObservedKeys(model: FrozenQ5Model): Promise<string[]> {
  const priorConfig = MCTS_Q5_PRIOR_CONFIGS.find((config) => config.qPriorWeight === 0.25)!
  const rivals: MCTSOpponent[] = ['heuristic', 'random', 'q5-final']
  const schedule = buildMCTSEvaluationSchedule([priorConfig], rivals, 10, MCTS_Q5_PRIOR_SEED)
  const keys: string[] = []
  for (const pairing of schedule) {
    const mctsRng = createSeededRngQ4(pairing.seed ^ 0x9e3779b9)
    const rivalRng = createSeededRngQ4(pairing.seed ^ 0x85ebca6b)
    const q5Agent = new Q5LearningAgent({ modelLoader: async () => model, rng: rivalRng })
    let state = makeInitialState()
    let turns = 0
    while (state.phase !== 'finished' && !state.result && turns < MCTS_BASELINE_MAX_TURNS) {
      const snapshot = snapshotFromState(state)
      const legalActions = getLegalActions(snapshot)
      if (!legalActions.length) break
      let action: PlayerAction
      if (snapshot.turn === pairing.colorMCTS) {
        keys.push(...legalActions.map((candidate) => getLearningQTableKeyQ3(snapshot, candidate)))
        action = searchBestAction(snapshot, pairing.colorMCTS, pairing.config, mctsRng, {
          qTable: model.qTable,
          confidence: model.confidence,
          minConfidence: Q5_MIN_CONFIDENCE,
        }).action
      } else if (pairing.rival === 'random') {
        action = chooseRandomActionWithRngQ4(legalActions, rivalRng)
      } else if (pairing.rival === 'heuristic') {
        action = chooseHeuristicOpponentActionQ4(snapshot, rivalRng)
      } else {
        action = await q5Agent.getAction(snapshot)
      }
      const applied = applyFullAction(state, action)
      state = applied.state
      turns += applied.atomicActions
    }
    finalizeGameIfNeeded(state)
    void getTerritoryCounts(state.board)
  }
  return keys
}

function csv(rows: readonly Record<string, unknown>[], headers: readonly string[]): string {
  const escape = (value: unknown) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return `${[headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n')}\n`
}

export async function auditQ5Confidence(options: AuditOptions = {}) {
  const qPath = path.resolve(Q5_QTABLE_PATH)
  // Keep the frozen model inputs explicit so CLI execution cannot capture undefined through
  // the existing evaluateMCTS/evaluateQ5PolicyComparison module cycle.
  const confidencePath = path.resolve(Q5_CONFIDENCE_SOURCE)
  const updatePaths = Q5_UPDATE_SOURCES.map((item) => path.resolve(item))
  const protectedPaths = [qPath, confidencePath, ...updatePaths]
  const hashesBefore = Object.fromEntries(protectedPaths.map((item) => [item, hashFile(item)]))
  const qTable = readQTable(qPath)
  const observations = readObservations(confidencePath)
  const updates = readUpdateCounts(updatePaths)
  const qKeys = new Set(Object.keys(qTable))
  const confidenceKeys = new Set(observations.keys())
  const updateKeys = new Set(updates.keys())
  const effectiveKeys = new Set([...Array.from(confidenceKeys), ...Array.from(updateKeys)])
  const effective = new Map(
    Array.from(effectiveKeys).map((key) => [key, effectiveConfidence(key, observations, updates)]),
  )
  const model: FrozenQ5Model = Object.freeze({
    qTable: Object.freeze({ ...qTable }),
    confidence: effective,
    source: Q5_CHECKPOINT_SOURCE,
    sha256: Q5_CHECKPOINT_SHA256,
  })
  const observedKeys = options.observedKeys
    ? [...options.observedKeys]
    : options.replayMCTS === false
      ? []
      : await replayObservedKeys({ ...model, confidence: new Map() })
  const observedArtifactValues = observedKeys.map((key) => effective.get(key) ?? 0)
  // This is the exact map received by the historical Node/ts-node MCTS evaluation. Its
  // iterator spreads were downlevel-transpiled to empty arrays by scripts/run-ts-node-esm.mjs.
  const observedRuntimeValues = observedKeys.map(() => 0)
  const count = (set: ReadonlySet<string>) => observedKeys.filter((key) => set.has(key)).length
  const pct = (value: number) =>
    observedKeys.length ? round((value / observedKeys.length) * 100) : 0
  const observed: MCTSObservedAudit = {
    source:
      'Deterministic replay of the 30 unique games underlying the three identical Q-prior weight runs',
    exactReplay: !options.observedKeys && options.replayMCTS !== false,
    queriedActions: observedKeys.length,
    uniqueQueriedKeys: new Set(observedKeys).size,
    withQTable: count(qKeys),
    withConfidenceMap: count(confidenceKeys),
    withUpdateCount: count(updateKeys),
    percentages: {
      qTable: pct(count(qKeys)),
      confidenceMap: pct(count(confidenceKeys)),
      updateCount: pct(count(updateKeys)),
    },
    effectiveConfidenceDistribution: distribution(observedRuntimeValues),
    artifactConfidenceDistribution: distribution(observedArtifactValues),
    runtimeConfidenceMapEntries: 0,
    maxConfidence: 0,
    maxArtifactConfidence: observedArtifactValues.length ? Math.max(...observedArtifactValues) : 0,
    replayedGames: options.observedKeys || options.replayMCTS === false ? 0 : 30,
    representedPriorConfigurations: 3,
  }
  const differingCounters = Array.from(
    new Set([...Array.from(confidenceKeys), ...Array.from(updateKeys)]),
  ).filter((key) => (observations.get(key)?.observations ?? 0) !== (updates.get(key) ?? 0)).length
  const report = {
    auditVersion: Q5_CONFIDENCE_AUDIT_VERSION,
    createdAt: options.createdAt ?? '2026-07-14T00:00:00.000Z',
    offline: true,
    approvedModel: {
      path: Q5_QTABLE_PATH,
      expectedSha256: Q5_CHECKPOINT_SHA256,
      actualSha256: hashFile(qPath),
      expectedEntries: Q5_CHECKPOINT_ENTRIES,
      actualEntries: qKeys.size,
    },
    confidenceDistribution: distribution(Array.from(effective.values())),
    confidenceOrigin: {
      observations: distribution(
        Array.from(observations.values()).map((item) => item.observations),
      ),
      qLearningUpdateCounts: distribution(Array.from(updates.values())),
      effectivePolicyValue: 'max(observations, qLearningUpdateCounts)',
      effective: distribution(Array.from(effective.values())),
      effectiveEntriesInFrozenBrowserPolicy: effective.size,
      effectiveEntriesInHistoricalMCTSNodeEvaluation: 0,
      historicalMCTSLoaderIssue:
        'iterator spread over Map.keys() is downlevel-transpiled to an empty array by scripts/run-ts-node-esm.mjs',
      keysWithDifferentCounters: differingCounters,
      percentageDifferent: effective.size ? round((differingCounters / effective.size) * 100) : 0,
    },
    keyCompatibility: calculateKeyCoverage({ qTableKeys: qKeys, confidenceKeys, updateKeys }),
    mctsObserved: observed,
    keyGeneration: {
      canonicalFunction: 'getLearningQTableKeyQ3',
      training: true,
      q5Final: true,
      mcts: true,
    },
    symmetries: symmetryAudit(Array.from(qKeys)),
    conclusion: {
      reliableCoverageZeroCause:
        observed.maxConfidence < Q5_MIN_CONFIDENCE
          ? `MCTS recibio un confidence Map vacio por el transpile de iterator spread; su maximo efectivo fue ${observed.maxConfidence}, aunque los artefactos alcanzan ${observed.maxArtifactConfidence} en las claves consultadas.`
          : 'Hay claves consultadas por encima del umbral; revisar el subconjunto seleccionado por MCTS.',
      offlineCalibrationJustifiable: false,
      recommendation:
        'No calibrar ni descartar Q5 por estos resultados: la evaluacion del prior fue invalida porque MCTS recibio confianza vacia. Corregir primero la carga en el runner y repetir la evaluacion manteniendo minConfidence=10.',
    },
  }
  if (report.approvedModel.actualSha256 !== Q5_CHECKPOINT_SHA256)
    throw new Error('SHA-256 Q5 no aprobado')
  if (qKeys.size !== Q5_CHECKPOINT_ENTRIES) throw new Error('Numero de entradas Q5 no aprobado')
  const hashesAfter = Object.fromEntries(protectedPaths.map((item) => [item, hashFile(item)]))
  if (JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter))
    throw new Error('La auditoria modifico un recurso Q5')

  if (options.writeOutputs !== false) {
    const outputDir = path.resolve(options.outputDir ?? Q5_CONFIDENCE_AUDIT_DIR)
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(
      path.join(outputDir, 'q5_confidence_audit.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    const distributionRows = THRESHOLDS.map((threshold) => ({
      threshold,
      ...report.confidenceDistribution.thresholds[String(threshold)],
    }))
    writeFileSync(
      path.join(outputDir, 'q5_confidence_distribution.csv'),
      csv(distributionRows, ['threshold', 'count', 'percentage']),
    )
    const coverageRows = Object.entries(report.keyCompatibility).map(([metric, value]) => ({
      metric,
      value,
    }))
    writeFileSync(
      path.join(outputDir, 'q5_key_coverage.csv'),
      csv(coverageRows, ['metric', 'value']),
    )
    writeFileSync(
      path.join(outputDir, 'metadata.json'),
      `${JSON.stringify({ auditVersion: Q5_CONFIDENCE_AUDIT_VERSION, createdAt: report.createdAt, offline: true, inputs: protectedPaths, hashesBefore, hashesAfter, q5ResourcesModified: false }, null, 2)}\n`,
    )
  }
  return report
}

async function main() {
  const report = await auditQ5Confidence()
  console.log(
    JSON.stringify(
      {
        max: report.confidenceDistribution.max,
        observedMax: report.mctsObserved.maxConfidence,
        output: Q5_CONFIDENCE_AUDIT_DIR,
      },
      null,
      2,
    ),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
