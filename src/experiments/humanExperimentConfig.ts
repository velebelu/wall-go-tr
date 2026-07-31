export const CURRENT_HUMAN_EXPERIMENT_ID = 'WGTR-HUMAN-FINAL-2026-V3-R1'
export const CURRENT_HUMAN_EXPERIMENT_DIRECTORY = 'data/human-experiment/final-2026-v3-r1'
export const CURRENT_HUMAN_EXPERIMENT_INVALID_SESSIONS_DIRECTORY =
  'data/human-experiment/invalid-sessions-v3-r1'
export const ARCHIVED_HUMAN_EXPERIMENT_DIRECTORY = 'data/human-experiment/final-2026-v3'

export interface HumanExperimentCodeFreezeTraceability {
  implementationCommit: string
  experimentPreparationCommit: string
  codeFreezeBindingCommit: string
}
