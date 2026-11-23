import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildFixtures, runtimeRevision } from './fixtures.mjs'

/** Everything a run makes lives here: fixtures, profiles, homes, npm prefixes and caches. */
export const E = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-updates-')))
/** The folder of the Node that runs `stage`, as the person's own Node would. */
export const N = process.env.E2E_NODE ?? path.dirname(process.execPath)
export const NODE_V = execFileSync(`${N}/node`, ['-v'], { encoding: 'utf8' }).trim()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const results = []
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 1500)}`)
}
export async function until(fn, ms = 20000, every = 150) {
  const end = Date.now() + ms; let last
  for (;;) {
    try { last = await fn(); if (last) return last } catch { last = undefined }
    if (Date.now() > end) return null
    await sleep(every)
  }
}

const RUNTIMES = `${E}/rt/home/Library/Application Support/Stage/Runtime`
let runtime = null

/** Builds the fixtures, downloads the runtime once for every test to copy, and fetches a real signature. */
export async function prepare() {
  const env = { HOME: `${E}/rt/home`, PATH: `${N}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR, npm_config_cache: `${E}/npm-cache`, npm_config_update_notifier: 'false' }
  fs.mkdirSync(env.HOME, { recursive: true })
  console.log('building fixtures')
  buildFixtures(E, `${N}/npm`)
  console.log('downloading the runtime')
  execFileSync(`${N}/node`, [`${E}/fix/0.4.0/dist/bin/stage.js`, '--prepare-runtime'], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  runtime = fs.readdirSync(RUNTIMES).find((n) => n.endsWith(`-r${runtimeRevision()}`))
  if (!runtime) throw new Error(`no runtime in ${RUNTIMES}`)
  // A real release's signature, which the fixtures don't match, for the test that turns checking back on.
  console.log('fetching a signature')
  fs.mkdirSync(`${E}/signature`)
  const res = await fetch('https://registry.npmjs.org/-/npm/v1/attestations/stage-browser@0.3.2')
  if (!res.ok) throw new Error(`attestations for 0.3.2: HTTP ${res.status}`)
  fs.writeFileSync(`${E}/signature/0.3.2.json`, Buffer.from(await res.arrayBuffer()))
}

export const srv = { latest: '0.5.0', status: 200, slow: 0, log: [], cut: false, missing: false, dlMs: 15000 }
const pages = (u) => `<!doctype html><title>${u}</title><body style="height:2000px">${u}<button>hi</button>${u === '/guard' ? "<script>onbeforeunload=e=>{e.preventDefault();return 'x'}</script>" : ''}`
export const server = http.createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0])
  if (u.startsWith('/page') || u === '/guard') return res.writeHead(200, { 'content-type': 'text/html' }).end(pages(u))
  if (u === '/dl') { // a download that takes srv.dlMs
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': 100 * 1024 })
    for (let i = 0; i < 100 && !res.destroyed; i++) { res.write(Buffer.alloc(1024)); await sleep(srv.dlMs / 100) }
    return res.end()
  }
  srv.log.push({ url: u, headers: req.headers })
  if (srv.status !== 200) return res.writeHead(srv.status).end()
  if (u === '/-/package/stage-browser/dist-tags') return res.end(JSON.stringify({ latest: srv.latest }))
  if (u.startsWith('/-/npm/v1/attestations/')) return res.end(fs.readFileSync(`${E}/signature/0.3.2.json`))
  const v = /^\/stage-browser\/-\/stage-browser-(\d+\.\d+\.\d+)\.tgz$/.exec(u)?.[1]
  const file = `${E}/fix/stage-browser-${v}.tgz`
  if (!v || srv.missing || !fs.existsSync(file)) return res.writeHead(404).end()
  const body = fs.readFileSync(file)
  res.writeHead(200, { 'content-length': body.length })
  for (let i = 0; i < body.length; i += 60000) {
    if (res.destroyed) return
    if (srv.cut && i > 200000) return res.destroy()
    res.write(body.subarray(i, i + 60000))
    if (srv.slow) await sleep(srv.slow)
  }
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
export const origin = `http://127.0.0.1:${server.address().port}`
export const FAKE_HOST = 'registry.stage-e2e.test' // only reachable through the proxy below
export const fakeOrigin = `http://${FAKE_HOST}:${server.address().port}`

