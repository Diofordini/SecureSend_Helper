// End-to-end browser test: opens site/index.html from file://, drives the UI,
// downloads the archive, and verifies it with the real 7-Zip CLI.
// Run: node tests/e2e.test.mjs   (needs Chrome/Chromium; set CHROME_PATH if not auto-detected)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const SEVENZ = process.env.SEVENZ || '7z';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = pathToFileURL(path.join(ROOT, 'site/index.html')).href;
const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => fs.existsSync(p));

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
if (!CHROME) { console.error('Chrome not found. Set CHROME_PATH.'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'securesend-e2e-'));
const dl = path.join(tmp, 'downloads'); fs.mkdirSync(dl);
const files = [
  ['机场报告_2026.txt', Buffer.from('中文内容 snippet-ZH\n')],
  ['report.txt', Buffer.from('E2E-SECRET-SNIPPET\n')],
  ['big.bin', crypto.randomBytes(24 * 1024 * 1024)],
  ['empty.txt', Buffer.alloc(0)],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const net = [], errs = [];
page.on('request', r => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); });
page.on('pageerror', e => errs.push(e.message));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
await page.goto(URL_);

// Password generator: 300 samples, guarantees + no look-alikes
const bad = await page.evaluate(() => {
  const out = [];
  for (let i = 0; i < 300; i++) {
    document.getElementById('regenBtn').click();
    const v = document.getElementById('pw').value;
    if (v.length !== 16 || !/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[2-9]/.test(v) || !/[!@#$%&*?\-]/.test(v) || /[0Oo1lI]/.test(v)) out.push(v);
  }
  return out;
});
ok(bad.length === 0, 'Generator: 300 passwords meet class/look-alike rules');

// Add files through the drop zone
await page.evaluate(specs => {
  const dt = new DataTransfer();
  for (const [n, b] of specs) dt.items.add(new File([Uint8Array.from(atob(b), c => c.charCodeAt(0))], n));
  document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, files.map(([n, b]) => [n, b.toString('base64')]));
const listed = await page.$$eval('#fileList .fname', a => a.map(x => x.textContent));
ok(listed.length === 3 && !listed.includes('empty.txt'), '0-byte file refused, others listed');

// Short password blocked
const pw = await page.$eval('#pw', e => e.value);
await page.$eval('#pw', e => { e.value = 'short'; e.dispatchEvent(new Event('input')); });
await page.click('#encryptBtn');
ok(/at least 10/.test(await page.$eval('#encError', e => e.textContent)), 'Password under 10 chars shows inline error');
await page.$eval('#pw', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, pw);

await page.type('#recipient', 'Test Recipient');
await page.click('#encryptBtn');
await page.waitForFunction(() => /Done|failed/.test(document.getElementById('status').textContent + document.getElementById('encError').textContent), { timeout: 90000 });
ok(!(await page.$eval('#encError', e => e.textContent)), 'Encryption completed without error');

// Wait for download
let arc;
for (let i = 0; i < 60 && !arc; i++) { await new Promise(r => setTimeout(r, 500)); arc = fs.readdirSync(dl).find(f => f.endsWith('.7z')); }
ok(!!arc, 'Archive downloaded');

const msg2 = await page.$eval('#msg2', e => e.value);
ok(msg2.includes(pw), 'Message 2 contains the password');
ok(!(await page.$eval('#msg1', e => e.value)).includes(pw), 'Message 1 (email) does NOT contain the password');
const ls = await page.evaluate(() => JSON.stringify(localStorage));
ok(ls.includes('SS-') && !ls.includes(pw), 'Send log saved without the password');

await page.setViewport({ width: 320, height: 800 });
ok(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), 'No horizontal scroll at 320px');

await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
ok((await page.$eval('#pw', e => e.value)) === '', 'Password cleared on pagehide');
ok(net.length === 0, `No network requests (${net.length})`);
ok(errs.length === 0, `No page errors ${errs.join(' | ')}`);
await browser.close();

if (arc) {
  const p = path.join(dl, arc), out = path.join(tmp, 'x');
  const x = spawnSync(SEVENZ, ['x', `-p${pw}`, `-o${out}`, '-y', p], { input: '', encoding: 'utf8' });
  const same = x.status === 0 && files.filter(f => f[1].length).every(([n, b]) => fs.readFileSync(path.join(out, n)).equals(b));
  ok(same, 'Browser-made archive extracts byte-identical with 7-Zip');
  ok(spawnSync(SEVENZ, ['t', '-pwrongpassword1', p], { input: '' }).status !== 0, 'Browser-made archive rejects wrong password');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} test(s) FAILED` : '\nAll e2e tests passed');
process.exit(failures ? 1 : 0);
