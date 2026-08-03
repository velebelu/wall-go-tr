import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FINAL_HUMAN_CHALLENGE_MCTS_CONFIG } from '@/agents/humanChallengeMCTS'
import { FAST_SELF_PLAY_CONFIG } from '@/fixtures/mctsSelfPlayFastConfig'
import { makeInitialState } from '@/store/gameState'
import { canonicalStringify } from './humanExperimentCanonical'
import {
  SELF_PLAY_GAME_COUNT,
  SELF_PLAY_MAX_DECISIONS,
  SELF_PLAY_PAIR_COUNT,
  SELF_PLAY_PAIR_SEED_STRIDE,
  SELF_PLAY_SEED_BASE,
  SELF_PLAY_STREAM_SEED_OFFSET,
  buildSelfPlayPlan,
  countActionAtoms,
  emptyActionCounts,
  runSelfPlayGame,
  scoreForRed,
  validateSelfPlayPlan,
} from './mctsSelfPlayColorBias'

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('plan de emparejamiento del autoenfrentamiento MCTS', () => {
  const plan = buildSelfPlayPlan()

  it('genera 100 parejas y 200 partidas sin duplicados', () => {
    expect(plan).toHaveLength(SELF_PLAY_GAME_COUNT)
    expect(new Set(plan.map((row) => row.pairNumber)).size).toBe(SELF_PLAY_PAIR_COUNT)
    expect(new Set(plan.map((row) => row.gameId)).size).toBe(SELF_PLAY_GAME_COUNT)
    expect(new Set(plan.map((row) => row.gameNumber)).size).toBe(SELF_PLAY_GAME_COUNT)
    expect(plan.map((row) => row.gameNumber)).toEqual(
      Array.from({ length: SELF_PLAY_GAME_COUNT }, (_, index) => index + 1),
    )
  })

  it('intercambia exactamente los flujos de semillas dentro de cada pareja', () => {
    for (let pairNumber = 1; pairNumber <= SELF_PLAY_PAIR_COUNT; pairNumber++) {
      const [direct, swapped] = plan.filter((row) => row.pairNumber === pairNumber)
      expect(direct!.orientation).toBe('direct')
      expect(swapped!.orientation).toBe('swapped')
      expect(direct!.redSeedBase).toBe(swapped!.blueSeedBase)
      expect(direct!.blueSeedBase).toBe(swapped!.redSeedBase)
      expect(direct!.redSeedStream).toBe('alpha')
      expect(swapped!.redSeedStream).toBe('beta')
    }
  })

  it('deriva las semillas de la fórmula determinista documentada', () => {
    expect(plan[0]!.alphaSeedBase).toBe(SELF_PLAY_SEED_BASE)
    expect(plan[0]!.betaSeedBase).toBe(SELF_PLAY_SEED_BASE + SELF_PLAY_STREAM_SEED_OFFSET)
    expect(plan[2]!.alphaSeedBase).toBe(SELF_PLAY_SEED_BASE + SELF_PLAY_PAIR_SEED_STRIDE)
    const blocks = plan.flatMap((row) => [row.redSeedBase, row.blueSeedBase])
    expect(new Set(blocks).size).toBe(SELF_PLAY_PAIR_COUNT * 2)
    expect(SELF_PLAY_STREAM_SEED_OFFSET).toBeGreaterThan(SELF_PLAY_MAX_DECISIONS)
  })

  it('acepta el plan oficial y rechaza cualquier plan manipulado', () => {
    expect(() => validateSelfPlayPlan(plan)).not.toThrow()
    expect(() => validateSelfPlayPlan(plan.slice(0, 199))).toThrow(/200 games/)
    const tampered = plan.map((row) => ({ ...row }))
    tampered[1]!.redSeedBase = tampered[0]!.redSeedBase
    expect(() => validateSelfPlayPlan(tampered)).toThrow()
    const renamed = plan.map((row) => ({ ...row }))
    renamed[5]!.gameId = renamed[4]!.gameId
    expect(() => validateSelfPlayPlan(renamed)).toThrow(/duplicate game identifiers/)
  })
})

