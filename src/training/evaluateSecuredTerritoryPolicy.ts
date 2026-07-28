import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  chooseHumanChallengeMCTSDecision,
  chooseHumanChallengeMCTSDecisionExperimentalSecuredTerritory,
} from '@/agents/humanChallengeMCTS'
import { createPlayableMCTSRng, choosePlayableMCTSAction } from '@/agents/mctsWorkerDecision'
import { FINAL_MCTS_CONFIG } from '@/agents/mctsConfig'
import { evaluatePosition } from '@/engine/evaluatePosition'
import { applyFullAction } from '@/engine/gameSimulator'
import type { GameSnapshot, Player, PlayerAction } from '@/lib/types'
import { makeInitialState } from '@/store/gameState'
import { getLegalActions, scoreHeuristicAction } from '@/utils/ai'
import { getTerritoryMap } from '@/utils/territory'

type Policy = 'candidate' | 'baseline' | 'mcts' | 'heuristic' | 'random'
type Outcome = 'win' | 'loss' | 'draw'

interface MatchResult {
  matchup: string
  seed: number
  candidateColor?: Player
  candidateOutcome?: Outcome
  candidateTerritory?: number
  opponentTerritory?: number
  turns: number
  capped: boolean
  illegalActions: number
  decisionMs: Record<Policy, number[]>
  interventions: { beneficial: number; harmful: number; neutral: number; inconclusive: number }
  interventionCount: number
  fallbacks: number
}

const gamesPerColor = Number(process.env.SECURED_POLICY_GAMES_PER_COLOR ?? 4)
const simulations = Number(process.env.SECURED_POLICY_SIMULATIONS ?? 250)
const maxTurns = 100
const outputDirectory = resolve('data/evaluations/secured-territory-policy')

const config = {
  ...FINAL_MCTS_CONFIG,
  simulations,
  qPriorWeight: 0,
  rolloutPolicy: 'mixed' as const,
  heuristicProbability: 0.8,
  expansionPolicy: 'heuristic' as const,
  progressiveWidening: true,
  wideningConstant: 2,
  wideningExponent: 0.5,
  tacticalVerification: true,
  tacticalCandidateCount: 2,
}

const plans: Array<{ matchup: string; red: Policy; blue: Policy; candidateColor?: Player }> = []
for (const opponent of ['random', 'heuristic', 'mcts'] as const) {
  for (const tested of ['baseline', 'candidate'] as const) {
    plans.push(
      { matchup: `${tested}-vs-${opponent}`, red: tested, blue: opponent, candidateColor: 'R' },
      { matchup: `${tested}-vs-${opponent}`, red: opponent, blue: tested, candidateColor: 'B' },
    )
  }
}
plans.push(
  { matchup: 'candidate-vs-baseline', red: 'candidate', blue: 'baseline', candidateColor: 'R' },
  { matchup: 'candidate-vs-baseline', red: 'baseline', blue: 'candidate', candidateColor: 'B' },
)

const results: MatchResult[] = []
console.log(
  `Evaluation plan: ${plans.length} plans x ${gamesPerColor} pairs, ${simulations} simulations`,
)
for (let pair = 0; pair < gamesPerColor; pair++) {
  console.log(`Starting pair ${pair + 1}/${gamesPerColor}`)
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    const plan = plans[planIndex]!
    const seed = (0x51ec0000 + pair * 101 + Math.floor(planIndex / 2)) >>> 0
    const result = playMatch(plan, seed)
    results.push(result)
    console.log(
      `${results.length}/${gamesPerColor * plans.length} ${plan.matchup} seed=${seed} ` +
        `${result.candidateOutcome ?? '-'} territory=${result.candidateTerritory ?? '-'}-${result.opponentTerritory ?? '-'}`,
    )
  }
}

