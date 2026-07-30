import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  HUMAN_MCTS_TRACE_SCHEMA,
  parseHumanMCTSTrace,
  type HumanMCTSTraceV1,
} from '@/utils/humanMCTSTrace'
import {
  HumanExperimentError,
  humanExperimentErrorCode,
  type HumanExperimentErrorCode,
} from './humanExperimentErrors'

/** Espera mínima real entre reintentos: evita el bucle activo cuando `intervalMs` es 0. */
const MINIMUM_WAIT_MS = 5
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_ATTEMPTS = 40

export interface TraceCandidate {
  path: string
  modifiedMs: number
  contentSha256: string
  trace: HumanMCTSTraceV1
}

/** Motivo por el que un archivo del directorio de descargas no llegó a ser candidato. */
export interface TraceRejection {
  path: string
  code?: HumanExperimentErrorCode
  reason: string
}

/**
 * El archivo es un JSON válido pero no una traza del experimento. Las descargas del navegador
 * contienen JSON de todo tipo, así que estos descartes no se muestran: sólo añadirían ruido.
 */
export class NotATraceFileError extends Error {
  constructor(path: string) {
    super(`Not a human-MCTS trace file: ${path}`)
    this.name = 'NotATraceFileError'
  }
}

export interface StableFileOptions {
  stableObservations?: number
  intervalMs?: number
  timeoutMs?: number
  maxAttempts?: number
  io?: { stat: typeof stat; readFile: typeof readFile }
  now?: () => number
}

export interface StableFile {
  path: string
  contents: string
  modifiedMs: number
  signature: string
  contentSha256: string
}

export async function usualDownloadDirectories(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const profile = environment.USERPROFILE
  const candidates = [
    environment.HUMAN_EXPERIMENT_DOWNLOAD_DIR,
    'Z:\\ARCHIVOS ERIC\\Descargas',
    ...(profile
      ? [
          resolve(profile, 'Downloads'),
          resolve(profile, 'Descargas'),
          resolve(profile, 'OneDrive', 'Downloads'),
          resolve(profile, 'OneDrive', 'Descargas'),
        ]
      : []),
  ]
  const existing: string[] = []
  for (const directory of candidates) {
    if (!directory) continue
    try {
      if ((await stat(directory)).isDirectory()) existing.push(directory)
    } catch {
      // A common download directory may not exist.
    }
  }
  return [...new Set(existing)]
}

export async function discoverHumanMCTSTraces(params: {
  directories?: string[]
  explicitTracePath?: string
  accept?: (candidate: TraceCandidate) => Promise<boolean>
}): Promise<{
  candidates: TraceCandidate[]
  rejected: TraceRejection[]
  searchedDirectories: string[]
}> {
  if (params.explicitTracePath) {
    // Con ruta explícita el error se propaga: quien la indicó quiere saber exactamente
    // por qué esa traza concreta no sirve.
    const candidate = await readTraceCandidate(resolve(params.explicitTracePath))
    const accepted = !params.accept || (await params.accept(candidate))
    return { candidates: accepted ? [candidate] : [], rejected: [], searchedDirectories: [] }
  }
  const directories = params.directories ?? (await usualDownloadDirectories())
  const candidates: TraceCandidate[] = []
  const rejected: TraceRejection[] = []
  const contentHashes = new Set<string>()
  for (const directory of directories) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      const path = resolve(directory, name)
      try {
        const candidate = await readTraceCandidate(path)
        if (contentHashes.has(candidate.contentSha256)) continue
        if (params.accept && !(await params.accept(candidate))) {
          rejected.push({ path, reason: 'La traza no fue aceptada' })
          continue
        }
        contentHashes.add(candidate.contentSha256)
        candidates.push(candidate)
      } catch (error) {
        // Un JSON cualquiera de la carpeta de descargas no es un rechazo digno de mención;
        // una traza que sí lo es y falla la validación, sí.
        if (error instanceof NotATraceFileError) continue
        rejected.push({
          path,
          code: humanExperimentErrorCode(error),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return {
    candidates: candidates.sort((left, right) => right.modifiedMs - left.modifiedMs),
    rejected,
    searchedDirectories: directories,
  }
}

export async function readTraceCandidate(
  path: string,
  options: StableFileOptions = {},
): Promise<TraceCandidate> {
  const stable = await readStableFile(path, {
    stableObservations: 1,
    intervalMs: 0,
    ...options,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(stable.contents)
  } catch (error) {
    throw new HumanExperimentError(
      'JSON_INCOMPLETE',
      `JSON inválido o incompleto en ${path}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    )
  }
  if ((parsed as { schema?: unknown } | null)?.schema !== HUMAN_MCTS_TRACE_SCHEMA)
    throw new NotATraceFileError(path)
  let trace: HumanMCTSTraceV1
  try {
    trace = parseHumanMCTSTrace(stable.contents)
  } catch (error) {
    // Declara ser una traza pero le faltan piezas: normalmente una descarga a medio escribir.
    throw new HumanExperimentError(
      'JSON_INCOMPLETE',
      `Traza incompleta en ${path}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    )
  }
  return {
    path,
    modifiedMs: stable.modifiedMs,
    contentSha256: stable.contentSha256,
    trace,
  }
}

/**
 * Lee un archivo sólo cuando ha dejado de cambiar.
 *
 * La versión anterior giraba indefinidamente —y a pleno consumo de CPU con `intervalMs: 0`—
 * si el archivo nunca se estabilizaba. Ahora la espera está acotada por número de intentos y
 * por tiempo, y agotarla produce `FILE_STILL_WRITING`, que el vigilante puede reintentar.
 */
export async function readStableFile(
  path: string,
  options: StableFileOptions = {},
): Promise<StableFile> {
  const stableObservations = Math.max(1, options.stableObservations ?? 3)
  const intervalMs = Math.max(0, options.intervalMs ?? 250)
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const io = options.io ?? { stat, readFile }
  const now = options.now ?? Date.now
  const startedAt = now()
  let attempts = 0

  const exhausted = (): boolean => attempts >= maxAttempts || now() - startedAt >= timeoutMs
  const giveUp = (): never => {
    throw new HumanExperimentError(
      'FILE_STILL_WRITING',
      `El archivo seguía cambiando tras ${attempts} intento(s): ${path}`,
    )
  }

  let stableCount = 0
  let previousSignature: string | undefined
  while (stableCount < stableObservations) {
    attempts += 1
    const details = await io.stat(path)
    const currentSignature = fileSignature(details)
    stableCount = currentSignature === previousSignature ? stableCount + 1 : 1
    previousSignature = currentSignature
    if (stableCount < stableObservations) {
      if (exhausted()) giveUp()
      await delay(Math.max(intervalMs, MINIMUM_WAIT_MS))
    }
  }
  for (;;) {
    attempts += 1
    const before = await io.stat(path)
    const beforeSignature = fileSignature(before)
    const contents = await io.readFile(path, 'utf8')
    const after = await io.stat(path)
    const afterSignature = fileSignature(after)
    if (beforeSignature === afterSignature) {
      return {
        path,
        contents: String(contents),
        modifiedMs: after.mtimeMs,
        signature: afterSignature,
        contentSha256: createHash('sha256').update(String(contents)).digest('hex'),
      }
    }
    if (exhausted()) giveUp()
    await delay(Math.max(intervalMs, MINIMUM_WAIT_MS))
  }
}

function fileSignature(value: { size: number; mtimeMs: number }): string {
  return `${value.size}:${value.mtimeMs}`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}
