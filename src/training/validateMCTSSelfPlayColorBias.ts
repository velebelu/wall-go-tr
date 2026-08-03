import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  type HumanChallengeConfig,
} from '@/agents/humanChallengeMCTS'
import { applyFullAction } from '@/engine/gameSimulator'
import { canonicalStringify } from '@/experiments/humanExperimentCanonical'
import { PLAYER_LIST } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { checkGameEnd } from '@/utils/game'
import {
  SELF_PLAY_EXPERIMENT_ID,
  SELF_PLAY_MAX_DECISIONS,
  SELF_PLAY_OUTPUT_DIRECTORY,
  SELF_PLAY_PAIR_COUNT,
  SELF_PLAY_SCHEMA_VERSION,
  buildSelfPlayPlan,
  countActionAtoms,
  emptyActionCounts,
  runSelfPlayGame,
  scoreForRed,
  territoryCountsFromBoard,
  validateSelfPlayPlan,
  type SelfPlayGameResult,
  type SelfPlayPlanRow,
} from '@/experiments/mctsSelfPlayColorBias'
import { summarizeSelfPlayColorBias } from './mctsSelfPlayColorBiasAnalysis'
import {
  HUMAN_EXPERIMENT_GUARD,
  SELF_PLAY_METADATA_SCHEMA,
  parseArgs,
  sha256,
  toCsv,
  toResultsCsvRow,
} from './runMCTSSelfPlayColorBias'

const FULL_COMMIT = /^[0-9a-f]{40}$/
const BOARD_CELLS = 49
export const DEFAULT_REPLAY_SAMPLE = 2

export interface ValidationIssue {
  check: string
  detail: string
}

export class SelfPlayValidationCollector {
  readonly issues: ValidationIssue[] = []
  readonly passed: string[] = []

