import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CURRENT_EXPERIMENT_ID = 'WGTR-HUMAN-FINAL-2026-V3'
export const CURRENT_EXPERIMENT_DIRECTORY = 'data/human-experiment/final-2026-v3'
export const CODE_FREEZE_METADATA_PATH = 'data/human-experiment/final-2026-v3/metadata.json'

const OPERATIONAL_EXPERIMENT_PATHS = [
  /^data\/human-experiment\/final-2026-v3\/metadata\.json$/,
  /^data\/human-experiment\/final-2026-v3\/registry\.json$/,
  /^data\/human-experiment\/final-2026-v3\/participants\/P0[1-8]\/participant\.json$/,
  /^data\/human-experiment\/final-2026-v3\/participants\/P0[1-8]\/game-[12]\.json$/,
  /^data\/human-experiment\/final-2026-v3\/participants\/P0[1-8]\/traces\/[^/]+$/,
  /^data\/human-experiment\/final-2026-v3\/participants\/P0[1-8]\/auxiliary\/game-[12]\/[^/]+$/,
  /^data\/human-experiment\/final-2026-v3\/participants\/P0[1-8]\/checklist\.md$/,
  // Non-playable operational infrastructure may evolve without changing the frozen game runtime.
  /^src\/experiments\/humanExperiment(Ingestion|Transaction|Watcher)(\.test)?\.ts$/,
  /^src\/training\/validateHumanExperimentV3\.test\.ts$/,
  /^src\/experiments\/humanExperimentParticipantSetup\.test\.ts$/,
  /^scripts\/start-human-experiment\.mjs$/,
]

