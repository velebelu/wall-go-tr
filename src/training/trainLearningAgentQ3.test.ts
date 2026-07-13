import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getLearningQTableKey } from '@/agents/learningPolicy'
import { getLearningQTableKeyQ3 } from '@/agents/learningPolicyQ3'
import { applyActionToState } from '@/engine/gameSimulator'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  DEFAULT_Q3_TRAINING_CONFIG,
  Q3_REWARD_CONFIG,
  applyFullActionQ3,
  chooseLearningActionQ3,
  createFixedEvaluationQTableQ3,
  getMaxQValueQ3,
  getQ3LearningSideForGame,
  runLearningAgentQ3Training,
  saveQ3Checkpoint0,
  updateQValueQ3,
  validateQ3Checkpoint0,
} from './trainLearningAgentQ3'
import {
  DEFAULT_Q2_TRAINING_CONFIG,
  Q2_REWARD_CONFIG,
  calculateFinalRewardQ2,
  calculateIntermediateRewardQ2,
} from './trainLearningAgentQ2'

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'wall-go-q3-'))
}

function makePlayingState() {
  const state = makeInitialState()
  state.phase = 'playing'
  state.turn = 'R'
  state.stonesPlaced = { R: 4, B: 4 }
  return state
}

function readCheckpoint0(baseDir: string): { qTable: string; metadata: string } {
  return {
    qTable: readFileSync(path.join(baseDir, 'checkpoint_0', 'qtable_q3_0.json'), 'utf8'),
    metadata: readFileSync(path.join(baseDir, 'checkpoint_0', 'metadata.json'), 'utf8'),
  }
}

describe('trainLearningAgentQ3 configuration', () => {
  it('uses Q2 rewards and hyperparameters', () => {
    expect(Q3_REWARD_CONFIG).toEqual(Q2_REWARD_CONFIG)
    expect(DEFAULT_Q3_TRAINING_CONFIG.alpha).toBe(DEFAULT_Q2_TRAINING_CONFIG.alpha)
    expect(DEFAULT_Q3_TRAINING_CONFIG.gamma).toBe(DEFAULT_Q2_TRAINING_CONFIG.gamma)
    expect(DEFAULT_Q3_TRAINING_CONFIG.epsilonStart).toBe(DEFAULT_Q2_TRAINING_CONFIG.epsilonStart)
    expect(DEFAULT_Q3_TRAINING_CONFIG.epsilonMin).toBe(DEFAULT_Q2_TRAINING_CONFIG.epsilonMin)
    expect(DEFAULT_Q3_TRAINING_CONFIG.epsilonDecay).toBe(DEFAULT_Q2_TRAINING_CONFIG.epsilonDecay)
    expect(DEFAULT_Q3_TRAINING_CONFIG.maxTurns).toBe(DEFAULT_Q2_TRAINING_CONFIG.maxTurns)
  })

  it('keeps Q2 reward functions unchanged', () => {
    expect(calculateFinalRewardQ2('R', { R: 30, B: 10 }, 'R')).toBe(120)
    expect(calculateIntermediateRewardQ2(makeInitialState(), makeInitialState(), 'R')).toBe(0)
  })

  it('keeps Q1/Q2 key helpers unchanged', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }

    expect(getLearningQTableKey(state, action)).toBe('placing|R|2|2|0|||place|3|3')
    expect(getLearningQTableKeyQ3(state, action)).not.toBe(getLearningQTableKey(state, action))
  })

  it('keeps colors balanced', () => {
    const colors = Array.from({ length: 20 }, (_, index) => getQ3LearningSideForGame(index + 1))
    expect(colors.filter((color) => color === 'R')).toHaveLength(10)
    expect(colors.filter((color) => color === 'B')).toHaveLength(10)
  })
})

