import type { Player } from '@/lib/types'
import type { HumanMCTSSessionType } from '@/utils/humanMCTSTrace'

export interface HumanExperimentSessionContext {
  experimentId: string
  participantId?: string
  gameNumber?: 1 | 2
  humanColor: Player
  aiColor: Player
  sessionType: HumanMCTSSessionType
  runtimeCommit: string
  sessionId: string
}

export function sessionContextFromEnvironment(
  environment: Record<string, string | boolean | undefined>,
): HumanExperimentSessionContext {
  const sessionType = required(environment.VITE_SESSION_TYPE, 'VITE_SESSION_TYPE')
  if (!['practice', 'official', 'diagnostic'].includes(sessionType))
    throw new Error(`Invalid VITE_SESSION_TYPE: ${sessionType}`)
  const humanColor = player(environment.VITE_HUMAN_COLOR, 'VITE_HUMAN_COLOR')
  const aiColor = player(environment.VITE_AI_COLOR, 'VITE_AI_COLOR')
  if (humanColor === aiColor) throw new Error('Human and AI colors must differ')
  const runtimeCommit = required(environment.VITE_GIT_COMMIT, 'VITE_GIT_COMMIT')
  if (!/^[0-9a-f]{40}$/i.test(runtimeCommit))
    throw new Error('VITE_GIT_COMMIT must be a full commit')
  const context: HumanExperimentSessionContext = {
    experimentId: required(environment.VITE_EXPERIMENT_ID, 'VITE_EXPERIMENT_ID'),
    humanColor,
    aiColor,
    sessionType: sessionType as HumanMCTSSessionType,
    runtimeCommit,
    sessionId: required(environment.VITE_SESSION_ID, 'VITE_SESSION_ID'),
  }
  if (sessionType === 'official' || sessionType === 'practice') {
    context.participantId = required(environment.VITE_PARTICIPANT_ID, 'VITE_PARTICIPANT_ID')
  }
  if (sessionType === 'official') {
    const gameNumber = Number(required(environment.VITE_GAME_NUMBER, 'VITE_GAME_NUMBER'))
    if (gameNumber !== 1 && gameNumber !== 2) throw new Error('VITE_GAME_NUMBER must be 1 or 2')
    context.gameNumber = gameNumber
  }
  return context
}

function player(value: string | boolean | undefined, name: string): Player {
  const parsed = required(value, name)
  if (parsed !== 'R' && parsed !== 'B') throw new Error(`${name} must be R or B`)
  return parsed
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}
