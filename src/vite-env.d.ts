/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GIT_COMMIT?: string
  readonly VITE_EXPERIMENT_ID?: string
  readonly VITE_PARTICIPANT_ID?: string
  readonly VITE_GAME_NUMBER?: string
  readonly VITE_SESSION_TYPE?: string
  readonly VITE_SESSION_ID?: string
  readonly VITE_HUMAN_COLOR?: string
  readonly VITE_AI_COLOR?: string
}