describe('trainLearningAgentQ3 Q updates', () => {
  it('uses getLearningQTableKeyQ3 and the Q-learning formula', () => {
    const state = makeInitialState()
    const nextState = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const nextAction = { type: 'place' as const, pos: { x: 4, y: 3 } }
    const qTable = {
      [getLearningQTableKeyQ3(state, action)]: 10,
      [getLearningQTableKeyQ3(nextState, nextAction)]: 20,
    }

    updateQValueQ3({
      qTable,
      state,
      action,
      reward: 5,
      nextState,
      terminal: false,
      alpha: 0.1,
      gamma: 0.9,
    })

    expect(qTable[getLearningQTableKeyQ3(state, action)]).toBe(11.3)
  })

  it('uses maxQ 0 for terminal updates', () => {
    const state = makeInitialState()
    const action = { type: 'place' as const, pos: { x: 3, y: 3 } }
    const qTable = { [getLearningQTableKeyQ3(state, action)]: 7 }

    expect(getMaxQValueQ3(state, qTable, true)).toBe(0)
  })

  it('updates a complete move-wall key', () => {
    const state = makePlayingState()
    const action = getLegalActions(state).find(
      (candidate) => candidate.type === 'move' && candidate.followUp,
    )
    expect(action).toBeTruthy()

    const qTable = {}
    updateQValueQ3({
      qTable,
      state,
      action: action!,
      reward: 10,
      nextState: undefined,
      terminal: true,
      alpha: 0.1,
      gamma: 0.9,
    })

    const key = Object.keys(qTable)[0]!
    expect(key).toContain('|||move-wall|')
    expect(key.split('|||')[1]?.split('|')).toHaveLength(8)
  })

  it('stores different walls for the same movement in different entries', () => {
    const state = makePlayingState()
    const base = { type: 'move' as const, from: { x: 1, y: 1 }, pos: { x: 2, y: 2 } }
    const qTable = {}

    updateQValueQ3({
      qTable,
      state,
      action: { ...base, followUp: { type: 'wall', pos: { x: 2, y: 2 }, dir: 'top' } },
      reward: 1,
      nextState: undefined,
      terminal: true,
      alpha: 0.1,
      gamma: 0.9,
    })
    updateQValueQ3({
      qTable,
      state,
      action: { ...base, followUp: { type: 'wall', pos: { x: 2, y: 2 }, dir: 'left' } },
      reward: 1,
      nextState: undefined,
      terminal: true,
      alpha: 0.1,
      gamma: 0.9,
    })

    expect(Object.keys(qTable)).toHaveLength(2)
  })

  it('applies movement and follow-up wall completely', () => {
    const state = makePlayingState()
    const action = {
      type: 'move' as const,
      from: { x: 1, y: 1 },
      pos: { x: 2, y: 1 },
      followUp: { type: 'wall' as const, pos: { x: 2, y: 1 }, dir: 'top' as const },
    }

    const full = applyFullActionQ3(state, action)
    const q2Style = applyActionToState(applyActionToState(state, action), action.followUp)

    expect(full.state.board[1][1].stone).toBeNull()
    expect(full.state.board[1][2].stone).toBe('R')
    expect(full.state.board[1][2].wallTop).toBe('R')
    expect(full.state).toEqual(q2Style)
  })
})

