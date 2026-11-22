import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { NAME, launcherOf, updatesDir } from './common'

// How this copy of Stage was installed decides how it can update itself:
// - npx, staged: a verified copy goes into <userData>/Updates/<version> and Stage starts from there.
// - global: the verified copy replaces that exact npm global package.
// - system: an npm global package only an administrator can change, such as one in /usr/local from
//   the nodejs.org installer. Stage hands over a sudo command and never asks for a password itself.
// - manual: another package manager or a project owns the folder, so Stage only hands over a command.
// - dev: a source checkout, which never updates itself.
export type InstallKind = 'dev' | 'npx' | 'staged' | 'global' | 'system' | 'manual'

export interface Install {
  kind: InstallKind
  root: string
  /** Updates this install by hand, then restarts. Built from constants only. */
  command: string
  /** What the terminal notice suggests for a newer version. */
  updateHint: string
  /** What the terminal notice suggests when an older Stage is still open. */
  restartHint: string
}

const NPX = `npx ${NAME}@latest --restart`

const GLOBAL_MANAGERS: readonly (readonly [folder: string, command: string])[] = [
  ['/.volta/', `volta install ${NAME}@latest`],
  ['/pnpm/global/', `pnpm add -g ${NAME}@latest`],
  ['/.bun/install/global/', `bun add -g ${NAME}@latest`],
]

const real = (file: string): string | null => {
  try {
    return realpathSync(file)
  } catch {
    return null
  }
}

const writable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Kinds that replace their own files when updating. */
export const canUpdateItself = (kind: InstallKind): boolean => kind === 'global' || kind === 'npx' || kind === 'staged'

export function detectInstall(appRoot: string, userData: string): Install {
  const root = real(appRoot) ?? appRoot
  const parent = dirname(root)
  const make = (kind: InstallKind, command = NPX, updateHint = command, restartHint = NPX): Install => ({ kind, root, command, updateHint, restartHint })

  if (parent === real(updatesDir(userData))) return make('staged')
  if (existsSync(join(root, 'node_modules', 'electron', 'package.json')) || !root.includes(`${sep}node_modules${sep}`))
    return make('dev', 'git pull && npm ci && npm run build && npm start', '', 'stage --restart')

  for (const [folder, add] of GLOBAL_MANAGERS) {
    if (root.includes(folder)) return make('manual', `${add} && stage --restart`, undefined, 'stage --restart')
  }

  const grandparent = dirname(parent)
  if (basename(root) !== NAME || basename(parent) !== 'node_modules') return make('manual')
  if (basename(dirname(grandparent)) === '_npx' && /^[0-9a-f]+$/.test(basename(grandparent))) return make('npx')

  if (basename(grandparent) === 'lib' && real(join(dirname(grandparent), 'bin', 'stage')) === launcherOf(root)) {
    if (writable(parent) && writable(root)) return make('global', `npm i -g ${NAME}@latest && stage --restart`, 'stage update', 'stage --restart')
    const command = `sudo npm i -g ${NAME}@latest && stage --restart`
    return make('system', command, command, 'stage --restart')
  }
  return make('manual')
}
