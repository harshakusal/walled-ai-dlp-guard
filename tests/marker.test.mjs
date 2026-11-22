import test from 'node:test';
import assert from 'node:assert/strict';
import { containsMarker, containsMarkerLoose, findMarkerFuzzy, preview } from '../dist/core/marker.js';

test('exact marker in a prompt', () => {
  assert.equal(containsMarker('please review WALLED_SENSITIVE data'), true);
  assert.equal(containsMarker('nothing to see here'), false);
  assert.equal(containsMarker(''), false);
});

test('case-insensitive and Unicode-normalised (full-width, zero-width evasion)', () => {
  assert.equal(containsMarker('walled_sensitive'), true);
  assert.equal(containsMarker('ＷＡＬＬＥＤ＿ＳＥＮＳＩＴＩＶＥ'), true);
  assert.equal(containsMarker('WALLED\u200B_SENS\u2060ITIVE'), true);
});

test('near-misses in prompts are not flagged', () => {
  assert.equal(containsMarker('WALLED SENSITIVE'), false);
  assert.equal(containsMarker('WALLED_SENSITIV'), false);
  assert.equal(containsMarker('walled garden, sensitive topic'), false);
});

test('loose match tolerates PDF text-run splitting', () => {
  assert.equal(containsMarkerLoose('WALLED_ SENSI TIVE'), true);
  assert.equal(containsMarkerLoose('WALLED SENSITIVE'), false);
});

test('fuzzy OCR match tolerates typical recognition errors only', () => {
  assert.equal(findMarkerFuzzy('Label: WALLED_SENSITIVE').distance, 0);
  assert.equal(findMarkerFuzzy('Label: WALLEO_SENSlTIVE').found, true);
  assert.equal(findMarkerFuzzy('WALLED SENS1TIVE').found, true);
  assert.equal(findMarkerFuzzy('A wallet is sensitive to theft').found, false);
  assert.equal(findMarkerFuzzy('Quarterly sales report').found, false);
});

test('preview is single-line and bounded', () => {
  const p = preview('a\n\n b'.repeat(200), 50);
  assert.ok(p.length <= 50);
  assert.ok(!p.includes('\n'));
});
