#!/usr/bin/env node
/* Screenshots the UI in mock mode with headless Google Chrome.
   Usage: node scripts/ui-preview.js [--only=scene[,scene]] [--size=1280x800]
   Output: selftest-out/ui-preview/<scene>-<theme>-<backdrop>-<WxH>.png
   Also runs the in-page self-checks (src/ui/mock.js) unless --no-selfcheck. */
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'selftest-out', 'ui-preview');
const PAGE = pathToFileURL(path.join(ROOT, 'src', 'ui', 'index.html')).href;

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];
const SCENES = (arg('only') || 'bar,omnibox,omnibox-edit,many,loading,pinned,single,newtab').split(',');
const SIZES = (arg('size') || '1280x800,640x400').split(',');
const THEMES = ['dark', 'light'];
const BACKDROPS = ['light', 'dark'];

function chrome(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ui-preview-'));
  const full = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${dir}`, '--force-device-scale-factor=2', ...args];
  return new Promise((resolve, reject) => {
    execFile(CHROME, full, { timeout: 60000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

async function pool(items, n, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME=...)`);
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [];
  for (const scene of SCENES) for (const theme of THEMES) for (const backdrop of BACKDROPS) for (const size of SIZES) jobs.push({ scene, theme, backdrop, size });

  await pool(jobs, 4, async (j) => {
    const file = path.join(OUT, `${j.scene}-${j.theme}-${j.backdrop}-${j.size}.png`);
    const url = `${PAGE}?scene=${j.scene}&theme=${j.theme}&backdrop=${j.backdrop}&anim=0`;
    await chrome([`--screenshot=${file}`, `--window-size=${j.size.replace('x', ',')}`, '--virtual-time-budget=2500', url]);
    process.stdout.write('.');
  });
  console.log(`\n${jobs.length} screenshots in ${path.relative(process.cwd(), OUT)}`);

  if (process.argv.includes('--no-selfcheck')) return;
  let failed = false;
  for (const [suite, scene, size] of [['main', 'bar', '1280,800'], ['many', 'many', '1280,800'], ['many', 'many', '640,400']]) {
    const url = `${PAGE}?scene=${scene}&theme=dark&backdrop=light&selfcheck=${suite}`;
    const { stdout } = await chrome(['--dump-dom', `--window-size=${size}`, '--virtual-time-budget=20000', url]);
    const m = stdout.match(/<pre id="selfcheck"[^>]*>([\s\S]*?)<\/pre>/);
    const text = m ? m[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') : 'SELFCHECK FAIL (no result in DOM)';
    console.log(`\n[selfcheck ${suite} @${size}]\n${text}`);
    if (!/SELFCHECK PASS/.test(text)) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
