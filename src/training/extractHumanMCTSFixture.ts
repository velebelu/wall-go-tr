import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractHumanMCTSDecisionFixture,
  parseHumanMCTSTrace,
  type HumanMCTSDecisionFixtureV1,
} from '@/utils/humanMCTSTrace'

export function extractHumanMCTSFixtureFile(
  tracePath: string,
  turnIndex: number,
  outputPath?: string,
): { fixture: HumanMCTSDecisionFixtureV1; outputPath: string } {
  const resolvedTracePath = path.resolve(tracePath)
  const trace = parseHumanMCTSTrace(readFileSync(resolvedTracePath, 'utf8'))
  const fixture = extractHumanMCTSDecisionFixture(trace, turnIndex)
  const resolvedOutput = path.resolve(
    outputPath ??
      path.join(
        path.dirname(resolvedTracePath),
        `${path.basename(tracePath, path.extname(tracePath))}_turn_${turnIndex}.fixture.json`,
      ),
  )
  writeFileSync(resolvedOutput, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  return { fixture, outputPath: resolvedOutput }
}

function main(): void {
  const tracePath = process.argv[2]
  const rawTurn = process.argv[3]
  const outputPath = process.argv[4]
  if (!tracePath || rawTurn === undefined) {
    throw new Error('Usage: npm run fixture:human-mcts -- <trace.json> <turn-index> [output.json]')
  }
  const turnIndex = Number(rawTurn)
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error('turn-index must be a non-negative integer')
  }
  const result = extractHumanMCTSFixtureFile(tracePath, turnIndex, outputPath)
  console.log(JSON.stringify({ outputPath: result.outputPath, turnIndex }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
