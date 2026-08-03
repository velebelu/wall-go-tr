import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  type HumanChallengeConfig,
} from '@/agents/humanChallengeMCTS'
import { canonicalStringify } from '@/experiments/humanExperimentCanonical'
import {
  SELF_PLAY_EXPERIMENT_ID,
  SELF_PLAY_MAX_DECISIONS,
  SELF_PLAY_OUTPUT_DIRECTORY,
  SELF_PLAY_PAIR_COUNT,
  SELF_PLAY_PAIR_SEED_STRIDE,
  SELF_PLAY_SCHEMA_VERSION,
  SELF_PLAY_SEED_BASE,
  SELF_PLAY_SEED_RULE,
  SELF_PLAY_STREAM_SEED_OFFSET,
  buildSelfPlayPlan,
  runSelfPlayGame,
  validateSelfPlayPlan,
  type SelfPlayGameResult,
} from '@/experiments/mctsSelfPlayColorBias'
import { buildSelfPlayPairRows, summarizeSelfPlayColorBias } from './mctsSelfPlayColorBiasAnalysis'

export const SELF_PLAY_METADATA_SCHEMA = 'MCTSSelfPlayColorBiasMetadataV1'
export const SELF_PLAY_MANIFEST_SCHEMA = 'MCTSSelfPlayColorBiasManifestV1'
export const SELF_PLAY_RUN_COMMAND = 'npm run experiment:mcts-selfplay-color-bias'
export const SELF_PLAY_VALIDATE_COMMAND = 'npm run experiment:mcts-selfplay-color-bias:validate'

export interface HumanExperimentGuard {
  directory: string
  referenceCommit: string
  referenceTree: string
}

/** Frozen V3-R1 human experiment. Nothing in this experiment may touch it. */
export const HUMAN_EXPERIMENT_GUARD: Readonly<HumanExperimentGuard> = Object.freeze({
  directory: 'data/human-experiment/final-2026-v3-r1',
  referenceCommit: '941368c3c5447471aee1802320e08b0bdae8072c',
  referenceTree: 'c37c8db86ea74fd2df0b1b6398e046140b7de6a5',
})

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function parseArgs(argv: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    argv
      .filter((entry) => entry.startsWith('--'))
      .map((entry) => {
        const [key, ...rest] = entry.slice(2).split('=')
        return [key!, rest.length ? rest.join('=') : 'true']
      }),
  )
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8' }).trim()
}

export function readImplementationCommit(): { commit: string; workingTreeClean: boolean } {
  return {
    commit: git(['rev-parse', 'HEAD']),
    // Only the implementation matters here; generated data lands in an untracked folder.
    workingTreeClean: git(['status', '--porcelain', '--', 'src', 'scripts', 'package.json']) === '',
  }
}

export function gamePath(outputDir: string, gameNumber: number): string {
  return path.join(outputDir, 'games', `game-${String(gameNumber).padStart(3, '0')}.json`)
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, filePath)
}

function csvEscape(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value)
  return `"${text.split('"').join('""')}"`
}

export function toCsv<T extends object>(rows: readonly T[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0] as object)
  const body = rows
    .map((row) =>
      headers.map((header) => csvEscape((row as Record<string, unknown>)[header])).join(','),
    )
    .join('\n')
  return `${headers.join(',')}\n${body}\n`
}

export function toResultsCsvRow(result: SelfPlayGameResult) {
  return {
    experimentId: result.experimentId,
    gameId: result.gameId,
    gameNumber: result.gameNumber,
    pairNumber: result.pairNumber,
    orientation: result.orientation,
    redSeedBase: result.redSeedBase,
    blueSeedBase: result.blueSeedBase,
    redSeedStream: result.redSeedStream,
    blueSeedStream: result.blueSeedStream,
    redSeedCount: result.redSeedCount,
    blueSeedCount: result.blueSeedCount,
    configSha256: result.configSha256,
    configsIdentical: result.configsIdentical,
    implementationCommit: result.implementationCommit,
    firstActionColor: result.firstActionColor,
    winner: result.winner,
    tie: result.tie,
    redScore: result.redScore,
    territoryRed: result.territoryRed,
    territoryBlue: result.territoryBlue,
    territoryDiff: result.territoryDiff,
    totalDecisions: result.totalDecisions,
    redDecisions: result.redDecisions,
    blueDecisions: result.blueDecisions,
    redMoves: result.redActions.moves,
    blueMoves: result.blueActions.moves,
    redWalls: result.redActions.walls,
    blueWalls: result.blueActions.walls,
    redPlacements: result.redActions.placements,
    bluePlacements: result.blueActions.placements,
    terminationReason: result.terminationReason,
    terminal: result.terminal,
    durationMs: result.durationMs,
    decisionsStoppedByTimeLimit: result.diagnostics.stoppedByTimeLimit,
    decisionsExpandedTo500: result.diagnostics.expandedTo500,
    decisionsTacticalChanged: result.diagnostics.tacticalChanged,
    actionSequenceSha256: result.actionSequenceSha256,
    outcomeSha256: result.outcomeSha256,
    reproducible: result.reproducible,
  }
}

