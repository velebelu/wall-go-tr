export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  return value
}

export async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(value))
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.subtle) throw new Error('Web Crypto SHA-256 is unavailable')
  const digest = await cryptoApi.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createExperimentalGameId(
  participantId: string,
  gameNumber: 1 | 2,
  uuid = globalThis.crypto.randomUUID(),
): string {
  return `WGTR-2026-${participantId}-G${gameNumber}-${uuid}`
}
