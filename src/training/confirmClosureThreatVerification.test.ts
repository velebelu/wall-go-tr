import { describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG } from '@/engine/mcts/closureThreatVerification'
import {
  COMPETITIVE_GAMES_PER_VARIANT_RIVAL,
  CRITICAL_TURNS,
  FIXTURE_SEEDS,
  NORMAL_SEEDS,
  NORMAL_TURNS,
} from './confirmClosureThreatVerification'

describe('closure threat verification confirmation protocol', () => {
  it('defines the requested paired sample sizes', () => {
    expect(CRITICAL_TURNS).toEqual([34, 36, 38])
    expect(FIXTURE_SEEDS).toHaveLength(20)
    expect(new Set(FIXTURE_SEEDS).size).toBe(20)
    expect(CRITICAL_TURNS.length * FIXTURE_SEEDS.length * 2).toBe(120)
    expect(NORMAL_TURNS).toHaveLength(30)
    expect(NORMAL_SEEDS).toHaveLength(2)
    expect(COMPETITIVE_GAMES_PER_VARIANT_RIVAL * 2 * 2).toBe(160)
  })

  it('keeps the frozen and detector parameters exact', () => {
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget).toMatchObject({
      enable750: false,
      base: 250,
      lowConfidence: 500,
      maxDecisionMs: 5_000,
    })
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts.qPriorWeight).toBe(0)
    expect(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame.enabled).toBe(false)
    expect(EXPERIMENTAL_CLOSURE_THREAT_VERIFICATION_CONFIG).toEqual({
      enabled: true,
      candidateCount: 4,
      maxRepliesPerCandidate: 80,
      maxTimeMsPerCandidate: 250,
      minimumOpponentTerritoryGain: 12,
      minimumOwnAccessibleDrop: 12,
      minimumExposedComponentSize: 15,
      terminalTerritoryDiffThreshold: -12,
    })
  })
})
