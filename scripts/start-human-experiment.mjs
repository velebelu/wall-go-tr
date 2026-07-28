import { execFileSync, spawn } from 'node:child_process'
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
} = {}) {
  const commit = getGitCommit(run)
  assertCleanWorktree(run)
  console.log(`Human experiment commit:\n${commit}`)
  const devCommand = resolveDevCommand(platform, environment)
  const childEnvironment = { ...environment, VITE_GIT_COMMIT: commit }
  const child = spawnProcess(devCommand.command, devCommand.args, {
    stdio: 'inherit',
    env: childEnvironment,
  })
  const watcherCommand = resolveWatcherCommand(platform, environment)
  const watcher = spawnProcess(watcherCommand.command, watcherCommand.args, {
    stdio: 'inherit',
    env: childEnvironment,
  })
  const children = [child, watcher]
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
  watcher.once('exit', onExit)
  return { child, watcher, commit, close: stopAll }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startHumanExperimentServer()