export function loadResults(outputDir: string, gameNumbers: readonly number[]) {
  return gameNumbers.flatMap((gameNumber) => {
    const filePath = gamePath(outputDir, gameNumber)
    if (!existsSync(filePath)) return []
    return [JSON.parse(readFileSync(filePath, 'utf8')) as SelfPlayGameResult]
  })
}

function buildMetadata(params: {
  pairCount: number
  commit: string
  workingTreeClean: boolean
  workers: number
  startedAt: string
  finishedAt: string
  configHash: string
  config: Readonly<HumanChallengeConfig>
}) {
  return {
    schema: SELF_PLAY_METADATA_SCHEMA,
    experimentId: SELF_PLAY_EXPERIMENT_ID,
    gameSchema: SELF_PLAY_SCHEMA_VERSION,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    pairs: params.pairCount,
    games: params.pairCount * 2,
    maxDecisionsSafetyLimit: SELF_PLAY_MAX_DECISIONS,
    implementationCommit: params.commit,
    implementationWorkingTreeClean: params.workingTreeClean,
    agent: {
      name: 'FINAL_HUMAN_CHALLENGE_MCTS_CONFIG',
      source: 'src/agents/humanChallengeMCTS.ts',
      appliedToBothColours: true,
      securedTerritoryPolicy: false,
      endgameSolverEnabled: false,
      configSha256: params.configHash,
      config: params.config,
    },
    seeds: {
      rule: SELF_PLAY_SEED_RULE,
      base: SELF_PLAY_SEED_BASE,
      pairStride: SELF_PLAY_PAIR_SEED_STRIDE,
      streamOffset: SELF_PLAY_STREAM_SEED_OFFSET,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      workers: params.workers,
      virtualClock: true,
      latencyGuardDisabled: true,
      latencyGuardMs: params.config.budget.maxDecisionMs,
      latencyGuardNote:
        'The 5 s per-decision guard is a user-interface latency limit. Offline it would make ' +
        'the outcome depend on machine load, so a frozen virtual clock is injected through the ' +
        'official now parameter. No search parameter is altered and both colours are affected ' +
        'identically; every decision completes its full 250/500 simulation budget.',
    },
    humanExperimentGuard: HUMAN_EXPERIMENT_GUARD,
    reproduction: {
      run: SELF_PLAY_RUN_COMMAND,
      validate: SELF_PLAY_VALIDATE_COMMAND,
      note:
        'Every decision reseeds a fresh RNG from sideSeedBase + decisionIndex, so games are ' +
        'independent of execution order and can be replayed one by one in any process.',
    },
  }
}

export function buildManifest(outputDir: string, gameNumbers: readonly number[]) {
  return {
    schema: SELF_PLAY_MANIFEST_SCHEMA,
    experimentId: SELF_PLAY_EXPERIMENT_ID,
    files: gameNumbers.map((gameNumber) => {
      const filePath = gamePath(outputDir, gameNumber)
      return {
        path: path.relative(outputDir, filePath).split(path.sep).join('/'),
        sha256: sha256(readFileSync(filePath, 'utf8')),
      }
    }),
  }
}

export interface RunSelfPlayOptions {
  pairCount?: number
  outputDir?: string
  workers?: number
  shard?: { index: number; total: number }
  onProgress?: (message: string) => void
}

export function runShard(
  options: Required<Pick<RunSelfPlayOptions, 'pairCount' | 'outputDir'>> & {
    shard: { index: number; total: number }
    onProgress?: (message: string) => void
  },
): void {
  const plan = buildSelfPlayPlan(options.pairCount)
  validateSelfPlayPlan(plan, options.pairCount)
  const { commit, workingTreeClean } = readImplementationCommit()
  if (!workingTreeClean)
    options.onProgress?.('Warning: the implementation working tree is not clean.')
  for (const planned of plan) {
    if ((planned.gameNumber - 1) % options.shard.total !== options.shard.index) continue
    const filePath = gamePath(options.outputDir, planned.gameNumber)
    if (existsSync(filePath)) continue
    const result = runSelfPlayGame(planned, { implementationCommit: commit, sha256 })
    if (!result.terminal) throw new Error(`Game ${planned.gameId} did not finish terminally`)
    writeJsonAtomic(filePath, result)
    options.onProgress?.(
      `[shard ${options.shard.index}] ${planned.gameId} ${result.winner} ` +
        `${result.territoryRed}-${result.territoryBlue} (${Math.round(result.durationMs)} ms)`,
    )
  }
}

