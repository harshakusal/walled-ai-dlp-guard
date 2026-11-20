// Bundles the MV3 extension into dist/extension (load it with "Load unpacked").
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const out = path.resolve('dist/extension');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
await build({
  entryPoints: { content: 'src/extension/content.ts', background: 'src/extension/background.ts', popup: 'src/extension/popup.ts' },
  bundle: true, format: 'esm', target: 'chrome116', outdir: out, logLevel: 'warning', legalComments: 'none',
});
// content scripts are classic scripts: rebuild that one as an IIFE.
await build({ entryPoints: ['src/extension/content.ts'], bundle: true, format: 'iife', target: 'chrome116', outfile: path.join(out, 'content.js'), logLevel: 'warning' });
for (const f of fs.readdirSync('extension-static')) fs.copyFileSync(path.join('extension-static', f), path.join(out, f));
for (const size of [16, 32, 48, 128]) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const s = size / 128;
  ctx.fillStyle = '#c2410c';
  ctx.beginPath(); // shield
  ctx.moveTo(64 * s, 8 * s); ctx.lineTo(112 * s, 26 * s); ctx.lineTo(108 * s, 74 * s);
  ctx.quadraticCurveTo(100 * s, 106 * s, 64 * s, 122 * s); ctx.quadraticCurveTo(28 * s, 106 * s, 20 * s, 74 * s); ctx.lineTo(16 * s, 26 * s); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = `bold ${Math.round(64 * s)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('W', 64 * s, 66 * s);
  fs.writeFileSync(path.join(out, 'icons', `${size}.png`), c.toBuffer('image/png'));
}
console.log('extension built ->', out);
