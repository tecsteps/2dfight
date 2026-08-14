/*
 * grab.mjs -- pull images off a page so they can actually be looked at.
 *
 * WebFetch flattens a page to text, which is useless for animation
 * reference. Playwright can render the real thing, so we screenshot each
 * image element to a PNG on disk and read those instead.
 *
 * Animated GIFs are the interesting case: a single screenshot catches one
 * frame, so --gif re-shoots the same element on a timer to walk through the
 * animation. That turns a looping reference clip into a contact sheet.
 *
 * Usage:
 *   node tools/grab.mjs <url> <outdir> [--min=200] [--max=40]
 *   node tools/grab.mjs <url> <outdir> --gif=<index> --frames=12 --every=140
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const pos = args.filter(a => !a.startsWith('--'));
const flag = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
}));

const url = pos[0];
const outdir = pos[1] || 'grab';
fs.mkdirSync(outdir, { recursive: true });

const minW = +(flag.min || 200);
const maxN = +(flag.max || 40);

/* Outbound HTTPS in this environment goes through a local policy proxy, and
 * Chromium will not pick that up on its own. The proxy re-terminates TLS, so
 * the CA it presents has already been added to the browser trust store by
 * the environment -- we only have to point at the tunnel. */
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium',
  proxy: proxy ? { server: proxy } : undefined,
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// substack and friends lazy-load; crawl the page so everything decodes
for (let i = 0; i < 30; i++) {
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(180);
}
await page.waitForTimeout(1200);

const imgs = await page.$$('img');
const meta = [];
let n = 0;

for (let i = 0; i < imgs.length && n < maxN; i++) {
  const el = imgs[i];
  const box = await el.boundingBox();
  if (!box || box.width < minW) continue;
  const info = await el.evaluate(e => ({
    src: e.currentSrc || e.src, alt: e.alt || '',
    w: e.naturalWidth, h: e.naturalHeight
  }));
  if (!info.src) continue;

  try {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    const file = path.join(outdir, String(n).padStart(2, '0') + '.png');
    await el.screenshot({ path: file });
    meta.push({ i: n, file, ...info });
    n++;
  } catch (e) { /* offscreen or detached; skip */ }
}

/* Walk an animated GIF by re-shooting the same element over time. */
if (flag.gif !== undefined) {
  const idx = +flag.gif;
  const frames = +(flag.frames || 12);
  const every = +(flag.every || 140);
  const target = imgs[meta[idx] ? imgs.indexOf(imgs[idx]) : idx];
  const el = (await page.$$('img'))[meta[idx] ? metaIndexToDom(meta, idx) : idx];
  const use = el || target;
  await use.scrollIntoViewIfNeeded();
  const dir = path.join(outdir, 'gif' + idx);
  fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < frames; f++) {
    await use.screenshot({ path: path.join(dir, String(f).padStart(2, '0') + '.png') });
    await page.waitForTimeout(every);
  }
  console.log('gif frames -> ' + dir);
}

function metaIndexToDom(meta, idx) { return idx; }

fs.writeFileSync(path.join(outdir, 'index.json'), JSON.stringify(meta, null, 1));
console.log(meta.map(m => `${m.i}  ${m.w}x${m.h}  ${m.file}  ${m.alt.slice(0, 70)}`).join('\n'));
console.log('\n' + meta.length + ' images -> ' + outdir);
await browser.close();
