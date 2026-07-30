import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { readRegistry } from './humanExperimentExport'
import { ingestLatestHumanExperimentTrace, type IngestionSummary } from './humanExperimentIngestion'
import type { HumanExperimentRegistry } from './humanExperimentTypes'
import { readStableFile } from './humanExperimentDownloadDiscovery'
import { recoverHumanExperimentTransaction } from './humanExperimentTransaction'

const TRACE_FILE = /^traza_humano_mcts_.*\.json$/i

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
  }
  private known = new Map<string, string>()
  private processed = new Set<string>()
  private processedContent = new Set<string>()
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
    try {
      const stable = await readStableFile(path, {
        stableObservations: 3,
        intervalMs: this.params.stabilityIntervalMs ?? 750,
      })
      this.known.set(path, stable.signature)
      const finalVersionKey = `${path}\0${stable.signature}`
      this.processed.add(finalVersionKey)
      if (this.processedContent.has(stable.contentSha256)) return
      this.processedContent.add(stable.contentSha256)
      if (this.closed) return
      const registry = await readRegistry(resolve(this.params.experimentDirectory, 'registry.json'))
      const pending = nextPendingHumanExperimentGame(registry)
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
      this.params.logger?.log(formatIngestionResult(result))
      await this.showNextPending()
    } catch (error) {
      if (!this.closed) {
        const quarantine = resolve(
          this.params.quarantineDirectory ?? resolve(this.params.experimentDirectory, 'quarantine'),
        )
        await mkdir(quarantine, { recursive: true })
        await copyFile(path, resolve(quarantine, `${Date.now()}-${basename(path)}`))
        this.params.logger?.error(
          `Traza rechazada (${path}): ${errorMessage(error)}\n` +
            'El vigilante continúa activo; corrija la partida y descargue una traza nueva.',
        )
      }
    }
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
      if (!TRACE_FILE.test(name)) continue
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

function signature(value: { size: number; mtimeMs: number }): string {
  return `${value.size}:${value.mtimeMs}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
