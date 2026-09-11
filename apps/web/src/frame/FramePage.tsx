import { useEffect, useMemo, useRef, useState } from 'react';
import type { FrameFeedPost, FrameFeedResponse } from '@family-frame/shared';
import { AutoCarousel, nextIndexWithWrap } from './carousel';
import { decideCurrentAfterFeedUpdate } from './feedApply';
import {
  getAllCachedMedia,
  getAllCachedPosts,
  getExistingMediaIds,
  getMediaBlob,
  getPendingFrameEvents,
  queuePendingFrameEvent,
} from './idb';
import type { CachedMediaRow } from './idb';
import { PlaybackController } from './playback';
import {
  computeFeedKey,
  getLastSyncedFeedKey,
  setLastSyncedFeedKey,
  shouldSyncCache,
  syncOfflineCache,
} from './sync';
import { getTtsAdapter } from './TtsAdapter';
import { useFrameFeed, useFrameHeartbeat } from './useFrameFeed';
import './frame.css';

/**
 * /frame — 相框主界面（PRD §5 / §6 / §25 + M4 离线）。
 * 产品原则：点照片可以听；点左右可以换照片。无导航、无菜单、无技术错误文案。
 *
 * M4 离线：
 * - 首屏优先从 IndexedDB 显示缓存照片（不等服务器）；
 * - 媒体显示/播放优先使用本地 Blob（objectURL 仅显示阶段临时生成，切换/卸载时 revoke）；
 * - 在线轮询成功后后台同步缓存（先存新再淘汰，不抢屏）；
 * - seen/heard 离线本地记录，恢复后 best-effort 补报。
 */

const TOKEN_KEY = 'ff_device_token';

function TokenSetup({ invalid, onSave }: { invalid: boolean; onSave: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <div className="frame-setup">
      <h1>相框配置</h1>
      {invalid && <p className="frame-setup-error">设备令牌无效，请重新输入</p>}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="粘贴设备令牌"
        aria-label="设备令牌"
      />
      <button type="button" onClick={() => value.trim() && onSave(value.trim())}>
        保存并连接
      </button>
    </div>
  );
}

/** IndexedDB 缓存行 → 相框 feed 结构 */
function buildCachedFeed(): Promise<FrameFeedPost[]> {
  return (async () => {
    const [rows, media] = await Promise.all([getAllCachedPosts(), getAllCachedMedia()]);
    const mediaByPost = new Map<string, CachedMediaRow[]>();
    for (const m of media) {
      const list = mediaByPost.get(m.postId) ?? [];
      list.push(m);
      mediaByPost.set(m.postId, list);
    }
    return rows.map((row) => ({
      id: row.id,
      messageText: row.messageText,
      createdAt: new Date(row.createdAt).toISOString(),
      member: { displayName: row.memberName },
      media: (mediaByPost.get(row.id) ?? [])
        .sort((a, b) => a.cachedAt - b.cachedAt)
        .map((m) => ({ id: m.id, type: m.type, mimeType: m.mimeType, durationMs: null })),
    }));
  })();
}

