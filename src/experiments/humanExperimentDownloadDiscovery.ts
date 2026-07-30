import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseHumanMCTSTrace, type HumanMCTSTraceV1 } from '@/utils/humanMCTSTrace'

export interface TraceCandidate {
  path: string
  modifiedMs: number
  contentSha256: string
  trace: HumanMCTSTraceV1
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
}): Promise<{ candidates: TraceCandidate[]; searchedDirectories: string[] }> {
  if (params.explicitTracePath) {
    const candidate = await readTraceCandidate(resolve(params.explicitTracePath))
    const accepted = !params.accept || (await params.accept(candidate))
    return { candidates: accepted ? [candidate] : [], searchedDirectories: [] }
  }
  const directories = params.directories ?? (await usualDownloadDirectories())
  const candidates: TraceCandidate[] = []
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
      try {
        const candidate = await readTraceCandidate(resolve(directory, name))
        if (contentHashes.has(candidate.contentSha256)) continue
        if (!params.accept || (await params.accept(candidate))) {
          contentHashes.add(candidate.contentSha256)
          candidates.push(candidate)
        }
      } catch {
        // Invalid and unrelated JSON downloads are ignored.
      }
    }
  }
  return {
    candidates: candidates.sort((left, right) => right.modifiedMs - left.modifiedMs),
    searchedDirectories: directories,
  }
}

export async function readTraceCandidate(path: string): Promise<TraceCandidate> {
  const stable = await readStableFile(path, { stableObservations: 1, intervalMs: 0 })
  return {
    path,
    modifiedMs: stable.modifiedMs,
    contentSha256: stable.contentSha256,
    trace: parseHumanMCTSTrace(stable.contents),
  }
}

export async function readStableFile(
  path: string,
  options: { stableObservations?: number; intervalMs?: number } = {},
): Promise<StableFile> {
  const stableObservations = Math.max(1, options.stableObservations ?? 3)
  const intervalMs = Math.max(0, options.intervalMs ?? 250)
  let stableCount = 0
  let previousSignature: string | undefined
  while (stableCount < stableObservations) {
    const details = await stat(path)
    const currentSignature = fileSignature(details)
    stableCount = currentSignature === previousSignature ? stableCount + 1 : 1
    previousSignature = currentSignature
    if (stableCount < stableObservations) await delay(intervalMs)
  }
  for (;;) {
    const before = await stat(path)
    const beforeSignature = fileSignature(before)
    const contents = await readFile(path, 'utf8')
    const after = await stat(path)
    const afterSignature = fileSignature(after)
    if (beforeSignature === afterSignature) {
      return {
        path,
        contents,
        modifiedMs: after.mtimeMs,
        signature: afterSignature,
        contentSha256: createHash('sha256').update(contents).digest('hex'),
      }
    }
    await delay(intervalMs)
  }
}

function fileSignature(value: { size: number; mtimeMs: number }): string {
  return `${value.size}:${value.mtimeMs}`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}
