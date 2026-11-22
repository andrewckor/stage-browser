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

// The updater installs the signed tarball as it is, so everything that runs must be inside it.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const loose = Object.keys(pkg.dependencies ?? {}).filter((name) => !pkg.bundleDependencies?.includes(name))
if (loose.length) {
  console.error(`write-runtime: add ${loose.join(', ')} to bundleDependencies in package.json`)
  process.exit(1)
}

// npm holds bundled packages to their own `engines` on an upgrade, but not on a first install.
// Sigstore names only recent Node patch releases, so on an older Node 22 or 24 the next upgrade
// would warn thirty times, or fail with engine-strict. The bundle ships as one package with one
// range, Stage's own, so this drops that one metadata field in node_modules before npm packs it.
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
for (const [dir, entry] of Object.entries(lock.packages)) {
  if (!dir || entry.dev) continue
  const file = join(root, dir, 'package.json')
  const { engines, ...meta } = JSON.parse(readFileSync(file, 'utf8'))
  if (engines) writeFileSync(file, JSON.stringify(meta, null, 2) + '\n')
}

writeFileSync(join(root, 'dist', 'runtime.json'), JSON.stringify({ electron: version, sha256 }, null, 2) + '\n')
