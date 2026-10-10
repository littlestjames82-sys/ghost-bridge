#!/usr/bin/env node
/**
 * pack-audit — prove the published npm tarball is safe to ship (v4.2).
 *
 *   node scripts/pack-audit.mjs        (or: npm run pack-audit)
 *
 * Runs `npm pack` on the root package, unpacks the tarball to a temp dir,
 * and asserts:
 *   (a) zero private-data markers anywhere in the packed content,
 *   (b) no secret/state files are packed: no .setup-secret, no .netlify/,
 *       no context.json (the context.EXAMPLE.json template is fine),
 *   (c) the runtime essentials are present: bin, mcp/server.js,
 *       relay/core.mjs, README, LICENSE.
 * Exits non-zero on any failure. Wired into CI (.github/workflows/ci.yml).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bridge-pack-audit-'));
const failures = [];
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures.push(name);
};

// Patterns are fragment-assembled so this script — which is itself packed —
// does not match its own scan.
const PATTERNS = [
  '215-' + '9386', '408-' + '2150', '321-' + '3724', 'Powers ' + 'Loop',
  'gdev' + '6145', 'ghost' + 'malone', 'gregarious-' + 'entremet',
  '615945467' + '50800', 'storefront-' + 'ghost-dev', 'littlest' + 'james'
];

try {
  const out = execFileSync('npm', ['pack', '--pack-destination', tmp, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const meta = JSON.parse(out.slice(out.indexOf('[')));
  const tgz = path.join(tmp, meta[0].filename);
  if (!fs.existsSync(tgz)) throw new Error('npm pack produced no tarball at ' + tgz);
  const extract = path.join(tmp, 'extract');
  fs.mkdirSync(extract);
  execFileSync('tar', ['-xzf', tgz, '-C', extract]);
  const base = path.join(extract, 'package');

  const all = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else all.push(path.relative(base, p).split(path.sep).join('/'));
    }
  })(base);
  console.log(`packed ${all.length} file(s) from ${meta[0].filename}`);

  // (b) forbidden files
  const isContext = f => /(^|\/)context\.json$/.test(f) && !/(^|\/)context\.example\.json$/.test(f);
  ok('no .setup-secret packed', !all.some(f => f.endsWith('/.setup-secret') || f === '.setup-secret'), all.filter(f => f.includes('.setup-secret')).join(','));
  ok('no .netlify packed', !all.some(f => f.split('/').includes('.netlify')), all.filter(f => f.includes('.netlify')).join(','));
  ok('no real context.json packed', !all.some(isContext), all.filter(isContext).join(','));

  // (a) private-data scan over packed content (text files up to 2 MB)
  const hits = [];
  for (const f of all) {
    const full = path.join(base, f);
    let text = '';
    try { if (fs.statSync(full).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const p of PATTERNS) if (text.includes(p)) hits.push(`${f} ~ ${p}`);
  }
  ok('zero private-data markers in packed content', hits.length === 0, hits.slice(0, 10).join(' | '));

  // (c) runtime essentials
  for (const need of ['bin/ghost-bridge.mjs', 'mcp/server.js', 'relay/core.mjs', 'scripts/archive.mjs', 'README.md', 'LICENSE']) {
    ok(`essential present: ${need}`, all.includes(need), all.slice(0, 20).join(', '));
  }
} catch (e) {
  ok('pack audit ran', false, e.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) { console.error(`\nPACK AUDIT FAILED (${failures.length})`); process.exit(1); }
console.log('\nPACK AUDIT PASSED — tarball is clean and complete.');
