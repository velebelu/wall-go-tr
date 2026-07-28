import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import type { TurnDecisionTrace } from '@/agents/TurnManager'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, PlayerAction } from '@/lib/types'
import { createEmptyBoard, makeInitialState } from '@/store/gameState'
import { getLegalActions } from '@/utils/ai'
import {
  appendHumanMCTSDecision,
  createHumanMCTSTrace,
  finalizeHumanMCTSTrace,
  type HumanMCTSTraceV1,
} from '@/utils/humanMCTSTrace'
import { ingestLatestHumanExperimentTrace } from './humanExperimentIngestion'
import type { HumanExperimentRegistry } from './humanExperimentTypes'

const COMMIT = 'a'.repeat(40)
const temporaryDirectories: string[] = []
const closingAction: PlayerAction = {
  type: 'wall',
  from: { x: 3, y: 3 },
  pos: { x: 3, y: 3 },
  dir: 'right',
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

function closingState(): GameSnapshot {
  const state = makeInitialState()
  state.board = createEmptyBoard()
  state.phase = 'playing'
  state.turn = 'B'
  state.stonesPlaced = { R: 4, B: 4 }
  state.board[2][5].stone = 'R'
  state.board[4][5].stone = 'R'
  state.board[3][3].stone = 'B'
  state.board[1][1].stone = 'B'
  for (let y = 0; y < state.board.length; y++) if (y !== 3) state.board[y][4].wallLeft = 'B'
  return state
}

function syntheticTrace(): HumanMCTSTraceV1 {
  const before = closingState()
  const after = applyFullAction(before, closingAction).state
  const decision: TurnDecisionTrace = {
    turnNumber: 0,
    player: 'B',
    stateBefore: before,
    stateAfter: after,
    action: structuredClone(closingAction),
    legalActionCount: getLegalActions(before).length,
    decisionMs: 10,
  }
  const trace = createHumanMCTSTrace({
    gameId: 'controlled-test',
    createdAt: '2026-01-01T00:00:00.000Z',
    experimentId: 'WGTR-HUMAN-FINAL-2026',
    projectCommit: COMMIT,
    humanColor: 'R',
    mctsColor: 'B',
    seed: 123,
    mctsConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG.mcts,
    finalHumanChallengeConfig: FINAL_HUMAN_CHALLENGE_MCTS_CONFIG,
    initialState: before,
  })
  appendHumanMCTSDecision(trace, decision, 'B')
  finalizeHumanMCTSTrace(trace, 'controlled-test', after)
  trace.metadata.startedAt = '2026-01-01T00:00:00.000Z'
  trace.metadata.finishedAt = '2026-01-01T00:01:00.000Z'
  trace.metadata.durationMs = 60_000
  return trace
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'wgtr-ingestion-'))
  temporaryDirectories.push(root)
  const participantDirectory = resolve(root, 'participants', 'P01')
  const downloads = resolve(root, 'downloads')
  await mkdir(resolve(participantDirectory, 'traces'), { recursive: true })
  await mkdir(downloads)
  const registry: HumanExperimentRegistry = {
    schema: 'HumanExperimentRegistryV1',
    experimentId: 'WGTR-HUMAN-FINAL-2026',
    participants: [
      {
        schema: 'HumanExperimentParticipantV1',
        experimentId: 'WGTR-HUMAN-FINAL-2026',
        participantId: 'P01',
        experienceGroup: 'none',
        previousWallGoGames: 0,
        practiceGames: 1,
        colorOrder: ['R', 'B'],
        notes: '',
      },
    ],
    games: [],
  }
  await writeFile(resolve(root, 'registry.json'), JSON.stringify(registry))
  await writeFile(
    resolve(participantDirectory, 'game-1.json'),
    JSON.stringify({
      schema: 'HumanExperimentGameInputV1',
      experimentId: registry.experimentId,
      participantId: 'P01',
      gameNumber: 1,
      incidents: [],
    }),
  )
  await writeFile(
    resolve(participantDirectory, 'game-2.json'),
    JSON.stringify({
      schema: 'HumanExperimentGameInputV1',
      experimentId: registry.experimentId,
      participantId: 'P01',
      gameNumber: 2,
      incidents: [],
    }),
  )
  return { root, participantDirectory, downloads }
}