describe('contabilidad de acciones y resultados', () => {
  it('cuenta colocaciones, movimientos y muros de una acción completa', () => {
    const counts = emptyActionCounts()
    countActionAtoms({ type: 'place', pos: { x: 0, y: 0 } }, counts)
    countActionAtoms(
      {
        type: 'move',
        from: { x: 1, y: 1 },
        pos: { x: 1, y: 2 },
        followUp: { type: 'wall', pos: { x: 1, y: 2 }, dir: 'top' },
      },
      counts,
    )
    countActionAtoms({ type: 'wall', pos: { x: 3, y: 3 }, dir: 'left' }, counts)
    expect(counts).toEqual({ placements: 1, moves: 1, walls: 2 })
  })

  it('puntúa a rojo con 1, 0,5 y 0', () => {
    expect(scoreForRed('R')).toBe(1)
    expect(scoreForRed('tie')).toBe(0.5)
    expect(scoreForRed('B')).toBe(0)
  })
})

describe('simetría estructural del tablero inicial', () => {
  it('la posición inicial es simétrica al reflejar en horizontal e intercambiar colores', () => {
    const { board } = makeInitialState()
    const size = board.length
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mirrored = board[size - 1 - y]![x]!.stone
        const expected = mirrored === null ? null : mirrored === 'R' ? 'B' : 'R'
        expect(board[y]![x]!.stone).toBe(expected)
      }
    }
  })
})

describe('determinismo del motor de partidas', () => {
  const [planned] = buildSelfPlayPlan(1)

  it('reproduce exactamente la misma partida con las mismas semillas', () => {
    const options = {
      implementationCommit: 'a'.repeat(40),
      config: FAST_SELF_PLAY_CONFIG,
      sha256,
      timestamp: () => '2026-08-03T00:00:00.000Z',
    }
    const first = runSelfPlayGame(planned!, options)
    const second = runSelfPlayGame(planned!, options)
    expect(second.actionSequenceSha256).toBe(first.actionSequenceSha256)
    expect(second.outcomeSha256).toBe(first.outcomeSha256)
    expect(second.winner).toBe(first.winner)
    expect(second.territoryRed).toBe(first.territoryRed)
    expect(second.territoryBlue).toBe(first.territoryBlue)
    expect(first.terminal).toBe(true)
  }, 180_000)

  it('aplica una única configuración idéntica a ambos colores y no recorta por tiempo', () => {
    const result = runSelfPlayGame(planned!, {
      implementationCommit: 'b'.repeat(40),
      config: FAST_SELF_PLAY_CONFIG,
      sha256,
    })
    expect(result.redConfig).toEqual(result.blueConfig)
    expect(result.redConfig).toBe(FAST_SELF_PLAY_CONFIG)
    expect(result.configsIdentical).toBe(true)
    expect(result.diagnostics.stoppedByTimeLimit).toBe(0)
    expect(result.firstActionColor).toBe('R')
    expect(result.totalDecisions).toBe(result.redDecisions + result.blueDecisions)
    expect(result.totalDecisions).toBe(result.actions.length)
    expect(result.redActions.placements).toBe(2)
    expect(result.blueActions.placements).toBe(2)
    expect(result.territoryDiff).toBe(result.territoryRed - result.territoryBlue)
  }, 180_000)

  it('coincide con la huella obtenida al ejecutar el mismo motor bajo ts-node', () => {
    // Los comandos npm ejecutan el experimento con ts-node, que compila a ES5, mientras que
    // los tests usan esbuild. Esta huella fijada garantiza que los dos entornos producen
    // exactamente la misma partida y que el motor de juego no depende del compilador.
    const result = runSelfPlayGame(planned!, {
      implementationCommit: 'a'.repeat(40),
      config: FAST_SELF_PLAY_CONFIG,
      sha256,
    })
    expect(result.actionSequenceSha256).toBe(
      '18a2525d3c6b7df4dde983da04e4c2a2b201754d6a1c2b4e05d492e3c555eeed',
    )
    expect(result.outcomeSha256).toBe(
      'fe1507e15206b1e3cdfcbc3f2bdcd342580257be0527ce647ac12bb252b32c41',
    )
    expect(result.winner).toBe('R')
    expect(result.territoryRed).toBe(20)
    expect(result.territoryBlue).toBe(19)
    expect(result.totalDecisions).toBe(54)
  }, 180_000)

  it('usa la configuración final congelada cuando no se indica ninguna', () => {
    // Una sola decisión basta para comprobar el valor por defecto sin jugar la partida entera.
    const result = runSelfPlayGame(planned!, {
      implementationCommit: 'c'.repeat(40),
      maxDecisions: 1,
      sha256,
    })
    expect(result.redConfig).toBe(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
    expect(result.blueConfig).toBe(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)
    expect(result.configSha256).toBe(sha256(canonicalStringify(FINAL_HUMAN_CHALLENGE_MCTS_CONFIG)))
  }, 120_000)
})
