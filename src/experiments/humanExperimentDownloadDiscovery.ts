import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseHumanMCTSTrace, type HumanMCTSTraceV1 } from '@/utils/humanMCTSTrace'

export interface TraceCandidate {
  path: string
  modifiedMs: number
  trace: HumanMCTSTraceV1
}

export async function usualDownloadDirectories(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const profile = environment.USERPROFILE
  if (!profile) return []
  const candidates = [
    resolve(profile, 'Downloads'),
    resolve(profile, 'Descargas'),
    resolve(profile, 'OneDrive', 'Downloads'),
    resolve(profile, 'OneDrive', 'Descargas'),
  ]
  const existing: string[] = []
  for (const directory of candidates) {
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
        if (!params.accept || (await params.accept(candidate))) candidates.push(candidate)
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
  const [json, details] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  return { path, modifiedMs: details.mtimeMs, trace: parseHumanMCTSTrace(json) }
}
