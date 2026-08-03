import {
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
  type HumanChallengeConfig,
} from '@/agents/humanChallengeMCTS'

/**
 * Same architecture, same seeding protocol and same staged-budget mechanics as the frozen
 * configuration, but with a tiny simulation budget so the automated tests can play complete
 * games in seconds. It exists only for tests: the experiment commands always use
 * `FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`, and the validator demands that constant by default.
 */
export const FAST_SELF_PLAY_CONFIG: Readonly<HumanChallengeConfig> = Object.freeze({
  mcts: Object.freeze({ ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts, simulations: 4, maxDepth: 6 }),
  budget: Object.freeze({
    ...FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.budget,
    base: 4,
    lowConfidence: 6,
    highUncertainty: 8,
    maxDecisionMs: 600_000,
  }),
  endgame: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.endgame,
})
