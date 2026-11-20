// Generates the sample files used by the tests and the demo (fixtures/).
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const dir = path.resolve(process.argv[2] ?? 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const out = (name, data) => { fs.writeFileSync(path.join(dir, name), data); console.log('wrote', path.join(dir, name)); };

const LOREM = 'Quarterly planning notes for the platform team. Roadmap, hiring plan and budget review.';

// --- text ---
out('notes-clean.txt', `${LOREM}\nNothing confidential in here.\n`);
out('notes-sensitive.txt', `${LOREM}\nCustomer list attached below.\nClassification: WALLED_SENSITIVE\n`);
out('notes-sensitive-utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`Header\nWALLED_SENSITIVE payroll export\n`, 'utf16le')]));

// --- PDF with a text layer (marker on page 2) ---
async function textPdf(withMarker) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Board report – page ${i}`, { x: 50, y: 780, size: 20, font });
    page.drawText(LOREM, { x: 50, y: 740, size: 11, font });
    if (withMarker && i === 2) page.drawText('Internal classification: WALLED_SENSITIVE', { x: 50, y: 700, size: 12, font, color: rgb(0.6, 0, 0) });
  }
  doc.setTitle('Board report');
  return doc.save({ useObjectStreams: true }); // compressed object streams: marker not visible in raw bytes
}
out('report-clean.pdf', await textPdf(false));
out('report-sensitive.pdf', await textPdf(true));

// --- images with the marker rendered as pixels (no text metadata) ---
function textImage(lines, { w = 900, h = 300, bg = '#ffffff', fg = '#111111', size = 34 } = {}) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg; ctx.font = `${size}px sans-serif`;
  lines.forEach((l, i) => ctx.fillText(l, 40, 70 + i * (size + 22)));
  return c;
}
out('screenshot-clean.png', textImage(['Sprint review – burndown chart', 'All tickets closed on time']).toBuffer('image/png'));
out('screenshot-sensitive.png', textImage(['Customer database export', 'Label: WALLED_SENSITIVE', 'Do not share externally']).toBuffer('image/png'));
out('photo-sensitive.jpg', textImage(['Scanned memo', 'WALLED_SENSITIVE'], { bg: '#f4f1ea', fg: '#222222', size: 40 }).toBuffer('image/jpeg', 85));
out('darkmode-sensitive.png', textImage(['Dark mode screenshot', 'WALLED_SENSITIVE'], { bg: '#1e1e1e', fg: '#e6e6e6' }).toBuffer('image/png'));

// --- scanned PDF: the page is only an image, there is no text layer ---
{
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(textImage(['Signed contract (scan)', 'WALLED_SENSITIVE'], { w: 1240, h: 500, size: 48 }).toBuffer('image/png'));
  const page = doc.addPage([595, 842]);
  page.drawImage(png, { x: 20, y: 500, width: 555, height: 224 });
  out('scan-sensitive.pdf', await doc.save());
}

// --- evasion: a PDF renamed to .txt is still parsed as a PDF ---
fs.copyFileSync(path.join(dir, 'report-sensitive.pdf'), path.join(dir, 'renamed-pdf-sensitive.txt'));
console.log('wrote', path.join(dir, 'renamed-pdf-sensitive.txt'));
