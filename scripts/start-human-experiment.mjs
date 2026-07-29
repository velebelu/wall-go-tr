import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
} = {}) {
  const commit = getGitCommit(run)
  assertCleanWorktree(run)
  console.log(`Human experiment commit:\n${commit}`)
  const sessionEnvironment = resolveSessionEnvironment(argv, {
    ...environment,
    RUNTIME_GIT_COMMIT: commit,
  })
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
    const directory =
      environment.HUMAN_EXPERIMENT_DIRECTORY ?? 'data/human-experiment/final-2026-v2'
    const registry = JSON.parse(read(resolve(directory, 'registry.json'), 'utf8'))
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
    }
  }
  if (sessionType === 'practice') {
    if (!participantId || gameNumberOrAiColor)
      throw new Error('Uso: npm run human-experiment:start -- practice P01')
    const directory =
      environment.HUMAN_EXPERIMENT_DIRECTORY ?? 'data/human-experiment/final-2026-v2'
    const registry = JSON.parse(read(resolve(directory, 'registry.json'), 'utf8'))
    const participant = registry.participants.find((row) => row.participantId === participantId)
    if (!participant) throw new Error(`Participant is not registered: ${participantId}`)
    const humanColor = participant.colorOrder[0]
    return {
      VITE_EXPERIMENT_ID: registry.experimentId,
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startHumanExperimentServer()
