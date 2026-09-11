// Run against an already paired frame with at least one cloud post:
//   FRAME_ADB=<path-to-adb> FRAME_BASE_URL=<frame-server-base-url> node scripts/check-frame-sync.mjs <adb-serial>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const serial = process.argv[2];
assert(serial, 'Supply the frame adb serial');
const executable = process.env.FRAME_ADB || 'adb';
const pkg = 'com.familyframe.capability';
function adb(...args) {
  const result = spawnSync(executable, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, 'adb command failed');
  return result.stdout;
}
function index() {
  return JSON.parse(adb('shell', 'run-as', pkg, 'cat', 'files/library/index.json'));
}
function tap(text) {
  const ui = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
  const node = [...ui.matchAll(/<node\s+[^>]+>/g)].find(m => m[0].includes(`text="${text}"`));
  const bounds = node?.[0].match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert(bounds, `Missing button: ${text}`);
  adb('shell', 'input', 'tap', String((+bounds[1] + +bounds[3]) / 2), String((+bounds[2] + +bounds[4]) / 2));
}

// Read credentials in memory only; never log or save them.
const prefs = adb('shell', 'run-as', pkg, 'cat', 'shared_prefs/frame_config.xml');
const base = prefs.match(/<string name="baseUrl">([^<]+)<\/string>/)?.[1];
const token = prefs.match(/<string name="deviceToken">([^<]+)<\/string>/)?.[1];
if (process.env.FRAME_BASE_URL) assert.equal(base, process.env.FRAME_BASE_URL);
assert(base, 'Frame must have a server baseUrl configured');
assert(token, 'Frame must be paired first');
const response = await fetch(`${base}/api/frame/feed?limit=50`, {
  headers: { 'x-device-token': token }, signal: AbortSignal.timeout(15000),
});
assert.equal(response.status, 200, 'Frame authentication failed');
const expected = (await response.json()).posts;
assert(expected.length > 0, 'Upload a test photo first');

async function checkSaved() {
  const deadline = Date.now() + 45000;
  let saved;
  do {
    saved = index().posts;
    if (expected.every(p => saved.some(s => s.id === p.id && s.receiptSent &&
      p.media.every(m => s.media.some(local => local.id === m.id && local.size > 0))))) break;
    await delay(1000);
  } while (Date.now() < deadline);
  for (const post of expected) {
    const local = saved.find(p => p.id === post.id);
    assert(local?.receiptSent, 'Post missing or delivery not acknowledged');
    for (const media of post.media) {
      const item = local.media.find(m => m.id === media.id);
      assert(item && /^media\/[A-Za-z0-9._-]+$/.test(item.fileName), 'Media index missing');
      const bytes = Number(adb('shell', 'run-as', pkg, 'stat', '-c', '%s', `files/library/${item.fileName}`).trim());
      assert(bytes > 0 && bytes === item.size, 'Media file missing or incomplete');
    }
  }
}

adb('shell', 'am', 'force-stop', pkg);
adb('shell', 'am', 'start', '-n', `${pkg}/.FrameActivity`);
await checkSaved();
for (let i = 0; i < 2; i++) {
  tap('设置');
  tap('立即同步');
  await checkSaved();
  tap('返回相框');
  await checkSaved();
}
adb('shell', 'am', 'force-stop', pkg);
adb('shell', 'am', 'start', '-n', `${pkg}/.FrameActivity`);
await checkSaved();
const ui = adb('exec-out', 'uiautomator', 'dump', '/dev/tty');
assert(!ui.includes('家人的照片会出现在这里'), 'Frame still shows empty state');
console.log(`PASS: ${expected.length} post(s), media files, receipts, page switching and app restart.`);
