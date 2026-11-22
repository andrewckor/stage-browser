#!/usr/bin/env node
// Screenshots the UI in mock mode with headless Google Chrome, then runs the in-page self-checks.
// Usage: node scripts/ui-preview.mts [--only=scene[,scene]]  (scene:left / scene:right previews the sidebar layout) [--size=1280x800] [--no-selfcheck]
// Output: selftest-out/ui-preview/<scene>-<theme>-<backdrop>-<WxH>.png
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

interface Job {
  scene: string
  layout: string
  theme: string
  backdrop: string
  size: string
}

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'selftest-out', 'ui-preview')
const PAGE = pathToFileURL(join(ROOT, 'dist', 'ui', 'index.html')).href

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const SCENES = (arg('only') ?? 'bar,omnibox,omnibox-edit,many,loading,pinned,single,newtab,bar:left,bar:right,many:left,pinned:right,omnibox:left,update-available,update-available:left,update,update:left,update:right,update-manual,update-manual:left,update-working,update-ready,update-ready-warned,update-restarting,update-checking,update-current,update-error,update-error:right,update-error-check').split(',')
const SIZES = (arg('size') ?? '1280x800,640x400').split(',')
const THEMES = ['dark', 'light']
const BACKDROPS = ['light', 'dark']
const SELFCHECKS: readonly [suite: string, scene: string, size: string][] = [
  ['main', 'bar', '1280,800'],
  ['many', 'many', '1280,800'],
  ['many', 'many', '640,400'],
  ['update', 'bar', '1280,800'],
  ['update', 'bar', '640,400'],
]

function chrome(args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'stage-ui-preview-'))
  const full = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${dir}`, '--force-device-scale-factor=2', ...args]
  return new Promise((resolve, reject) => {
    execFile(CHROME, full, { timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout) => {
      rmSync(dir, { recursive: true, force: true })
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
    }),
  )
}

const unescape = (s: string) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

async function main(): Promise<void> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME=...)`)
  mkdirSync(OUT, { recursive: true })
  const jobs: Job[] = SCENES.flatMap((name) => {
    const [scene = '', layout = 'top'] = name.split(':')
    return THEMES.flatMap((theme) => BACKDROPS.flatMap((backdrop) => SIZES.map((size) => ({ scene, layout, theme, backdrop, size }))))
  })

  await pool(jobs, 4, async (j) => {
    const file = join(OUT, `${j.scene}${j.layout === 'top' ? '' : `-${j.layout}`}-${j.theme}-${j.backdrop}-${j.size}.png`)
    const url = `${PAGE}?scene=${j.scene}&layout=${j.layout}&theme=${j.theme}&backdrop=${j.backdrop}&anim=0`
    await chrome([`--screenshot=${file}`, `--window-size=${j.size.replace('x', ',')}`, '--virtual-time-budget=2500', url])
    process.stdout.write('.')
  })
  console.log(`\n${jobs.length} screenshots in ${relative(process.cwd(), OUT)}`)

  if (process.argv.includes('--no-selfcheck')) return
  let failed = false
  for (const [suite, scene, size] of SELFCHECKS) {
    const url = `${PAGE}?scene=${scene}&theme=dark&backdrop=light&selfcheck=${suite}`
    const stdout = await chrome(['--dump-dom', `--window-size=${size}`, '--virtual-time-budget=20000', url])
    const m = /<pre id="selfcheck"[^>]*>([\s\S]*?)<\/pre>/.exec(stdout)
    const text = m?.[1] ? unescape(m[1]) : 'SELFCHECK FAIL (no result in DOM)'
    console.log(`\n[selfcheck ${suite} @${size}]\n${text}`)
    if (!/SELFCHECK PASS/.test(text)) failed = true
  }
  if (failed) process.exitCode = 1
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
