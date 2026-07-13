import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditQ5Checkpoint1000Vs1500 } from './auditQ5Checkpoint1000Vs1500'

const Q5_1000_QTABLE_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json'
const Q5_1500_QTABLE_PATH =
  'data/entrenamiento/q5/hybrid/final_checkpoint_1500/qtable_q5_hybrid_final_1500.json'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q5-audit-'))
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(path.resolve(filePath))).digest('hex')
}

describe('auditQ5Checkpoint1000Vs1500', () => {
  it('creates audit artifacts and does not modify Q5 tables', async () => {
    const outputDir = path.join(makeTempDir(), 'audit')
    const hash1000Before = hashFile(Q5_1000_QTABLE_PATH)
    const hash1500Before = hashFile(Q5_1500_QTABLE_PATH)

    const result = await auditQ5Checkpoint1000Vs1500({ outputDir })

    expect(hashFile(Q5_1000_QTABLE_PATH)).toBe(hash1000Before)
    expect(hashFile(Q5_1500_QTABLE_PATH)).toBe(hash1500Before)
    expect(result.summary.hashes.qTablesChangedDuringAudit).toBe(false)
    expect(result.summary.qTable.entries.q1000).toBe(27815)
    expect(result.summary.qTable.entries.q1500).toBe(31244)
    expect(result.summary.qTable.entries.common).toBe(27815)
    expect(result.summary.qTable.entries.new).toBe(3429)
    expect(result.summary.qTable.entries.disappeared).toBe(0)
    expect(result.changeRows).toHaveLength(31244)
    expect(result.summary.qTable.valueDirection.increased).toBeGreaterThan(0)
    expect(result.summary.qTable.valueDirection.decreased).toBeGreaterThan(0)
    expect(result.summary.thresholdTransitions.observedCandidateRows).toBeGreaterThan(0)
    expect(existsSync(path.join(outputDir, 'audit_summary.json'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'q_value_changes.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'threshold_transitions.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'largest_decreases.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'largest_increases.csv'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'audit_report.md'))).toBe(true)
  }, 60000)
})
