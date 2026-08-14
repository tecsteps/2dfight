/*
 * shot.mjs -- headless screenshot / probe harness.
 *
 * Usage: node tools/shot.mjs <path-or-url> <out.png> [--w=N] [--h=N]
 *                            [--wait=ms] [--eval=expr] [--sel=cssSelector]
 *
 * Lets the build loop actually look at what it rendered instead of guessing.
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));

const target = positional[0];
const out = positional[1] || 'shot.png';
let url;
if (/^https?:/.test(target)) {
  url = target;
} else {
  // keep any ?query when turning a relative path into a file:// URL
  const q = target.indexOf('?');
  const filePart = q < 0 ? target : target.slice(0, q);
  const query = q < 0 ? '' : target.slice(q);
  url = pathToFileURL(path.resolve(filePart)).href + query;
}

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage({
  viewport: { width: +(flags.w || 1280), height: +(flags.h || 900) },
  deviceScaleFactor: 1
});

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'load' });
if (flags.wait) await page.waitForTimeout(+flags.wait);

/* --evalfile keeps probes in a file. The inline --eval strings grew past
 * the point where shell quoting was the main source of bugs. */
const probe = flags.evalfile ? fs.readFileSync(flags.evalfile, 'utf8') : flags.eval;
if (probe) {
  try {
    const r = await page.evaluate(probe);
    console.log('EVAL: ' + JSON.stringify(r));
  } catch (e) {
    console.log('EVAL ERROR: ' + e.message);
  }
}

const el = flags.sel ? await page.$(flags.sel) : null;
await (el || page).screenshot({ path: out, fullPage: !flags.sel && !flags.h });

if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
console.log('TITLE: ' + await page.title());
console.log('WROTE: ' + out + ' (' + fs.statSync(out).size + ' bytes)');
await browser.close();
