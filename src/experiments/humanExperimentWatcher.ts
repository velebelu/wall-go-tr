import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { readRegistry } from './humanExperimentExport'
import {
  describeErrorClassification,
  humanExperimentErrorCode,
  retryPolicyOf,
  type HumanExperimentErrorCode,
} from './humanExperimentErrors'
import { ingestLatestHumanExperimentTrace, type IngestionSummary } from './humanExperimentIngestion'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import { readStableFile } from './humanExperimentDownloadDiscovery'
import { recoverHumanExperimentTransaction } from './humanExperimentTransaction'
import {
  TRANSITION_MISMATCH_SCHEMA,
  validateTransitionMismatchArtifact,
} from './humanExperimentTransitionDiagnostics'

const TRACE_FILE = /^traza_humano_mcts_.*\.json$/i
const TRANSITION_DIAGNOSTIC_FILE = /^diagnostico_transicion_.*\.json$/i
/** Tope de reintentos por contenido: acota el ruido sin descartar un fallo pasajero. */
const MAX_RECOVERABLE_ATTEMPTS = 3

type ContentOutcome =
  | { status: 'registered'; participantId: string; gameNumber: 1 | 2 }
  | {
      status: 'rejected'
      code?: HumanExperimentErrorCode
      reason: string
      retry: 'final' | 'recoverable' | 'inspect'
      attempts: number
    }

export interface PendingHumanExperimentGame {
  participantId: string
  gameNumber: 1 | 2
  humanColor: 'R' | 'B'
  aiColor: 'R' | 'B'
  menuButton: 'Rojo' | 'Azul'
}

interface FileVersion {
  path: string
  signature: string
}

export function nextPendingHumanExperimentGame(
  registry: HumanExperimentRegistry,
): PendingHumanExperimentGame | undefined {
  for (const participant of registry.participants) {
    for (const gameNumber of [1, 2] as const) {
      const registered = registry.games.some(
        (game) =>
          game.participantId === participant.participantId && game.gameNumber === gameNumber,
      )
      if (!registered) {
        const humanColor = participant.colorOrder[gameNumber - 1]
        const aiColor = humanColor === 'R' ? 'B' : 'R'
        return {
          participantId: participant.participantId,
          gameNumber,
          humanColor,
          aiColor,
          menuButton: aiColor === 'R' ? 'Rojo' : 'Azul',
        }
      }
    }
  }
}

export function formatPendingGame(pending: PendingHumanExperimentGame): string {
  return [
    '',
    'Siguiente partida pendiente:',
    `  Participante: ${pending.participantId}`,
    `  Partida: ${pending.gameNumber}`,
    `  Color humano: ${pending.humanColor === 'R' ? 'Rojo (R)' : 'Azul (B)'}`,
    `  Color IA: ${pending.aiColor === 'R' ? 'Rojo (R)' : 'Azul (B)'}`,
    `  Botón del menú: ${pending.menuButton}`,
    '',
  ].join('\n')
}

export function formatIngestionResult(result: IngestionSummary): string {
  return [
    '',
    `Partida registrada: ${result.participantId}, partida ${result.gameNumber}`,
    `  Ganador: ${result.winner}`,
    `  Territorio: humano ${result.humanTerritory} - IA ${result.aiTerritory}`,
    `  Turnos: ${result.turnCount}`,
    `  Duración: ${result.durationMs} ms`,
    `  Registro: ${result.participantCount} participantes, ${result.gameCount} partidas`,
    '  Validation: OK',
    '',
  ].join('\n')
}

export class HumanExperimentWatcher {
  private readonly params: {
    experimentDirectory: string
    downloadDirectory: string
    expectedCommit: string
    pollIntervalMs?: number
    stabilityIntervalMs?: number
    logger?: Pick<Console, 'log' | 'error'>
    ingest?: typeof ingestLatestHumanExperimentTrace
    quarantineDirectory?: string
    invalidSessionDirectory?: string
  }
  private known = new Map<string, string>()
  private processed = new Set<string>()
  private processedContent = new Map<string, ContentOutcome>()
  private timer: NodeJS.Timeout | undefined
  private scanning = false
  private closed = false

  constructor(params: HumanExperimentWatcher['params']) {
    this.params = params
  }

  async start(): Promise<void> {
    await recoverHumanExperimentTransaction(this.params.experimentDirectory)
    const details = await stat(this.params.downloadDirectory)
    if (!details.isDirectory())
      throw new Error(`La ruta de descargas no es una carpeta: ${this.params.downloadDirectory}`)
    for (const file of await this.fileVersions()) this.known.set(file.path, file.signature)
    this.params.logger?.log(
      `Vigilando nuevas trazas en: ${this.params.downloadDirectory}\n` +
        `Se han ignorado ${this.known.size} archivo(s) existentes al arrancar.`,
    )
    await this.showNextPending()
    if (!this.closed) {
      this.timer = setInterval(() => void this.scanOnce(), this.params.pollIntervalMs ?? 500)
    }
  }

