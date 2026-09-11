import { useEffect, useRef, useState } from 'react';
import type { FrameFeedPost, FrameFeedResponse } from '@family-frame/shared';
import { nextPollDelayMs, POLL_INTERVAL_MS } from './poll';

/**
 * 相框 feed 轮询（PRD §15，MVP 不使用 WebSocket）：
 * - 同一时间只允许一个在途请求（上一请求未完成则跳过本轮 tick）；
 * - 每个请求使用独立 AbortController；
 * - 失败指数退避（最大 60 秒），成功恢复 15 秒；
 * - 任何失败不产生面向老人的错误 UI，只更新连接状态点。
 */

export type ConnState = 'connecting' | 'ok' | 'reconnecting';

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function useFrameFeed(token: string | null): {
  posts: FrameFeedPost[];
  conn: ConnState;
  /** token 被服务端拒绝（清除后回配置界面） */
  tokenInvalid: boolean;
} {
  const [posts, setPosts] = useState<FrameFeedPost[]>([]);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const tokenInvalidRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = POLL_INTERVAL_MS;

    const schedule = (): void => {
      if (!stopped && !tokenInvalidRef.current) {
        timer = setTimeout(tick, delay);
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped || tokenInvalidRef.current) return;
      // 同一时间只能存在一个 polling request：上一请求仍在途则跳过本轮
      if (controller) {
        schedule();
        return;
      }
      controller = new AbortController();
      try {
        const res = await fetch('/api/frame/feed?limit=50', {
          headers: { 'x-device-token': token },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.status === 401) {
          tokenInvalidRef.current = true;
          setTokenInvalid(true);
          return; // 停止轮询
        }
        if (!res.ok) throw new Error(`feed status ${res.status}`);
        const data = (await res.json()) as FrameFeedResponse;
        if (stopped) return;
        setPosts(data.posts);
        setConn('ok');
        delay = nextPollDelayMs(delay, true);
      } catch (err) {
        if (stopped) return;
        if (!isAbortError(err)) {
          // 网络失败：老人端无任何报错，只更新状态点，当前照片保留
          setConn('reconnecting');
          delay = nextPollDelayMs(delay, false);
        }
      } finally {
        controller = null;
      }
      schedule();
    };

    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [token]);

  return { posts, conn, tokenInvalid };
}

/** 设备心跳（PRD §14）：加载时立即上报一次，之后每 60 秒一次；失败静默 */
export function useFrameHeartbeat(token: string | null): void {
  useEffect(() => {
    if (!token) return;
    let stopped = false;
    const report = async (): Promise<void> => {
      try {
        await fetch('/api/frame/heartbeat', {
          method: 'POST',
          headers: { 'x-device-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ appVersion: '0.1.0-web', clientTime: new Date().toISOString(), cacheCount: 0 }),
        });
      } catch {
        // 心跳失败不影响看照片
      }
    };
    void report();
    const timer = setInterval(() => {
      if (!stopped) void report();
    }, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [token]);
}