// A forward proxy that reaches only the test server, so anything that skips it fails.
export const proxyLog = []
const target = (host) => (host === FAKE_HOST || host === '127.0.0.1' ? '127.0.0.1' : null)
export const proxy = http.createServer((req, res) => {
  let u; try { u = new URL(req.url) } catch { return res.writeHead(400).end() }
  proxyLog.push({ kind: 'GET', url: req.url })
  const to = target(u.hostname); if (!to) return res.writeHead(502).end()
  const up = http.request({ host: to, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  up.on('error', () => res.destroy()); req.pipe(up)
})
proxy.on('connect', (req, sock, head) => {
  proxyLog.push({ kind: 'CONNECT', url: req.url })
  const [host, p] = req.url.split(':'); const to = target(host)
  if (!to) return sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  const up = net.connect(+p, to, () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up) })
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
export const proxyAt = `127.0.0.1:${proxy.address().port}`

export const procs = () => execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 1 << 25 }).split('\n').map((l) => /^\s*(\d+) (.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], cmd: m[2] }))
export const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
export const version = (root) => { try { return JSON.parse(fs.readFileSync(`${root}/package.json`)).version } catch { return null } }

let port = 41700, seq = 0
export class Box {
  constructor(label, { weird = false, extra = {} } = {}) {
    this.dir = fs.mkdtempSync(`${E}/r${++seq}-`)
    this.name = label
    this.home = `${this.dir}/${weird ? 'hö me' : 'home'}`
    this.ud = `${this.dir}/ud`
    this.prefix = `${this.dir}/${weird ? 'pré fix' : 'prefix'}`
    this.port = ++port
    fs.mkdirSync(`${this.home}/Library/Application Support/Stage/Runtime`, { recursive: true })
    fs.mkdirSync(this.ud)
    this.runtimes = `${this.home}/Library/Application Support/Stage/Runtime`
    execFileSync('/bin/cp', ['-Rc', `${RUNTIMES}/${runtime}`, `${this.runtimes}/${runtime}`])
    this.env = { HOME: this.home, PATH: `${N}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', STAGE_USER_DATA: this.ud, E2E_REGISTRY: origin, E2E_PORT: String(this.port),
      npm_config_cache: `${this.dir}/cache`, npm_config_prefix: this.prefix, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', ...extra }
    console.log(`\n## ${label}  (${path.basename(this.dir)})`)
  }
  npm(...args) { return execFileSync(`${N}/npm`, args, { env: this.env, cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  global(v) { this.npm('i', '-g', `${E}/fix/stage-browser-${v}.tgz`); return (this.root = `${this.prefix}/lib/node_modules/stage-browser`) }
  /** Another global install, as a second Node version would have, leaving this.root alone. */
  globalAt(prefix, v) {
    execFileSync(`${N}/npm`, ['i', '-g', `${E}/fix/stage-browser-${v}.tgz`], { env: { ...this.env, npm_config_prefix: prefix }, cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    return `${prefix}/lib/node_modules/stage-browser`
  }
  npx(v) {
    this.npm('exec', '--yes', `--package=${E}/fix/stage-browser-${v}.tgz`, '--', 'stage', '--version')
    const base = `${this.dir}/cache/_npx`
    return (this.root = `${base}/${fs.readdirSync(base)[0]}/node_modules/stage-browser`)
  }
  local(v) {
    fs.mkdirSync(`${this.dir}/proj`); fs.writeFileSync(`${this.dir}/proj/package.json`, '{"name":"p","version":"1.0.0"}')
    this.npm('i', '--prefix', `${this.dir}/proj`, `${E}/fix/stage-browser-${v}.tgz`)
    return (this.root = `${this.dir}/proj/node_modules/stage-browser`)
  }
  start(args = [], { root = this.root, env = {}, cwd = this.dir } = {}) {
    const child = spawn(`${N}/node`, [`${root}/dist/bin/stage.js`, ...args], { env: { ...this.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d))
    const done = new Promise((r) => child.on('exit', (code, signal) => setTimeout(() => r({ code, signal, out }), 120)))
    return { child, done, text: () => out }
  }
  run(args, o) { return this.start(args, o).done }
  seed(v, more = {}) { fs.writeFileSync(`${this.ud}/update.json`, JSON.stringify({ latest: v, latestAt: Date.now(), announced: v, attemptedAt: Date.now(), attemptFailed: false, ...more })) }
  json(f) { try { return JSON.parse(fs.readFileSync(`${this.ud}/${f}`, 'utf8')) } catch { return null } }
  pid() { try { const p = +/-(\d+)$/.exec(fs.readlinkSync(`${this.ud}/SingletonLock`))[1]; return alive(p) ? p : null } catch { return null } }
  async open(args = [], o) {
    const r = await this.run(args, o)
    const up = await this.ready()
    if (!up) console.log('  launch output:', r.out, '\n  crash log:', fs.existsSync(`${this.ud}/e2e-crash.log`) ? fs.readFileSync(`${this.ud}/e2e-crash.log`, 'utf8') : 'none')
    return r
  }
  ready(v) { return until(() => { const r = this.json('running.json'); return r?.ready && alive(r.pid) && (!v || r.version === v) ? r : null }, 40000) }
  targets() { return fetch(`http://127.0.0.1:${this.port}/json/list`).then((r) => r.json()) }
  async cdp(match, calls) {
    const t = await until(async () => (await this.targets()).find(match), 15000)
    if (!t) throw new Error(`${this.name}: no devtools target`)
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
    let id = 0; const wait = new Map()
    ws.onmessage = (m) => { const d = JSON.parse(m.data); wait.get(d.id)?.(d) }
    ws.onclose = () => wait.forEach((r) => r({}))
    const send = (method, params = {}) => new Promise((r) => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
    try { return await calls(send) } finally { ws.close() }
  }
  ui(expr, match = (t) => t.url.endsWith('/dist/ui/index.html')) {
    return this.cdp(match, async (send) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result?.result?.value)
  }
  state() { return this.ui('window.stage.getState()') }
  panel() { return this.ui(`(()=>{const $=(i)=>{const e=document.getElementById(i);return e&&e.getClientRects().length?e.textContent.trim():null};return {button:document.getElementById('update-btn').hidden?null:document.getElementById('update-label').textContent,title:$('update-title'),detail:$('update-detail'),command:$('update-command'),copy:$('update-copy'),dismiss:$('update-dismiss'),go:$('update-go')}})()`) }
  async click(sel, match = (t) => t.url.endsWith('/dist/ui/index.html')) {
    return this.cdp(match, async (send) => {
      const at = await until(async () => {
        const get = async () => (await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.hidden)return null;const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const h=document.elementFromPoint(x,y);return r.width&&h&&(h===e||e.contains(h))?{x,y}:null})()` })).result?.result?.value
        const a = await get(); if (!a) return null
        await sleep(120); const b = await get()
        return b && a.x === b.x && a.y === b.y ? b : null
      }, 8000)
      if (!at) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        const sent = send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 })
        await Promise.race([sent, sleep(1500)]) // the target may quit on it
      }
      return true
    })
  }
  async key(key, code) {
    return this.cdp((t) => t.url.endsWith('/dist/ui/index.html'), async (send) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code }) })
  }
  async offer() { if (!(await this.click('#update-btn'))) return false; return !!(await until(async () => (await this.state()).overlay?.type === 'update' && (await this.panel()).title, 5000)) }
  async dump(click) {
    const pid = this.pid(); if (!pid) return null
    fs.rmSync(`${this.ud}/e2e-dump.json`, { force: true })
    if (click) fs.writeFileSync(`${this.ud}/e2e-click`, click)
    process.kill(pid, 'SIGUSR2')
    return until(() => this.json('e2e-dump.json'), 8000)
  }
  helpers() { return procs().filter((p) => p.cmd.includes('/dist/update/helper.js') && p.cmd.includes(this.ud)) }
  leftovers() {
    const ls = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
    return [...ls(`${this.ud}/Updates`).filter((n) => n.startsWith('.tmp-') || n === '.lock'), ...ls(`${this.prefix}/lib/node_modules`).filter((n) => n.startsWith('.stage-browser-'))]
  }
  async close() {
    const mine = () => procs().filter((p) => p.pid !== process.pid && p.cmd.includes(`${this.dir}/`))
    const pid = this.pid()
    for (const p of mine()) try { process.kill(p.pid, 'SIGTERM') } catch {}
    if (pid && mine().some((p) => p.pid === pid)) await until(() => !alive(pid), 5000)
    await sleep(300)
    for (const p of mine()) try { process.kill(p.pid, 'SIGKILL') } catch {}
  }
}