  async scanOnce(): Promise<void> {
    if (this.closed || this.scanning) return
    this.scanning = true
    try {
      for (const file of await this.fileVersions()) {
        const previous = this.known.get(file.path)
        this.known.set(file.path, file.signature)
        if (previous === undefined || previous !== file.signature) {
          const versionKey = `${file.path}\0${file.signature}`
          if (!this.processed.has(versionKey)) await this.processFile(file.path, versionKey)
        }
      }
    } catch (error) {
      this.params.logger?.error(`Error del vigilante: ${errorMessage(error)}`)
    } finally {
      this.scanning = false
    }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async processFile(path: string, versionKey: string): Promise<void> {
    this.processed.add(versionKey)
    let contentKey: string | undefined
    try {
      const stable = await readStableFile(path, {
        stableObservations: 3,
        intervalMs: this.params.stabilityIntervalMs ?? 750,
      })
      this.known.set(path, stable.signature)
      const finalVersionKey = `${path}\0${stable.signature}`
      this.processed.add(finalVersionKey)
      contentKey = stable.contentSha256
      if (this.closed) return
      const parsed = JSON.parse(stable.contents) as { schema?: unknown }
      if (parsed.schema === TRANSITION_MISMATCH_SCHEMA) {
        await this.archiveTransitionDiagnostic(path, stable.contentSha256, parsed)
        this.processedContent.set(contentKey, {
          status: 'rejected',
          reason: 'non-official transition mismatch diagnostic',
          retry: 'final',
          attempts: 1,
        })
        return
      }
      const registry = await readRegistry(resolve(this.params.experimentDirectory, 'registry.json'))
      const pending = nextPendingHumanExperimentGame(registry)
      if (!this.shouldProcessAgain(contentKey, registry)) return
      if (!pending) {
        this.params.logger?.log('Experimento completo: no quedan partidas pendientes.')
        return
      }
      this.params.logger?.log(`Nueva traza detectada: ${path}`)
      const ingest = this.params.ingest ?? ingestLatestHumanExperimentTrace
      const result = await ingest({
        experimentDirectory: this.params.experimentDirectory,
        participantId: pending.participantId,
        gameNumber: pending.gameNumber,
        explicitTracePath: path,
        expectedCommit: this.params.expectedCommit,
      })
      this.processedContent.set(contentKey, {
        status: 'registered',
        participantId: result.participantId,
        gameNumber: result.gameNumber,
      })
      this.params.logger?.log(formatIngestionResult(result))
      await this.showNextPending()
    } catch (error) {
      if (this.closed) return
      const retry = retryPolicyOf(error)
      const attempts = this.recordRejection(contentKey, error, retry)
      const exhausted = attempts >= MAX_RECOVERABLE_ATTEMPTS
      // Sólo se conserva copia de lo que ya no puede prosperar: una traza aún en escritura o
      // un fallo de E/S se reintentan, y copiarlos sólo llenaría la cuarentena de duplicados.
      if (retry === 'final' || exhausted) await this.quarantine(path)
      this.params.logger?.error(
        `Traza rechazada (${path}) [${describeErrorClassification(error)}]: ${errorMessage(error)}\n` +
          (retry === 'final'
            ? 'Rechazo definitivo para este contenido: corrija la partida y descargue una traza nueva.'
            : exhausted
              ? `Se agotaron los ${MAX_RECOVERABLE_ATTEMPTS} intentos para este contenido; revise el estado antes de reintentar.`
              : `Se reintentará si el archivo vuelve a aparecer (intento ${attempts}/${MAX_RECOVERABLE_ATTEMPTS}).`),
      )
    }
  }

  /**
   * Decide si un contenido ya visto vuelve a intentarse. Antes se descartaba en silencio,
   * de modo que volver a descargar la traza tras un fallo no producía ninguna señal.
   */
  private shouldProcessAgain(contentSha256: string, registry: HumanExperimentRegistry): boolean {
    const previous = this.processedContent.get(contentSha256)
    if (!previous) return true
    if (previous.status === 'registered') {
      this.params.logger?.log(
        `Traza ya registrada como ${previous.participantId}-${previous.gameNumber}; ` +
          'se ignora esta copia para no duplicar la partida.',
      )
      return false
    }
    const classification = `${previous.code ?? 'UNCLASSIFIED'} (${previous.retry})`
    if (previous.retry === 'final') {
      this.params.logger?.error(
        `Este contenido ya fue rechazado [${classification}]: ${previous.reason}\n` +
          'No se reintenta: descargue una traza nueva tras corregir la partida.',
      )
      return false
    }
    if (previous.attempts >= MAX_RECOVERABLE_ATTEMPTS) {
      this.params.logger?.error(
        `Este contenido acumula ${previous.attempts} intentos fallidos [${classification}]: ` +
          `${previous.reason}\nNo se reintenta automáticamente.`,
      )
      return false
    }
    if (previous.retry === 'inspect') {
      // `DESTINATION_CONFLICT`: el destino existía. Si la partida ya consta en el registro
      // fue una publicación correcta; si no, quedó un resto que sí conviene reintentar.
      const pending = nextPendingHumanExperimentGame(registry)
      if (!pending) {
        this.params.logger?.log(
          'El destino ya está ocupado y no quedan partidas pendientes; no se reintenta.',
        )
        return false
      }
    }
    this.params.logger?.log(
      `Reintento ${previous.attempts + 1}/${MAX_RECOVERABLE_ATTEMPTS} tras el fallo previo ` +
        `[${classification}]: ${previous.reason}`,
    )
    return true
  }

  private recordRejection(
    contentSha256: string | undefined,
    error: unknown,
    retry: 'final' | 'recoverable' | 'inspect',
  ): number {
    if (!contentSha256) return 1
    const previous = this.processedContent.get(contentSha256)
    const attempts = previous?.status === 'rejected' ? previous.attempts + 1 : 1
    this.processedContent.set(contentSha256, {
      status: 'rejected',
      code: humanExperimentErrorCode(error),
      reason: errorMessage(error),
      retry,
      attempts,
    })
    return attempts
  }

  private async quarantine(path: string): Promise<void> {
    const directory = resolve(
      this.params.quarantineDirectory ?? resolve(this.params.experimentDirectory, 'quarantine'),
    )
    await mkdir(directory, { recursive: true })
    await copyFile(path, resolve(directory, `${Date.now()}-${basename(path)}`))
  }

  private async archiveTransitionDiagnostic(
    path: string,
    packageSha256: string,
    parsed: unknown,
  ): Promise<void> {
    const artifact = await validateTransitionMismatchArtifact(parsed)
    const quarantineDirectory = resolve(
      this.params.quarantineDirectory ?? resolve(this.params.experimentDirectory, 'quarantine'),
    )
    await mkdir(quarantineDirectory, { recursive: true })
    await copyFile(path, resolve(quarantineDirectory, basename(path)))
    if (artifact.partialTraceDiagnostic) {
      await writeFile(
        resolve(
          quarantineDirectory,
          `traza_parcial_${safeFileName(artifact.sessionId ?? 'sin-sesion')}.json`,
        ),
        `${JSON.stringify(artifact.partialTraceDiagnostic, null, 2)}\n`,
        { flag: 'wx' },
      )
    }
    const invalidSessionDirectory = resolve(
      this.params.invalidSessionDirectory ??
        resolve(dirname(this.params.experimentDirectory), 'invalid-sessions-v3'),
    )
    await mkdir(invalidSessionDirectory, { recursive: true })
    const manifest = {
      ...artifact.proposedInvalidSessionManifest,
      packageSha256,
      manifestPayloadSha256: artifact.artifactHashes.proposedManifestSha256,
      registration: 'rejected' as const,
      repeatRequired: true as const,
    }
    await writeFile(
      resolve(invalidSessionDirectory, `${safeFileName(artifact.sessionId ?? packageSha256)}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' },
    )
    this.params.logger?.error(
      `Sesión inválida archivada sin ingesta oficial: ${artifact.sessionId ?? '<sin sesión>'}`,
    )
  }

  private async showNextPending(): Promise<void> {
    const registry = await readRegistry(resolve(this.params.experimentDirectory, 'registry.json'))
    const pending = nextPendingHumanExperimentGame(registry)
    this.params.logger?.log(
      pending ? formatPendingGame(pending) : 'Experimento completo: no quedan partidas pendientes.',
    )
  }

  private async fileVersions(): Promise<FileVersion[]> {
    const names = await readdir(this.params.downloadDirectory)
    const files: FileVersion[] = []
    for (const name of names) {
      if (!TRACE_FILE.test(name) && !TRANSITION_DIAGNOSTIC_FILE.test(name)) continue
      const path = resolve(this.params.downloadDirectory, name)
      try {
        const details = await stat(path)
        if (details.isFile()) files.push({ path, signature: signature(details) })
      } catch {
        // The browser or antivirus may briefly move a download while it is being finalized.
      }
    }
    return files
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_')
}

function signature(value: { size: number; mtimeMs: number }): string {
  return `${value.size}:${value.mtimeMs}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
