// End-to-end tests of updating Stage: real installs (global, npx, project), a fake npm registry and
// proxy on this Mac, and Stage windows driven over the DevTools protocol. See README.md.
//   node test/updates/run.mjs            every scenario
//   node test/updates/run.mjs cli npx    only those
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { runtimeRevision } from './fixtures.mjs'
import { Box, E, N, NODE_V, alive, check, fakeOrigin, origin, prepare, procs, proxy, proxyAt, proxyLog, results, server, sleep, srv, until, version } from './lib.mjs'

const P = (n) => `${origin}/page${n}`
const tabs = async (b) => { const s = await b.state(); return { urls: s.tabs.map((t) => t.url), active: s.tabs.findIndex((t) => t.id === s.activeTabId) } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** Stops every process that runs from the work folder, so one scenario's copies can't outlive it. */
async function sweep() {
  const left = () => procs().filter((p) => p.pid !== process.pid && p.cmd.includes(`${E}/`))
  for (const p of left()) try { process.kill(p.pid, 'SIGTERM') } catch {}
  if (await until(() => !left().length, 5000)) return
  for (const p of left()) try { process.kill(p.pid, 'SIGKILL') } catch {}
}
const S = {}

S.global = async (b = new Box('global install: button to relaunch', { weird: true })) => {
  b.global('0.4.0'); b.seed('0.5.0')
  await b.open(['--pin', '--size', '900x620', P(1), P(2), `${origin}/guard`])
  await sleep(1500)
  await b.click('button', (t) => t.url.endsWith('/guard')) // arms beforeunload
  await sleep(300)
  const before = await tabs(b), pid = b.pid(), win = await b.dump()
  check('three tabs open', before.urls.length === 3, before)
  check('button says Update', (await b.panel()).button === 'Update', await b.panel())
  check('click opens the popover', await b.offer())
  const p = await b.panel()
  check('popover offers 0.5.0', /0\.5\.0/.test(p.title) && p.go, p)
  const open = await b.dump()
  check('popover window is content protected', open.windows.some((w) => w.protected && w.visible), open.windows)
  check('page cannot see the bridge', (await b.ui('typeof window.stage', (t) => t.url.endsWith('/page1'))) === 'undefined')
  check('click Update', await b.click('#update-go'))
  const warned = await until(async () => { const q = await b.panel(); return q.go === 'Restart Anyway' && q }, 30000)
  check('stops to warn about the page with a beforeunload handler', !!warned && /“\/guard” may have unsaved changes/.test(warned.detail) && !/page1|page2/.test(warned.detail), warned ?? await b.panel())
  console.log('      warning:', warned?.detail)
  await sleep(2500)
  check('and waits', b.pid() === pid && version(b.root) === '0.4.0')
  check('the guard page never ran its handler', (await b.ui('document.title', (t) => t.url.endsWith('/guard'))) === '/guard')
  check('click Restart Anyway', await b.click('#update-go'))
  const up = await b.ready('0.5.0')
  check('0.5.0 is running', !!up)
  check('old process is gone', !alive(pid) && up?.pid !== pid)
  check('package replaced in place', version(b.root) === '0.5.0')
  await sleep(1500)
  const after = await tabs(b), now = await b.dump(), st = await b.state()
  check('same tabs and active tab, beforeunload included', same(before, after), { before, after })
  check('same window bounds', same(win.windows.map((w) => w.bounds)[0], now.windows.map((w) => w.bounds)[0]), [win.windows, now.windows])
  check('still pinned', st.bar.pinned)
  check('no Update button now', !(await b.panel()).button && st.update.current === '0.5.0', st.update)
  check('normal GUI process, none of the updater env', now.dock && now.windows.some((w) => w.visible) && !now.env.length && now.name === 'Stage', now)
  check('knows the Node that launched it', now.node === NODE_V, now.node)
  check('runs from home, not the package', now.cwd === fs.realpathSync(b.home), now.cwd)
  check('About and app version are 0.5.0', now.about && now.version === '0.5.0', now)
  check('helper exited', !!(await until(() => !b.helpers().length, 15000)), b.helpers())
  check('nothing left over', !!(await until(() => !b.leftovers().length, 8000)), b.leftovers())
  check('bin link still works', execFileSync(`${b.prefix}/bin/stage`, ['--version'], { env: b.env, encoding: 'utf8' }).trim() === '0.5.0')
  check('npm ls -g agrees', b.npm('ls', '-g', '--depth=0').includes('stage-browser@0.5.0'))
  await b.close()
  b.global('0.7.0'); check('npm can reinstall over it', version(b.root) === '0.7.0')
  b.npm('rm', '-g', 'stage-browser'); check('npm can uninstall it', !fs.existsSync(b.root) && !fs.existsSync(`${b.prefix}/bin/stage`))
}

S.npx = async (b = new Box('npx: staged copy, then staged update with a new runtime')) => {
  b.npx('0.4.0'); b.seed('0.5.0')
  await b.open(['--pin', P(1), P(2)]); await sleep(1200)
  const before = await tabs(b)
  check('can install', (await b.state()).update.canInstall, (await b.state()).update)
  await b.offer(); await b.click('#update-go')
  check('0.5.0 running', !!(await b.ready('0.5.0')))
  const staged = `${b.ud}/Updates/0.5.0`
  check('in Updates', version(staged) === '0.5.0')
  check('npx folder untouched', version(b.root) === '0.4.0')
  await sleep(1000)
  check('tabs restored', same(before, await tabs(b)), await tabs(b))
  const r = await b.run([P(3)])
  await sleep(1500)
  check('older npx launch hands its URL to the newer Stage', (await tabs(b)).urls.at(-1) === P(3) && b.json('running.json').version === '0.5.0', await tabs(b))
  check('and quietly', !/older|restart/i.test(r.out), r.out)
  srv.latest = '0.7.0'
  await b.dump('Check for Updates…')
  check('staged copy sees 0.7.0 by hand', !!(await until(async () => (await b.state()).update.available === '0.7.0')), (await b.state()).update)
  check('staged copy can install', (await b.state()).update.canInstall)
  await b.click('#update-go')
  const steps = new Set(); let pct = 0
  await until(async () => { if (b.json('running.json')?.version === '0.7.0') return true; const u = (await b.state()).update; steps.add(u.step); if (u.step === 'runtime') pct = Math.max(pct, u.percent ?? 0); return false }, 120000, 100)
  check('new runtime downloaded before quitting, with progress', steps.has('runtime') && pct > 0, [...steps, pct])
  check('0.7.0 running', !!(await b.ready('0.7.0')))
  check('on the new runtime', procs().find((p) => p.pid === b.pid())?.cmd.includes(`-r${runtimeRevision() + 1}/Stage.app`), procs().find((p) => p.pid === b.pid()))
  check('previous staged copy pruned', !!(await until(() => !fs.existsSync(staged), 8000)))
  await sleep(1000)
  check('all three tabs kept', (await tabs(b)).urls.length === 3, await tabs(b))
  check('nothing left over', !!(await until(() => !b.leftovers().length, 8000)), b.leftovers())
  await b.close()
}

S.dismiss = async (b = new Box('popover closed while it works')) => {
  srv.slow = 120
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin', P(1)]); await sleep(800)
  const pid = b.pid()
  await b.offer(); await b.click('#update-go')
  await until(async () => (await b.state()).update.status === 'working', 5000)
  await b.key('Escape', 27)
  check('Esc closes without cancelling', !!(await until(async () => { const s = await b.state(); return !s.overlay && s.update.status === 'working' }, 5000)), await b.state())
  check('ends ready', !!(await until(async () => (await b.state()).update.status === 'ready', 30000)), (await b.state()).update)
  await sleep(2500)
  check('did not restart by itself', b.pid() === pid && version(b.root) === '0.4.0' && !(await b.state()).overlay)
  check('button says Restart', /Restart/.test((await b.panel()).button), await b.panel())
  await b.offer(); await sleep(1000)
  check('opening it does not restart either', b.pid() === pid)
  await b.click('#update-go')
  check('Restart finishes it', !!(await b.ready('0.5.0')) && version(b.root) === '0.5.0')
  await b.close()
}

S.cancel = async (b = new Box('cancel')) => {
  srv.slow = 200
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  const pid = b.pid()
  await b.offer(); await b.click('#update-go')
  await until(async () => (await b.state()).update.percent > 5, 10000)
  await b.click('#update-dismiss')
  check('helper gone', !!(await until(() => !b.helpers().length, 8000)))
  const s = await b.state()
  check('idle, popover closed', s.update.status === 'idle' && !s.overlay, s)
  check('nothing changed', b.pid() === pid && version(b.root) === '0.4.0')
  check('lock and temp files gone', !b.leftovers().length, b.leftovers())
  srv.slow = 0
  await b.offer(); await b.click('#update-go')
  check('works afterwards', !!(await b.ready('0.5.0')))
  await b.close()
}

S.quitting = async (b = new Box('quit and helper death during work')) => {
  srv.slow = 200
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  await b.offer(); await b.click('#update-go')
  const h = await until(() => b.helpers()[0], 8000)
  process.kill(h.pid, 'SIGKILL')
  check('killed helper becomes an error', !!(await until(async () => (await b.state()).update.status === 'error', 8000)), (await b.state()).update)
  await b.click('#update-go')
  check('Try Again gets past the stale lock', !!(await until(async () => (await b.state()).update.percent > 0, 10000)), (await b.state()).update)
  const pid = b.pid(); process.kill(pid, 'SIGTERM')
  check('quitting cancels the helper', !!(await until(() => !alive(pid) && !b.helpers().length, 15000)))
  await sleep(1500)
  check('stays quit, unchanged', !b.pid() && version(b.root) === '0.4.0')
  check('nothing left over', !b.leftovers().length, b.leftovers())
  await b.close()
}

S.refuse = async (b = new Box('real signature check in the app', { extra: { E2E_REAL_VERIFY: '1' } })) => {
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  const pid = b.pid()
  await b.offer(); await b.click('#update-go')
  const u = await until(async () => { const x = (await b.state()).update; return x.status === 'error' && x }, 30000)
  check('unsigned build refused', !!u, (await b.state()).update)
  console.log('      message:', u?.message)
  check('nothing changed', b.pid() === pid && version(b.root) === '0.4.0')
  check('nothing left over', !!(await until(() => !b.leftovers().length, 5000)), b.leftovers())
  const r = await b.run(['update'])
  check('stage update refuses it too', r.code === 1 && version(b.root) === '0.4.0' && b.pid() === pid, r)
  await b.close()
}

S.network = async (b = new Box('network failures')) => {
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  const pid = b.pid()
  await b.offer()
  for (const [label, set] of [['HTTP 500', { status: 500 }], ['404 while the release lands', { missing: true }], ['connection cut', { cut: true }]]) {
    Object.assign(srv, { status: 200, cut: false, missing: false, latest: '0.5.0' }, set)
    await b.click('#update-go'); await sleep(250)
    const u = await until(async () => { const x = (await b.state()).update; return x.status === 'error' && x }, 25000)
    check(`${label}: clear error`, !!u?.message, u); console.log('      message:', u?.message)
    check(`${label}: unchanged`, b.pid() === pid && version(b.root) === '0.4.0' && !!(await until(() => !b.helpers().length && !b.leftovers().length, 5000)))
  }
  Object.assign(srv, { status: 200, cut: false, missing: false, latest: '0.5.0' })
  await b.click('#update-go')
  check('Try Again succeeds', !!(await b.ready('0.5.0')))
  await b.close()
}

for (const kind of ['global', 'npx'])
  S[`rollback_${kind}`] = async (b = new Box(`rollback: ${kind}`)) => {
    srv.latest = '0.6.0'
    b[kind]('0.4.0'); b.seed('0.6.0'); await b.open(['--pin', P(1), P(2)]); await sleep(1000)
    const before = await tabs(b), pid = b.pid()
    await b.offer(); await b.click('#update-go')
    check('quit for it', !!(await until(() => !alive(pid), 30000)))
    const r = await until(() => { const x = b.json('running.json'); return x?.ready && x.pid !== pid && alive(x.pid) && x }, 90000)
    check('previous version reopened', r?.version === '0.4.0', r)
    check('files restored', version(b.root) === '0.4.0' && !fs.existsSync(`${b.ud}/Updates/0.6.0`))
    await sleep(1500)
    check('tabs restored', same(before, await tabs(b)), await tabs(b))
    const u = (await b.state()).update
    check('says it could not finish', u.status === 'error' && /couldn.t finish/.test(u.message), u)
    check('nothing left over', !!(await until(() => !b.leftovers().length, 8000)), b.leftovers())
    await b.close()
  }

S.replaced = async (b = new Box('package replaced under a running Stage')) => {
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin', P(1)]); await sleep(1000)
  b.global('0.5.0')
  const r = await b.run([])
  check('terminal points to --restart', /--restart/.test(r.out), r.out); console.log('      notice:', r.out.trim())
  srv.log = []
  await b.offer(); await b.click('#update-go')
  check('button just restarts into it', !!(await b.ready('0.5.0')))
  check('without downloading', !srv.log.some((l) => l.url.endsWith('.tgz')), srv.log.map((l) => l.url))
  await b.close()
}

S.cli = async (b = new Box('stage update and --restart')) => {
  b.global('0.4.0'); await b.open(['--pin', P(1), P(2)]); await sleep(1500)
  const before = await tabs(b)
  let r = await b.run(['update'])
  check('update succeeds', r.code === 0 && /✓ Stage 0\.5\.0 is open/.test(r.out), r); console.log(r.out.replace(/^/gm, '      '))
  check('0.5.0 open', !!(await b.ready('0.5.0')) && version(b.root) === '0.5.0')
  await sleep(1200)
  check('tabs restored', same(before, await tabs(b)), await tabs(b))
  r = await b.run(['update'])
  check('second update says up to date', r.code === 0 && /up to date/.test(r.out), r)
  const pid = b.pid(); r = await b.run(['--restart'])
  check('--restart restarts the same version', r.code === 0 && b.pid() !== pid && !!(await b.ready('0.5.0')), r); console.log(r.out.replace(/^/gm, '      '))
  await sleep(1200)
  check('tabs survive --restart', same(before, await tabs(b)), await tabs(b))
  r = await b.run(['--restart', P(3)])
  check('--restart takes no URL', r.code === 1, r)
  r = await b.run(['--quit-running'])
  check('--quit-running closes it', r.code === 0 && !!(await until(() => !b.pid(), 15000)), r)
  r = await b.run(['--quit-running'])
  await sleep(2000)
  check('--quit-running with none open opens nothing', !b.pid(), r)
  r = await b.run(['--restart'])
  check('--restart with none open opens it', r.code === 0 && !!b.pid(), r)
  await b.close()
}

S.cli_closed = async (b = new Box('stage update: closed, cancelled, concurrent')) => {
  b.global('0.4.0')
  let r = await b.run(['update'])
  check('closed: updates without opening', r.code === 0 && version(b.root) === '0.5.0' && !b.pid() && /Run stage/.test(r.out), r)
  await b.close()
  const c = new Box('ctrl-C and concurrency'); c.global('0.4.0'); await c.open([]); srv.slow = 200
  const pid = c.pid(), one = c.start(['update'])
  await until(() => /Getting/.test(one.text()), 8000); await sleep(700)
  r = await c.run(['update'])
  check('second update refused', r.code === 1 && /already running/.test(r.out), r)
  one.child.kill('SIGINT'); r = await one.done
  check('ctrl-C cancels', r.code === 130 && c.pid() === pid && version(c.root) === '0.4.0' && !c.leftovers().length, [r, c.leftovers()])
  await c.close()
}

S.relative = async (b = new Box('relative STAGE_USER_DATA')) => {
  b.global('0.4.0')
  const o = { env: { STAGE_USER_DATA: fs.realpathSync(b.ud) } }
  await b.open([], { env: { STAGE_USER_DATA: 'ud' } })
  check('opens on that profile', !!b.pid())
  const r = await b.run(['update'], { env: { STAGE_USER_DATA: 'ud' } })
  check('update finds the same profile', r.code === 0 && !!(await b.ready('0.5.0')), r)
  check('no stray profile in home', !fs.existsSync(`${b.home}/ud`), o)
  await b.close()
}

S.manual = async (b = new Box('project install: command only')) => {
  b.local('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  await b.offer()
  const p = await b.panel(), u = (await b.state()).update
  check('no Update action', !u.canInstall && !p.go && p.copy, p)
  await b.ui('window.stage.installUpdate()'); await sleep(1000)
  check('install over IPC does nothing', !b.helpers().length && (await b.state()).update.status === 'idle')
  await b.click('#update-copy')
  const copied = await until(() => { try { return fs.readFileSync(`${b.ud}/e2e-clipboard`, 'utf8') } catch { return null } }, 4000)
  check('copies the command', copied === u.command && copied === 'npx stage-browser@latest --restart', copied)
  const r = await b.run(['update'])
  check('stage update prints it', r.code === 1 && r.out.includes(u.command) && version(b.root) === '0.4.0', r)
  await b.close()
  const c = new Box('global folder that needs sudo'); c.global('0.4.0'); c.seed('0.5.0')
  fs.chmodSync(`${c.prefix}/lib/node_modules`, 0o555)
  try {
    await c.open(['--pin']); await sleep(800)
    const v = (await c.state()).update
    check('sudo command to copy, no Update action', !v.canInstall && v.command === 'sudo npm i -g stage-browser@latest && stage --restart', v)
    await c.offer(); const q = await c.panel()
    check('popover shows it with Copy only', !q.go && q.copy && q.command === v.command, q)
    await c.ui('window.stage.installUpdate()'); await sleep(1000)
    check('never starts the helper itself', !c.helpers().length)
    await c.close()
    const r = await c.run(['update'])
    check('stage update prints the sudo command', r.code === 1 && r.out.includes(v.command) && version(c.root) === '0.4.0', r)
    console.log('      stage update:', r.out.trim())
    const n = await c.run([]); await c.ready()
    check('terminal notice suggests it too', n.out.includes(v.command), n.out)
  } finally { fs.chmodSync(`${c.prefix}/lib/node_modules`, 0o755); await c.close() }
}

S.guard = async (b = new Box('install needs the open popover')) => {
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin']); await sleep(800)
  await b.ui('window.stage.installUpdate()'); await b.ui('window.stage.copyUpdateCommand()'); await sleep(1000)
  check('no helper without it', !b.helpers().length)
  check('no clipboard write without it', !fs.existsSync(`${b.ud}/e2e-clipboard`))
  await b.close()
}

S.checks = async (b = new Box('checks: by hand, automatic, opt-out', { extra: { E2E_ACTIVE: '1' } })) => {
  b.global('0.4.0'); srv.log = []
  await b.open(['--pin']); await sleep(1000)
  check('no request at launch', !srv.log.length, srv.log)
  check('no button', !(await b.panel()).button)
  check('first automatic check after 30 s', !!(await until(() => srv.log.length, 45000)))
  await sleep(1000)
  check('first sighting is not announced', !(await b.panel()).button && b.json('update.json')?.latest === '0.5.0', b.json('update.json'))
  const h = srv.log[0]?.headers ?? {}
  console.log('      request headers:', JSON.stringify(h))
  check('no cookie, version or identifier', !h.cookie && h['user-agent'] === 'Stage', h)
  await b.close()
  b.seed('0.5.0', { announced: null, latestAt: Date.now() - 7200e3, attemptedAt: Date.now() - 7200e3 }); srv.log = []
  await b.open(['--pin']); await sleep(1000)
  check('second sighting shows the button', !!(await until(async () => (await b.panel()).button, 50000)))
  check('without opening anything', !(await b.state()).overlay)
  check('menu offers it', (await b.dump()).labels.includes('Update to Stage 0.5.0…'))
  await b.close()

  const c = new Box('by hand, and opt-out', { extra: { E2E_ACTIVE: '1', STAGE_NO_UPDATE_CHECK: '1' } })
  c.global('0.4.0'); srv.log = []
  await c.open(['--pin']); await sleep(36000)
  check('opt-out sends nothing', !srv.log.length, srv.log)
  await c.dump('Check for Updates…')
  check('by hand still works and announces at once', !!(await until(async () => { const s = await c.state(); return s.update.available === '0.5.0' && s.overlay?.type === 'update' }, 10000)), await c.state())
  await c.close()
}

S.engines = async (b = new Box('release that needs a newer Node')) => {
  srv.latest = '0.9.0'
  b.global('0.4.0'); b.seed('0.9.0'); await b.open(['--pin']); await sleep(800)
  const pid = b.pid()
  check('offers it', await b.offer())
  await b.click('#update-go')
  const u = await until(async () => { const x = (await b.state()).update; return x.status === 'error' && x }, 30000)
  check('refused, naming both Nodes', !!u && u.message.includes('needs Node >=99') && u.message.includes(`Node ${NODE_V.slice(1)} here`) && /Nothing changed/.test(u.message), u)
  console.log('      message:', u?.message)
  check('nothing changed', b.pid() === pid && version(b.root) === '0.4.0')
  check('nothing left over', !!(await until(() => !b.helpers().length && !b.leftovers().length, 5000)), b.leftovers())
  let r = await b.run(['update'])
  check('stage update refuses it with it open', r.code === 1 && r.out.includes('needs Node >=99') && version(b.root) === '0.4.0' && b.pid() === pid, r)
  await b.close()
  r = await b.run(['update'])
  check('and with it closed', r.code === 1 && r.out.includes('needs Node >=99') && version(b.root) === '0.4.0' && !b.pid(), r)
  console.log('      stage update:', r.out.trim())
  const c = new Box('npx copy, needs a newer Node'); c.npx('0.4.0')
  srv.latest = '0.9.0'
  r = await c.run(['update'])
  check('npx: refused, nothing staged', r.code === 1 && r.out.includes('needs Node >=99') && !fs.existsSync(`${c.ud}/Updates/0.9.0`) && !c.leftovers().length, r)
  await c.close()
}

S.handoff = async (b = new Box('two installs: an older launcher opens the newer copy', { weird: true })) => {
  b.global('0.4.0')
  const newer = b.globalAt(`${b.dir}/other prefix`, '0.5.0')
  await b.open([P(1)], { root: newer })
  const saved = b.json('newest.json')
  check('the newer copy records itself', saved?.version === '0.5.0' && saved.root === fs.realpathSync(newer), saved)
  await b.run(['--quit-running'], { root: newer }); await until(() => !b.pid(), 15000)
  let r = await b.run([P(2), '--pin'])
  check('older launcher opens the newer copy', !!(await b.ready('0.5.0')), r)
  check('and says so', /opening Stage 0\.5\.0, the newest one installed/.test(r.out), r.out); console.log('      notice:', r.out.trim())
  await sleep(1500)
  const st = await b.state()
  check('with its URL and flags', (await tabs(b)).urls.includes(P(2)) && st.bar.pinned, [await tabs(b), st.bar])
  check('no handoff marker left in the app', !(await b.dump()).env.length)
  r = await b.run([P(3)]); await sleep(2500)
  check('older launcher with it open adds the URL there', (await tabs(b)).urls.at(-1) === P(3) && b.json('running.json').version === '0.5.0', await tabs(b))
  r = await b.run(['--version'])
  check('--version stays its own', r.out.trim() === '0.4.0', r)
  check('newest.json still names the newer copy', b.json('newest.json')?.version === '0.5.0')
  await b.close()

  const n99 = b.globalAt(`${b.dir}/p99`, '0.9.0')
  fs.writeFileSync(`${b.ud}/newest.json`, JSON.stringify({ version: '0.9.0', root: fs.realpathSync(n99) }))
  r = await b.run([])
  check('a newer copy for another Node: says so and opens this one', /Stage 0\.9\.0 is installed too, but needs Node >=99/.test(r.out) && !!(await b.ready('0.4.0')), r)
  console.log('      notice:', r.out.trim())
  await b.close()

  fs.writeFileSync(`${b.ud}/newest.json`, JSON.stringify({ version: '0.5.0', root: fs.realpathSync(newer) }))
  execFileSync(`${N}/npm`, ['rm', '-g', 'stage-browser'], { env: { ...b.env, npm_config_prefix: `${b.dir}/other prefix` }, stdio: 'ignore' })
  check('newer copy uninstalled', !fs.existsSync(newer))
  r = await b.run([])
  check('a removed newer copy is ignored', !!(await b.ready('0.4.0')) && !/opening|installed too/.test(r.out), r)
  await sleep(1000)
  check('and forgotten', b.json('newest.json')?.version === '0.4.0', b.json('newest.json'))
  await b.close()

  for (const [label, bad] of [['a relative root', { version: '0.5.0', root: 'lib/node_modules/stage-browser' }], ['a version that does not match', { version: '9.0.0', root: fs.realpathSync(b.root) }], ['a prerelease', { version: '0.5.0-rc.1', root: fs.realpathSync(n99) }], ['junk', 'nope']]) {
    fs.writeFileSync(`${b.ud}/newest.json`, typeof bad === 'string' ? bad : JSON.stringify(bad))
    const o = await b.run([])
    check(`${label} in newest.json is ignored`, !!(await b.ready('0.4.0')) && !/opening|installed too/.test(o.out), o)
    await b.close()
  }
}

S.proxy = async (b = new Box('system proxy reaches the updater, not the relaunched app', { extra: { E2E_PROXY: proxyAt, E2E_REGISTRY: fakeOrigin } })) => {
  b.global('0.4.0'); proxyLog.length = 0
  await b.open(['--pin', P(1)]); await sleep(1200)
  check('pages still load direct', (await tabs(b)).urls[0] === P(1) && !proxyLog.some((l) => l.url.includes('/page')), proxyLog)
  await b.dump('Check for Updates…')
  check('the app checks through the proxy', !!(await until(() => proxyLog.some((l) => l.url.includes('dist-tags')), 10000)), proxyLog)
  await until(async () => (await b.state()).overlay?.type === 'update', 8000)
  await b.click('#update-go')
  check('0.5.0 running', !!(await b.ready('0.5.0')), (await b.state().catch(() => ({}))).update)
  check('the helper downloads through it', proxyLog.some((l) => l.url.includes(':' + new URL(fakeOrigin).port)) && proxyLog.filter((l) => l.kind === 'CONNECT' || l.url.includes('.tgz')).length > 0, proxyLog)
  console.log('      proxy saw:', JSON.stringify(proxyLog.map((l) => `${l.kind} ${l.url}`)))
  await sleep(1000)
  const d = await b.dump()
  check('relaunched app has none of the added env', !d.env.filter((k) => k !== 'E2E_PROXY').length, d.env)
  await b.close()
  // A proxy already in the environment wins, and stage update from Terminal uses it.
  const c = new Box('proxy from the environment, from Terminal', { extra: { HTTP_PROXY: `http://${proxyAt}`, E2E_REGISTRY: fakeOrigin } }); c.global('0.4.0'); proxyLog.length = 0
  const r = await c.run(['update'])
  const [maj, min] = NODE_V.slice(1).split('.').map(Number)
  if (maj >= 24 || (maj === 22 && min >= 21)) check('stage update goes through HTTP_PROXY', r.code === 0 && version(c.root) === '0.5.0' && proxyLog.length > 0, [r, proxyLog])
  else check(`Node ${NODE_V} ignores HTTP_PROXY, and stage update fails cleanly`, r.code === 1 && /Couldn’t reach npm/.test(r.out) && version(c.root) === '0.4.0' && !c.leftovers().length, [r, c.leftovers()])
  const bare = new Box('no proxy at all', { extra: { E2E_REGISTRY: fakeOrigin } }); bare.global('0.4.0')
  const f = await bare.run(['update'])
  check('without it the fake host is unreachable (the test is real)', f.code === 1 && version(bare.root) === '0.4.0', f)
  await c.close(); await bare.close()
}

S.warnings = async (b = new Box('restart warnings: a download in progress')) => {
  srv.dlMs = 15000
  const real = `${os.homedir()}/Downloads/big.bin`
  const stamp = () => { try { return fs.statSync(real).mtimeMs } catch { return null } }
  const realDl = stamp()
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin', P(1)]); await sleep(1200)
  const pid = b.pid()
  await b.ui(`location.href = '${origin}/dl'`, (t) => t.url.endsWith('/page1'))
  check('download started', !!(await until(() => { try { return fs.readdirSync(`${b.home}/Downloads`).length } catch { return 0 } }, 8000)))
  await b.offer(); await b.click('#update-go')
  const warned = await until(async () => { const q = await b.panel(); return q.go === 'Restart Anyway' && q }, 30000)
  check('warns about the download', warned?.detail === 'A download is still in progress.', warned ?? await b.panel())
  check('and only that, the page is fine', !/may have|playing/.test(warned?.detail ?? ''))
  await b.click('#update-dismiss'); await sleep(800)
  const s = await b.state()
  check('closing it keeps the update ready, unchanged', s.update.status === 'ready' && b.pid() === pid && version(b.root) === '0.4.0' && !s.overlay, s.update)
  check('button says Restart', /Restart/.test((await b.panel()).button), await b.panel())
  check('download finishes', !!(await until(() => fs.existsSync(`${b.home}/Downloads/big.bin`) && fs.statSync(`${b.home}/Downloads/big.bin`).size === 100 * 1024, 30000)))
  await sleep(500)
  await b.offer()
  const q = await b.panel()
  check('once it is done, plain Restart', q.go === 'Restart' && !/download/.test(q.detail ?? ''), q)
  await b.click('#update-go')
  check('restarts on one click', !!(await b.ready('0.5.0')))
  check('the real Downloads folder untouched', stamp() === realDl, stamp())
  await b.close()
}

S.sizes = async (b = new Box('new launcher to new app')) => {
  b.global('0.4.0'); await b.open(['--size', '900x620', P(1)]); await sleep(1200)
  const w = () => b.dump().then((d) => d.windows.map((x) => x.bounds.width))
  check('cold --size W', (await w()).includes(900), await w())
  await b.run([P(2), '--size', '830x570']); await sleep(2500)
  check('warm --size W, no extra tab', (await w()).includes(830) && same((await tabs(b)).urls, [P(1), P(2)]), [await w(), await tabs(b)])
  await b.run(['--size=860x590']); await sleep(2500)
  check('warm --size=W', (await w()).includes(860) && (await tabs(b)).urls.length === 2, [await w(), await tabs(b)])
  srv.latest = '0.3.2'
  const r = await b.run(['update'])
  check('never downgrades', r.code === 0 && /up to date/.test(r.out) && version(b.root) === '0.4.0', r)
  await b.close()
}

S.unconfirmed = async (b = new Box('new version holds the profile but never gets ready')) => {
  srv.latest = '0.8.0'
  b.global('0.4.0'); await b.open([]); await sleep(1000)
  const r = await b.run(['update'])
  check('says it did not confirm', r.code === 1 && /confirm/.test(r.out), r)
  check('moves no files under it', !!b.pid() && version(b.root) === '0.8.0', [b.pid(), version(b.root)])
  await b.close()
}

S.announced = async (b = new Box('installs the announced version, not a newer latest')) => {
  srv.latest = '0.6.0' // published since 0.5.0 was announced, so it hasn't had its hour
  b.global('0.4.0'); b.seed('0.5.0', { latest: '0.6.0' }); await b.open(['--pin', P(1)]); await sleep(1000)
  check('offers 0.5.0', (await b.state()).update.available === '0.5.0', (await b.state()).update)
  await b.offer(); await b.click('#update-go')
  check('0.5.0 running, not 0.6.0', !!(await b.ready('0.5.0')) && version(b.root) === '0.5.0', [b.json('running.json'), version(b.root)])
  check('never fetched 0.6.0', !srv.log.some((l) => l.url.includes('0.6.0.tgz')), srv.log.map((l) => l.url))
  await b.close()
}

S.pulled = async (b = new Box('announced version pulled before the click')) => {
  srv.latest = '0.4.1'
  b.global('0.4.0'); b.seed('0.5.0'); await b.open(['--pin', P(1)]); await sleep(1000)
  const pid = b.pid()
  await b.offer(); await b.click('#update-go')
  const u = await until(async () => { const x = (await b.state()).update; return x.status === 'error' && x }, 30000)
  check('refuses with a clear message', !!u && /0\.5\.0 is no longer the latest/.test(u.message), u ?? (await b.state()).update)
  check('nothing changed', b.pid() === pid && version(b.root) === '0.4.0' && !srv.log.some((l) => l.url.endsWith('.tgz')), srv.log.map((l) => l.url))
  check('helper gone', !!(await until(() => !b.helpers().length, 8000)))
  await b.close()
}

S.flags = async (b = new Box('--quit-running only first, --restart takes the lock')) => {
  b.global('0.4.0'); await b.open(['--pin', P(1)]); await sleep(1200)
  const pid = b.pid()
  let r = await b.run([P(2), '--quit-running']); await sleep(3000)
  check('a later --quit-running does not quit', b.pid() === pid, [pid, b.pid(), r])
  check('and the URL still opens', (await tabs(b)).urls.includes(P(2)), await tabs(b))
  fs.mkdirSync(`${b.ud}/Updates`, { recursive: true })
  fs.writeFileSync(`${b.ud}/Updates/.lock`, String(process.pid)) // a live process holds it
  r = await b.run(['--restart'])
  check('--restart waits its turn', r.code === 1 && /Another Stage update is already running/.test(r.out) && b.pid() === pid, r)
  fs.writeFileSync(`${b.ud}/Updates/.lock`, '999999') // a stale one is taken over
  r = await b.run(['--restart'])
  check('--restart takes a stale lock', r.code === 0 && b.pid() !== pid && !!(await b.ready('0.4.0')), r)
  check('and lets it go', !fs.existsSync(`${b.ud}/Updates/.lock`))
  await b.close()
}

const pick = process.argv.slice(2)
const unknown = pick.filter((k) => !S[k])
if (unknown.length) { console.error(`unknown scenarios: ${unknown.join(' ')}\nscenarios: ${Object.keys(S).join(' ')}`); process.exit(2) }
if (process.platform !== 'darwin') { console.error('the update tests need macOS'); process.exit(2) }
console.log(`work folder: ${E}\nstage runs on Node ${NODE_V} from ${N}`)
await prepare()
for (const [k, f] of Object.entries(S)) {
  if (pick.length && !pick.includes(k)) continue
  Object.assign(srv, { latest: '0.5.0', status: 200, slow: 0, cut: false, missing: false, log: [], dlMs: 15000 })
  try { await f() } catch (e) { check(`${k} ran to the end`, false, String(e.stack)) }
  await sweep() // a scenario that throws skips its own close()
}
const bad = results.filter((r) => !r.ok)
console.log(`\nE2E ${results.length - bad.length}/${results.length}`)
for (const r of bad) console.log(' failed:', r.name)
server.close(); proxy.close()
if (bad.length) console.log(`work folder kept: ${E}`)
else { await sleep(1000); fs.rmSync(E, { recursive: true, force: true }) }
process.exit(bad.length ? 1 : 0)
