/**
 * Códigos explícitos para la capa operacional del experimento humano.
 *
 * El vigilante decide si reintenta una traza a partir del código, nunca del texto
 * del mensaje: los mensajes son para las personas y pueden cambiar sin aviso.
 */
export type HumanExperimentErrorCode =
  | 'ALREADY_REGISTERED'
  | 'INVALID_TRACE'
  | 'COMMIT_MISMATCH'
  | 'REPLAY_MISMATCH'
  | 'PARTICIPANT_NOT_REGISTERED'
  | 'TRANSACTION_IO_FAILURE'
  | 'DESTINATION_CONFLICT'
  | 'FILE_STILL_WRITING'
  | 'JSON_INCOMPLETE'

/**
 * `final` no se reintenta nunca para ese contenido; `recoverable` admite reintentos
 * acotados tras corregir la preparación; `inspect` obliga a mirar el estado real del
 * registro antes de decidir.
 */
export type HumanExperimentRetryPolicy = 'final' | 'recoverable' | 'inspect'

const DEFAULT_RETRY_POLICY: Record<HumanExperimentErrorCode, HumanExperimentRetryPolicy> = {
  ALREADY_REGISTERED: 'final',
  INVALID_TRACE: 'final',
  COMMIT_MISMATCH: 'final',
  REPLAY_MISMATCH: 'final',
  PARTICIPANT_NOT_REGISTERED: 'recoverable',
  TRANSACTION_IO_FAILURE: 'recoverable',
  DESTINATION_CONFLICT: 'inspect',
  FILE_STILL_WRITING: 'recoverable',
  // Un JSON a medio escribir se vuelve definitivo sólo cuando persiste tras el límite
  // de espera; en ese caso quien lo lanza pasa `retry: 'final'` de forma explícita.
  JSON_INCOMPLETE: 'recoverable',
}

/**
 * Un error sin código se trata como `recoverable`: el vigilante ya acota los reintentos,
 * así que equivocarse hacia el reintento sólo cuesta ruido, mientras que equivocarse
 * hacia `final` descartaría una partida recuperable.
 */
export const UNCLASSIFIED_RETRY_POLICY: HumanExperimentRetryPolicy = 'recoverable'

export class HumanExperimentError extends Error {
  readonly code: HumanExperimentErrorCode
  readonly retry: HumanExperimentRetryPolicy
  /** Error original, cuando este envuelve a otro. Declarado aquí porque la `lib` del
   *  proyecto no incluye el segundo argumento de `Error`. */
  readonly reason?: unknown

  constructor(
    code: HumanExperimentErrorCode,
    message: string,
    options: { retry?: HumanExperimentRetryPolicy; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'HumanExperimentError'
    this.code = code
    this.retry = options.retry ?? DEFAULT_RETRY_POLICY[code]
    this.reason = options.cause
  }
}

export function humanExperimentErrorCode(error: unknown): HumanExperimentErrorCode | undefined {
  return error instanceof HumanExperimentError ? error.code : undefined
}

export function retryPolicyOf(error: unknown): HumanExperimentRetryPolicy {
  return error instanceof HumanExperimentError ? error.retry : UNCLASSIFIED_RETRY_POLICY
}

/** Marca de trazabilidad para los registros del vigilante: `INVALID_TRACE (final)`. */
export function describeErrorClassification(error: unknown): string {
  const code = humanExperimentErrorCode(error)
  return `${code ?? 'UNCLASSIFIED'} (${retryPolicyOf(error)})`
}
