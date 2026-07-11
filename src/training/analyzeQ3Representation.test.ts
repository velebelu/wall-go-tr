import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeInitialState } from '@/store/gameState'
import {
  buildTrainingTraceGameRecord,
  getTrainingTraceActionKey,
  getTrainingTraceStateKey,
  type TrainingTraceGameRecord,
} from '@/utils/trainingTrace'
import { analyzeQ3Representation } from './analyzeQ3Representation'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q3-representation-'))
}

function writeTrace(dir: string, fileName: string, trace: TrainingTraceGameRecord): string {
  const filePath = path.join(dir, fileName)
  writeFileSync(filePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return filePath
}

function makeTrace(): TrainingTraceGameRecord {
  const state = makeInitialState()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  const move = { type: 'move' as const, from: { x: 1, y: 1 }, pos: { x: 2, y: 2 } }
  const wall = { type: 'wall' as const, pos: { x: 2, y: 2 }, dir: 'top' as const }
  const placeState = makeInitialState()

  return buildTrainingTraceGameRecord({
    id: 'training_game_001',
    createdAt: '2026-07-11T00:00:00.000Z',
    initialState: placeState,
    finalState: state,
    players: { R: 'heuristic', B: 'heuristic' },
    finalScore: { R: 20, B: 10 },
    actions: [
      { turn: 1, player: 'R', state: placeState, action: { type: 'place', pos: { x: 3, y: 3 } } },
      { turn: 2, player: 'R', state, action: move },
      { turn: 3, player: 'R', state, action: wall },
    ],
  })
}

describe('analyzeQ3Representation', () => {
  it('combines only safe move + wall pairs and counts Q3 keys', () => {
    const inputDir = makeTempDir()
    writeTrace(inputDir, 'training_game_001.json', makeTrace())

    const analysis = analyzeQ3Representation({
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    })

    expect(analysis.validation.validGames).toBe(1)
    expect(analysis.decisions.logicalDecisions).toBe(2)
    expect(analysis.decisions.places).toBe(1)
    expect(analysis.decisions.moveWall).toBe(1)
    expect(analysis.decisions.preservedMoveWalls).toBe(1)
    expect(analysis.keys.uniqueQ3StateKeys).toBeGreaterThan(0)
    expect(analysis.keys.uniqueQ3StateActionPairs).toBe(2)
    expect(analysis.moveWallVariants[0]?.variantCount).toBe(1)
    expect(analysis.bucketDistributions).not.toHaveProperty('lowMine')
    expect(analysis.bucketDistributions).not.toHaveProperty('lowOpponent')
    expect(analysis.playersAfterNormalization[0]?.q3StateKey ?? '').not.toContain('|low:')
  })

  it('keeps independent walls when the pair is not safe', () => {
    const inputDir = makeTempDir()
    const trace = makeTrace()
    trace.actions[2] = {
      turn: 3,
      player: 'R',
      stateKey: getTrainingTraceStateKey(makeInitialState()),
      actionType: 'wall',
      actionKey: getTrainingTraceActionKey({ type: 'wall', pos: { x: 4, y: 4 }, dir: 'left' }),
    }
    writeTrace(inputDir, 'training_game_001.json', trace)

    const analysis = analyzeQ3Representation({
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    })

    expect(analysis.decisions.moveWall).toBe(0)
    expect(analysis.decisions.movesWithoutWall).toBe(1)
    expect(analysis.decisions.independentWalls).toBe(1)
  })

  it('reports invalid traces and remains deterministic', () => {
    const inputDir = makeTempDir()
    const tracePath = writeTrace(inputDir, 'training_game_001.json', makeTrace())
    writeFileSync(path.join(inputDir, 'training_game_002.json'), '{ invalid', 'utf8')
    const before = readFileSync(tracePath, 'utf8')
    const options = {
      inputDir,
      outputDir: makeTempDir(),
      createdAt: '2026-07-11T00:00:00.000Z',
      writeOutputs: false,
    }

    const first = analyzeQ3Representation(options)
    const second = analyzeQ3Representation(options)

    expect(first.validation.gamesRead).toBe(2)
    expect(first.validation.rejectedGames).toBe(1)
    expect(second).toEqual(first)
    expect(readFileSync(tracePath, 'utf8')).toBe(before)
  })
})
