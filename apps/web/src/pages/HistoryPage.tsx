import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useMe, useRequireLogin } from '../App';
import type { HistoryResponse, PostSummary } from '@family-frame/shared';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HistoryPage() {
  const { member, loading } = useMe();
  const ready = useRequireLogin(member, loading);
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [summary, setSummary] = useState({ yesterdayPhotoCount: 0, pendingPostCount: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadingPosts(true);
    setError(null);
    try {
      const res = await api<HistoryResponse>('/api/posts');
      setPosts(res.posts);
      setSummary({ yesterdayPhotoCount: res.yesterdayPhotoCount, pendingPostCount: res.pendingPostCount });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载失败，请稍后重试');
    } finally {
      setLoadingPosts(false);
    }
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const onDelete = async (id: string) => {
    if (!window.confirm('确定删除这条内容吗？删除后相框将不再显示。')) return;
    setDeletingId(id);
    try {
      await api(`/api/posts/${id}`, { method: 'DELETE' });
      setPosts((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败，请稍后重试');
    } finally {
      setDeletingId(null);
    }
  };

  if (!ready) return null;

  const canDelete = (post: PostSummary): boolean =>
    member?.role === 'ADMIN' || post.member.id === member?.id;

  return (
    <main className="page">
      <div className="page-header-row">
        <h1>发送历史</h1>
        <button type="button" className="link-button" onClick={() => void load()} disabled={loadingPosts}>
          刷新
        </button>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      {loadingPosts && <p className="muted">加载中…</p>}

      {!loadingPosts && <p className="muted">昨日已发送 {summary.yesterdayPhotoCount} 张照片{summary.pendingPostCount > 0 ? ` · 待相框保存 ${summary.pendingPostCount} 条` : ''}</p>}



      {!loadingPosts && posts.length === 0 && !error && (
        <p className="muted">还没有发送过内容，去「发送」页给奶奶发第一张照片吧。</p>
      )}

      <ul className="history-list">
        {posts.map((post) => {
          const photo = post.media.find((m) => m.type === 'PHOTO');
          const voice = post.media.find((m) => m.type === 'VOICE');
          const video = post.media.find((m) => m.type === 'VIDEO');
          return (
            <li key={post.id} className="history-item card">
              <div className="history-body">
                {video ? <video className="history-thumb" controls playsInline preload="none" src={`/api/media/${video.id}`} aria-label="已发送的视频" /> : photo ? (
                  <img className="history-thumb" src={`/api/media/${photo.id}`} alt="照片缩略图" loading="lazy" />
                ) : (
                  <div className="history-thumb history-thumb-empty" aria-hidden="true" />
                )}
                <div className="history-text">
                  {post.messageText && <p className="history-message">{post.messageText}</p>}
                  {!post.messageText && <p className="muted">（没有留言）</p>}
                  <p className="muted">
                    {post.member.displayName} · {formatTime(post.createdAt)}
                    {voice && ` · 含语音 ${voice.durationMs ? Math.round(voice.durationMs / 1000) + '秒' : ''}`}
                  </p>
                </div>
              </div>
              {canDelete(post) && (
                <button
                  type="button"
                  className="danger-button"
                  onClick={() => onDelete(post.id)}
                  disabled={deletingId === post.id}
                >
                  {deletingId === post.id ? '删除中…' : '删除'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
