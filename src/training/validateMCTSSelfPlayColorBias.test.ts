import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FAST_SELF_PLAY_CONFIG } from '@/fixtures/mctsSelfPlayFastConfig'
import {
  buildSelfPlayPlan,
  runSelfPlayGame,
  type SelfPlayGameResult,
} from '@/experiments/mctsSelfPlayColorBias'
import { gamePath, sha256, writeAggregates, writeJsonAtomic } from './runMCTSSelfPlayColorBias'
import {
  SelfPlayValidationCollector,
  replayRecordedGame,
  validateHumanExperimentUntouched,
  validateSelfPlayColorBiasDirectory,
} from './validateMCTSSelfPlayColorBias'

const PAIRS = 2
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
let referenceDir = ''

function validate(directory: string) {
  return validateSelfPlayColorBiasDirectory({
    outputDir: directory,
    pairCount: PAIRS,
    replaySample: 0,
    skipGitGuard: true,
    expectedConfig: FAST_SELF_PLAY_CONFIG,
  })
}

function copyReference(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'wall-go-selfplay-'))
  cpSync(referenceDir, directory, { recursive: true })
  return directory
}

function readGame(directory: string, gameNumber: number): SelfPlayGameResult {
  return JSON.parse(readFileSync(gamePath(directory, gameNumber), 'utf8')) as SelfPlayGameResult
}

function failedChecks(directory: string): string[] {
  return validate(directory).collector.issues.map((issue) => issue.check)
}

beforeAll(() => {
  referenceDir = mkdtempSync(path.join(tmpdir(), 'wall-go-selfplay-ref-'))
  mkdirSync(path.join(referenceDir, 'games'), { recursive: true })
  const results = buildSelfPlayPlan(PAIRS).map((planned) => {
    const result = runSelfPlayGame(planned, {
      implementationCommit: COMMIT,
      config: FAST_SELF_PLAY_CONFIG,
      sha256,
    })
    writeJsonAtomic(gamePath(referenceDir, planned.gameNumber), result)
    return result
  })
  writeAggregates({
    outputDir: referenceDir,
    pairCount: PAIRS,
    results,
    commit: COMMIT,
    workingTreeClean: true,
    workers: 1,
    startedAt: '2026-08-03T00:00:00.000Z',
    finishedAt: '2026-08-03T00:10:00.000Z',
    config: FAST_SELF_PLAY_CONFIG,
  })
  writeFileSync(path.join(referenceDir, 'README.md'), '# fixture\n', 'utf8')
}, 600_000)

