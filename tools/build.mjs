/*
 * build.mjs -- inline everything into one self-contained page.
 *
 * The artifact host wraps the file in its own doctype/head/body and blocks
 * every external request, so the output here is a fragment: a <title>, a
 * <style>, the markup, and every source file concatenated into one <script>.
 * No modules, no fetches, nothing to load at runtime.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SOURCES = [
  'src/engine/gfx.js',
  'src/engine/raster.js',
  'src/engine/font.js',
  'src/engine/audio.js',
  'src/engine/figure.js',
  'src/game/seq.js',
  'src/game/level.js',
  'src/game/char.js',
  'src/game/bot.js',
  'src/game/game.js',
  'src/shell.js'
];

const shell = read('index.html');

// pull the <style> and the body markup straight out of the dev page so the
// two never drift apart
const style = shell.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = shell
  .match(/<body>([\s\S]*?)<script src=/)[1]
  .trim();

const code = SOURCES.map(f => `/* ===== ${f} ===== */\n${read(f)}`).join('\n');

const out = `<title>Prince of Persia — Software Renderer</title>
<style>
${style}
</style>
${body}
<script>
${code}
POP.boot();
</script>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/pop.html'), out);
console.log('dist/pop.html  ' + (out.length / 1024).toFixed(1) + ' KB');
