import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const extensionlessPattern = /^\.{1,2}\//

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = pathToFileURL(path.join(root, 'src', specifier.slice(2))).href
    return nextResolve(`${target}.ts`, context)
  }

  if (extensionlessPattern.test(specifier) && !path.extname(specifier)) {
    return nextResolve(`${specifier}.ts`, context)
  }

  return nextResolve(specifier, context)
}
