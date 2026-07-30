import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningActionKey, getLearningStateKey } from '@/agents/learningPolicy'
import type { Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import {
  buildTrainingTraceGameRecord,
  getTrainingTraceStateKey,
  type TrainingTraceGameRecord,
} from '@/utils/trainingTrace'
import { analyzeHeuristicTracesForQ3, parseTraceActionKey } from './analyzeHeuristicTracesForQ3'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q3-analysis-'))
}

function writeTrace(dir: string, fileName: string, trace: TrainingTraceGameRecord): string {
  const filePath = path.join(dir, fileName)
  writeFileSync(filePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return filePath
}

function makeTrace(params: {
  id: string
  winner: Player | 'tie'
  firstAction?: PlayerAction
  firstPlayer?: Player
  mutateSecondState?: boolean
}): TrainingTraceGameRecord {
  const initialState = makeInitialState()
  const secondState = makeInitialState()
  if (params.mutateSecondState) {
    secondState.board[0][0].wallTop = 'R'
  }

  const firstAction = params.firstAction ?? { type: 'place', pos: { x: 3, y: 3 } }
  const actions = [
    {
      turn: 1,
      player: params.firstPlayer ?? 'R',
      state: initialState,
      action: firstAction,
    },
    {
      turn: 2,
      player: 'R' as const,
      state: secondState,
      action: { type: 'place' as const, pos: { x: 3, y: 3 } },
    },
  ]

  return buildTrainingTraceGameRecord({
    id: params.id,
    createdAt: '2026-07-11T00:00:00.000Z',
    initialState,
    finalState: initialState,
    players: { R: 'heuristic', B: 'heuristic' },
    finalScore: params.winner === 'R' ? { R: 20, B: 10 } : { R: 10, B: 20 },
    actions,
  })
}

describe('analyzeHeuristicTracesForQ3', () => {
  it('parses trace action keys and calculates compact keys with learningPolicy helpers', () => {
    const state = makeInitialState()
    const action = parseTraceActionKey('place', 'place|3|3')

    expect(getLearningStateKey(state)).toBe('placing|R|2|2|0')
    expect(getLearningActionKey(action)).toBe('place|3|3')
  })

  it('analyzes representative traces and detects compact collisions', () => {
    const inputDir = makeTempDir()
    writeTrace(inputDir, 'training_game_001.json', makeTrace({ id: 'trace-1', winner: 'R' }))
    writeTrace(
      inputDir,
      'training_game_002.json',
      makeTrace({ id: 'trace-2', winner: 'B', mutateSecondState: true }),
    )

    const analysis = analyzeHeuristicTracesForQ3({
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    })

    expect(analysis.validation).toMatchObject({
      gamesRead: 2,
      validGames: 2,
      rejectedGames: 0,
    })
    expect(analysis.globalMetrics.totalActions).toBe(4)
    expect(analysis.collisionMetrics.uniqueLegacyStateActionPairs).toBeGreaterThan(
      analysis.collisionMetrics.uniqueCompactStateActionPairs,
    )
    expect(analysis.collisionMetrics.stateActionCollapsePercentage).toBeGreaterThan(0)
    expect(analysis.collisionMetrics.maxLegacyStatesPerCompactState).toBeGreaterThan(1)
    expect(
      Object.keys(analysis.collisionMetrics.compactStateCollisionGroupSizeDistribution),
    ).not.toHaveLength(0)
    expect(analysis.collisionMetrics.topStateActionCollisions[0]).toMatchObject({
      compactStateKey: 'placing|R|2|2|0',
      compactActionKey: 'place|3|3',
    })
  })

  it('detects secure move followed by wall associations and wall variants', () => {
    const inputDir = makeTempDir()
    const trace = makeTrace({
      id: 'trace-move-wall',
      winner: 'R',
      firstAction: { type: 'move', from: { x: 1, y: 1 }, pos: { x: 1, y: 2 } },
    })
    trace.actions = [
      {
        turn: 1,
        player: 'R',
        stateKey: getTrainingTraceStateKey(makeInitialState()),
        actionType: 'move',
        actionKey: 'move|1|1|1|2',
      },
      {
        turn: 2,
        player: 'R',
        stateKey: getTrainingTraceStateKey(makeInitialState()),
        actionType: 'wall',
        actionKey: 'wall|1|2|top',
      },
      {
        turn: 3,
        player: 'R',
        stateKey: getTrainingTraceStateKey(makeInitialState()),
        actionType: 'move',
        actionKey: 'move|1|1|1|2',
      },
      {
        turn: 4,
        player: 'R',
        stateKey: getTrainingTraceStateKey(makeInitialState()),
        actionType: 'wall',
        actionKey: 'wall|1|2|left',
      },
    ]
    writeTrace(inputDir, 'training_game_001.json', trace)

    const analysis = analyzeHeuristicTracesForQ3({
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    })

    expect(analysis.compositeActionMetrics.secureMovesFollowedByWall).toBe(2)
    expect(analysis.compositeActionMetrics.maxWallVariantsForSameMoveActionKey).toBe(2)
    expect(analysis.compositeActionMetrics.moveActionKeysWithMultipleWallVariants[0]).toMatchObject(
      {
        compactMoveActionKey: 'move|1|1|1|2',
        wallVariantCount: 2,
      },
    )
  })

  it('reports invalid files without rejecting valid traces', () => {
    const inputDir = makeTempDir()
    writeTrace(inputDir, 'training_game_001.json', makeTrace({ id: 'trace-1', winner: 'R' }))
    writeFileSync(path.join(inputDir, 'training_game_002.json'), '{ invalid json', 'utf8')

    const analysis = analyzeHeuristicTracesForQ3({
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    })

    expect(analysis.validation.gamesRead).toBe(2)
    expect(analysis.validation.validGames).toBe(1)
    expect(analysis.validation.rejectedGames).toBe(1)
    expect(analysis.validation.rejections[0]?.reason).toContain('JSON')
  })

  it('does not modify source traces and is deterministic for the same inputs', () => {
    const inputDir = makeTempDir()
    const tracePath = writeTrace(
      inputDir,
      'training_game_001.json',
      makeTrace({ id: 'trace-1', winner: 'R' }),
    )
    const before = readFileSync(tracePath, 'utf8')
    const options = {
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    }

    const first = analyzeHeuristicTracesForQ3(options)
    const second = analyzeHeuristicTracesForQ3(options)

    expect(readFileSync(tracePath, 'utf8')).toBe(before)
    expect(second).toEqual(first)
  })
})
