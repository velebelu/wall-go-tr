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

export function resolveDevCommand(platform = process.platform, environment = process.env) {
  if (platform === 'win32') {
    const command = environment.ComSpec || environment.COMSPEC
    if (!command) throw new Error('Unable to start Vite: ComSpec is not available on Windows')
    return { command, args: ['/d', '/s', '/c', 'npm run dev'] }
  }
  return { command: 'npm', args: ['run', 'dev'] }
}

export function startHumanExperimentServer({
  run = execFileSync,
  spawnProcess = spawn,
  platform = process.platform,
  environment = process.env,
} = {}) {
  const commit = getGitCommit(run)
  console.log(`Human experiment commit:\n${commit}`)
  const devCommand = resolveDevCommand(platform, environment)
  const child = spawnProcess(devCommand.command, devCommand.args, {
    stdio: 'inherit',
    env: { ...environment, VITE_GIT_COMMIT: commit },
  })
  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', forward)
    process.removeListener('SIGTERM', forward)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  return { child, commit }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  startHumanExperimentServer()
