import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MCTSResult } from '@/engine/mcts/types'
import type { PlayerAction } from '@/lib/types'
import {
  aggregateCounterfactualMatches,
  buildCandidates,
  classifyDecision,
  collectSelectionObservations,
  deduplicateCandidateActions,
  loadCounterfactualFixture,
  selectionSeed,
  structuralActionKey,
  summarizeBudgetStability,
  type CounterfactualMatch,
  type SelectionObservation,
} from './evaluateHumanMCTSCounterfactual'

const FIXTURE = path.resolve(
  'data/entrenamiento/mcts/analisis_partida_humana_g_41746ecd/fixtures/1_turn_3_mcts_1.fixture.json',
)

function action(x: number): PlayerAction {
  return { type: 'place', pos: { x, y: 3 } }
}

function observation(budget: number, seed: number, selected = action(1)): SelectionObservation {
  return {
    fixtureId: 'fixture',
    turnIndex: 3,
    budget,
    seed,
    actionKey: structuralActionKey(selected),
    action: selected,
    visits: 10,
    value: 0.2,
    rootVisits: budget,
    elapsedMs: budget,
  }
}

function match(
  candidate: PlayerAction,
  seed: number,
  outcome: 'win' | 'loss',
): CounterfactualMatch {
  return {
    fixtureId: 'fixture',
    turnIndex: 3,
    candidateKey: structuralActionKey(candidate),
    candidateAction: candidate,
    pairSeed: seed,
    winner: outcome === 'win' ? 'R' : 'B',
    outcome,
    territoryCandidate: outcome === 'win' ? 30 : 15,
    territoryOpponent: outcome === 'win' ? 19 : 34,
    territoryDiff: outcome === 'win' ? 11 : -19,
    turns: 20,
    reachedTurnLimit: false,
    durationMs: 100,
  }
}

describe('evaluateHumanMCTSCounterfactual', () => {
  it('carga un fixture MCTS real y rechaza fixtures humanos o inválidos', () => {
    expect(loadCounterfactualFixture(FIXTURE).fixture.actor).toBe('mcts')
    const dir = mkdtempSync(path.join(tmpdir(), 'counterfactual-fixture-'))
    const invalidPath = path.join(dir, 'invalid.json')
    writeFileSync(invalidPath, JSON.stringify({ schema: 'wrong' }))
    expect(() => loadCounterfactualFixture(invalidPath)).toThrow('Invalid fixture schema')
    const human = JSON.parse(JSON.stringify(loadCounterfactualFixture(FIXTURE).fixture))
    human.actor = 'human'
    const humanPath = path.join(dir, 'human.json')
    writeFileSync(humanPath, JSON.stringify(human))
    expect(() => loadCounterfactualFixture(humanPath)).toThrow('only accepts MCTS')
  })

  it('elimina duplicados estructurales, incluido from redundante en muros', () => {
    const wall: PlayerAction = {
      type: 'wall',
      pos: { x: 1, y: 1 },
      from: { x: 1, y: 1 },
      dir: 'top',
    }
    const withoutFrom: PlayerAction = { type: 'wall', pos: { x: 1, y: 1 }, dir: 'top' }
    const candidates = deduplicateCandidateActions([
      { action: wall, source: 'a' },
      { action: withoutFrom, source: 'b' },
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].sources).toEqual(['a', 'b'])
  })

  it('genera semillas reproducibles y observaciones idénticas', async () => {
    expect(selectionSeed(42, 100)).toBe(selectionSeed(42, 100))
    const loaded = loadCounterfactualFixture(FIXTURE)
    const choose = ({ config, seed }: { config: { simulations: number }; seed: number }) => {
      const selected = action((seed + config.simulations) % 2)
      return {
        action: selected,
        visits: 5,
        value: 0,
        rootVisits: config.simulations,
        children: [{ action: selected, visits: 5, value: 0 }],
      } as MCTSResult
    }
    const options = {
      budgets: [50],
      selectionSeeds: [1, 2],
      chooseDecision: choose as never,
      now: () => 0,
    }
    expect(await collectSelectionObservations(loaded, options)).toEqual(
      await collectSelectionObservations(loaded, options),
    )
  })

  it('mantiene estable el ranking y agrega resultados emparejados', () => {
    const rows = [
      observation(50, 2, action(2)),
      observation(50, 1, action(1)),
      observation(50, 3, action(1)),
    ]
    expect(summarizeBudgetStability(rows)[0].modalActionKey).toBe(structuralActionKey(action(1)))
    const aggregated = aggregateCounterfactualMatches([
      match(action(1), 1, 'win'),
      match(action(2), 1, 'loss'),
      match(action(1), 2, 'win'),
      match(action(2), 2, 'loss'),
    ])
    expect(
      aggregated.find((row) => row.candidateKey === structuralActionKey(action(1)))?.wins,
    ).toBe(2)
    expect(new Set([1, 2])).toEqual(new Set([1, 2]))
  })

  it('incluye acciones originales, finales, raíz y ganadoras con presupuesto alto', () => {
    const fixture = loadCounterfactualFixture(FIXTURE).fixture
    const high = action(0)
    const candidates = buildCandidates(fixture, [observation(1000, 1, high)], [1000])
    expect(candidates.map((row) => row.key)).toContain(structuralActionKey(fixture.action))
    expect(candidates.map((row) => row.key)).toContain(structuralActionKey(high))
  })

  it('clasifica estabilidad, sensibilidad y evidencia contrafactual', () => {
    const final = action(1)
    const alternative = action(2)
    const stability = summarizeBudgetStability([
      observation(50, 1, final),
      observation(50, 2, alternative),
      observation(1000, 1, alternative),
      observation(1000, 2, alternative),
    ])
    const aggregates = aggregateCounterfactualMatches([
      match(final, 1, 'loss'),
      match(final, 2, 'loss'),
      match(alternative, 1, 'win'),
      match(alternative, 2, 'win'),
    ])
    expect(
      classifyDecision({
        finalActionKey: structuralActionKey(final),
        stability,
        aggregates,
      }),
    ).toEqual(
      expect.arrayContaining(['budget-sensitive', 'seed-sensitive', 'possible-suboptimal-action']),
    )
  })
})
