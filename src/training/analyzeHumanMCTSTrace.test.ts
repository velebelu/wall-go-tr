import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FINAL_MCTS_CONFIG } from '@/agents/MCTSAgent'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { applyFullAction } from '@/engine/gameSimulator'
import type { MCTSResult } from '@/engine/mcts/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  replayHumanMCTSTrace,
  serializeHumanMCTSTrace,
  type HumanMCTSTraceV1,
} from '@/utils/humanMCTSTrace'
import {
  analyzeHumanMCTSTrace,
  analyzeHumanMCTSTraceFile,
  DEFAULT_HUMAN_MCTS_ANALYSIS_THRESHOLDS,
} from './analyzeHumanMCTSTrace'

function syntheticTrace(): HumanMCTSTraceV1 {
  let state = makeInitialState()
  const trace = createHumanMCTSTrace({
    gameId: 'analysis-synthetic',
    createdAt: '2026-07-24T00:00:00.000Z',
    humanColor: 'B',
    mctsColor: 'R',
    seed: 44,
    mctsConfig: FINAL_MCTS_CONFIG,
    initialState: state,
  })
  let mctsIndex = 0
  for (let turnIndex = 0; turnIndex < 8; turnIndex++) {
    const before = state
    const legalActions = getLegalActions(before)
    const action = legalActions[0]!
    state = applyFullAction(before, action).state
    const isMCTS = before.turn === 'R'
    const result: MCTSResult = {
      action,
      originalAction: action,
      visits: 8,
      value: 0.2,
      rootVisits: 50,
      children: [
        { action, visits: 8, value: 0.2 },
        { action: legalActions[1]!, visits: 7, value: 0.15 },
        { action: legalActions[2]!, visits: 4, value: -0.1 },
      ],
      rootLegalActions: legalActions.length,
      rootExpandedChildren: 3,
      maxDepthReached: 2,
      averageSelectedDepth: 1,
      tacticalCandidatesChecked: 2,
      tacticalSelectionChanged: false,
      originalMCTSActionScore: 0,
      verifiedActionScore: 0,
      worstOpponentReplyScore: -1,
      verificationTimeMs: 20,
      immediateTerminalLossAvoided: false,
    }
    const decision: TurnDecisionTrace = {
      turnNumber: turnIndex,
      player: before.turn,
      stateBefore: before,
      stateAfter: state,
      action,
      legalActionCount: legalActions.length,
      decisionMs: isMCTS ? 120 : 10,
      ...(isMCTS
        ? {
            agentDiagnostics: {
              baseSeed: 44,
              decisionIndex: mctsIndex++,
              decisionSeed: 44 + mctsIndex,
              mcts: {
                result,
                effectiveConfig: FINAL_MCTS_CONFIG,
                searchTimeMs: 100,
              },
            },
          }
        : {}),
    }
    appendHumanMCTSDecision(trace, decision, 'R')
  }
  const mctsRows = trace.decisions.filter((decision) => decision.actor === 'mcts')
  mctsRows[0]!.mcts!.tacticalSelectionChanged = true
  mctsRows[0]!.mcts!.verifiedScore = 20
  mctsRows[0]!.mcts!.originalScore = 0
  mctsRows[0]!.mcts!.searchTimeMs = 900
  mctsRows[1]!.mcts!.rootCandidates[0]!.visits = 6
  mctsRows[1]!.mcts!.rootCandidates[1]!.visits = 6
  mctsRows[1]!.mcts!.rootCandidates[0]!.value = 0.1
  mctsRows[1]!.mcts!.rootCandidates[1]!.value = 0.1
  mctsRows[2]!.metricsAfter.accessibleTerritory.R =
    mctsRows[2]!.metricsBefore.accessibleTerritory.R - 8
  mctsRows[2]!.metricsAfter.mobility.R.totalDestinations =
    mctsRows[2]!.metricsBefore.mobility.R.totalDestinations - 5
  return trace
}