const report = buildReport(results)
await mkdir(outputDirectory, { recursive: true })
await writeFile(resolve(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
await writeFile(resolve(outputDirectory, 'report.md'), markdown(report))
console.log(JSON.stringify(report.decision, null, 2))

function playMatch(
  plan: { matchup: string; red: Policy; blue: Policy; candidateColor?: Player },
  seed: number,
): MatchResult {
  let state = initialPlacedState(seed)
  const decisionMs: Record<Policy, number[]> = {
    candidate: [],
    baseline: [],
    mcts: [],
    heuristic: [],
    random: [],
  }
  const interventions = { beneficial: 0, harmful: 0, neutral: 0, inconclusive: 0 }
  let interventionCount = 0
  let fallbacks = 0
  let illegalActions = 0
  let turns = 0
  while (state.phase !== 'finished' && !state.result && turns < maxTurns) {
    const policy = state.turn === 'R' ? plan.red : plan.blue
    const started = performance.now()
    const decisionSeed = (seed + turns * 0x9e3779b9 + (state.turn === 'R' ? 1 : 2)) >>> 0
    const { action, intervention } = choose(policy, state, decisionSeed)
    decisionMs[policy].push(performance.now() - started)
    const legal = getLegalActions(state)
    if (!legal.some((candidate) => sameAction(candidate, action))) {
      illegalActions++
      break
    }
    if (intervention) {
      interventionCount++
      if (intervention.fallback) fallbacks++
      const originalState = applyFullAction(state, intervention.original).state
      const candidateState = applyFullAction(state, action).state
      const originalScore = evaluatePosition(originalState, state.turn)
      const candidateScore = evaluatePosition(candidateState, state.turn)
      if (!Number.isFinite(originalScore) || !Number.isFinite(candidateScore))
        interventions.inconclusive++
      else if (candidateScore > originalScore + 1e-9) interventions.beneficial++
      else if (candidateScore < originalScore - 1e-9) interventions.harmful++
      else interventions.neutral++
    }
    state = applyFullAction(state, action).state
    turns++
  }
  const score = territory(state)
  const candidateColor = plan.candidateColor
  const opponentColor = candidateColor === 'R' ? 'B' : 'R'
  const candidateTerritory = candidateColor ? score[candidateColor] : undefined
  const opponentTerritory = opponentColor ? score[opponentColor] : undefined
  const candidateOutcome =
    candidateTerritory === undefined || opponentTerritory === undefined
      ? undefined
      : candidateTerritory > opponentTerritory
        ? 'win'
        : candidateTerritory < opponentTerritory
          ? 'loss'
          : 'draw'
  return {
    matchup: plan.matchup,
    seed,
    candidateColor,
    candidateOutcome,
    candidateTerritory,
    opponentTerritory,
    turns,
    capped: turns >= maxTurns,
    illegalActions,
    decisionMs,
    interventions,
    interventionCount,
    fallbacks,
  }
}

function choose(
  policy: Policy,
  state: GameSnapshot,
  seed: number,
): {
  action: PlayerAction
  intervention?: { original: PlayerAction; fallback: boolean }
} {
  if (policy === 'candidate' || policy === 'baseline') {
    const chooseDecision =
      policy === 'candidate'
        ? chooseHumanChallengeMCTSDecisionExperimentalSecuredTerritory
        : chooseHumanChallengeMCTSDecision
    const result = chooseDecision({
      gameState: state,
      seed,
      config: {
        mcts: config,
        budget: {
          enable750: false,
          base: simulations,
          lowConfidence: simulations * 2,
          highUncertainty: simulations * 3,
          maxDecisionMs: 60_000,
          maxVisitGap: -1,
          maxValueGap: -1,
          maxSelectedVisitShare: -1,
          highUncertaintyVisitGap: -1,
          highUncertaintyValueGap: -1,
          highUncertaintySelectedVisitShare: -1,
        },
        endgame: {
          enabled: false,
          maxLegalActions: 0,
          maxConnectedRegions: 0,
          maxMobilePieces: 0,
          maxDepth: 0,
          maxNodes: 0,
          maxTimeMs: 0,
        },
      },
    })
    return {
      action: result.action,
      intervention: result.securedTerritoryIntervention
        ? { original: result.mcts.action, fallback: result.securedTerritoryFallback }
        : undefined,
    }
  }
  if (policy === 'mcts')
    return { action: choosePlayableMCTSAction({ gameState: state, config, seed }) }
  const legal = getLegalActions(state)
  const rng = createPlayableMCTSRng(seed)
  if (policy === 'random') return { action: legal[Math.floor(rng() * legal.length)]! }
  const ranked = legal
    .map((action) => ({ action, score: scoreHeuristicAction(state, action, 'default') }))
    .sort((left, right) => right.score - left.score)
  const best = ranked.filter(({ score }) => score === ranked[0]!.score)
  return { action: best[Math.floor(rng() * best.length)]!.action }
}

function initialPlacedState(seed: number): GameSnapshot {
  let state = makeInitialState()
  const rng = createPlayableMCTSRng(seed)
  while (state.phase === 'placing') {
    const placements = getLegalActions(state)
    const index = Math.floor(rng() * placements.length)
    const action = placements[index]!
    state = applyFullAction(state, action).state
  }
  return state
}

function territory(state: GameSnapshot): Record<Player, number> {
  const score: Record<Player, number> = { R: 0, B: 0 }
  for (const row of getTerritoryMap(state.board)) for (const owner of row) if (owner) score[owner]++
  return score
}

function buildReport(rows: MatchResult[]) {
  const matchups = Object.fromEntries(
    rows
      .map(({ matchup }) => matchup)
      .filter((matchup, index, values) => values.indexOf(matchup) === index)
      .map((matchup) => {
        const subset = rows.filter((row) => row.matchup === matchup)
        const wins = subset.filter(({ candidateOutcome }) => candidateOutcome === 'win').length
        const losses = subset.filter(({ candidateOutcome }) => candidateOutcome === 'loss').length
        const draws = subset.length - wins - losses
        const scoreRate = (wins + draws * 0.5) / subset.length
        const territoryMean =
          subset.reduce((sum, row) => sum + (row.candidateTerritory ?? 0), 0) / subset.length
        return [
          matchup,
          {
            games: subset.length,
            wins,
            losses,
            draws,
            scoreRate,
            winRateWilson95: wilson(wins, subset.length),
            territoryMean,
            opponentTerritoryMean:
              subset.reduce((sum, row) => sum + (row.opponentTerritory ?? 0), 0) / subset.length,
            cappedGames: subset.filter(({ capped }) => capped).length,
          },
        ]
      }),
  )
  const totals = rows.reduce(
    (acc, row) => {
      acc.interventions += row.interventionCount
      acc.fallbacks += row.fallbacks
      acc.illegalActions += row.illegalActions
      for (const key of Object.keys(row.interventions) as Array<keyof typeof row.interventions>)
        acc[key] += row.interventions[key]
      return acc
    },
    {
      interventions: 0,
      beneficial: 0,
      harmful: 0,
      neutral: 0,
      inconclusive: 0,
      fallbacks: 0,
      illegalActions: 0,
    },
  )
  const meanDecisionMs = Object.fromEntries(
    (['candidate', 'baseline', 'mcts', 'heuristic', 'random'] as Policy[]).map((policy) => {
      const values = rows.flatMap((row) => row.decisionMs[policy])
      return [policy, values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0]
    }),
  )
  const direct = matchups['candidate-vs-baseline']
  const controls = ['random', 'heuristic', 'mcts'].map((opponent) => ({
    opponent,
    candidate: matchups[`candidate-vs-${opponent}`],
    baseline: matchups[`baseline-vs-${opponent}`],
  }))
  const accepted =
    direct.scoreRate >= 0.45 &&
    direct.territoryMean - direct.opponentTerritoryMean >= -1.5 &&
    controls.every(
      ({ candidate, baseline }) =>
        candidate.scoreRate >= baseline.scoreRate - 0.1 &&
        candidate.territoryMean >= baseline.territoryMean - 2,
    ) &&
    totals.illegalActions === 0 &&
    totals.fallbacks === 0 &&
    totals.harmful <= totals.beneficial &&
    totals.interventions > 0
  return {
    schema: 'SecuredTerritoryPolicyEvaluationV1',
    generatedAt: new Date().toISOString(),
    gamesPerColor,
    simulations,
    maxTurns,
    criteriaDocument: 'docs/secured-territory-policy-evaluation.md',
    matchups,
    interventions: totals,
    meanDecisionMs,
    decision: {
      accepted,
      recommendation: accepted ? 'enable-final-policy' : 'keep-final-policy-disabled',
      ambiguous: totals.interventions < 10,
    },
  }
}

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 1]
  const z = 1.959963984540054
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return [center - margin, center + margin]
}

function markdown(report: ReturnType<typeof buildReport>): string {
  return `# Evaluación de política de territorio asegurado

- Simulaciones MCTS por decisión: ${report.simulations}
- Partidas por color y plan: ${report.gamesPerColor}
- Intervenciones: ${report.interventions.interventions}
- Beneficiosas/perjudiciales/neutrales/inconclusas: ${report.interventions.beneficial}/${report.interventions.harmful}/${report.interventions.neutral}/${report.interventions.inconclusive}
- Fallbacks: ${report.interventions.fallbacks}
- Acciones ilegales: ${report.interventions.illegalActions}
- Decisión: **${report.decision.recommendation}**

\`\`\`json
${JSON.stringify(report.matchups, null, 2)}
\`\`\`
`
}

function sameAction(left: PlayerAction, right: PlayerAction): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
