import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { HumanExperimentError } from './humanExperimentErrors'

const TRANSACTION_DIRECTORY = '.ingestion-transaction'

interface TransactionTarget {
  relativePath: string
  existed: boolean
}

interface TransactionManifest {
  schema: 'HumanExperimentIngestionTransactionV1'
  state: 'prepared' | 'committed'
  targets: TransactionTarget[]
}

export interface TransactionHooks {
  beforePublish?: () => Promise<void> | void
  afterPublish?: (relativePath: string, index: number) => Promise<void> | void
}

export async function publishHumanExperimentTransaction(params: {
  root: string
  candidates: Record<string, string>
  hooks?: TransactionHooks
}): Promise<void> {
  const root = resolve(params.root)
  await recoverHumanExperimentTransaction(root)
  const transaction = resolve(root, TRANSACTION_DIRECTORY)
  const staged = resolve(transaction, 'staged')
  const backups = resolve(transaction, 'backups')
  await mkdir(staged, { recursive: true })
  await mkdir(backups, { recursive: true })

  const targets: TransactionTarget[] = []
  for (const [relativePath, contents] of Object.entries(params.candidates)) {
    const target = resolveSafe(root, relativePath)
    const existed = await exists(target)
    targets.push({ relativePath, existed })
    const candidate = resolveSafe(staged, relativePath)
    await mkdir(dirname(candidate), { recursive: true })
    await writeFile(candidate, contents, { encoding: 'utf8', flag: 'wx' })
    if (relativePath.endsWith('.json')) JSON.parse(await readFile(candidate, 'utf8'))
    if (existed) {
      const backup = resolveSafe(backups, relativePath)
      await mkdir(dirname(backup), { recursive: true })
      await copyFile(target, backup)
    }
  }

  const manifest: TransactionManifest = {
    schema: 'HumanExperimentIngestionTransactionV1',
    state: 'prepared',
    targets,
  }
  await writeManifest(transaction, manifest)
  try {
    await params.hooks?.beforePublish?.()
    // No usar `for ... of targets.entries()` aquí. El cargador operacional de TypeScript
    // transpila ese iterador como si fuese un array y el bucle no ejecuta ninguna vuelta:
    // se eliminaba el journal y se devolvía éxito sin publicar un solo archivo.
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]
      const destination = resolveSafe(root, target.relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await rename(resolveSafe(staged, target.relativePath), destination)
      await params.hooks?.afterPublish?.(target.relativePath, index)
    }
    await writeManifest(transaction, { ...manifest, state: 'committed' })
    await rm(transaction, { recursive: true, force: true })
  } catch (error) {
    await rollback(root, transaction, manifest)
    // El estado en disco queda restaurado, así que el fallo es recuperable: se conserva el
    // mensaje original y sólo se añade la clasificación que el vigilante necesita.
    if (error instanceof HumanExperimentError) throw error
    throw new HumanExperimentError(
      'TRANSACTION_IO_FAILURE',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    )
  }
}

export async function recoverHumanExperimentTransaction(rootPath: string): Promise<boolean> {
  const root = resolve(rootPath)
  const transaction = resolve(root, TRANSACTION_DIRECTORY)
  const manifestPath = resolve(transaction, 'manifest.json')
  if (!(await exists(manifestPath))) return false
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TransactionManifest
  if (
    manifest.schema !== 'HumanExperimentIngestionTransactionV1' ||
    !Array.isArray(manifest.targets)
  )
    throw new Error('Invalid human-experiment ingestion transaction manifest')
  if (manifest.state === 'prepared') await rollback(root, transaction, manifest)
  else await rm(transaction, { recursive: true, force: true })
  return true
}

async function rollback(
  root: string,
  transaction: string,
  manifest: TransactionManifest,
): Promise<void> {
  for (const target of [...manifest.targets].reverse()) {
    const destination = resolveSafe(root, target.relativePath)
    if (target.existed) {
      const backup = resolveSafe(resolve(transaction, 'backups'), target.relativePath)
      if (await exists(backup)) await copyFile(backup, destination)
    } else {
      await rm(destination, { force: true })
    }
  }
  await rm(transaction, { recursive: true, force: true })
}

async function writeManifest(transaction: string, manifest: TransactionManifest): Promise<void> {
  const path = resolve(transaction, 'manifest.json')
  const temporary = resolve(transaction, 'manifest.tmp')
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rm(path, { force: true })
  await rename(temporary, path)
}

/**
 * Resuelve una ruta relativa dentro de `root` aplicando las reglas del sistema anfitrión.
 *
 * Se apoya en `isAbsolute`/`relative`/`sep` en lugar de comparar prefijos con un separador
 * fijo: la versión anterior incrustaba `\\` y, en POSIX, rechazaba cualquier ruta. No se
 * normaliza la barra invertida a mano de forma deliberada, porque en POSIX es un carácter
 * legítimo dentro de un nombre de archivo y no un separador.
 */
export function resolveSafeTransactionPath(root: string, relativePath: string): string {
  const base = resolve(root)
  if (isAbsolute(relativePath)) throw unsafePath(relativePath)
  const target = resolve(base, relativePath)
  const offset = relative(base, target)
  if (offset === '') return target
  if (isAbsolute(offset) || offset === '..' || offset.startsWith(`..${sep}`))
    throw unsafePath(relativePath)
  return target
}

function unsafePath(relativePath: string): HumanExperimentError {
  return new HumanExperimentError('INVALID_TRACE', `Unsafe transaction path: ${relativePath}`)
}

function resolveSafe(root: string, relativePath: string): string {
  return resolveSafeTransactionPath(root, relativePath)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