export default function FramePage() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const { posts: onlinePosts, conn, tokenInvalid: feedTokenInvalid } = useFrameFeed(token);
  useFrameHeartbeat(token);

  // 离线启动：首屏立即用 IndexedDB 缓存，不等服务器
  const [cachedPosts, setCachedPosts] = useState<FrameFeedPost[] | null>(null);
  const posts = onlinePosts.length > 0 ? onlinePosts : (cachedPosts ?? []);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  const currentIdRef = useRef<string | null>(null);
  const photoIndexRef = useRef(0);
  const [badgeVisible, setBadgeVisible] = useState(false);
  const seenLocalRef = useRef(new Set<string>());
  const hadPostsRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [previousPhotoUrl, setPreviousPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const controllerRef = useRef<PlaybackController | null>(null);
  const carouselRef = useRef<AutoCarousel | null>(null);
  const playSeqRef = useRef(0);
  const pendingPlayRef = useRef(false);
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);
  useEffect(() => {
    photoIndexRef.current = photoIndex;
  }, [photoIndex]);

  // 媒体内存层：Blob 缓存（可低成本重建 objectURL）+ 当前存活的 objectURL（及时 revoke 防泄漏）
  const blobCacheRef = useRef(new Map<string, Blob>());
  const objectUrlsRef = useRef(new Map<string, string>());
  const lastVoiceMediaIdRef = useRef<string | null>(null);
  const photoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!photoUrl) return;
    const timer = window.setTimeout(() => setPreviousPhotoUrl(null), 450);
    return () => window.clearTimeout(timer);
  }, [photoUrl]);

  const revokeObjectUrl = (mediaId: string): void => {
    const url = objectUrlsRef.current.get(mediaId);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(mediaId);
    }
  };

  const fetchNetworkBlob = async (mediaId: string): Promise<Blob> => {
    const t = tokenRef.current;
    if (!t) throw new Error('no token');
    const res = await fetch(`/api/frame/media/${mediaId}`, {
      headers: { 'x-device-token': t },
    });
    if (!res.ok) throw new Error(`media status ${res.status}`);
    return res.blob();
  };

  /**
   * 媒体地址解析（M4）：IndexedDB Blob 优先（离线可用、在线也避免重复请求/签名过期/闪烁），
   * 其次网络获取。objectURL 只在显示/播放阶段生成并登记，便于 revoke。
   */
  const ensureMediaUrl = async (mediaId: string): Promise<string> => {
    const existing = objectUrlsRef.current.get(mediaId);
    if (existing) return existing;
    let blob = blobCacheRef.current.get(mediaId) ?? null;
    if (!blob) {
      blob = (await getMediaBlob(mediaId).catch(() => null)) ?? (await fetchNetworkBlob(mediaId));
    }
    blobCacheRef.current.set(mediaId, blob);
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.set(mediaId, url);
    return url;
  };

  useEffect(() => {
    if (feedTokenInvalid) {
      setTokenInvalid(true);
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
    }
  }, [feedTokenInvalid]);

  // 启动时读取 IndexedDB 缓存（在线启动也优先显示缓存，不等服务器）
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void buildCachedFeed()
      .then((rows) => {
        if (!cancelled && rows.length > 0) setCachedPosts(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const asc = useMemo(() => [...posts].reverse(), [posts]);
  const currentIndex = currentId ? asc.findIndex((p) => p.id === currentId) : -1;
  const current = currentIndex >= 0 ? asc[currentIndex] : undefined;
  const currentPhotos = current?.media.filter((m) => m.type === 'PHOTO') ?? [];
  const photoMediaId = currentPhotos[photoIndex]?.id ?? currentPhotos[0]?.id ?? null;
  const voiceMediaId = current?.media.find((m) => m.type === 'VOICE')?.id ?? null;

  // 播放控制器：单一 audio 元素 + TTS adapter；任何新播放前先停止旧播放
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || controllerRef.current) return;
    let abort: (() => void) | null = null;
    let voiceGeneration = 0;
    controllerRef.current = new PlaybackController({
      playVoice: (mediaId) => {
        const generation = voiceGeneration;
        return ensureMediaUrl(mediaId).then(
          (url) =>
            new Promise<void>((resolve, reject) => {
              if (generation !== voiceGeneration) {
                reject(new Error('audio stopped'));
                return;
              }
              lastVoiceMediaIdRef.current = mediaId;
              const cleanup = () => {
                audio.removeEventListener('playing', onPlaying);
                audio.removeEventListener('error', onError);
                if (generation === voiceGeneration) abort = null;
              };
              const onPlaying = () => {
                cleanup();
                resolve();
              };
              const onError = () => {
                cleanup();
                reject(new Error('audio error'));
              };
              abort = () => {
                cleanup();
                reject(new Error('audio stopped'));
              };
              audio.addEventListener('playing', onPlaying);
              audio.addEventListener('error', onError);
              audio.src = url;
              audio.play().catch((e) => {
                cleanup();
                reject(e instanceof Error ? e : new Error(String(e)));
              });
            }),
        );
      },
      stopVoice: () => {
        voiceGeneration += 1;
        abort?.();
        abort = null;
        audio.pause();
        audio.removeAttribute('src');
        const voiceId = lastVoiceMediaIdRef.current;
        if (voiceId) {
          revokeObjectUrl(voiceId); // 语音 objectURL 用完即回收
          lastVoiceMediaIdRef.current = null;
        }
      },
      tts: getTtsAdapter(),
    });
    return () => {
      playSeqRef.current += 1;
      pendingPlayRef.current = false;
      controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, []);

  // 播放状态跟随真实 audio 事件
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlaying = () => setPlaying(true);
    // 停止旧 audio 的 pause/error 不能清除正在等待的语音或 TTS 状态。
    const onStop = () => { if (!pendingPlayRef.current) setPlaying(false); };
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('ended', onStop);
    audio.addEventListener('pause', onStop);
    audio.addEventListener('error', onStop);
    return () => {
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onStop);
      audio.removeEventListener('pause', onStop);
      audio.removeEventListener('error', onStop);
    };
  }, []);

  // 卸载：回收全部 objectURL（Blob 仍在 IndexedDB，下次启动可重建）
  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    };
  }, []);

  // 自动轮播（US-07）：0/1 张不轮播；播放中禁止；用户操作重置 idle；到末尾循环
  const advanceRef = useRef<() => void>(() => {});
  useEffect(() => {
    carouselRef.current = new AutoCarousel(() => advanceRef.current());
    const carousel = carouselRef.current;
    return () => {
      carousel.stop();
    };
  }, []);
  advanceRef.current = () => {
    if (asc.length === 0) return;
    const idx = currentIdRef.current ? asc.findIndex((p) => p.id === currentIdRef.current) : -1;
    const post = idx >= 0 ? asc[idx] : undefined;
    const photoCount = post?.media.filter((m) => m.type === 'PHOTO').length ?? 0;
    if (photoIndexRef.current + 1 < photoCount) {
      setPhotoIndex((value) => value + 1);
      return;
    }
    setPhotoIndex(0);
    setCurrentId(asc[nextIndexWithWrap(idx, asc.length)]!.id);
  };
  useEffect(() => {
    const count = asc.reduce((total, post) => total + Math.max(1, post.media.filter((m) => m.type === 'PHOTO').length), 0);
    carouselRef.current?.setPhotoCount(count);
  }, [asc]);
  useEffect(() => {
    carouselRef.current?.setPlaying(playing);
  }, [playing]);

  // feed 应用（新照片不抢屏）：首启/首张直接展示；已有照片时新照片只进 feed
  useEffect(() => {
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: hadPostsRef.current,
      currentId: currentIdRef.current,
      newestId: posts[0]?.id ?? null,
      postIdsInFeed: posts.map((p) => p.id),
    });
    if (posts.length > 0) hadPostsRef.current = true;
    if (decision && decision !== currentIdRef.current) {
      setPhotoIndex(0);
      setCurrentId(decision);
    }
  }, [posts]);

  // 切换照片：停止播放，更新未读标记
  useEffect(() => {
    if (currentId === null) return;
    setPhotoIndex(0);
    playSeqRef.current += 1;
    pendingPlayRef.current = false;
    controllerRef.current?.stop();
    setPlaying(false);
    setBadgeVisible(!seenLocalRef.current.has(currentId));
  }, [currentId]);

  useEffect(() => {
    if (photoIndex > 0 && photoIndex >= currentPhotos.length) setPhotoIndex(0);
  }, [currentPhotos.length, photoIndex]);

  // 照片加载/失败（objectURL 在切走/卸载时 revoke）
  useEffect(() => {
    if (!photoMediaId) {
      setPhotoUrl(null);
      setPreviousPhotoUrl(null);
      photoUrlRef.current = null;
      setPhotoError(false);
      return;
    }
    let cancelled = false;
    setPhotoError(false);
    void (async () => {
      try {
        const url = await ensureMediaUrl(photoMediaId);
        if (!cancelled) {
          setPreviousPhotoUrl(photoUrlRef.current && photoUrlRef.current !== url ? photoUrlRef.current : null);
          photoUrlRef.current = url;
          setPhotoUrl(url);
        }
      } catch {
        if (!cancelled) setPhotoError(true);
      }
    })();
    return () => {
      cancelled = true;
      const scheduledUrl = objectUrlsRef.current.get(photoMediaId);
      window.setTimeout(() => {
        if (scheduledUrl && objectUrlsRef.current.get(photoMediaId) === scheduledUrl && photoUrlRef.current !== scheduledUrl) {
          revokeObjectUrl(photoMediaId);
        }
      }, 500);
    };
  }, [photoMediaId]);

  // 后台同步缓存：先存新内容再淘汰；更新本地缓存 feed；补报离线事件
  const syncingRef = useRef(false);
  const lastSyncedKeyRef = useRef<string | null>(null);
  const pendingCountRef = useRef(0);
  const hadFailedMediaRef = useRef(false);
  const completeReceiptRef = useRef(new Set<string>());
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void getLastSyncedFeedKey()
      .then((key) => {
        if (!cancelled) lastSyncedKeyRef.current = key;
      })
      .catch(() => undefined);
    void getPendingFrameEvents()
      .then((pending) => {
        if (!cancelled) pendingCountRef.current = pending.length;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || onlinePosts.length === 0) return;
    const feedKey = computeFeedKey({ posts: onlinePosts, cursor: null, serverTime: '' });
    if (
      !shouldSyncCache({
        feedKey,
        lastSyncedFeedKey: lastSyncedKeyRef.current,
        pendingEventCount: pendingCountRef.current,
        hasFailedMedia: hadFailedMediaRef.current,
      })
    ) {
      return;
    }
    if (syncingRef.current) return;
    syncingRef.current = true;
    void (async () => {
      try {
        const result = await syncOfflineCache({
          fetchFeed: async () => {
            const res = await fetch('/api/frame/feed?limit=50', {
              headers: { 'x-device-token': tokenRef.current ?? '' },
            });
            if (!res.ok) throw new Error(`feed status ${res.status}`);
            return (await res.json()) as FrameFeedResponse;
          },
          fetchMediaBlob: fetchNetworkBlob,
          protectedPostIds: () =>
            currentIdRef.current ? [currentIdRef.current] : [],
          sendEvent: async (ev) => {
            const res = await fetch(`/api/frame/posts/${ev.postId}/${ev.event}`, {
              method: 'POST',
              headers: { 'x-device-token': tokenRef.current ?? '' },
            });
            if (!res.ok) throw new Error(`event status ${res.status}`);
          },
        });
        hadFailedMediaRef.current = result.failedMedia.length > 0;
        if (feedKey) await setLastSyncedFeedKey(feedKey).catch(() => undefined);
        lastSyncedKeyRef.current = feedKey;
        pendingCountRef.current = Math.max(0, pendingCountRef.current - result.flushedEvents);
        for (const id of result.evictedPosts) {
          revokeObjectUrl(id);
          blobCacheRef.current.delete(id);
        }
        const rows = await buildCachedFeed();
        setCachedPosts(rows.length > 0 ? rows : null);
      } catch {
        // 同步失败静默：不影响在线浏览与看照片
    } finally {
      syncingRef.current = false;
    }
  })();
  }, [onlinePosts, token]);

  // 完整落盘后才回报 complete；seen/heard 不能替代此回执。失败随下一次轮询重试。
  useEffect(() => {
    if (!token || onlinePosts.length === 0) return;
    void getExistingMediaIds().then((cachedIds) => {
      for (const post of onlinePosts) {
        const mediaIds = post.media.map((m) => m.id);
        const receiptKey = `${post.id}:${mediaIds.join(',')}`;
        if (completeReceiptRef.current.has(receiptKey) || !mediaIds.every((id) => cachedIds.has(id))) continue;
        void fetch(`/api/frame/posts/${post.id}/complete`, {
          method: 'POST',
          headers: { 'x-device-token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaIds }),
        }).then((res) => {
          if (!res.ok) throw new Error(`complete status ${res.status}`);
          completeReceiptRef.current.add(receiptKey);
        }).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, [onlinePosts, token]);

  // seen/heard 上报：失败时本地记录，恢复后由同步流程 best-effort 补报
  const reportEvent = (postId: string, event: 'seen' | 'heard'): void => {
    const t = tokenRef.current;
    if (!t) return;
    void fetch(`/api/frame/posts/${postId}/${event}`, {
      method: 'POST',
      headers: { 'x-device-token': t },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`event status ${res.status}`);
      })
      .catch(() => {
        pendingCountRef.current += 1;
        void queuePendingFrameEvent(postId, event).catch(() => undefined);
      });
  };

  // 照片真正展示后才上报 seen（PRD §6）
  const onPhotoLoad = (): void => {
    setBadgeVisible(false);
    if (current && !seenLocalRef.current.has(current.id)) {
      seenLocalRef.current.add(current.id);
      reportEvent(current.id, 'seen');
    }
  };

  const stopForNavigation = (): void => {
    playSeqRef.current += 1;
    pendingPlayRef.current = false;
    controllerRef.current?.stop();
    setPlaying(false);
  };

  const goPrev = (): void => {
    carouselRef.current?.notifyUserActivity();
    stopForNavigation();
    if (photoIndex > 0) {
      setPhotoIndex((value) => value - 1);
    } else if (currentIndex > 0) {
      setCurrentId(asc[currentIndex - 1]!.id);
    }
  };
  const goNext = (): void => {
    carouselRef.current?.notifyUserActivity();
    stopForNavigation();
    if (photoIndex + 1 < currentPhotos.length) {
      setPhotoIndex((value) => value + 1);
    } else if (currentIndex >= 0 && currentIndex < asc.length - 1) {
      setCurrentId(asc[currentIndex + 1]!.id);
    }
  };

  // 点照片 / 🔊：真人语音优先，其次 TTS，无声音时保持看照片（离线时语音来自本地缓存）
  const handlePlay = async (): Promise<void> => {
    const controller = controllerRef.current;
    if (!controller || !current) return;
    carouselRef.current?.notifyUserActivity();
    const seq = ++playSeqRef.current;
    pendingPlayRef.current = true;
    setPlaying(!!voiceMediaId || !!current.messageText?.trim());
    const result = await controller.play({
      voiceSource: voiceMediaId,
      memberName: current.member.displayName,
      messageText: current.messageText,
    });
    if (seq !== playSeqRef.current) return;
    pendingPlayRef.current = false;
    if (result === 'voice' || result === 'tts') {
      reportEvent(current.id, 'heard');
      setPlaying(result === 'voice' && !!audioRef.current && !audioRef.current.paused && !audioRef.current.ended);
    } else {
      setPlaying(false);
    }
  };

  const saveToken = (value: string): void => {
    setTokenInvalid(false);
    localStorage.setItem(TOKEN_KEY, value);
    setToken(value);
  };

  return (
    <div className="frame-root" data-conn={conn}
      onPointerDownCapture={() => carouselRef.current?.notifyUserActivity()}
      onKeyDownCapture={() => carouselRef.current?.notifyUserActivity()}>
      <audio ref={audioRef} style={{ display: 'none' }} />

      {!token || tokenInvalid ? (
        <TokenSetup invalid={tokenInvalid} onSave={saveToken} />
      ) : posts.length === 0 ? (
        <div className="frame-empty">还没有收到照片，等家人发照片来吧</div>
      ) : (
        <main className="frame-main">
          <div
            className="frame-stage"
            data-post-id={current?.id ?? ''}
            role="button"
            tabIndex={0}
            aria-label="播放这条留言"
            onClick={handlePlay}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void handlePlay();
              }
            }}
          >
            {photoUrl ? (
              <>
                {previousPhotoUrl && <img className="frame-photo-previous" src={previousPhotoUrl} alt="" aria-hidden="true" />}
                <img className="frame-photo-incoming" src={photoUrl} alt="家人发来的照片" onLoad={onPhotoLoad} onError={() => setPhotoError(true)} />
              </>
            ) : photoError ? (
              <div className="frame-photo-error">照片暂时无法显示</div>
            ) : (
              <div className="frame-photo-loading" aria-hidden="true" />
            )}
            {badgeVisible && current && <span className="frame-badge" aria-hidden="true" />}
          </div>

          {current?.messageText?.trim() && (
            <section className="frame-message" aria-label="家人留言">
              <span className="frame-message-author">{current.member.displayName}说：</span>
              <p>{current.messageText.trim()}</p>
            </section>
          )}

          <div className="frame-bar">
            <button
              type="button"
              className="frame-btn"
              onClick={goPrev}
              disabled={currentIndex <= 0 && photoIndex <= 0}
              aria-label="上一张"
            >
              <span className="frame-icon" aria-hidden="true">
                ←
              </span>
              <span className="frame-label">上一张</span>
            </button>
            <button
              type="button"
              className="frame-btn frame-btn-play"
              onClick={handlePlay}
              aria-label="播放留言"
              aria-pressed={playing}
            >
              <span className="frame-icon" aria-hidden="true">
                🔊
              </span>
              <span className="frame-label">{playing ? '播放中…' : '播放'}</span>
            </button>
            <button
              type="button"
              className="frame-btn"
              onClick={goNext}
              disabled={currentIndex < 0 || (currentIndex >= asc.length - 1 && photoIndex + 1 >= currentPhotos.length)}
              aria-label="下一张"
            >
              <span className="frame-icon" aria-hidden="true">
                →
              </span>
              <span className="frame-label">下一张</span>
            </button>
          </div>
        </main>
      )}

      <span className="frame-conn" data-conn={conn} title={`连接状态：${conn}`} aria-hidden="true" />
    </div>
  );
}
