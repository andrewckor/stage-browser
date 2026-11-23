// Run by the release workflow before publishing. Copies of Stage check that an update was signed by
// one of the release workflows they know (SIGNERS in src/update/verify.ts), so a release signed by
// any other one, after a repository move or a workflow rename, would reach no one. This stops it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MEMBER = 'package/dist/update/verify.js'

/** @param {string} message */
const fail = (message) => {
  console.error(`check-signer: ${message}`)
  process.exit(1)
}

const ref = process.env.GITHUB_WORKFLOW_REF
if (!ref) fail('GITHUB_WORKFLOW_REF is not set; run this in the release workflow.')
const identity = `https://github.com/${ref}`

/**
 * The SIGNERS list in a built verify.js, read as text: the array literal tsc emits, and only the
 * strings inside it, so a mention anywhere else in the file doesn't count.
 * @param {string} source
 */
function signersIn(source) {
  const list = /^exports\.SIGNERS = \[([^\]]*)\];$/m.exec(source)?.[1]
  if (list === undefined) return null
  return [...list.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map((m) => m[1] ?? m[2])
}

const require = createRequire(import.meta.url)
const { SIGNERS } = /** @type {{ SIGNERS: readonly string[] }} */ (require('../dist/update/verify.js'))
// The reader has to agree with this build, or it can't be trusted on the published one either.
if (JSON.stringify(signersIn(readFileSync(new URL('../dist/update/verify.js', import.meta.url), 'utf8'))) !== JSON.stringify(SIGNERS)) {
  fail('could not read SIGNERS from dist/update/verify.js as text; update signersIn() for the new build output.')
}
if (!SIGNERS.includes(identity)) fail(`SIGNERS in src/update/verify.ts doesn't include ${identity}, so the next release couldn't update this one.`)

// The version people have now decides whether they can take this one. Its code is only read, never run.
const dir = mkdtempSync(join(tmpdir(), 'stage-latest-'))
const npm = (/** @type {string[]} */ args) => execFileSync('npm', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const tarball = npm(['pack', 'stage-browser@latest', '--pack-destination', dir, '--ignore-scripts', '--silent']).trim().split('\n').pop() ?? ''
const listing = execFileSync('tar', ['-tzf', join(dir, tarball)], { encoding: 'utf8' }).split('\n')
if (!listing.includes(MEMBER)) {
  console.log('check-signer: the version on npm has no updater, so any signer will do.')
  process.exit(0)
}
execFileSync('tar', ['-xzf', join(dir, tarball), '-C', dir, MEMBER])
const published = signersIn(readFileSync(join(dir, MEMBER), 'utf8'))
if (!published) fail(`could not find SIGNERS in stage-browser@latest's ${MEMBER}.`)
if (!published.includes(identity)) {
  fail(`stage-browser@latest doesn't accept ${identity}. Publish a version that accepts it from the old workflow first.`)
}
console.log(`check-signer: ${identity} is accepted by this build and by stage-browser@latest.`)
