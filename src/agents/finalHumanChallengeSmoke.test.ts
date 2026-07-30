import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  parseHumanMCTSTrace,
  replayHumanMCTSTrace,
  serializeHumanMCTSTrace,
} from '@/utils/humanMCTSTrace'
import { getLegalActions } from '@/utils/ai'
import type { TurnDecisionTrace } from './TurnManager'
import {
  chooseHumanChallengeMCTSDecision,
  FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
} from './humanChallengeMCTS'

function append(
  trace: ReturnType<typeof createHumanMCTSTrace>,
  before: GameSnapshot,
  action: PlayerAction,
  mctsColor: Player,
  agentDiagnostics?: TurnDecisionTrace['agentDiagnostics'],
) {
  const after = applyFullAction(before, action).state
  appendHumanMCTSDecision(
    trace,
    {
      turnNumber: trace.decisions.length,
      player: before.turn,
      stateBefore: before,
      stateAfter: after,
      action,
      legalActionCount: getLegalActions(before).length,
      decisionMs: 0,
      agentDiagnostics,
    },
    mctsColor,
  )
  return after
}

describe('smoke humano contra IA final', () => {
  it.each(['R', 'B'] as const)(
    'calcula como %s, genera una traza con la configuración congelada y la reproduce',
    (mctsColor) => {
      const humanColor: Player = mctsColor === 'R' ? 'B' : 'R'
      const seed = mctsColor === 'R' ? 0x524544 : 0x424c5545
      let state = makeInitialState()
      const trace = createHumanMCTSTrace({
        gameId: `smoke-final-${mctsColor}`,
        createdAt: '2026-07-25T00:00:00.000Z',
        humanColor,
        mctsColor,
        seed,
        mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
        finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
        initialState: state,
      })

      if (state.turn === humanColor)
        state = append(trace, state, getLegalActions(state)[0]!, mctsColor)
      const decision = chooseHumanChallengeMCTSDecision({ gameState: state, seed })
      state = append(trace, state, decision.action, mctsColor, {
        baseSeed: seed,
        decisionIndex: 0,
        decisionSeed: seed,
        mcts: {
          result: decision.mcts,
          effectiveConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
          searchTimeMs: decision.decisionMs,
        },
      })

      const directory = mkdtempSync(path.join(tmpdir(), `wall-go-smoke-${mctsColor}-`))
      const tracePath = path.join(directory, `smoke_human_mcts_${mctsColor}.json`)
      writeFileSync(tracePath, serializeHumanMCTSTrace(trace), 'utf8')
      const saved = parseHumanMCTSTrace(readFileSync(tracePath, 'utf8'))
      expect(replayHumanMCTSTrace(saved)).toEqual({
        ok: true,
        decisionsReplayed: trace.decisions.length,
      })
      expect(saved.metadata.finalHumanChallengeConfig).toEqual(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
      expect(getLegalActions(state)).toBeDefined()
    },
    20_000,
  )
})
