import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import { serializeGameSnapshot } from '@/utils/humanMCTSTrace'
import {
  classifyPairedDeltas,
  CONTINUATION_DETECTOR_ENABLED,
  loadProgress,
  pairedBootstrap95,
  pairedContinuationSeed,
  TARGET_INTERVENTIONS,
  validateFixture,
  VERSION,
  type InterventionFixture,
} from './captureDirectedClosureThreat'

function fixture(): InterventionFixture {
  const state = makeInitialState()
  const legal = [...getLegalActions(state)]
  return {
    schema: 'ClosureThreatInterventionFixtureV1',
    version: VERSION,
    interventionId: 'game-turn-0-unique',
    gameId: 'game',
    gameIndex: 0,
    turnIndex: 0,
    phaseBand: 'opening',
    rival: 'heuristic',
    candidateColor: 'R',
    player: 'R',
    seed: 1,
    decisionSeed: 1,
    state: serializeGameSnapshot(state),
    legalActions: legal,
    originalAction: legal[0]!,
    detectorAction: legal[1]!,
    candidates: [],
    top2Diagnostics: [],
    inspectedReplies: [
      {
        candidateAction: legal[0]!,
        repliesAvailable: 1,
        repliesInspected: 1,
        responses: [
          {
            order: 0,
            action: legal[1]!,
            ownStonesBefore: 0,
            rivalStonesBefore: 0,
            ownStonesAfter: 1,
            rivalStonesAfter: 0,
            diagnostic: {
              action: legal[1]!,
              ownTerritoryBefore: 0,
              ownTerritoryAfter: 0,
              opponentTerritoryBefore: 0,
              opponentTerritoryAfter: 0,
              ownAccessibleBefore: 49,
              ownAccessibleAfter: 49,
              opponentAccessibleBefore: 49,
              opponentAccessibleAfter: 49,
              opponentTerritoryGain: 0,
              ownAccessibleDrop: 0,
              largestComponentBefore: 49,
              largestComponentAfter: 49,
              lostLastOwnStoneInLargeComponent: false,
              exposedComponentSize: 0,
              severe: false,
              reasons: [],
            },
          },
        ],
      },
    ],
    reason: 'safer-candidate-preferred',
    threatsDetected: 1,
    simulations: 250,
    baseBudget: 250,
    effectiveBudget: 250,
    searchMs: 10,
    detectorMs: 2,
    mctsConfig: {} as InterventionFixture['mctsConfig'],
    detectorConfig: {} as InterventionFixture['detectorConfig'],
  }
}

describe('directed closure capture protocol', () => {
  it('persists and validates a complete root state', () => {
    const value = fixture()
    expect(() => validateFixture(value)).not.toThrow()
    expect(value.state.board).toHaveLength(7)
    expect(value.legalActions.length).toBeGreaterThan(1)
  })

  it('serializes actions and inspected responses', () => {
    const restored = JSON.parse(JSON.stringify(fixture())) as InterventionFixture
    expect(() => validateFixture(restored)).not.toThrow()
    expect(restored.inspectedReplies[0]?.responses[0]?.action).toBeTruthy()
  })

  it('rejects incomplete response serialization', () => {
    const value = fixture()
    value.inspectedReplies[0]!.repliesInspected = 2
    expect(() => validateFixture(value)).toThrow(/incomplete response/)
  })

  it('uses unique paired seeds and the same seed can serve both branches', () => {
    const seeds = Array.from({ length: 10 }, (_, index) => pairedContinuationSeed(3, index))
    expect(new Set(seeds).size).toBe(10)
    expect(pairedContinuationSeed(3, 4)).toBe(pairedContinuationSeed(3, 4))
  })

  it('resumes and removes duplicate progress entries', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'closure-progress-'))
    writeFileSync(
      path.join(directory, 'progress.json'),
      JSON.stringify({
        schema: 'DirectedClosureCaptureProgressV1',
        version: VERSION,
        startedAt: 'x',
        updatedAt: 'x',
        gamesCompleted: ['g', 'g'],
        interventionIds: ['i', 'i'],
        counterfactualResults: [
          { interventionId: 'i', pairIndex: 0, branch: 'original' },
          { interventionId: 'i', pairIndex: 0, branch: 'original' },
        ],
        complete: false,
      }),
    )
    const progress = loadProgress(directory)
    expect(progress.gamesCompleted).toEqual(['g'])
    expect(progress.interventionIds).toEqual(['i'])
    expect(progress.counterfactualResults).toHaveLength(1)
  })

  it('keeps the detector disabled after the forced action', () => {
    expect(CONTINUATION_DETECTOR_ENABLED).toBe(false)
    const source = readFileSync(
      path.join(process.cwd(), 'src/training/captureDirectedClosureThreat.ts'),
      'utf8',
    )
    expect(source).toContain('chooseHumanChallengeMCTSDecision({')
  })

  it('classifies individual paired evidence conservatively', () => {
    expect(classifyPairedDeltas([2, 1, 3, 2, 1, 4, 2, 1, 3, 0])).toBe('beneficial')
    expect(classifyPairedDeltas([-2, -1, -3, -2, -1, -4, -2, -1, -3, 0])).toBe('harmful')
    expect(classifyPairedDeltas(Array(10).fill(0))).toBe('neutral')
    expect(classifyPairedDeltas([2, -2, 1, -1, 0, 2, -2, 1, -1, 0])).toBe('inconclusive')
  })

  it('computes a deterministic paired bootstrap interval', () => {
    expect(pairedBootstrap95([1, 2, 3, 4])).toEqual(pairedBootstrap95([1, 2, 3, 4]))
    expect(pairedBootstrap95([])).toBeNull()
  })

  it('does not derive intervention quality from a global game result', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/training/captureDirectedClosureThreat.ts'),
      'utf8',
    )
    expect(source).not.toContain('pairQuality(')
    expect(TARGET_INTERVENTIONS).toBe(20)
  })
})