  check(name: string, condition: boolean, detail: string): boolean {
    if (condition) {
      if (!this.passed.includes(name)) this.passed.push(name)
      return true
    }
    this.issues.push({ check: name, detail })
    return false
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

/** Replays the recorded action list with the official engine and returns the reached outcome. */
export function replayRecordedGame(result: SelfPlayGameResult) {
  let state = makeInitialState()
  const counts = { R: emptyActionCounts(), B: emptyActionCounts() }
  const decisions = { R: 0, B: 0 }
  // Indexed loop, not an iterator: the ts-node runner downlevels to ES5.
  for (let index = 0; index < result.actions.length; index++) {
    const action = result.actions[index]!
    if (state.phase === 'finished' || state.result)
      return { ok: false as const, reason: `action ${index} applied after the game ended` }
    const mover = state.turn
    const legal = getLegalActions(state)
    if (!legal.some((candidate) => canonicalStringify(candidate) === canonicalStringify(action)))
      return { ok: false as const, reason: `action ${index} is illegal for ${mover}` }
    countActionAtoms(action, counts[mover])
    decisions[mover]++
    state = applyFullAction(state, action).state
  }
  const territory = state.result?.score ?? territoryCountsFromBoard(state.board)
  const winner = state.result?.tie
    ? ('tie' as const)
    : (state.result?.winner ??
      (territory.R === territory.B ? ('tie' as const) : territory.R > territory.B ? 'R' : 'B'))
  const terminal = state.phase === 'finished' || state.result !== undefined
  return {
    ok: true as const,
    winner,
    territory,
    terminal,
    counts,
    decisions,
    terminationReason: !terminal
      ? 'incomplete'
      : checkGameEnd(state.board, PLAYER_LIST.slice()).finished
        ? 'all-territory-closed'
        : 'all-players-blocked',
  }
}

function validateGame(
  collector: SelfPlayValidationCollector,
  result: SelfPlayGameResult,
  planned: SelfPlayPlanRow,
  metadataCommit: string,
  canonicalConfig: string,
  configHash: string,
): void {
  const id = result.gameId
  collector.check(
    'game-schema',
    result.schema === SELF_PLAY_SCHEMA_VERSION && result.experimentId === SELF_PLAY_EXPERIMENT_ID,
    `${id}: unexpected schema or experiment identifier`,
  )
  const planFields: (keyof SelfPlayPlanRow)[] = [
    'gameId',
    'gameNumber',
    'pairNumber',
    'orientation',
    'alphaSeedBase',
    'betaSeedBase',
    'redSeedBase',
    'blueSeedBase',
    'redSeedStream',
    'blueSeedStream',
  ]
  collector.check(
    'seeds-match-plan',
    planFields.every((field) => result[field] === planned[field]),
    `${id}: recorded seeds or identifiers do not match the deterministic plan`,
  )
  collector.check(
    'seeds-valid',
    Number.isInteger(result.redSeedBase) &&
      Number.isInteger(result.blueSeedBase) &&
      result.redSeedBase !== result.blueSeedBase &&
      result.redSeedCount === result.redDecisions &&
      result.blueSeedCount === result.blueDecisions &&
      result.redSeedCount <= SELF_PLAY_MAX_DECISIONS &&
      result.blueSeedCount <= SELF_PLAY_MAX_DECISIONS,
    `${id}: invalid seed usage`,
  )
  collector.check(
    'identical-configuration',
    canonicalStringify(result.redConfig) === canonicalStringify(result.blueConfig) &&
      result.configsIdentical,
    `${id}: red and blue configurations differ`,
  )
  collector.check(
    'official-configuration',
    canonicalStringify(result.redConfig) === canonicalConfig && result.configSha256 === configHash,
    `${id}: the configuration is not FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`,
  )
  collector.check(
    'commit-recorded',
    FULL_COMMIT.test(result.implementationCommit) && result.implementationCommit === metadataCommit,
    `${id}: missing or inconsistent implementation commit`,
  )
  collector.check(
    'complete-result',
    result.terminal &&
      ['all-territory-closed', 'all-players-blocked'].includes(result.terminationReason) &&
      Number.isFinite(result.durationMs) &&
      result.durationMs > 0 &&
      typeof result.startedAt === 'string' &&
      typeof result.finishedAt === 'string',
    `${id}: incomplete or non-terminal result`,
  )
  collector.check(
    'first-action-colour',
    result.firstActionColor === 'R',
    `${id}: the first action was not played by red`,
  )
  const territoryCoherent =
    result.territoryDiff === result.territoryRed - result.territoryBlue &&
    result.territoryRed >= 0 &&
    result.territoryBlue >= 0 &&
    result.territoryRed + result.territoryBlue <= BOARD_CELLS &&
    (result.winner === 'R'
      ? result.territoryRed > result.territoryBlue
      : result.winner === 'B'
        ? result.territoryBlue > result.territoryRed
        : result.territoryRed === result.territoryBlue) &&
    result.tie === (result.winner === 'tie') &&
    result.redScore === scoreForRed(result.winner)
  collector.check(
    'winner-matches-territory',
    territoryCoherent,
    `${id}: winner, tie flag or score is not coherent with the territory`,
  )
  const countsValid =
    result.totalDecisions === result.redDecisions + result.blueDecisions &&
    result.totalDecisions === result.actions.length &&
    result.redActions.placements === 2 &&
    result.blueActions.placements === 2 &&
    result.redActions.walls === result.redDecisions - result.redActions.placements &&
    result.blueActions.walls === result.blueDecisions - result.blueActions.placements &&
    result.redActions.moves >= 0 &&
    result.blueActions.moves >= 0 &&
    result.redActions.moves <= result.redActions.walls &&
    result.blueActions.moves <= result.blueActions.walls &&
    result.diagnostics.stoppedByTimeLimit === 0
  collector.check(
    'counts-and-metrics-valid',
    countsValid,
    `${id}: decision, move or wall counters are inconsistent`,
  )
  collector.check(
    'hashes-consistent',
    result.actionSequenceSha256 === sha256(canonicalStringify(result.actions)) &&
      result.outcomeSha256 ===
        sha256(
          canonicalStringify({
            gameId: result.gameId,
            winner: result.winner,
            territoryRed: result.territoryRed,
            territoryBlue: result.territoryBlue,
            totalDecisions: result.totalDecisions,
            terminationReason: result.terminationReason,
          }),
        ),
    `${id}: stored hashes do not match the stored content`,
  )
  const replay = replayRecordedGame(result)
  collector.check(
    'action-sequence-replays',
    replay.ok &&
      replay.winner === result.winner &&
      replay.territory.R === result.territoryRed &&
      replay.territory.B === result.territoryBlue &&
      replay.terminationReason === result.terminationReason &&
      replay.decisions.R === result.redDecisions &&
      replay.decisions.B === result.blueDecisions &&
      canonicalStringify(replay.counts.R) === canonicalStringify(result.redActions) &&
      canonicalStringify(replay.counts.B) === canonicalStringify(result.blueActions),
    `${id}: replaying the recorded actions does not reproduce the recorded outcome` +
      (replay.ok ? '' : ` (${replay.reason})`),
  )
}

export function validateHumanExperimentUntouched(
  collector: SelfPlayValidationCollector,
  guard = HUMAN_EXPERIMENT_GUARD,
): void {
  const run = (args: readonly string[]) =>
    execFileSync('git', [...args], { encoding: 'utf8' }).trim()
  let currentTree = ''
  let changedFiles = ''
  let dirty = ''
  try {
    currentTree = run(['rev-parse', `HEAD:${guard.directory}`])
    changedFiles = run([
      'diff',
      '--name-only',
      guard.referenceCommit,
      'HEAD',
      '--',
      guard.directory,
    ])
    dirty = run(['status', '--porcelain', '--', guard.directory])
  } catch (error) {
    collector.check(
      'human-experiment-frozen',
      false,
      `Unable to inspect ${guard.directory}: ${(error as Error).message}`,
    )
    return
  }
  collector.check(
    'human-experiment-frozen',
    currentTree === guard.referenceTree && changedFiles === '' && dirty === '',
    `The frozen V3-R1 human experiment changed: tree ${currentTree || 'unknown'} ` +
      `(expected ${guard.referenceTree}); committed changes "${changedFiles}"; ` +
      `working tree "${dirty}"`,
  )
}

export interface ValidateSelfPlayOptions {
  outputDir?: string
  pairCount?: number
  replaySample?: number
  skipGitGuard?: boolean
  /** Test-only override; the official command always demands the frozen configuration. */
  expectedConfig?: Readonly<HumanChallengeConfig>
  onProgress?: (message: string) => void
}

export function validateSelfPlayColorBiasDirectory(options: ValidateSelfPlayOptions = {}) {
  const outputDir = path.resolve(options.outputDir ?? SELF_PLAY_OUTPUT_DIRECTORY)
  const pairCount = options.pairCount ?? SELF_PLAY_PAIR_COUNT
  const expectedGames = pairCount * 2
  const replaySample = options.replaySample ?? DEFAULT_REPLAY_SAMPLE
  const onProgress = options.onProgress ?? (() => {})
  const collector = new SelfPlayValidationCollector()
  const expectedConfig = options.expectedConfig ?? FINAL_HUMAN_CHALLENGE_MCTS_CONFIG
  const canonicalConfig = canonicalStringify(expectedConfig)
  const configHash = sha256(canonicalConfig)

  const requiredFiles = [
    'metadata.json',
    'plan.json',
    'summary.json',
    'results.csv',
    'pairs.csv',
    'manifest.json',
    'README.md',
  ]
  const missing = requiredFiles.filter((file) => !existsSync(path.join(outputDir, file)))
  if (
    !collector.check(
      'required-files-present',
      missing.length === 0,
      `Missing files: ${missing.join(', ') || 'none'}`,
    )
  )
    return { ok: false, collector, summary: undefined }

  const metadata = readJson<{
    schema?: string
    experimentId?: string
    pairs?: number
    games?: number
    implementationCommit?: string
    agent?: { config?: unknown; configSha256?: string; appliedToBothColours?: boolean }
  }>(path.join(outputDir, 'metadata.json'))
  collector.check(
    'metadata-valid',
    metadata.schema === SELF_PLAY_METADATA_SCHEMA &&
      metadata.experimentId === SELF_PLAY_EXPERIMENT_ID &&
      metadata.pairs === pairCount &&
      metadata.games === expectedGames &&
      metadata.agent?.appliedToBothColours === true,
    'metadata.json does not describe the expected experiment',
  )
  collector.check(
    'metadata-commit-recorded',
    FULL_COMMIT.test(metadata.implementationCommit ?? ''),
    'metadata.json does not record a full implementation commit',
  )
  collector.check(
    'metadata-official-configuration',
    canonicalStringify(metadata.agent?.config) === canonicalConfig &&
      metadata.agent?.configSha256 === configHash,
    'metadata.json does not store FINAL_HUMAN_CHALLENGE_MCTS_CONFIG',
  )

  const plan = buildSelfPlayPlan(pairCount)
  try {
    validateSelfPlayPlan(plan, pairCount)
    collector.check('plan-deterministic', true, '')
  } catch (error) {
    collector.check('plan-deterministic', false, (error as Error).message)
  }
  collector.check(
    'stored-plan-matches',
    canonicalStringify(readJson(path.join(outputDir, 'plan.json'))) === canonicalStringify(plan),
    'plan.json does not match the deterministic plan',
  )

  const gameFiles = existsSync(path.join(outputDir, 'games'))
    ? readdirSync(path.join(outputDir, 'games')).filter((file) => file.endsWith('.json'))
    : []
  collector.check(
    'exactly-expected-games',
    gameFiles.length === expectedGames,
    `Expected ${expectedGames} game files but found ${gameFiles.length}`,
  )

  const results: SelfPlayGameResult[] = []
  for (const file of gameFiles.sort()) {
    try {
      results.push(readJson<SelfPlayGameResult>(path.join(outputDir, 'games', file)))
    } catch (error) {
      collector.check(
        'no-corrupt-files',
        false,
        `${file} is not valid JSON: ${(error as Error).message}`,
      )
    }
  }
  collector.check(
    'no-corrupt-files',
    results.length === gameFiles.length,
    'Some game files failed to parse',
  )
  collector.check(
    'no-duplicates',
    new Set(results.map((row) => row.gameId)).size === results.length &&
      new Set(results.map((row) => row.gameNumber)).size === results.length,
    'Duplicate game identifiers or game numbers',
  )
  collector.check(
    'exactly-expected-pairs',
    new Set(results.map((row) => row.pairNumber)).size === pairCount &&
      plan.every((row) => results.some((stored) => stored.gameId === row.gameId)),
    `Expected ${pairCount} complete pairs`,
  )

  const metadataCommit = metadata.implementationCommit ?? ''
  for (const planned of plan) {
    const stored = results.find((row) => row.gameId === planned.gameId)
    if (!stored) {
      collector.check('complete-result', false, `${planned.gameId}: missing result file`)
      continue
    }
    validateGame(collector, stored, planned, metadataCommit, canonicalConfig, configHash)
  }

  const manifest = readJson<{ files?: { path: string; sha256: string }[] }>(
    path.join(outputDir, 'manifest.json'),
  )
  const manifestValid =
    (manifest.files?.length ?? 0) === expectedGames &&
    (manifest.files ?? []).every((entry) => {
      const filePath = path.join(outputDir, entry.path)
      return existsSync(filePath) && sha256(readFileSync(filePath, 'utf8')) === entry.sha256
    })
  collector.check(
    'manifest-hashes-match',
    manifestValid,
    'manifest.json does not match the stored game files',
  )

  const summaryPath = path.join(outputDir, 'summary.json')
  const storedSummary = readJson<Record<string, unknown>>(summaryPath)
  let recomputed: ReturnType<typeof summarizeSelfPlayColorBias> | undefined
  if (results.length === expectedGames) {
    recomputed = summarizeSelfPlayColorBias(results, {
      generatedAt: storedSummary.generatedAt as string,
      expectedGames,
      expectedPairs: pairCount,
    })
    collector.check(
      'summary-reproducible',
      canonicalStringify(recomputed) === canonicalStringify(storedSummary),
      'summary.json does not match the summary recomputed from the individual games',
    )
    collector.check(
      'csv-matches-results',
      readFileSync(path.join(outputDir, 'results.csv'), 'utf8') ===
        toCsv([...results].sort((a, b) => a.gameNumber - b.gameNumber).map(toResultsCsvRow)),
      'results.csv does not match the individual game files',
    )
    collector.check(
      'pairs-csv-rows',
      readFileSync(path.join(outputDir, 'pairs.csv'), 'utf8').trim().split('\n').length ===
        pairCount + 1,
      `pairs.csv must contain ${pairCount} data rows`,
    )
  }

  if (replaySample > 0 && results.length) {
    const sample = plan.slice(0, replaySample)
    for (const planned of sample) {
      const stored = results.find((row) => row.gameId === planned.gameId)
      if (!stored) continue
      onProgress(`Re-running ${planned.gameId} to verify reproducibility…`)
      const rerun = runSelfPlayGame(planned, {
        implementationCommit: stored.implementationCommit,
        config: expectedConfig,
        sha256,
      })
      collector.check(
        'games-reproducible',
        rerun.actionSequenceSha256 === stored.actionSequenceSha256 &&
          rerun.outcomeSha256 === stored.outcomeSha256,
        `${planned.gameId}: re-running the game did not reproduce the stored result`,
      )
    }
  }

  if (!options.skipGitGuard) validateHumanExperimentUntouched(collector)

  return { ok: collector.issues.length === 0, collector, summary: recomputed }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = validateSelfPlayColorBiasDirectory({
    outputDir: args.output,
    pairCount: args.pairs ? Number(args.pairs) : undefined,
    replaySample: args.replay ? Number(args.replay) : undefined,
    onProgress: console.log,
  })
  for (const name of result.collector.passed) console.log(`ok   ${name}`)
  for (const issue of result.collector.issues) console.error(`FAIL ${issue.check}: ${issue.detail}`)
  if (!result.ok) {
    console.error(`\n${result.collector.issues.length} validation issues.`)
    process.exitCode = 1
    return
  }
  console.log('\nAll checks passed.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
