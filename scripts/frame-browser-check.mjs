// Run after build + Vite preview. Uses a supplied Playwright installation, no production dependencies.
// FRAME_PLAYWRIGHT_MODULE can point to playwright/index.mjs; FRAME_BROWSER_CHANNEL defaults to msedge.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.FRAME_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.FRAME_PLAYWRIGHT_MODULE).href : 'playwright');
const output = process.env.FRAME_CHECK_OUTPUT || path.join(tmpdir(), 'family-frame-check');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.FRAME_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    localStorage.setItem('ff_device_token', 'local-fixture-only');
    Object.defineProperty(window, 'speechSynthesis', { value: undefined });
  });
  const longMessage = '奶奶，今天我们一起去公园散步，阳光很好，花也开了。希望您每天开心，吃好睡好，我们周末回来看您！'.repeat(2).slice(0, 80);
  const posts = [3, 2, 1].map(n => ({ id: `p${n}`, messageText: n === 3 ? longMessage : n === 2 ? '奶奶，这是今天的录音。' : null,
    createdAt: `2026-09-0${n}T00:00:00Z`, member: { displayName: '维' },
    media: [{ id: `photo${n}`, type: 'PHOTO', mimeType: 'image/svg+xml', durationMs: null },
      ...(n === 2 ? [{ id: 'voice2', type: 'VOICE', mimeType: 'audio/wav', durationMs: 3000 }] : [])] }));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#aecfca"/><circle cx="950" cy="170" r="80" fill="#fff4bc"/><path d="M0 650L340 240L800 800H0" fill="#548777"/><path d="M350 800L820 350L1200 660V800" fill="#305f54"/></svg>';
  const wav = Buffer.alloc(44 + 48000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(48000, 40);
  for (let i = 0; i < 24000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 1500), 44 + i * 2);
  let offline = false;
  await context.route('**/api/**', route => {
    if (offline) return route.abort();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/feed')) return route.fulfill({ json: { posts, cursor: 'p3', serverTime: new Date().toISOString() } });
    if (url.pathname.includes('/media/')) return route.fulfill(url.pathname.endsWith('voice2')
      ? { contentType: 'audio/wav', body: wav } : { contentType: 'image/svg+xml', body: svg });
    return route.fulfill({ json: { ok: true } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const base = process.env.FRAME_CHECK_URL || 'http://127.0.0.1:4173';
  await page.goto(`${base}/frame`);
  await page.locator('.frame-message p').waitFor();
  assert.equal(await page.locator('.frame-message p').textContent(), longMessage);
  for (const [width, height] of [[1920,1080],[2160,1080],[2280,1080],[2340,1080],[1920,900],[1920,864],[2400,1080]]) {
    await page.setViewportSize({ width, height });
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('.frame-root');
      const img = document.querySelector('.frame-stage img');
      return { fits: root.scrollWidth <= root.clientWidth && root.scrollHeight <= root.clientHeight,
        imageHeight: img.getBoundingClientRect().height,
        contain: getComputedStyle(img).objectFit,
        font: parseFloat(getComputedStyle(document.querySelector('.frame-message')).fontSize),
        buttons: [...document.querySelectorAll('.frame-btn')].every(b => b.getBoundingClientRect().bottom <= innerHeight && b.getBoundingClientRect().height >= 120) };
    });
    assert(metrics.fits && metrics.buttons && metrics.imageHeight > 200 && metrics.contain === 'contain' && metrics.font >= 28, JSON.stringify({width,height,...metrics}));
    console.log('viewport PASS', width, height, metrics);
    if (width === 1920 && height === 864) await page.screenshot({ path: path.join(output, 'frame-1920x864.png') });
  }
  await page.locator('.frame-stage').click();
  await page.waitForFunction(() => document.querySelector('.frame-btn-play').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('.frame-message p').textContent(), longMessage);
  await page.getByRole('button', {name:'上一张', exact:true}).click();
  assert.equal(await page.locator('.frame-message p').textContent(), posts[1].messageText);
  await page.locator('.frame-stage').click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.waitForFunction(() => document.querySelector('audio').ended);
  await page.getByRole('button', {name:'上一张', exact:true}).click();
  assert.equal(await page.locator('.frame-message').count(), 0);
  await page.locator('.frame-stage').click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => { const r=indexedDB.open('family-frame-offline');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
    return new Promise(resolve => {const r=db.transaction('media').objectStore('media').count();r.onsuccess=()=>{db.close();resolve(r.result===4);};});
  });
  // Natural reload activates the already installed Service Worker.
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.locator('.frame-message p').waitFor();
  assert.equal(await page.locator('.frame-message p').textContent(), longMessage);
  await page.waitForFunction(() => document.querySelector('.frame-stage img')?.naturalWidth > 0);
  await page.getByRole('button', {name:'上一张', exact:true}).click();
  await page.locator('.frame-stage').click();
  await page.waitForFunction(() => !document.querySelector('audio').paused);
  await page.waitForFunction(() => document.querySelector('audio').ended);
  assert.deepEqual(errors, []);
  console.log('PASS: text/voice priority, silent fallback, photo navigation, real IndexedDB + Service Worker offline reload and audio. Output:', output);
} finally { await browser.close(); }
