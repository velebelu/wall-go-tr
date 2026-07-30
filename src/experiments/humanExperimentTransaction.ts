import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
    for (const [index, target] of targets.entries()) {
      const destination = resolveSafe(root, target.relativePath)
      await mkdir(dirname(destination), { recursive: true })
      await rename(resolveSafe(staged, target.relativePath), destination)
      await params.hooks?.afterPublish?.(target.relativePath, index)
    }
    await writeManifest(transaction, { ...manifest, state: 'committed' })
    await rm(transaction, { recursive: true, force: true })
  } catch (error) {
    await rollback(root, transaction, manifest)
    throw error
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

function resolveSafe(root: string, relativePath: string): string {
  const target = resolve(root, relativePath)
  const prefix = `${resolve(root)}\\`
  if (target !== resolve(root) && !target.startsWith(prefix))
    throw new Error(`Unsafe transaction path: ${relativePath}`)
  return target
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