describe('analyzeHumanMCTSTrace', () => {
  it('analiza solo decisiones MCTS de una traza sintética', () => {
    const trace = syntheticTrace()
    expect(replayHumanMCTSTrace(trace).ok).toBe(true)
    const analysis = analyzeHumanMCTSTrace(trace)
    expect(analysis.game.totalDecisions).toBe(8)
    expect(analysis.game.humanDecisions).toBe(4)
    expect(analysis.game.mctsDecisions).toBe(4)
    expect(analysis.decisions.map((decision) => decision.turnIndex)).toEqual(
      trace.decisions
        .filter((decision) => decision.actor === 'mcts')
        .map((decision) => decision.turnIndex),
    )
  })

  it('mantiene un ranking estable', () => {
    const trace = syntheticTrace()
    const first = analyzeHumanMCTSTrace(trace).ranking.map((row) => row.turnIndex)
    const second = analyzeHumanMCTSTrace(trace).ranking.map((row) => row.turnIndex)
    expect(second).toEqual(first)
    expect(first[0]).toBe(0)
  })

  it('detecta cambio táctico, baja confianza y cambio territorial', () => {
    const analysis = analyzeHumanMCTSTrace(syntheticTrace())
    expect(analysis.decisions[0].categories).toContain('tactical-change')
    expect(analysis.decisions[1].categories).toContain('low-confidence')
    expect(analysis.decisions[2].categories).toEqual(
      expect.arrayContaining(['territory-swing', 'mobility-risk']),
    )
  })

  it('trata puntuaciones null serializadas desde NaN como no disponibles', () => {
    const trace = syntheticTrace()
    const mctsDecisions = trace.decisions.filter((decision) => decision.actor === 'mcts')
    const lastMCTS = mctsDecisions[mctsDecisions.length - 1]
    lastMCTS.mcts!.originalScore = null as unknown as number
    lastMCTS.mcts!.verifiedScore = -1_000_000
    const analyzedDecisions = analyzeHumanMCTSTrace(trace).decisions
    const analyzed = analyzedDecisions[analyzedDecisions.length - 1]
    expect(analyzed.originalScore).toBeUndefined()
    expect(analyzed.scoreChange).toBeNull()
    expect(analyzed.categories).not.toContain('large-score-change')
  })

  it('respeta umbrales configurables', () => {
    const trace = syntheticTrace()
    const permissive = analyzeHumanMCTSTrace(trace, {
      lowConfidenceMaxVisitGap: 100,
    })
    const strict = analyzeHumanMCTSTrace(trace, {
      lowConfidenceMaxVisitGap: 0,
      lowConfidenceMaxValueGap: 0,
      lowConfidenceMaxSelectedVisitShare: 0,
    })
    expect(permissive.summary.lowConfidenceDecisions).toBeGreaterThan(
      strict.summary.lowConfidenceDecisions,
    )
    expect(DEFAULT_HUMAN_MCTS_ANALYSIS_THRESHOLDS.lowConfidenceMaxVisitGap).toBe(1)
  })

  it('extrae fixtures únicamente para las tres decisiones MCTS mejor clasificadas', () => {
    const temp = mkdtempSync(path.join(tmpdir(), 'human-mcts-analysis-'))
    const tracePath = path.join(temp, 'trace.json')
    writeFileSync(tracePath, serializeHumanMCTSTrace(syntheticTrace()), 'utf8')
    const result = analyzeHumanMCTSTraceFile(tracePath, {
      outputDir: path.join(temp, 'output'),
      createdAt: '2026-07-24T00:00:00.000Z',
    })
    expect(result.fixtureFiles).toHaveLength(3)
    for (const fixtureFile of result.fixtureFiles) {
      const fixture = JSON.parse(readFileSync(path.join(result.outputDir, fixtureFile), 'utf8'))
      expect(fixture.actor).toBe('mcts')
      expect(fixture.mcts).toBeDefined()
    }
  })

  it('rechaza una traza cuyo replay diverge', () => {
    const trace = syntheticTrace()
    trace.decisions[0].action = { type: 'place', pos: { x: 1, y: 1 } }
    expect(() => analyzeHumanMCTSTrace(trace)).toThrow('replay diverged')
  })
})