export function validateFullCommit(value) {
  const commit = String(value).trim()
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Invalid Git commit: ${commit || '<empty>'}`)
  return commit
}

export function getGitCommit(run = execFileSync) {
  try {
    return validateFullCommit(run('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }))
  } catch (error) {
    throw new Error(
      `Unable to determine Git commit: ${error instanceof Error ? error.message : error}`,
    )
  }
}

export function assertCleanWorktree(run = execFileSync) {
  const status = String(
    run('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }),
  ).trim()
  if (status)
    throw new Error(
      'El experimento humano está congelado: hay cambios sin commit. Revise y cree el commit final antes de recoger partidas.',
    )
}

export function resolveDevCommand(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    const command = environment.ComSpec || environment.COMSPEC
    if (!command) throw new Error('Unable to start Vite: ComSpec is not available on Windows')
    return { command, args: ['/d', '/s', '/c', 'npm run dev'] }
  }
  return { command: 'npm', args: ['run', 'dev'] }
}

export function resolveWatcherCommand(platform = process.platform, environment = process.env) {
  const args = ['--import', './scripts/run-ts-node-esm.mjs', 'src/training/watchHumanExperiment.ts']
  if (platform === 'win32') {
    const command = environment.ComSpec || environment.COMSPEC
    if (!command) throw new Error('Unable to start watcher: ComSpec is not available on Windows')
    return { command, args: ['/d', '/s', '/c', `node ${args.join(' ')}`] }
  }
  return { command: 'node', args }
}

export function startHumanExperimentServer({
  run = execFileSync,
  spawnProcess = spawn,
  platform = process.platform,
  environment = process.env,
  argv = process.argv.slice(2),
  read = readFileSync,
} = {}) {
  const commit = getGitCommit(run)
  assertCleanWorktree(run)
  console.log(`Human experiment commit:\n${commit}`)
  const sessionEnvironment = resolveSessionEnvironment(
    argv,
    {
      ...environment,
      RUNTIME_GIT_COMMIT: commit,
      COMMIT_EXISTS: (candidate) => {
        run('git', ['cat-file', '-e', `${candidate}^{commit}`], { stdio: 'ignore' })
        return true
      },
      COMMIT_IS_ANCESTOR: (ancestor, descendant) => {
        run('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' })
        return true
      },
      ANCESTRY_PATH: (ancestor, descendant) =>
        String(
          run('git', ['rev-list', '--ancestry-path', '--reverse', `${ancestor}..${descendant}`], {
            encoding: 'utf8',
          }),
        )
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      COMMIT_PARENTS: (candidate) =>
        String(run('git', ['show', '-s', '--format=%P', candidate], { encoding: 'utf8' }))
          .trim()
          .split(/\s+/)
          .filter(Boolean),
      CHANGED_PATHS_IN_COMMIT: (candidate) =>
        String(
          run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', candidate], {
            encoding: 'utf8',
          }),
        )
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
      FILE_AT_COMMIT: (candidate, path) =>
        String(run('git', ['show', `${candidate}:${path}`], { encoding: 'utf8' })),
      CHANGED_PATHS_SINCE_BINDING: (binding, runtime) =>
        String(run('git', ['diff', '--name-only', `${binding}..${runtime}`], { encoding: 'utf8' }))
          .split(/\r?\n/)
          .map((path) => path.trim())
          .filter(Boolean),
    },
    read,
  )
  const devCommand = resolveDevCommand(platform, environment)
  const childEnvironment = {
    ...environment,
    VITE_SECURED_TERRITORY_POLICY: undefined,
    SECURED_TERRITORY_POLICY: undefined,
    VITE_GIT_COMMIT: commit,
    ...sessionEnvironment,
  }
  const child = spawnProcess(devCommand.command, devCommand.args, {
    stdio: 'inherit',
    env: childEnvironment,
  })
  const watcher =
    sessionEnvironment.VITE_SESSION_TYPE === 'official'
      ? spawnProcess(
          resolveWatcherCommand(platform, environment).command,
          resolveWatcherCommand(platform, environment).args,
          { stdio: 'inherit', env: childEnvironment },
        )
      : undefined
  const children = watcher ? [child, watcher] : [child]
  let stopping = false
  const stopAll = (signal = 'SIGTERM') => {
    if (stopping) return
    stopping = true
    for (const running of children) if (!running.killed) running.kill(signal)
  }
  const forward = (signal) => {
    stopAll(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  const onExit = (code, signal) => {
    stopAll(signal || 'SIGTERM')
    process.removeListener('SIGINT', forward)
    process.removeListener('SIGTERM', forward)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  }
  child.once('exit', onExit)
  watcher?.once('exit', onExit)
  return { child, watcher, commit, close: stopAll }
}

export function resolveSessionEnvironment(argv, environment = process.env, read = readFileSync) {
  const [sessionType, participantId, gameNumberOrAiColor] = argv
  if (sessionType === 'official') {
    if (!participantId || !gameNumberOrAiColor)
      throw new Error('Uso: npm run human-experiment:start -- official P01 <1|2>')
    const gameNumber = Number(gameNumberOrAiColor)
    if (gameNumber !== 1 && gameNumber !== 2) throw new Error('gameNumber must be 1 or 2')
    if (
      environment.HUMAN_EXPERIMENT_DIRECTORY &&
      environment.HUMAN_EXPERIMENT_DIRECTORY.replace(/\\/g, '/') !== CURRENT_EXPERIMENT_DIRECTORY
    )
      throw new Error('Official sessions only accept the current V3 experiment directory')
    const directory = CURRENT_EXPERIMENT_DIRECTORY
    const registry = JSON.parse(read(resolve(directory, 'registry.json'), 'utf8'))
    const metadata = JSON.parse(read(resolve(directory, 'metadata.json'), 'utf8'))
    if (
      registry.experimentId !== CURRENT_EXPERIMENT_ID ||
      metadata.experimentId !== CURRENT_EXPERIMENT_ID
    )
      throw new Error('Official sessions only accept WGTR-HUMAN-FINAL-2026-V3')
    const validatedFreeze = validateOfficialCodeFreeze(metadata, environment.RUNTIME_GIT_COMMIT, {
      commitExists: environment.COMMIT_EXISTS,
      isAncestor: environment.COMMIT_IS_ANCESTOR,
      ancestryPath: environment.ANCESTRY_PATH,
      commitParents: environment.COMMIT_PARENTS,
      changedPathsInCommit: environment.CHANGED_PATHS_IN_COMMIT,
      fileAtCommit: environment.FILE_AT_COMMIT,
      changedPaths: environment.CHANGED_PATHS_SINCE_BINDING,
    })
    const participant = registry.participants.find((row) => row.participantId === participantId)
    if (!participant) throw new Error(`Participant is not registered: ${participantId}`)
    if (
      registry.games.some(
        (row) => row.participantId === participantId && row.gameNumber === gameNumber,
      )
    )
      throw new Error(`Game ${gameNumber} is already registered for ${participantId}`)
    if (
      gameNumber === 2 &&
      !registry.games.some((row) => row.participantId === participantId && row.gameNumber === 1)
    )
      throw new Error('Game 1 must be registered before game 2')
    const humanColor = participant.colorOrder[gameNumber - 1]
    const aiColor = humanColor === 'R' ? 'B' : 'R'
    return {
      VITE_EXPERIMENT_ID: registry.experimentId,
      VITE_PARTICIPANT_ID: participantId,
      VITE_GAME_NUMBER: String(gameNumber),
      VITE_SESSION_TYPE: 'official',
      VITE_SESSION_ID: crypto.randomUUID(),
      VITE_HUMAN_COLOR: humanColor,
      VITE_AI_COLOR: aiColor,
      VITE_IMPLEMENTATION_COMMIT: validatedFreeze.implementationCommit,
      VITE_EXPERIMENT_PREPARATION_COMMIT: validatedFreeze.experimentPreparationCommit,
      VITE_CODE_FREEZE_BINDING_COMMIT: validatedFreeze.codeFreezeBindingCommit,
    }
  }
  if (sessionType === 'practice') {
    if (!participantId || gameNumberOrAiColor)
      throw new Error('Uso: npm run human-experiment:start -- practice P01')
    const registry = JSON.parse(
      read(resolve(CURRENT_EXPERIMENT_DIRECTORY, 'registry.json'), 'utf8'),
    )
    const participant = registry.participants.find((row) => row.participantId === participantId)
    if (!participant) throw new Error(`Participant is not registered: ${participantId}`)
    const humanColor = participant.colorOrder[0]
    return {
      VITE_EXPERIMENT_ID: CURRENT_EXPERIMENT_ID,
      VITE_PARTICIPANT_ID: participantId,
      VITE_SESSION_TYPE: 'practice',
      VITE_SESSION_ID: crypto.randomUUID(),
      VITE_HUMAN_COLOR: humanColor,
      VITE_AI_COLOR: humanColor === 'R' ? 'B' : 'R',
    }
  }
  if (sessionType === 'diagnostic') {
    const aiColor = participantId
    if (aiColor !== 'R' && aiColor !== 'B')
      throw new Error(`Uso: npm run human-experiment:start -- ${sessionType} <R|B>`)
    return {
      VITE_EXPERIMENT_ID: 'WGTR-DIAGNOSTIC',
      VITE_SESSION_TYPE: sessionType,
      VITE_SESSION_ID: crypto.randomUUID(),
      VITE_HUMAN_COLOR: aiColor === 'R' ? 'B' : 'R',
      VITE_AI_COLOR: aiColor,
    }
  }
  throw new Error('Debe indicar el contexto: official P01 <1|2>, practice P01 o diagnostic <R|B>')
}

export function validateOfficialCodeFreeze(metadata, runtimeCommit, git = {}) {
  const freeze = metadata?.codeFreeze
  if (metadata?.aiPolicy?.securedTerritoryPolicy !== false)
    throw new Error('securedTerritoryPolicy must remain disabled')
  if (freeze?.status !== 'frozen') throw new Error('V3 metadata is not frozen')
  const implementation = validateFullCommit(freeze?.implementationCommit)
  const preparation = validateFullCommit(freeze?.experimentPreparationCommit)
  if (implementation !== preparation)
    throw new Error('V3 implementationCommit and experimentPreparationCommit must match')
  const runtime = validateFullCommit(runtimeCommit)
  const commitExists = git.commitExists ?? (() => true)
  for (const commit of [implementation, preparation, runtime]) {
    try {
      if (!commitExists(commit)) throw new Error('not found')
    } catch {
      throw new Error(`Frozen commit does not exist: ${commit}`)
    }
  }
  try {
    if (!(git.isAncestor ?? (() => true))(implementation, runtime)) throw new Error('not ancestor')
  } catch {
    throw new Error('Runtime commit does not descend from the V3 implementation commit')
  }
  const ancestry = (git.ancestryPath ?? (() => []))(implementation, runtime).map(validateFullCommit)
  const binding = ancestry[0]
  if (!binding) throw new Error('V3 code-freeze binding commit is missing')
  const parents = (git.commitParents ?? (() => [implementation]))(binding).map(validateFullCommit)
  if (parents.length !== 1 || parents[0] !== implementation)
    throw new Error('V3 code-freeze binding must be the immediate child of the implementation')
  const bindingPaths = (git.changedPathsInCommit ?? (() => [CODE_FREEZE_METADATA_PATH]))(binding)
    .map(normalizeGitPath)
    .sort()
  if (bindingPaths.length !== 1 || bindingPaths[0] !== CODE_FREEZE_METADATA_PATH)
    throw new Error('V3 code-freeze binding must modify only metadata.json')
  if (git.fileAtCommit) {
    let boundMetadata
    try {
      boundMetadata = JSON.parse(git.fileAtCommit(binding, CODE_FREEZE_METADATA_PATH))
    } catch {
      throw new Error('Unable to read V3 metadata from the code-freeze binding commit')
    }
    if (JSON.stringify(boundMetadata?.codeFreeze) !== JSON.stringify(freeze))
      throw new Error('Runtime metadata does not match the code-freeze binding commit')
  }
  const changedPaths = (git.changedPaths ?? (() => []))(binding, runtime)
  const forbidden = changedPaths
    .map(normalizeGitPath)
    .filter((path) => !isAllowedOperationalExperimentPath(path))
  if (forbidden.length)
    throw new Error(`Functional files changed after the V3 code freeze: ${forbidden.join(', ')}`)
  return { ...freeze, codeFreezeBindingCommit: binding }
}

export function isAllowedOperationalExperimentPath(path) {
  const normalized = normalizeGitPath(path)
  return OPERATIONAL_EXPERIMENT_PATHS.some((pattern) => pattern.test(normalized))
}

function normalizeGitPath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startHumanExperimentServer()
