#!/usr/bin/env node
// Renders docs/client-api-guide.md into server/src/docs-page.ts, which GET /docs serves.
//
// ONE SOURCE, GENERATED SECOND COPY - the same arrangement as firmware/tools/gen-assets.py,
// and for the same reason: a page hand-maintained beside the markdown drifts, and a client
// guide that disagrees with itself is worse than one that does not exist. `--check` fails
// the build when the checked-in output no longer matches the markdown.
//
// The markdown subset is exactly what the guide uses: headings, paragraphs, fenced code,
// tables, lists, blockquotes, rules, and inline code/bold/italic/link. It is not a general
// markdown implementation and does not try to be.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(root, 'docs', 'client-api-guide.md');
const OUT = join(root, 'server', 'src', 'docs-page.ts');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Inline spans. Code spans are lifted out to placeholders FIRST, so their contents are never
 * touched by the emphasis regexes - and, just as importantly, so a bold span that WRAPS a
 * code span still closes. Splitting the line on backticks instead put the opening and
 * closing `**` in different pieces, and fourteen of them reached the page as literal
 * asterisks.
 */
function inline(text) {
  const spans = [];
  // `esc()` has already removed every raw `<` from the text, so `<c0/>` is a placeholder the
  // document cannot contain by accident. No sentinel character needed.
  const withHoles = esc(text).replace(/`([^`]*)`/g, (_, code) => {
    spans.push(`<code>${code}</code>`);
    return `<c${spans.length - 1}/>`;
  });
  return withHoles
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/<c(\d+)\/>/g, (_, n) => spans[Number(n)]);
}

const cells = (line) =>
  line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

function render(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      flushPara();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; // the closing fence
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // A table needs its separator row, or it is just a paragraph starting with a pipe.
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushPara();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    if (line.startsWith('> ') || line.trim() === '>') {
      flushPara();
      const body = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i].trim() === '>')) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = /^(\d+\.|-)\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const ordered = bullet[1] !== '-';
      const items = [];
      while (i < lines.length) {
        const m = /^(\d+\.|-)\s+(.*)$/.exec(lines[i]);
        if (m && (m[1] !== '-') === ordered) {
          items.push(m[2]);
          i++;
          // A continuation line is indented and is part of the item above it.
          while (i < lines.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ` ${lines[i++].trim()}`;
        } else break;
      }
      const li = items
        .map((t) => {
          const box = /^\[[ xX]\]\s+/.exec(t);
          if (!box) return `<li>${inline(t)}</li>`;
          const checked = /[xX]/.test(box[0]) ? ' checked' : '';
          return `<li class="task"><input type="checkbox" disabled${checked}>${inline(t.slice(box[0].length))}</li>`;
        })
        .join('');
      out.push(ordered ? `<ol>${li}</ol>` : `<ul>${li}</ul>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join('\n');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#ffffff; --fg:#1a1a1a; --mut:#5b6470; --line:#d8dde3;
        --code-bg:#f4f6f8; --accent:#0b6e2e; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#15181c; --fg:#e6e9ed; --mut:#9aa4b0; --line:#2c323a; --code-bg:#1e232a; --accent:#57c785; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); line-height:1.6;
       font-family: system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 54rem; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
h1 { font-size:1.9rem; line-height:1.2; margin:0 0 .25rem; }
/* No border-top: the guide already puts a horizontal rule between sections, and the two
   together drew a doubled line above every heading. */
h2 { font-size:1.35rem; margin:1.75rem 0 .75rem; }
h3 { font-size:1.1rem; margin:1.75rem 0 .5rem; }
h4 { font-size:1rem; margin:1.25rem 0 .5rem; color:var(--mut); }
p, ul, ol { margin:.75rem 0; }
li { margin:.3rem 0; }
li.task { list-style:none; margin-left:-1.4rem; }
li.task input { margin-right:.5rem; }
a { color:var(--accent); }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
code { background:var(--code-bg); padding:.12em .35em; border-radius:.25rem;
       font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.9em; }
pre { background:var(--code-bg); border:1px solid var(--line); border-radius:.4rem;
      padding:.9rem 1rem; overflow-x:auto; }
pre code { background:none; padding:0; font-size:.85rem; line-height:1.5; }
blockquote { margin:1rem 0; padding:.1rem 1rem; border-left:3px solid var(--accent);
             background:var(--code-bg); border-radius:0 .3rem .3rem 0; }
blockquote p { margin:.6rem 0; }
.scroll { overflow-x:auto; margin:1rem 0; }
table { border-collapse:collapse; width:100%; font-size:.92rem; }
th, td { border:1px solid var(--line); padding:.45rem .6rem; text-align:left; vertical-align:top; }
th { background:var(--code-bg); font-weight:600; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line);
         color:var(--mut); font-size:.85rem; }
`;

function page(md) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>On-air client guide</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${render(md)}
<footer>Generated from <code>docs/client-api-guide.md</code> by <code>server/tools/gen-docs.mjs</code>. The normative spec is <code>docs/api-contract.md</code>.</footer>
</main>
</body>
</html>
`;
}

const html = page(readFileSync(SRC, 'utf8'));
// Backticks, backslashes and ${ have to survive being carried in a template literal.
const literal = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const module = `// GENERATED by server/tools/gen-docs.mjs from docs/client-api-guide.md. Do not edit.
// Regenerate with: npm run docs:page   (npm run verify checks it is current)
//
// Self-contained and unauthenticated, like /display: no external resources, and it discloses
// nothing a caller could not read in the repo. It carries no credential and no configuration.
export const DOCS_HTML = \`${literal}\`;
`;

if (process.argv.includes('--check')) {
  let existing = '';
  try {
    existing = readFileSync(OUT, 'utf8');
  } catch {
    console.error('gen-docs: server/src/docs-page.ts is missing - run: npm run docs:page');
    process.exit(1);
  }
  if (existing !== module) {
    console.error('gen-docs: docs-page.ts is stale against docs/client-api-guide.md - run: npm run docs:page');
    process.exit(1);
  }
  console.log('gen-docs: docs-page.ts matches docs/client-api-guide.md');
} else {
  writeFileSync(OUT, module);
  console.log(`gen-docs: wrote server/src/docs-page.ts (${html.length} bytes of HTML)`);
}
