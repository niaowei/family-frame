/*
 * 家庭语音相框 Service Worker（M4）——只负责应用 shell 离线启动。
 *
 * 策略：
 * - 导航请求（HTML）：网络优先，离线回退缓存的 index.html（任何路由都回退到同一 shell）；
 * - 同源静态资源（Vite 构建产物，带内容 hash、不可变）：缓存优先，未命中走网络并写入缓存；
 * - /api/*、/sw.js、跨域请求（如 MinIO 预签名媒体）：完全绕过 SW，不做任何缓存；
 * - 业务数据（照片/语音 Blob）由页面 IndexedDB 负责，SW 不参与；
 * - 更新：新版本 SW 安装后进入 waiting，不强制刷新页面；
 *   所有标签页自然关闭/重开后自动接管（符合"禁止检测更新→立刻 reload"）。
 */

const SHELL_CACHE = 'family-frame-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        // 预缓存根 shell；失败不阻塞安装（首次访问时 fetch 处理器仍会运行时缓存）
        await cache.add(new Request('/', { cache: 'reload' }));
      } catch {
        // 忽略：离线安装场景
      }
      // 不调用 self.skipWaiting()：等待自然 reload，绝不强制刷新
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      // 不调用 self.clients.claim()：当前页面继续正常运行，自然 reload 后使用新版本
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（MinIO 预签名媒体等）绕过
  if (url.pathname.startsWith('/api/')) return; // API 一律不缓存
  if (url.pathname === '/sw.js') return; // SW 自身不走缓存

  if (req.mode === 'navigate') {
    // 导航：网络优先，离线回退缓存的 shell（保证 API 不可达时 /frame 仍能启动）
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          try {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put('/', res.clone());
          } catch {
            // 缓存写入失败不影响返回
          }
          return res;
        } catch {
          const cached = await caches.match('/');
          if (cached) return cached;
          return new Response('<!doctype html><meta charset="utf-8">相框启动中，请联网一次', {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // 同源静态资源：缓存优先（构建产物带 hash，内容不可变）
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) {
          try {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(req, res.clone());
          } catch {
            // 忽略缓存写入失败
          }
        }
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })(),
  );
});
