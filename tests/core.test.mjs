// Acceptance tests for the 7z/AES engine, validated against the real 7-Zip CLI.
// Run: node tests/core.test.mjs   (needs `7z` on PATH: p7zip-full or 7-Zip)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const SEVENZ = process.env.SEVENZ || '7z';
const HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../site/index.html');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// ---- Load the engine straight out of index.html (the exact code users run) ----
const html = fs.readFileSync(HTML, 'utf8');
const core = html.split('/* ===== CORE-BEGIN')[1].split('/* ===== CORE-END')[0].replace(/^[^\n]*\n/, '');
const ctx = vm.createContext({ setTimeout, Uint8Array, Int32Array, DataView, BigInt, Math, Date, Promise, Error });
vm.runInContext(core + '\nthis.S = SevenZipAES;', ctx);
const S = ctx.S;
const env = { subtle: globalThis.crypto.subtle, getRandomValues: a => globalThis.crypto.getRandomValues(a) };

// ---- Primitive checks ----
let shaOk = true;
for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100003]) {
  const d = crypto.randomBytes(n);
  const ref = crypto.createHash('sha256').update(d).digest('hex');
  const h = new S.Sha256(); let o = 0;
  while (o < n) { const k = Math.min(n - o, 1 + (o % 97)); h.update(new Uint8Array(d.subarray(o, o + k))); o += k; }
  if (Buffer.from(h.digest()).toString('hex') !== ref) shaOk = false;
}
ok(shaOk, 'SHA-256 (streaming) matches Node crypto for edge lengths');
ok(S.crc32(new Uint8Array(Buffer.from('hello'))) === 0x3610a686, 'CRC32 known vector');
let t = Date.now();
await S.deriveKey('Correct-Horse-Battery-Staple-Orbit-Tiger-42', new Uint8Array(0), 19);
const kdfMs = Date.now() - t;
ok(kdfMs < 3000, `Key derivation 2^19 rounds in ${kdfMs} ms`);

// ---- Archive round-trips against real 7-Zip ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'securesend-'));
const write = (name, buf) => { const p = path.join(tmp, 'in', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return p; };
const SNIPPET = 'TOP-SECRET-SNIPPET-7f3a9c';
const inputs = [
  ['report.txt', Buffer.from(`${SNIPPET}: quarterly figures\n`)],
  ['机场报告_2026.txt', Buffer.from('中文内容 測試 snippet-ZH\n')],
  ['Résumé – naïve café.txt', Buffer.from('ünïcödé\n')],
  ['notes 😀.md', Buffer.from('emoji\n')],
  ['one.bin', crypto.randomBytes(1)],
  ['b15.bin', crypto.randomBytes(15)],
  ['b16.bin', crypto.randomBytes(16)],
  ['b17.bin', crypto.randomBytes(17)],
  ['big25mb.bin', crypto.randomBytes(25 * 1024 * 1024)],
].map(([n, b]) => ({ name: n, path: write(n, b), data: new Uint8Array(b), mtime: Date.UTC(2026, 0, 15, 8, 30) }));

async function buildArchive(files, pw, out) {
  const r = await S.build(files, pw, env);
  fs.writeFileSync(out, Buffer.concat(r.parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.length))));
}
const run = args => spawnSync(SEVENZ, args, { input: '', encoding: 'utf8', timeout: 120000 });

const cases = [
  { label: 'multi-file, unicode names, 25 MB', files: inputs, pw: 'Xk7#mP2q-Rv9@Lw4' },
  { label: 'single 1-byte file, passphrase', files: [inputs[4]], pw: 'Marble-Prairie-Fossil-Liberty-Spider-Window-18' },
  { label: 'non-ASCII password', files: [inputs[0], inputs[6]], pw: 'Pässwörd-密码-Test1' },
];
for (const [i, c] of cases.entries()) {
  const arc = path.join(tmp, `case${i}.7z`);
  await buildArchive(c.files, c.pw, arc);
  const raw = fs.readFileSync(arc);

  ok(raw.subarray(0, 6).equals(Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])), `[${c.label}] 7z signature`);

  const list = run(['l', arc]);
  ok(list.status !== 0 && !c.files.some(f => list.stdout.includes(f.name)), `[${c.label}] listing without password fails and reveals no names`);

  const wrong = run(['t', `-p${c.pw}X`, arc]);
  ok(wrong.status !== 0, `[${c.label}] wrong password rejected`);

  const test = run(['t', `-p${c.pw}`, arc]);
  ok(test.status === 0 && /Everything is Ok/.test(test.stdout), `[${c.label}] 7z integrity test (CRC) OK`);

  const outDir = path.join(tmp, `x${i}`);
  const x = run(['x', `-p${c.pw}`, `-o${outDir}`, '-y', arc]);
  const same = x.status === 0 && c.files.every(f => {
    const p = path.join(outDir, f.name);
    return fs.existsSync(p) && fs.readFileSync(p).equals(Buffer.from(f.data));
  });
  ok(same, `[${c.label}] extracted files byte-identical (${c.files.length} files)`);

  const needles = c.files.map(f => f.name).concat([SNIPPET, '中文内容']);
  const leaks = needles.filter(n => raw.includes(Buffer.from(n, 'utf8')) || raw.includes(Buffer.from(n, 'utf16le')));
  ok(leaks.length === 0, `[${c.label}] no file names or content visible in raw bytes${leaks.length ? ' — LEAKED: ' + leaks.join(', ') : ''}`);
}

// Empty files must be rejected
let rejected = false;
try { await S.build([{ name: 'e.txt', data: new Uint8Array(0), mtime: 0 }], 'abcdefghijk', env); } catch { rejected = true; }
ok(rejected, '0-byte file rejected with an error');

try { execFileSync(SEVENZ, ['i'], { stdio: 'ignore' }); } catch {}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll core tests passed');
process.exit(failures ? 1 : 0);
