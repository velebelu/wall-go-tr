import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseHumanMCTSTrace,
  replayHumanMCTSTrace,
  type ReplayResult,
} from '@/utils/humanMCTSTrace'

export function replayHumanMCTSTraceFile(filePath: string): ReplayResult {
  const trace = parseHumanMCTSTrace(readFileSync(path.resolve(filePath), 'utf8'))
  return replayHumanMCTSTrace(trace)
}

function main(): void {
  const filePath = process.argv[2]
  if (!filePath) throw new Error('Usage: npm run replay:human-mcts -- <trace.json>')
  const result = replayHumanMCTSTraceFile(filePath)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