describe('trainLearningAgentQ3 workflow', () => {
  it('starts from an empty table and writes checkpoint 0 as empty', () => {
    const outputDir = makeTempDir()
    const metadata = saveQ3Checkpoint0({ outputDir })

    expect(metadata.startedFromEmptyQTable).toBe(true)
    expect(metadata.qTableEntries).toBe(0)
    expect(JSON.parse(readFileSync(path.join(outputDir, 'qtable_q3_0.json'), 'utf8'))).toEqual({})
  })

  it('creates checkpoint 0 when it does not exist', async () => {
    const baseDir = makeTempDir()

    await runLearningAgentQ3Training({
      totalGames: 1,
      outputDir: path.join(baseDir, 'checkpoint_1'),
      finalCheckpoint: 1,
      progressEvery: 0,
      maxTurns: 4,
    })

    expect(existsSync(path.join(baseDir, 'checkpoint_0', 'qtable_q3_0.json'))).toBe(true)
    expect(existsSync(path.join(baseDir, 'checkpoint_0', 'metadata.json'))).toBe(true)
  })

  it('reuses a valid checkpoint 0 without modifying it', async () => {
    const baseDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir: path.join(baseDir, 'checkpoint_0'), seed: 3 })
    const before = readCheckpoint0(baseDir)

    const result = await runLearningAgentQ3Training({
      totalGames: 1,
      outputDir: path.join(baseDir, 'checkpoint_1'),
      finalCheckpoint: 1,
      progressEvery: 0,
      maxTurns: 4,
      seed: 3,
    })

    expect(readCheckpoint0(baseDir)).toEqual(before)
    expect(result.metadata.checkpoint0Reused).toBe(true)
    expect(result.metadata.checkpoint0Validated).toBe(true)
  })

  it('rejects checkpoint 0 when its qtable is not empty and does not train', async () => {
    const baseDir = makeTempDir()
    const checkpoint0 = path.join(baseDir, 'checkpoint_0')
    saveQ3Checkpoint0({ outputDir: checkpoint0 })
    writeFileSync(path.join(checkpoint0, 'qtable_q3_0.json'), '{ "bad": 1 }\n', 'utf8')

    await expect(
      runLearningAgentQ3Training({
        totalGames: 1,
        outputDir: path.join(baseDir, 'checkpoint_1'),
        finalCheckpoint: 1,
        progressEvery: 0,
      }),
    ).rejects.toThrow('must be empty')
    expect(existsSync(path.join(baseDir, 'checkpoint_1'))).toBe(false)
  })

  it('rejects checkpoint 0 when metadata is missing', () => {
    const outputDir = makeTempDir()
    writeFileSync(path.join(outputDir, 'qtable_q3_0.json'), '{}\n', 'utf8')

    expect(() => validateQ3Checkpoint0(outputDir)).toThrow('missing metadata.json')
  })

  it('rejects checkpoint 0 when metadata indicates another model', () => {
    const outputDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir })
    const metadataPath = path.join(outputDir, 'metadata.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    metadata.model = 'Q2'
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

    expect(() => validateQ3Checkpoint0(outputDir)).toThrow('metadata.model must be Q3')
  })

  it('rejects checkpoint 0 when startedFromEmptyQTable is not true', () => {
    const outputDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir })
    const metadataPath = path.join(outputDir, 'metadata.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    metadata.startedFromEmptyQTable = false
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

    expect(() => validateQ3Checkpoint0(outputDir)).toThrow('startedFromEmptyQTable')
  })

  it('rejects checkpoint 0 when reward or hyperparameters do not match Q2', () => {
    const outputDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir })
    const metadataPath = path.join(outputDir, 'metadata.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    metadata.alpha = 0.2
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

    expect(() => validateQ3Checkpoint0(outputDir)).toThrow('alpha must match Q2')
  })

  it('does not overwrite existing output without explicit overwrite', async () => {
    const outputDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir })

    await expect(
      runLearningAgentQ3Training({
        totalGames: 1,
        outputDir,
        finalCheckpoint: 1,
        progressEvery: 0,
      }),
    ).rejects.toThrow('already exists')
  })

  it('keeps checkpoint 500 protection even when checkpoint 0 is reusable', async () => {
    const baseDir = makeTempDir()
    saveQ3Checkpoint0({ outputDir: path.join(baseDir, 'checkpoint_0') })
    const outputDir = path.join(baseDir, 'checkpoint_500')
    saveQ3Checkpoint0({ outputDir })
    const before = readCheckpoint0(baseDir)

    await expect(
      runLearningAgentQ3Training({
        totalGames: 1,
        outputDir,
        finalCheckpoint: 500,
        progressEvery: 0,
      }),
    ).rejects.toThrow('already exists')
    expect(readCheckpoint0(baseDir)).toEqual(before)
  })

  it('writes metadata with complete configuration and Q3 representation stats', async () => {
    const baseDir = makeTempDir()
    const outputDir = path.join(baseDir, 'checkpoint_2')
    const result = await runLearningAgentQ3Training({
      totalGames: 2,
      finalCheckpoint: 2,
      outputDir,
      seed: 7,
      progressEvery: 0,
      maxTurns: 40,
    })

    expect(existsSync(path.join(baseDir, 'checkpoint_0', 'qtable_q3_0.json'))).toBe(true)
    expect(result.metadata.model).toBe('Q3')
    expect(result.metadata.baseRewardModel).toBe('Q2')
    expect(result.metadata.initialization).toBe('empty')
    expect(result.metadata.rewardConfiguration).toEqual(Q2_REWARD_CONFIG)
    expect(result.metadata.configurationComparisonWithQ2.sameHyperparameters).toBe(true)
    expect(result.metadata.configurationComparisonWithQ2.differences).toEqual([
      'state/action key functions: Q3 instead of Q2',
    ])
    expect(result.metadata.uniqueQ3StatesVisited).toBeGreaterThan(0)
    expect(result.metadata.qHits + result.metadata.qMisses).toBeGreaterThan(0)
  }, 15000)

  it('evolves epsilon like Q2', async () => {
    const result = await runLearningAgentQ3Training({
      totalGames: 2,
      outputDir: path.join(makeTempDir(), 'checkpoint_2'),
      finalCheckpoint: 2,
      epsilonStart: 0.6,
      epsilonDecay: 0.5,
      epsilonMin: 0.2,
      progressEvery: 0,
      maxTurns: 40,
    })

    expect(result.metadata.epsilonFinal).toBe(0.2)
  }, 15000)

  it('is deterministic with the same seed', async () => {
    const first = await runLearningAgentQ3Training({
      totalGames: 3,
      outputDir: path.join(makeTempDir(), 'checkpoint_3'),
      finalCheckpoint: 3,
      seed: 11,
      progressEvery: 0,
      maxTurns: 40,
    })
    const second = await runLearningAgentQ3Training({
      totalGames: 3,
      outputDir: path.join(makeTempDir(), 'checkpoint_3'),
      finalCheckpoint: 3,
      seed: 11,
      progressEvery: 0,
      maxTurns: 40,
    })

    expect(second.qTable).toEqual(first.qTable)
    expect(second.metadata.wins).toBe(first.metadata.wins)
  }, 30000)

  it('allows different seeds to produce different runs', async () => {
    const first = await runLearningAgentQ3Training({
      totalGames: 3,
      outputDir: path.join(makeTempDir(), 'checkpoint_3'),
      finalCheckpoint: 3,
      seed: 1,
      progressEvery: 0,
      maxTurns: 40,
    })
    const second = await runLearningAgentQ3Training({
      totalGames: 3,
      outputDir: path.join(makeTempDir(), 'checkpoint_3'),
      finalCheckpoint: 3,
      seed: 2,
      progressEvery: 0,
      maxTurns: 40,
    })

    expect(JSON.stringify(second.qTable)).not.toBe(JSON.stringify(first.qTable))
  }, 30000)

  it('does not load heuristic traces or heuristic qtables', () => {
    const source = readFileSync(path.resolve('src/training/trainLearningAgentQ3.ts'), 'utf8')

    expect(source).not.toContain('qtable_from_heuristics')
    expect(source).not.toContain('training_game_')
    expect(source).not.toContain('heuristicas')
  })

  it('prepares fixed evaluation separation by cloning the Q-table', () => {
    const qTable = { sentinel: 12 }
    const clone = createFixedEvaluationQTableQ3(qTable)
    clone.sentinel = 20

    expect(qTable.sentinel).toBe(12)
  })

  it('uses Q3 action selection with Q3 keys', () => {
    const state = makeInitialState()
    const legalActions = getLegalActions(state).slice(0, 2)
    const preferred = legalActions[1]!
    const qTable = { [getLearningQTableKeyQ3(state, preferred)]: 5 }
    const choice = chooseLearningActionQ3(state, legalActions, 0, qTable, () => 0)

    expect(choice.action).toEqual(preferred)
    expect(choice.selectedKeyExists).toBe(true)
  })
})
