import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAME, UpdateError, launcherOf, readObject } from './common'
import { satisfiesNode } from './version'

/** Only ordinary files and folders: nothing in a package may point outside it. */
function assertPlainFiles(dir: string): void {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name)
    const stat = lstatSync(entry)
    if (stat.isDirectory()) assertPlainFiles(entry)
    else if (!stat.isFile() || stat.nlink > 1) throw new UpdateError('The update contains a file type Stage doesn’t install. Nothing changed.')
  }
}

/**
 * Unpacks an already verified tarball into the empty folder `dest`. Its dependencies are bundled, so
 * the signature covers every file that will run and no package manager or install script is involved.
 */
export function unpack(tarball: Buffer, file: string, dest: string, version: string): void {
  try {
    writeFileSync(file, tarball, { flag: 'wx', mode: 0o600 })
    execFileSync('/usr/bin/tar', ['-xzf', file, '-C', dest, '--strip-components', '1', '--no-same-owner'], { stdio: 'ignore', timeout: 60_000 })
  } catch (e) {
    throw new UpdateError('Couldn’t unpack the update. Nothing changed.', { cause: e })
  }
  assertPlainFiles(dest)

  const pkg = readObject(join(dest, 'package.json'))
  if (pkg.name !== NAME || pkg.version !== version || !existsSync(launcherOf(dest))) throw new UpdateError('The update isn’t the package Stage asked for. Nothing changed.')
  for (const dependency of Object.keys((pkg.dependencies as object | undefined) ?? {})) {
    if (!existsSync(join(dest, 'node_modules', dependency, 'package.json'))) throw new UpdateError('This release can’t install itself. Update from Terminal instead.')
  }
  chmodSync(dest, 0o755)
  chmodSync(launcherOf(dest), 0o755)
}

/** The `engines.node` range of the package in `root`: undefined when it has none, null when unreadable. */
export function nodeRange(root: string): string | null | undefined {
  const { engines } = readObject(join(root, 'package.json'))
  if (engines === undefined) return undefined
  const range = (engines as { node?: unknown } | null)?.node
  if (range === undefined && engines && typeof engines === 'object') return undefined
  return typeof range === 'string' ? range : null
}

/** Whether `node` can run the package in `root`, going by its `engines.node`. */
export function runsOn(root: string, node: string | null): boolean {
  const range = nodeRange(root)
  return range === undefined || (!!node && typeof range === 'string' && satisfiesNode(node, range))
}

/** Stops an update whose `stage` command wouldn't start on the Node that runs it here. */
export function assertRunsOn(root: string, version: string, node: string | null): void {
  if (runsOn(root, node)) return
  const range = nodeRange(root)
  throw new UpdateError(
    node && range
      ? `Stage ${version} needs Node ${range}, and stage runs on Node ${node.slice(1)} here. Update Node, then update Stage from Terminal. Nothing changed.`
      : `Stage couldn’t tell whether Stage ${version} runs on your Node. Update it from Terminal instead. Nothing changed.`,
  )
}
