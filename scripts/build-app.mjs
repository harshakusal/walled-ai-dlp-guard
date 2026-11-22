// Bundles the renderer-side code (preloads + toolbar page) into dist/app and
// creates the app icon. The main process and the DLP core are compiled by tsc.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const out = path.resolve('dist/app');
fs.mkdirSync(path.join(out, 'toolbar'), { recursive: true });
const common = { bundle: true, target: 'chrome130', logLevel: 'warning', legalComments: 'none' };
// Sandboxed preloads must be single CommonJS files; only 'electron' is require()d.
await build({ ...common, entryPoints: ['src/app/guard/guard.ts'], format: 'cjs', platform: 'browser', external: ['electron'], outfile: path.join(out, 'guard.cjs') });
await build({ ...common, entryPoints: ['src/app/toolbar/toolbar-preload.ts'], format: 'cjs', platform: 'browser', external: ['electron'], outfile: path.join(out, 'toolbar-preload.cjs') });
await build({ ...common, entryPoints: ['src/app/toolbar/toolbar.ts'], format: 'iife', platform: 'browser', outfile: path.join(out, 'toolbar', 'toolbar.js') });
fs.copyFileSync('src/app/toolbar/toolbar.html', path.join(out, 'toolbar', 'toolbar.html'));

// App icon (shield), also used by electron-builder.
function icon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size / 128;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.moveTo(64 * s, 8 * s); ctx.lineTo(112 * s, 26 * s); ctx.lineTo(108 * s, 74 * s);
  ctx.quadraticCurveTo(100 * s, 106 * s, 64 * s, 122 * s); ctx.quadraticCurveTo(28 * s, 106 * s, 20 * s, 74 * s); ctx.lineTo(16 * s, 26 * s); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#34d399'; ctx.lineWidth = 10 * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(42 * s, 64 * s); ctx.lineTo(58 * s, 80 * s); ctx.lineTo(88 * s, 48 * s); ctx.stroke();
  return c.toBuffer('image/png');
}
fs.writeFileSync(path.join(out, 'icon.png'), icon(256));
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', icon(512));
console.log('renderer bundles + icon ->', out);