async function spawnShards(
  scriptPath: string,
  workers: number,
  pairCount: number,
  outputDir: string,
  onProgress: (message: string) => void,
): Promise<void> {
  await Promise.all(
    Array.from({ length: workers }, (_, index) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            './scripts/run-ts-node-esm.mjs',
            scriptPath,
            `--shard=${index}/${workers}`,
            `--pairs=${pairCount}`,
            `--output=${outputDir}`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) onProgress(line.trim())
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => {
          for (const line of chunk.split('\n'))
            if (
              line.trim() &&
              !line.includes('DeprecationWarning') &&
              !line.includes('trace-depre')
            )
              onProgress(`[stderr ${index}] ${line.trim()}`)
        })
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`Shard ${index} exited with code ${code}`)),
        )
      })
    }),
  )
}

export function writeAggregates(params: {
  outputDir: string
  pairCount: number
  results: readonly SelfPlayGameResult[]
  commit: string
  workingTreeClean: boolean
  workers: number
  startedAt: string
  finishedAt: string
  /** Test-only override; the official commands always store the frozen configuration. */
  config?: Readonly<HumanChallengeConfig>
}) {
  const { outputDir, results } = params
  const config = params.config ?? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG
  const gameNumbers = [...results].map((row) => row.gameNumber).sort((a, b) => a - b)
  const summary = summarizeSelfPlayColorBias(results, {
    expectedGames: params.pairCount * 2,
    expectedPairs: params.pairCount,
  })
  const pairRows = buildSelfPlayPairRows(results)
  writeJsonAtomic(
    path.join(outputDir, 'metadata.json'),
    buildMetadata({
      pairCount: params.pairCount,
      commit: params.commit,
      workingTreeClean: params.workingTreeClean,
      workers: params.workers,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      configHash: sha256(canonicalStringify(config)),
      config,
    }),
  )
  writeJsonAtomic(path.join(outputDir, 'plan.json'), buildSelfPlayPlan(params.pairCount))
  writeJsonAtomic(path.join(outputDir, 'summary.json'), summary)
  writeFileSync(
    path.join(outputDir, 'results.csv'),
    toCsv([...results].sort((a, b) => a.gameNumber - b.gameNumber).map(toResultsCsvRow)),
    'utf8',
  )
  writeFileSync(path.join(outputDir, 'pairs.csv'), toCsv(pairRows), 'utf8')
  writeJsonAtomic(path.join(outputDir, 'manifest.json'), buildManifest(outputDir, gameNumbers))
  return summary
}

export async function runMCTSSelfPlayColorBias(options: RunSelfPlayOptions = {}) {
  const pairCount = options.pairCount ?? SELF_PLAY_PAIR_COUNT
  const outputDir = path.resolve(options.outputDir ?? SELF_PLAY_OUTPUT_DIRECTORY)
  const onProgress = options.onProgress ?? (() => {})
  const plan = buildSelfPlayPlan(pairCount)
  validateSelfPlayPlan(plan, pairCount)
  mkdirSync(path.join(outputDir, 'games'), { recursive: true })
  const startedAt = new Date().toISOString()
  const { commit, workingTreeClean } = readImplementationCommit()
  const workers = Math.max(
    1,
    Math.min(
      options.workers ?? Math.max(1, (availableParallelism?.() ?? cpus().length) - 4),
      plan.length,
    ),
  )
  onProgress(`Plan: ${plan.length} games in ${pairCount} pairs; ${workers} worker processes.`)
  const pending = plan.filter((row) => !existsSync(gamePath(outputDir, row.gameNumber)))
  onProgress(`${plan.length - pending.length} already stored, ${pending.length} pending.`)
  if (pending.length)
    await spawnShards(fileURLToPath(import.meta.url), workers, pairCount, outputDir, onProgress)

  const results = loadResults(
    outputDir,
    plan.map((row) => row.gameNumber),
  )
  if (results.length !== plan.length)
    throw new Error(`Expected ${plan.length} stored games but found ${results.length}`)
  const summary = writeAggregates({
    outputDir,
    pairCount,
    results,
    commit,
    workingTreeClean,
    workers,
    startedAt,
    finishedAt: new Date().toISOString(),
  })
  onProgress(
    `Red ${summary.outcomes.redWins} — Blue ${summary.outcomes.blueWins} — ` +
      `ties ${summary.outcomes.ties}; mean territory difference ${summary.territory.diff.mean}.`,
  )
  return summary
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const pairCount = args.pairs ? Number(args.pairs) : SELF_PLAY_PAIR_COUNT
  const outputDir = path.resolve(args.output ?? SELF_PLAY_OUTPUT_DIRECTORY)
  if (args.shard) {
    const [index, total] = args.shard.split('/').map(Number)
    runShard({
      pairCount,
      outputDir,
      shard: { index: index!, total: total! },
      onProgress: console.log,
    })
    return
  }
  const summary = await runMCTSSelfPlayColorBias({
    pairCount,
    outputDir,
    workers: args.workers ? Number(args.workers) : undefined,
    onProgress: console.log,
  })
  console.log(JSON.stringify(summary.outcomes, null, 2))
  console.log(JSON.stringify(summary.inference.primaryColourTest, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
