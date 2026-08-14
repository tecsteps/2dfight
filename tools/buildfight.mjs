/* Inline the fighting game into one self-contained artifact page. */
import fs from 'fs'; import path from 'path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = ['src/fx/surface.js','src/fx/shade.js','src/fx/fighter.js','src/fx/draw.js',
             'src/fx/sound.js','src/fx/fight.js'];
const shell = read('fight.html');
const style = shell.match(/<style>([\s\S]*?)<\/style>/)[1];
const body  = shell.match(/<body>([\s\S]*?)<script src=/)[1].trim();
const boot  = shell.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
const code  = SRC.map(f => `/* ===== ${f} ===== */\n${read(f)}`).join('\n');
const out = `<title>Iron Lantern</title>\n<style>\n${style}\n</style>\n${body}\n<script>\n${code}\n${boot}\n</script>\n`;
fs.mkdirSync(path.join(ROOT,'dist'),{recursive:true});
fs.writeFileSync(path.join(ROOT,'dist/fight.html'), out);
console.log('dist/fight.html  ' + (out.length/1024).toFixed(1) + ' KB');
