// Writes dist/runtime.json: the Electron version Stage runs on and the official SHA-256 of its
// macOS zips. `stage` downloads that exact zip on first launch and refuses anything that does not
// hash to these values.
//
// The hashes are read from the `electron` npm package (checksums.json), which package-lock.json
// pins by integrity hash. So they are as trustworthy as the lockfile, and they are baked into the
// published tarball rather than fetched from the network at run time.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = dirname(createRequire(join(root, 'package.json')).resolve('electron/package.json'))
const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'))
const checksums = JSON.parse(readFileSync(join(electronDir, 'checksums.json'), 'utf8'))

const sha256 = {}
for (const arch of ['arm64', 'x64']) {
  const name = `electron-v${version}-darwin-${arch}.zip`
  const hash = checksums[name]
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    console.error(`write-runtime: no valid SHA-256 for ${name} in electron/checksums.json`)
    process.exit(1)
  }
  sha256[arch] = hash
}

writeFileSync(join(root, 'dist', 'runtime.json'), JSON.stringify({ electron: version, sha256 }, null, 2) + '\n')
