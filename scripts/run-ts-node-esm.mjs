process.env.TS_NODE_TRANSPILE_ONLY = 'true'
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'ESNext',
  moduleResolution: 'bundler',
})

const { register } = await import('node:module')
const { pathToFileURL } = await import('node:url')

register('ts-node/esm', pathToFileURL('./'))
register('./scripts/ts-node-path-alias-loader.mjs', pathToFileURL('./'))