async function p02Fixture() {
  const paths = await fixture()
  const registry = JSON.parse(
    await readFile(resolve(paths.root, 'registry.json'), 'utf8'),
  ) as HumanExperimentRegistry
  registry.participants[0].participantId = 'P02'
  registry.participants[0].colorOrder = ['B', 'R']
  await writeFile(resolve(paths.root, 'registry.json'), JSON.stringify(registry))
  const oldDirectory = paths.participantDirectory
  const participantDirectory = resolve(paths.root, 'participants', 'P02')
  await mkdir(resolve(participantDirectory, 'traces'), { recursive: true })
  for (const gameNumber of [1, 2]) {
    await writeFile(
      resolve(participantDirectory, `game-${gameNumber}.json`),
      JSON.stringify({
        schema: 'HumanExperimentGameInputV1',
        experimentId: registry.experimentId,
        participantId: 'P02',
        gameNumber,
        incidents: [],
      }),
    )
  }
  await rm(oldDirectory, { recursive: true })
  return { ...paths, participantDirectory }
}

async function writeTrace(directory: string, trace = syntheticTrace(), name = 'trace.json') {
  const path = resolve(directory, name)
  await mkdir(directory, { recursive: true })
  await writeFile(path, JSON.stringify(trace))
  return path
}

describe('latest trace ingestion', () => {
  it('ingests P01 game 1, preserves source, and validates the final registry', async () => {
    const paths = await fixture()
    const source = await writeTrace(paths.downloads)
    const result = await ingestLatestHumanExperimentTrace({
      experimentDirectory: paths.root,
      participantId: 'P01',
      gameNumber: 1,
      downloadDirectories: [paths.downloads],
      expectedCommit: COMMIT,
    })
    expect(result).toMatchObject({
      participantId: 'P01',
      gameNumber: 1,
      humanColor: 'R',
      aiColor: 'B',
      turnCount: 1,
      durationMs: 60_000,
      gameCount: 1,
    })
    await expect(access(source)).resolves.toBeUndefined()
    const registry = JSON.parse(
      await readFile(resolve(paths.root, 'registry.json'), 'utf8'),
    ) as HumanExperimentRegistry
    expect(registry.games).toHaveLength(1)
  })

  it('imports P02 game 2 correctly after its first game in an isolated fixture', async () => {
    const paths = await p02Fixture()
    const firstTrace = syntheticTrace()
    firstTrace.metadata.humanColor = 'B'
    firstTrace.metadata.mctsColor = 'R'
    await writeTrace(paths.downloads, firstTrace, 'traza_humano_mcts_p02_g1.json')
    await ingestLatestHumanExperimentTrace({
      experimentDirectory: paths.root,
      participantId: 'P02',
      gameNumber: 1,
      explicitTracePath: resolve(paths.downloads, 'traza_humano_mcts_p02_g1.json'),
      expectedCommit: COMMIT,
    })
    await writeTrace(paths.downloads, syntheticTrace(), 'traza_humano_mcts_p02_g2.json')
    const result = await ingestLatestHumanExperimentTrace({
      experimentDirectory: paths.root,
      participantId: 'P02',
      gameNumber: 2,
      explicitTracePath: resolve(paths.downloads, 'traza_humano_mcts_p02_g2.json'),
      expectedCommit: COMMIT,
    })
    expect(result).toMatchObject({
      participantId: 'P02',
      gameNumber: 2,
      humanColor: 'R',
      aiColor: 'B',
      gameCount: 2,
    })
  })

  it.each([
    [
      'wrong color',
      (trace: HumanMCTSTraceV1) => {
        trace.metadata.humanColor = 'B'
        trace.metadata.mctsColor = 'R'
      },
    ],
    [
      'wrong commit',
      (trace: HumanMCTSTraceV1) => {
        trace.metadata.projectCommit = 'b'.repeat(40)
      },
    ],
    [
      'wrong config',
      (trace: HumanMCTSTraceV1) => {
        trace.metadata.finalHumanChallengeConfig!.budget.base++
      },
    ],
    [
      'nonterminal',
      (trace: HumanMCTSTraceV1) => {
        delete trace.final
      },
    ],
    [
      'replay divergence',
      (trace: HumanMCTSTraceV1) => {
        trace.decisions[0].action.pos.x = 0
      },
    ],
  ])('rejects %s traces', async (_label, mutate) => {
    const paths = await fixture()
    const trace = syntheticTrace()
    mutate(trace)
    await writeTrace(paths.downloads, trace)
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 1,
        downloadDirectories: [paths.downloads],
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('No compatible trace')
  })

  it('rejects a trace from the archived experiment when ingesting into v2', async () => {
    const paths = await fixture()
    const registryPath = resolve(paths.root, 'registry.json')
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as HumanExperimentRegistry
    registry.experimentId = 'WGTR-HUMAN-FINAL-2026-V2'
    registry.participants[0].experimentId = registry.experimentId
    await writeFile(registryPath, JSON.stringify(registry))
    await writeFile(
      resolve(paths.participantDirectory, 'game-1.json'),
      JSON.stringify({
        schema: 'HumanExperimentGameInputV1',
        experimentId: registry.experimentId,
        participantId: 'P01',
        gameNumber: 1,
        incidents: [],
      }),
    )
    const trace = syntheticTrace()
    trace.metadata.experimentId = 'WGTR-HUMAN-FINAL-2026'
    const source = await writeTrace(paths.downloads, trace, 'traza_humano_mcts_archived.json')
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 1,
        explicitTracePath: source,
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('No compatible trace')
  })

  it('rejects an unregistered participant and game 2 before game 1', async () => {
    const paths = await fixture()
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P02',
        gameNumber: 1,
        downloadDirectories: [paths.downloads],
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('not registered')
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 2,
        downloadDirectories: [paths.downloads],
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('Game 1')
  })

  it('rejects an existing destination', async () => {
    const paths = await fixture()
    await writeTrace(resolve(paths.participantDirectory, 'traces'), syntheticTrace(), 'game-1.json')
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 1,
        downloadDirectories: [paths.downloads],
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('Destination already exists')
  })

  it('rejects a game already registered', async () => {
    const paths = await fixture()
    await writeTrace(paths.downloads)
    const params = {
      experimentDirectory: paths.root,
      participantId: 'P01',
      gameNumber: 1,
      downloadDirectories: [paths.downloads],
      expectedCommit: COMMIT,
    }
    await ingestLatestHumanExperimentTrace(params)
    await expect(ingestLatestHumanExperimentTrace(params)).rejects.toThrow('already registered')
  })

  it('rejects traces located inside a pilot directory', async () => {
    const paths = await fixture()
    const source = await writeTrace(
      resolve(paths.root, 'data', 'human-experiment', 'pilot', 'downloads'),
    )
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 1,
        explicitTracePath: source,
        expectedCommit: COMMIT,
      }),
    ).rejects.toThrow('No compatible trace')
  })

  it('rolls back the copied destination when ingestion fails', async () => {
    const paths = await fixture()
    await writeTrace(paths.downloads)
    const destination = resolve(paths.participantDirectory, 'traces', 'game-1.json')
    const before = await readFile(resolve(paths.root, 'registry.json'), 'utf8')
    await expect(
      ingestLatestHumanExperimentTrace({
        experimentDirectory: paths.root,
        participantId: 'P01',
        gameNumber: 1,
        downloadDirectories: [paths.downloads],
        expectedCommit: COMMIT,
        hooks: {
          afterCopy: () => {
            throw new Error('simulated failure')
          },
        },
      }),
    ).rejects.toThrow('simulated failure')
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(resolve(paths.root, 'registry.json'), 'utf8')).toBe(before)
  })
})
