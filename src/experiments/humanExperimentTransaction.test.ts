import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { HumanExperimentError } from './humanExperimentErrors'
import {
  publishHumanExperimentTransaction,
  recoverHumanExperimentTransaction,
  resolveSafeTransactionPath,
} from './humanExperimentTransaction'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)
/**
 * Windows trata `\` como separador y `C:\...` como absoluta; POSIX admite ambos como
 * caracteres corrientes dentro de un nombre. Los intentos de escape se prueban en las dos
 * sintaxis, pero sólo se exige rechazo donde la sintaxis realmente designa un escape en el
 * sistema anfitrión. Así el archivo se ejecuta y pasa en cualquier plataforma.
 */
const onWindows = sep === '\\'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

async function root() {
  const directory = await mkdtemp(resolve(tmpdir(), 'wgtr-transaction-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('resolveSafeTransactionPath', () => {
  it('accepts relative paths of the host system, including nested ones', async () => {
    const base = await root()
    expect(resolveSafeTransactionPath(base, 'registry.json')).toBe(resolve(base, 'registry.json'))
    expect(resolveSafeTransactionPath(base, 'participants/P01/traces/game-1.json')).toBe(
      resolve(base, 'participants', 'P01', 'traces', 'game-1.json'),
    )
    expect(resolveSafeTransactionPath(base, '.')).toBe(resolve(base))
  })

  it('accepts a path that walks out and back without leaving the root', async () => {
    const base = await root()
    expect(resolveSafeTransactionPath(base, 'participants/../registry.json')).toBe(
      resolve(base, 'registry.json'),
    )
  })

  it('rejects escapes with POSIX syntax on every platform', async () => {
    const base = await root()
    for (const candidate of ['../escape.json', 'participants/../../escape.json', '../../..']) {
      expect(() => resolveSafeTransactionPath(base, candidate)).toThrow('Unsafe transaction path')
    }
  })

  it('rejects a POSIX absolute path on every platform', async () => {
    const base = await root()
    // `/tmp/escape.json` es absoluta en POSIX y también para `isAbsolute` de Windows,
    // donde designa la raíz de la unidad actual.
    expect(() => resolveSafeTransactionPath(base, '/tmp/escape.json')).toThrow(
      'Unsafe transaction path',
    )
  })

  it('handles Windows syntax according to the host rules', async () => {
    const base = await root()
    const windowsAbsolute = 'C:\\Windows\\escape.json'
    const windowsParent = '..\\escape.json'
    if (onWindows) {
      expect(() => resolveSafeTransactionPath(base, windowsAbsolute)).toThrow(
        'Unsafe transaction path',
      )
      expect(() => resolveSafeTransactionPath(base, windowsParent)).toThrow(
        'Unsafe transaction path',
      )
    } else {
      // En POSIX ninguna de las dos escapa: son nombres de archivo con barras invertidas.
      expect(resolveSafeTransactionPath(base, windowsAbsolute).startsWith(resolve(base))).toBe(true)
      expect(resolveSafeTransactionPath(base, windowsParent).startsWith(resolve(base))).toBe(true)
    }
  })

  it('never returns a path outside the root for any candidate', async () => {
    const base = await root()
    const candidates = [
      'registry.json',
      'participants/P01/game-1.json',
      '../escape.json',
      '..\\escape.json',
      '/tmp/escape.json',
      'C:\\Windows\\escape.json',
    ]
    for (const candidate of candidates) {
      let resolved: string | undefined
      try {
        resolved = resolveSafeTransactionPath(base, candidate)
      } catch (error) {
        expect((error as Error).message).toContain('Unsafe transaction path')
        continue
      }
      expect(isAbsolute(resolved)).toBe(true)
      expect(resolved === resolve(base) || resolved.startsWith(`${resolve(base)}${sep}`)).toBe(true)
    }
  })

  it('classifies the rejection with an explicit code', async () => {
    const base = await root()
    try {
      resolveSafeTransactionPath(base, '../escape.json')
      expect.unreachable('the unsafe path should have been rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(HumanExperimentError)
      expect((error as HumanExperimentError).code).toBe('INVALID_TRACE')
    }
  })
})

describe('human experiment transaction', () => {
  it('really publishes when executed through the operational TypeScript loader', async () => {
    const base = await root()
    const program = [
      "import('./src/experiments/humanExperimentTransaction.ts')",
      '.then(({publishHumanExperimentTransaction}) => publishHumanExperimentTransaction({',
      `root: ${JSON.stringify(base)},`,
      "candidates: {'registry.json': '{\"published\":true}\\n', 'participants/P01/traces/game-1.json': '{\"trace\":true}\\n'}",
      '}))',
    ].join('')
    await execFileAsync(process.execPath, [
      '--import',
      './scripts/run-ts-node-esm.mjs',
      '-e',
      program,
    ])

    expect(await readFile(resolve(base, 'registry.json'), 'utf8')).toBe('{"published":true}\n')
    expect(await readFile(resolve(base, 'participants/P01/traces/game-1.json'), 'utf8')).toBe(
      '{"trace":true}\n',
    )
    await expect(access(resolve(base, '.ingestion-transaction'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('publishes nested candidates and clears the transaction directory', async () => {
    const base = await root()
    await publishHumanExperimentTransaction({
      root: base,
      candidates: {
        'registry.json': '{"schema":"HumanExperimentRegistryV1"}\n',
        'participants/P01/traces/game-1.json': '{"trace":true}\n',
      },
    })
    expect(await readFile(resolve(base, 'registry.json'), 'utf8')).toContain(
      'HumanExperimentRegistryV1',
    )
    expect(
      await readFile(resolve(base, 'participants', 'P01', 'traces', 'game-1.json'), 'utf8'),
    ).toContain('"trace":true')
    await expect(access(resolve(base, '.ingestion-transaction'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses a candidate that escapes the root without touching the disk', async () => {
    const base = await root()
    await expect(
      publishHumanExperimentTransaction({
        root: base,
        candidates: { '../escape.json': '{}\n' },
      }),
    ).rejects.toThrow('Unsafe transaction path')
    await expect(access(resolve(base, '..', 'escape.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores the previous contents when publication fails midway', async () => {
    const base = await root()
    await writeFile(resolve(base, 'registry.json'), '{"original":true}\n')
    await expect(
      publishHumanExperimentTransaction({
        root: base,
        candidates: {
          'registry.json': '{"updated":true}\n',
          'participants/P01/traces/game-1.json': '{"trace":true}\n',
        },
        hooks: {
          afterPublish: (_path, index) => {
            if (index === 0) throw new Error('simulated publication failure')
          },
        },
      }),
    ).rejects.toThrow('simulated publication failure')
    expect(await readFile(resolve(base, 'registry.json'), 'utf8')).toBe('{"original":true}\n')
    await expect(
      access(resolve(base, 'participants', 'P01', 'traces', 'game-1.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies a publication failure as recoverable transaction I/O', async () => {
    const base = await root()
    try {
      await publishHumanExperimentTransaction({
        root: base,
        candidates: { 'registry.json': '{}\n' },
        hooks: {
          beforePublish: () => {
            throw new Error('simulated failure')
          },
        },
      })
      expect.unreachable('the publication should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(HumanExperimentError)
      expect((error as HumanExperimentError).code).toBe('TRANSACTION_IO_FAILURE')
      expect((error as HumanExperimentError).retry).toBe('recoverable')
      expect((error as Error).message).toBe('simulated failure')
    }
  })

  it('recovers a prepared transaction that stores POSIX separators in its manifest', async () => {
    const base = await root()
    const transaction = resolve(base, '.ingestion-transaction')
    await mkdir(resolve(transaction, 'backups'), { recursive: true })
    await writeFile(resolve(transaction, 'backups', 'registry.json'), '{"original":true}\n')
    await writeFile(resolve(base, 'registry.json'), '{"partial":true}\n')
    await mkdir(resolve(base, 'participants', 'P01', 'traces'), { recursive: true })
    await writeFile(resolve(base, 'participants', 'P01', 'traces', 'game-1.json'), '{}')
    await writeFile(
      resolve(transaction, 'manifest.json'),
      JSON.stringify({
        schema: 'HumanExperimentIngestionTransactionV1',
        state: 'prepared',
        targets: [
          { relativePath: 'registry.json', existed: true },
          { relativePath: 'participants/P01/traces/game-1.json', existed: false },
        ],
      }),
    )
    await expect(recoverHumanExperimentTransaction(base)).resolves.toBe(true)
    expect(await readFile(resolve(base, 'registry.json'), 'utf8')).toBe('{"original":true}\n')
    await expect(
      access(resolve(base, 'participants', 'P01', 'traces', 'game-1.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports nothing to recover when there is no manifest', async () => {
    const base = await root()
    await expect(recoverHumanExperimentTransaction(base)).resolves.toBe(false)
  })
})

describe('launcher recovery ordering', () => {
  async function launcher() {
    // @ts-expect-error El lanzador es JavaScript y no tiene declaración de tipos.
    return import('../../scripts/start-human-experiment.mjs')
  }

  function spy() {
    const calls: string[] = []
    const run = (_command: string, args: string[]) => {
      const joined = args.join(' ')
      if (joined.includes('rev-parse')) return `${'a'.repeat(40)}\n`
      if (joined.includes('recoverHumanExperimentTransaction')) calls.push('recover')
      else if (joined.includes('status')) calls.push('clean-worktree')
      return ''
    }
    return { calls, run }
  }

  it('recovers a pending transaction before checking that the worktree is clean', async () => {
    const { startHumanExperimentServer } = await launcher()
    const { calls, run } = spy()
    // argv vacío hace fallar la resolución de sesión después de ambos pasos, que es lo que
    // se quiere observar aquí sin llegar a arrancar Vite.
    expect(() => startHumanExperimentServer({ run, argv: [] })).toThrow('Debe indicar el contexto')
    expect(calls).toEqual(['recover', 'clean-worktree'])
  })

  it('still recovers first when the worktree turns out to be dirty', async () => {
    const { startHumanExperimentServer } = await launcher()
    const calls: string[] = []
    const run = (_command: string, args: string[]) => {
      const joined = args.join(' ')
      if (joined.includes('rev-parse')) return `${'a'.repeat(40)}\n`
      if (joined.includes('recoverHumanExperimentTransaction')) calls.push('recover')
      else if (joined.includes('status')) {
        calls.push('clean-worktree')
        return ' M data/human-experiment/final-2026-v3/registry.json\n'
      }
      return ''
    }
    expect(() => startHumanExperimentServer({ run, argv: ['diagnostic', 'R'] })).toThrow(
      'congelado',
    )
    expect(calls).toEqual(['recover', 'clean-worktree'])
  })

  it('explains what to run when the recovery step itself fails', async () => {
    const { recoverPendingIngestionTransaction } = await launcher()
    const run = () => {
      throw new Error('ts-node no disponible')
    }
    expect(() => recoverPendingIngestionTransaction(run)).toThrow(
      'human-experiment:recover-transaction',
    )
  })
})
