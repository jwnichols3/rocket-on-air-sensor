// Inlines the console's CSS and JS into one HTML file at server/public/admin/index.html.
//
// A bundler would be a dependency, a config file and a lockfile entry to serve one page
// with no imports and no framework. This is the whole build: read three files, substitute
// two placeholders, write one. The output is self-contained for the same reason /display
// is - the page has to render when the thing it would fetch assets from is the thing that
// is broken.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out-dir' || args[1].trim() === '')) {
  throw new Error('usage: node admin-ui/build.mjs [--out-dir DIRECTORY]');
}
const outputDir = args.length ? resolve(args[1]) : join(here, '..', 'server', 'public', 'admin');
const out = join(outputDir, 'index.html');

const [html, css, js] = await Promise.all([
  readFile(join(here, 'src', 'index.html'), 'utf8'),
  readFile(join(here, 'src', 'app.css'), 'utf8'),
  readFile(join(here, 'src', 'app.js'), 'utf8'),
]);

// Not a template literal and not a regex replace: the CSS and JS contain `$&` and `$'`
// sequences that String.replace would interpret. Split/join is the boring correct thing.
const page = html.split('/*STYLES*/').join(css).split('//SCRIPT').join(js);
if (page.includes('/*STYLES*/') || page.includes('//SCRIPT')) {
  throw new Error('build: a placeholder survived the substitution');
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, page, 'utf8');
console.log(`admin-ui: wrote ${out} (${(page.length / 1024).toFixed(1)} kB)`);