describe('validador del autoenfrentamiento MCTS', () => {
  it('acepta un conjunto de datos íntegro', () => {
    const result = validate(referenceDir)
    expect(result.collector.issues).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.summary?.outcomes.games).toBe(PAIRS * 2)
    expect(result.collector.passed).toContain('winner-matches-territory')
    expect(result.collector.passed).toContain('no-duplicates')
  })

  it('reproduce cada partida a partir de la secuencia de acciones guardada', () => {
    const stored = readGame(referenceDir, 1)
    const replay = replayRecordedGame(stored)
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(replay.winner).toBe(stored.winner)
    expect(replay.territory.R).toBe(stored.territoryRed)
    expect(replay.territory.B).toBe(stored.territoryBlue)
    expect(replay.terminal).toBe(true)
  })

  it('vuelve a jugar una muestra y obtiene el mismo resultado', () => {
    const result = validateSelfPlayColorBiasDirectory({
      outputDir: referenceDir,
      pairCount: PAIRS,
      replaySample: 2,
      skipGitGuard: true,
      expectedConfig: FAST_SELF_PLAY_CONFIG,
    })
    expect(result.collector.passed).toContain('games-reproducible')
    expect(result.collector.issues).toEqual([])
  }, 600_000)

  it('rechaza una configuración distinta entre rojo y azul', () => {
    const directory = copyReference()
    const game = readGame(directory, 1)
    writeJsonAtomic(gamePath(directory, 1), {
      ...game,
      blueConfig: { ...game.blueConfig, mcts: { ...game.blueConfig.mcts, simulations: 999 } },
    })
    expect(failedChecks(directory)).toContain('identical-configuration')
    rmSync(directory, { recursive: true, force: true })
  })

  it('rechaza una configuración que no es la oficial', () => {
    // El mismo conjunto validado contra la constante congelada del experimento humano.
    const result = validateSelfPlayColorBiasDirectory({
      outputDir: referenceDir,
      pairCount: PAIRS,
      replaySample: 0,
      skipGitGuard: true,
    })
    expect(result.ok).toBe(false)
    expect(result.collector.issues.map((issue) => issue.check)).toContain('official-configuration')
  })

  it('detecta un ganador incoherente con el territorio', () => {
    const directory = copyReference()
    const game = readGame(directory, 1)
    writeJsonAtomic(gamePath(directory, 1), {
      ...game,
      winner: game.winner === 'R' ? 'B' : 'R',
    })
    expect(failedChecks(directory)).toContain('winner-matches-territory')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta contadores manipulados', () => {
    const directory = copyReference()
    const game = readGame(directory, 1)
    writeJsonAtomic(gamePath(directory, 1), { ...game, redDecisions: game.redDecisions + 3 })
    const failures = failedChecks(directory)
    expect(failures).toContain('counts-and-metrics-valid')
    expect(failures).toContain('seeds-valid')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta semillas que no siguen el plan determinista', () => {
    const directory = copyReference()
    const game = readGame(directory, 1)
    writeJsonAtomic(gamePath(directory, 1), { ...game, redSeedBase: game.redSeedBase + 1 })
    expect(failedChecks(directory)).toContain('seeds-match-plan')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta una secuencia de acciones alterada', () => {
    const directory = copyReference()
    const game = readGame(directory, 1)
    writeJsonAtomic(gamePath(directory, 1), { ...game, actions: game.actions.slice(0, -1) })
    const failures = failedChecks(directory)
    expect(failures).toContain('hashes-consistent')
    expect(failures).toContain('action-sequence-replays')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta un archivo corrupto', () => {
    const directory = copyReference()
    writeFileSync(gamePath(directory, 2), '{ not json', 'utf8')
    expect(failedChecks(directory)).toContain('no-corrupt-files')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta una partida que falta', () => {
    const directory = copyReference()
    rmSync(gamePath(directory, 3))
    const failures = failedChecks(directory)
    expect(failures).toContain('exactly-expected-games')
    expect(failures).toContain('complete-result')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta un manifiesto que no corresponde a los archivos', () => {
    const directory = copyReference()
    const game = readGame(directory, 4)
    writeJsonAtomic(gamePath(directory, 4), { ...game, durationMs: game.durationMs + 1 })
    const failures = failedChecks(directory)
    expect(failures).toContain('manifest-hashes-match')
    expect(failures).toContain('summary-reproducible')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta un resumen agregado manipulado', () => {
    const directory = copyReference()
    const summary = JSON.parse(readFileSync(path.join(directory, 'summary.json'), 'utf8'))
    summary.outcomes.redWins = summary.outcomes.redWins + 1
    writeJsonAtomic(path.join(directory, 'summary.json'), summary)
    expect(failedChecks(directory)).toContain('summary-reproducible')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta un CSV que no corresponde a las partidas', () => {
    const directory = copyReference()
    const csv = readFileSync(path.join(directory, 'results.csv'), 'utf8')
    writeFileSync(path.join(directory, 'results.csv'), csv.replace(/"R"/, '"B"'), 'utf8')
    expect(failedChecks(directory)).toContain('csv-matches-results')
    rmSync(directory, { recursive: true, force: true })
  })

  it('detecta archivos obligatorios que faltan', () => {
    const directory = copyReference()
    rmSync(path.join(directory, 'README.md'))
    const result = validate(directory)
    expect(result.ok).toBe(false)
    expect(result.collector.issues[0]!.check).toBe('required-files-present')
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('lista blanca posterior al congelado del experimento humano', () => {
  let isAllowedOperationalExperimentPath: (path: string) => boolean

  beforeAll(async () => {
    // @ts-expect-error The runtime launcher is JavaScript and intentionally has no declaration file.
    const launcher = await import('../../scripts/start-human-experiment.mjs')
    isAllowedOperationalExperimentPath = launcher.isAllowedOperationalExperimentPath
  })

  it('admite los archivos nuevos de este experimento', () => {
    for (const path of [
      'src/experiments/mctsSelfPlayColorBias.ts',
      'src/experiments/mctsSelfPlayColorBias.test.ts',
      'src/fixtures/mctsSelfPlayFastConfig.ts',
      'src/training/mctsSelfPlayStatistics.ts',
      'src/training/mctsSelfPlayColorBiasAnalysis.ts',
      'src/training/runMCTSSelfPlayColorBias.ts',
      'src/training/validateMCTSSelfPlayColorBias.ts',
      'src/training/reportMCTSSelfPlayColorBias.ts',
      'scripts/generateSelfPlayColorBiasCharts.py',
      'docs/mcts-selfplay-color-bias.md',
      'data/mcts-selfplay/final-2026-color-bias-v1/summary.json',
      'data/mcts-selfplay/final-2026-color-bias-v1/games/game-001.json',
    ])
      expect(isAllowedOperationalExperimentPath(path), path).toBe(true)
  })

  it('sigue rechazando cualquier archivo del runtime jugable congelado', () => {
    for (const path of [
      'src/agents/humanChallengeMCTS.ts',
      'src/agents/mctsConfig.ts',
      'src/engine/mcts/MCTS.ts',
      'src/engine/gameSimulator.ts',
      'src/store/actions.ts',
      'src/utils/ai.ts',
      'src/utils/territory.ts',
      'src/lib/types.ts',
      'data/mcts-selfplay/suelto.json',
    ])
      expect(isAllowedOperationalExperimentPath(path), path).toBe(false)
  })
})

describe('protección del experimento humano congelado', () => {
  it('acepta el estado real del repositorio', () => {
    const collector = new SelfPlayValidationCollector()
    validateHumanExperimentUntouched(collector)
    expect(collector.issues).toEqual([])
  })

  it('rechaza cualquier árbol distinto al congelado', () => {
    const collector = new SelfPlayValidationCollector()
    validateHumanExperimentUntouched(collector, {
      directory: 'data/human-experiment/final-2026-v3-r1',
      referenceCommit: '941368c3c5447471aee1802320e08b0bdae8072c',
      referenceTree: '0'.repeat(40),
    })
    expect(collector.issues.map((issue) => issue.check)).toEqual(['human-experiment-frozen'])
  })

  it('rechaza una ruta inexistente', () => {
    const collector = new SelfPlayValidationCollector()
    validateHumanExperimentUntouched(collector, {
      directory: 'data/human-experiment/does-not-exist',
      referenceCommit: '941368c3c5447471aee1802320e08b0bdae8072c',
      referenceTree: '0'.repeat(40),
    })
    expect(collector.issues.map((issue) => issue.check)).toEqual(['human-experiment-frozen'])
  })
})
