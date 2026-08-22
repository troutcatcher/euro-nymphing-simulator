#!/usr/bin/env node
/*
 * Inlines the stylesheet and every script into one self-contained HTML file.
 *
 * The multi-file version needs relative paths to resolve, which they do not
 * when a phone opens a downloaded file through a content:// URI. The bundle
 * has no external references at all, so it works anywhere.
 *
 *   node tools/build-single-file.js              -> dist/euro-nymphing-simulator.html
 *   node tools/build-single-file.js --fragment   -> also dist/fragment.html (no
 *                                                   doctype/html/head/body, for
 *                                                   hosts that supply their own)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// Keep `</script>` inside inlined JS from closing the tag that wraps it.
function guard(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1');
}

const html = read('index.html');

const cssHref = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/i;
const cssMatch = html.match(cssHref);
if (!cssMatch) throw new Error('no stylesheet link found in index.html');
const css = read(cssMatch[1]);

const scripts = [...html.matchAll(/<script\s+src=["']([^"']+)["']\s*><\/script>\s*/gi)];
if (!scripts.length) throw new Error('no script tags found in index.html');
const js = scripts.map((m) => read(m[1])).join('\n');

let out = html
  .replace(cssMatch[0], '<style>\n' + css + '\n</style>')
  .replace(scripts[0][0], '__BUNDLE__\n');
for (const m of scripts.slice(1)) out = out.replace(m[0], '');
out = out.replace('__BUNDLE__', '<script>\n' + guard(js) + '\n</script>');

fs.mkdirSync(dist, { recursive: true });

const bundlePath = path.join(dist, 'euro-nymphing-simulator.html');
fs.writeFileSync(bundlePath, out);
console.log('wrote ' + path.relative(root, bundlePath) +
            '  (' + (Buffer.byteLength(out) / 1024).toFixed(0) + ' KB)');

if (process.argv.includes('--fragment')) {
  // Everything inside <body>, with the title and styles carried along.
  const title = (out.match(/<title>([^<]*)<\/title>/i) || [, 'Euro Nymphing Simulator'])[1];
  const style = out.match(/<style>[\s\S]*?<\/style>/i)[0];
  const body = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1].trim();
  const fragment = '<title>' + title + '</title>\n' + style + '\n' + body + '\n';
  const fragmentPath = path.join(dist, 'fragment.html');
  fs.writeFileSync(fragmentPath, fragment);
  console.log('wrote ' + path.relative(root, fragmentPath) +
              '  (' + (Buffer.byteLength(fragment) / 1024).toFixed(0) + ' KB)');
}
