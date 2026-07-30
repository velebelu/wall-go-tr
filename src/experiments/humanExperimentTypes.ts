import type { HumanChallengeConfig } from '@/agents/humanChallengeMCTS'
import type { Player } from '@/lib/types'

export type ExperienceGroup = 'none' | 'basic' | 'experienced'
export type HumanExperimentWinner = 'human' | 'ai' | 'draw'
export type HumanExperimentIncidentCode =
  | 'performance-warning'
  | 'participant-interruption'
  | 'application-reload'
  | 'trace-download-failure'
  | 'wrong-color-order'
  | 'practice-protocol-deviation'
  | 'missing-commit-pilot-only'
  | 'other'

export interface HumanExperimentIncident {
  code: HumanExperimentIncidentCode
  description?: string
}

export interface HumanExperimentParticipant {
  schema: 'HumanExperimentParticipantV1'
  experimentId: string
  participantId: string
  experienceGroup: ExperienceGroup
  previousWallGoGames: number
  practiceGames: number
  colorOrder: readonly [Player, Player]
  notes?: string
}

export interface HumanExperimentGame {
  schema: 'HumanExperimentGameV1'
  experimentId: string
  participantId: string
  gameId: string
  gameNumber: 1 | 2
  humanColor: Player
  aiColor: Player
  winner: HumanExperimentWinner
  humanTerritory: number
  aiTerritory: number
  territoryDiffHuman: number
  turnCount: number
  startedAt: string
  finishedAt: string
  durationMs: number
  terminalReason: string
  traceId: string
  tracePath: string
  traceSha256: string
  seed: number
  effectiveConfig: HumanChallengeConfig
  effectiveConfigSha256: string
  sourceCommit: string
  sourceVersion?: string
  recordedAt: string
  incidents: HumanExperimentIncident[]
}

export interface HumanExperimentRegistry {
  schema: 'HumanExperimentRegistryV1'
  experimentId: string
  participants: HumanExperimentParticipant[]
  games: HumanExperimentGame[]
}

export interface HumanExperimentGameInput {
  schema: 'HumanExperimentGameInputV1'
  experimentId: string
  participantId: string
  gameNumber: 1 | 2
  gameId?: string
  traceId?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  terminalReason?: string
  traceSha256?: string
  effectiveConfigSha256?: string
  sourceCommit?: string
  sourceVersion?: string
  recordedAt?: string
  incidents?: HumanExperimentIncident[]
}
