import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = 'data/entrenamiento/mcts/confirmacion_closure_threat_verification'
const shardRoots = Array.from({ length: 4 }, (_, index) => `${root}_shard_${index}`)
const mainPath = path.join(root, 'progress.json')
const progress = JSON.parse(readFileSync(mainPath, 'utf8')) as Record<string, unknown>
const shards = shardRoots.map((directory) =>
  JSON.parse(readFileSync(path.join(directory, 'progress.json'), 'utf8')),
) as Array<Record<string, unknown>>
function uniqueBy<T extends Record<string, unknown>>(rows: T[], field: keyof T): T[] {
  return Array.from(new Map(rows.map((row) => [row[field], row])).values())
}

const matches = uniqueBy(
  shards.flatMap((shard) => shard.matches as Array<Record<string, unknown>>),
  'id',
)
const normalPositions = uniqueBy(
  shards.flatMap((shard) => shard.normalPositions as Array<Record<string, unknown>>),
  'id',
)
const timings = uniqueBy(
  shards.flatMap((shard) =>
    (shard.timings as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      uniqueId: `${row.scope}:${row.gameId}:${row.variant}:${row.decisionIndex}`,
    })),
  ),
  'uniqueId',
).map(({ uniqueId: _uniqueId, ...row }) => row)
const changes = uniqueBy(
  shards.flatMap((shard) =>
    (shard.changes as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      uniqueId: `${row.scope}:${row.gameId}:${row.turnIndex}:${JSON.stringify(row.finalAction)}`,
    })),
  ),
  'uniqueId',
).map(({ uniqueId: _uniqueId, ...row }) => row)

const fixtureCount = matches.filter((row) => row.scope === 'fixture').length
const competitiveCount = matches.filter((row) => row.scope === 'competitive').length
if (fixtureCount !== 120 || normalPositions.length !== 60 || competitiveCount !== 160)
  throw new Error(
    `Incomplete merge: fixtures=${fixtureCount}, normal=${normalPositions.length}, competitive=${competitiveCount}`,
  )

const startedAt = String(progress.startedAt)
Object.assign(progress, {
  matches,
  normalPositions,
  timings,
  changes,
  complete: false,
  updatedAt: new Date().toISOString(),
  durationMs: Date.now() - Date.parse(startedAt),
})
writeFileSync(mainPath, `${JSON.stringify(progress, null, 2)}\n`)
console.log(
  JSON.stringify({
    fixtures: fixtureCount,
    normalPositions: normalPositions.length,
    competitive: competitiveCount,
    timings: timings.length,
    changes: changes.length,
  }),
)
