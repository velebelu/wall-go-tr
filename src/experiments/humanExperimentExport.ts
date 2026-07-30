import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { canonicalStringify, sha256Canonical } from './humanExperimentCanonical'
import { summarizeHumanExperiment } from './humanExperimentSummary'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import { validateRegistry } from './humanExperimentValidation'

export async function readRegistry(path: string): Promise<HumanExperimentRegistry> {
  return JSON.parse(await readFile(path, 'utf8')) as HumanExperimentRegistry
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  hooks: { beforeRename?: () => Promise<void> | void } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const json = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(temporary, json, { encoding: 'utf8', flag: 'wx' })
    JSON.parse(await readFile(temporary, 'utf8'))
    await hooks.beforeRename?.()
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export function participantsCsv(registry: HumanExperimentRegistry): string {
  const columns = [
    'experimentId',
    'participantId',
    'experienceGroup',
    'previousWallGoGames',
    'practiceGames',
    'firstColor',
    'secondColor',
    'notes',
  ]
  const rows = registry.participants.map((participant) => [
    participant.experimentId,
    participant.participantId,
    participant.experienceGroup,
    participant.previousWallGoGames,
    participant.practiceGames,
    participant.colorOrder[0],
    participant.colorOrder[1],
    participant.notes ?? '',
  ])
  return csv(columns, rows)
}

export function gamesCsv(registry: HumanExperimentRegistry): string {
  const columns = [
    'experimentId',
    'participantId',
    'gameId',
    'gameNumber',
    'humanColor',
    'aiColor',
    'winner',
    'humanTerritory',
    'aiTerritory',
    'territoryDiffHuman',
    'turnCount',
    'startedAt',
    'finishedAt',
    'durationMs',
    'terminalReason',
    'traceId',
    'tracePath',
    'traceSha256',
    'seed',
    'effectiveConfigSha256',
    'sourceCommit',
    'sourceVersion',
    'recordedAt',
    'incidents',
  ]
  const rows = registry.games.map((game) => [
    game.experimentId,
    game.participantId,
    game.gameId,
    game.gameNumber,
    game.humanColor,
    game.aiColor,
    game.winner,
    game.humanTerritory,
    game.aiTerritory,
    game.territoryDiffHuman,
    game.turnCount,
    game.startedAt,
    game.finishedAt,
    game.durationMs,
    game.terminalReason,
    game.traceId,
    game.tracePath,
    game.traceSha256,
    game.seed,
    game.effectiveConfigSha256,
    game.sourceCommit,
    game.sourceVersion ?? '',
    game.recordedAt,
    game.incidents
      .map((incident) =>
        incident.description ? `${incident.code}:${incident.description}` : incident.code,
      )
      .join('|'),
  ])
  return csv(columns, rows)
}

export async function exportHumanExperiment(params: {
  registry: HumanExperimentRegistry
  outputDirectory: string
  command: string
  globalIncidents?: string[]
  exportedAt?: string
}) {
  validateRegistry(params.registry)
  const output = resolve(params.outputDirectory)
  await mkdir(output, { recursive: true })
  const participantText = participantsCsv(params.registry)
  const gameText = gamesCsv(params.registry)
  const summary = summarizeHumanExperiment(params.registry.participants, params.registry.games)
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`
  const files = {
    participants: 'participants.csv',
    games: 'games.csv',
    summary: 'summary.json',
  }
  await Promise.all([
    writeFile(resolve(output, files.participants), participantText),
    writeFile(resolve(output, files.games), gameText),
    writeFile(resolve(output, files.summary), summaryText),
  ])
  const manifest = {
    schema: 'HumanExperimentManifestV1',
    experimentId: params.registry.experimentId,
    exportedAt: params.exportedAt ?? new Date().toISOString(),
    sourceCommits: Array.from(
      new Set(params.registry.games.map((game) => game.sourceCommit)),
    ).sort(),
    expectedConfigSha256: await sha256Canonical(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG),
    participantCount: params.registry.participants.length,
    gameCount: params.registry.games.length,
    files: {
      [files.participants]: sha256Text(participantText),
      [files.games]: sha256Text(gameText),
      [files.summary]: sha256Text(summaryText),
    },
    validation: { ok: true },
    globalIncidents: params.globalIncidents ?? [],
    command: params.command,
  }
  const manifestPath = resolve(output, 'manifest.json')
  await atomicWriteJson(manifestPath, manifest)
  return { summary, manifest, outputDirectory: relative(process.cwd(), output).replace(/\\/g, '/') }
}

export function registryJson(registry: HumanExperimentRegistry): string {
  return `${canonicalStringify(registry)}\n`
}

function csv(columns: string[], rows: Array<Array<string | number>>): string {
  return `${[columns, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n')}\n`
}
function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
