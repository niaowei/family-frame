import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { compressImage, ImageDecodeError } from '../lib/image';
import type { CompressedImage } from '../lib/image';
import { isRecordingSupported, MAX_VOICE_MS, VoiceRecorder } from '../lib/recorder';
import type { VoiceRecording } from '../lib/recorder';
import { uploadFile } from '../lib/upload';
import { useMe, useRequireLogin } from '../App';

/**
 * /send（PRD §8 / US-01/02/03）：
 * 选照片（1-9，自动压缩）→ 文字留言（0-80 字）→ 可选录音（≤30s，可试听/重录）→ 发送。
 * 上传走 presign 直传 S3，带百分比进度；失败可重试（已上传成功的文件不会重复上传）。
 */

const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTOS = 9;
const MAX_MESSAGE_CHARS = 80;

interface PhotoItem {
  id: string;
  compressed: CompressedImage;
  previewUrl: string;
  progress: number;
  uploadedKey?: string;
}

interface VoiceItem extends VoiceRecording {
  previewUrl: string;
}

let photoSeq = 0;

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SendPage() {
  const { member, loading } = useMe();
  const ready = useRequireLogin(member, loading);

  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [video, setVideo] = useState<File | null>(null);
  const [videoProgress, setVideoProgress] = useState(0);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!video) { setVideoPreview(null); return; }
    const url = URL.createObjectURL(video);
    setVideoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);
  const [message, setMessage] = useState('');
  const [voice, setVoice] = useState<VoiceItem | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const [recording, setRecording] = useState(false);
  const [recordingPending, setRecordingPending] = useState(false);
  const holdingRef = useRef(false);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recordingSupported] = useState(isRecordingSupported);

  useEffect(() => {
    return () => {
      // 卸载时释放所有 objectURL 与录音资源
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      if (voice) URL.revokeObjectURL(voice.previewUrl);
      recorderRef.current?.cancel();
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, []);

  const onPickPhotos = async (e: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许重复选择同一文件
    if (files.length === 0) return;

    const heic = files.find((f) => /image\/hei[cf]/.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (heic) {
      setError('暂不支持 iPhone 的 HEIC 格式：请在手机设置 → 相机 → 格式中改为「兼容性最佳」，或换用 JPG 图片');
      return;
    }

    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) {
      setNotice(`一次最多发送 ${MAX_PHOTOS} 张，已只添加前 ${room} 张`);
    }
    const accepted = files.slice(0, Math.max(0, room));

    for (const file of accepted) {
      const extOk = ALLOWED_PHOTO_TYPES.includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
      if (!extOk) {
        setError('仅支持 JPG / PNG / WebP 图片');
        continue;
      }
      try {
        const compressed = await compressImage(file);
        const item: PhotoItem = {
          id: `photo-${++photoSeq}`,
          compressed,
          previewUrl: URL.createObjectURL(compressed.blob),
          progress: 0,
        };
        setPhotos((prev) => [...prev, item]);
      } catch (err) {
        if (err instanceof ImageDecodeError) {
          setError(err.message);
        } else {
          setError('图片处理失败，请换一张试试');
        }
      }
    }
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const startRecording = async () => {
    if (recorderRef.current || startingRef.current || sending) return;
    holdingRef.current = true;
    startingRef.current = true;
    setRecordingPending(true);
    setError(null);
    try {
      const recorder = new VoiceRecorder();
      recorderRef.current = recorder;
      setElapsedMs(0);
      await recorder.start(() => {
        void stopRecording();
      });
      startingRef.current = false;
      setRecordingPending(false);
      if (recorderRef.current !== recorder) return;
      if (!holdingRef.current) { await stopRecording(); return; }
      setRecording(true);
      elapsedTimerRef.current = setInterval(() => {
        setElapsedMs((ms) => Math.min(MAX_VOICE_MS, ms + 200));
      }, 200);
    } catch (err) {
      if (!recorderRef.current) return;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') {
        setError('麦克风权限被拒绝，请在浏览器设置中允许后重试');
      } else {
        setError('无法开始录音，请重试');
      }
      recorderRef.current?.cancel();
      recorderRef.current = null;
    } finally {
      startingRef.current = false;
      setRecordingPending(false);
    }
  };

  const stopRecording = async () => {
    holdingRef.current = false;
    if (startingRef.current || stoppingRef.current) return;
    const recorder = recorderRef.current;
    if (!recorder) return;
    stoppingRef.current = true;
    try {
      const result = await recorder.stop();
      if (recorderRef.current !== recorder) return;
      if (!result.blob.size || result.durationMs < 300) { setError('录音太短，请按住按钮说话，松开结束'); return; }
      if (voice) URL.revokeObjectURL(voice.previewUrl);
      setVoice({ ...result, previewUrl: URL.createObjectURL(result.blob) });
    } catch {
      setError('录音保存失败，请重录');
    } finally {
      setRecording(false);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      recorderRef.current = null;
      stoppingRef.current = false;
    }
  };

  const removeVoice = () => {
    if (voice) URL.revokeObjectURL(voice.previewUrl);
    setVoice(null);
  };

  const updateProgress = (id: string, percent: number) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, progress: percent } : p)));
  };

  const onSubmit = async () => {
    setError(null);
    setNotice(null);
    if (photos.length === 0 && !video) {
      setError('请选择照片或一个视频');
      return;
    }
    setSending(true);
    try {
      if (video) {
        const { key } = await uploadFile(video, 'video', setVideoProgress);
        await api('/api/posts', {
          method: 'POST',
          body: JSON.stringify({ messageText: message.trim(), videoKey: key }),
        });
        setVideo(null);
        setVideoProgress(0);
        setMessage('');
        setSent(true);
        window.setTimeout(() => setSent(false), 5000);
        return;
      }
      // 逐个直传（已成功的跳过，支持重试不重复上传）
      for (const photo of photos) {
        if (photo.uploadedKey) continue;
        const { key } = await uploadFile(photo.compressed.blob, 'photo', (percent) =>
          updateProgress(photo.id, percent),
        );
        setPhotos((prev) =>
          prev.map((p) => (p.id === photo.id ? { ...p, uploadedKey: key } : p)),
        );
        photo.uploadedKey = key; // 同步更新本地引用，避免读取旧 state
      }
      let voiceKey: string | undefined;
      if (voice && !recording) {
        const { key } = await uploadFile(voice.blob, 'voice');
        voiceKey = key;
      }

      const photoItems = photos.map((p) => ({ ...p }));
      await api('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          messageText: message.trim(),
          photoKeys: photoItems.map((p) => p.uploadedKey!),
          ...(voiceKey ? { voiceKey } : {}),
          photoMeta: Object.fromEntries(
            photoItems.map((p) => [
              p.uploadedKey!,
              { width: p.compressed.width, height: p.compressed.height },
            ]),
          ),
          ...(voice ? { voiceDurationMs: voice.durationMs } : {}),
        }),
      });

      // 成功：清空表单，展示明确「已发送」（US-01）
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      removeVoice();
      setPhotos([]);
      setMessage('');
      setSent(true);
      window.setTimeout(() => setSent(false), 5000);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : '发送失败，请重试');
      }
    } finally {
      setSending(false);
    }
  };

  if (!ready) return null;

  const remaining = MAX_MESSAGE_CHARS - message.trim().length;

  return (
    <main className="page">
      <p className="page-eyebrow">发给奶奶</p>
      <h1>分享今天的小日常</h1>
      <p className="page-subtitle">一张照片，一句话，她就知道你过得很好。</p>

      {sent && <p className="success-banner" role="status">已发送 ✓ 奶奶的相框很快就会收到</p>}

      <section className="card">
        <h2>选择照片（最多 {MAX_PHOTOS} 张）</h2>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          multiple
          onChange={onPickPhotos}
          disabled={sending || !!video || photos.length >= MAX_PHOTOS}
        />
        {photos.length > 0 && (
          <div className="photo-grid">
            {photos.map((p) => (
              <figure key={p.id} className="photo-cell">
                <img src={p.previewUrl} alt="待发送照片" />
                <figcaption>
                  {p.compressed.width}×{p.compressed.height}
                  {p.uploadedKey || p.progress === 100 ? ' · 已上传' : p.progress > 0 ? ` · 上传中 ${p.progress}%` : ''}
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => removePhoto(p.id)}
                    disabled={sending}
                  >
                    移除
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>或选择一个视频</h2>
        <p className="muted">MP4 格式，最多 50MB，建议发送短视频。视频单独发送。</p>
        <input type="file" accept="video/mp4,.mp4" disabled={sending || photos.length > 0 || recording || !!voice}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setError(null);
            if (!/\.mp4$/i.test(file.name) || (file.type && file.type !== 'video/mp4')) {
              setError('请先将视频转为 MP4 格式'); return;
            }
            if (!file.size || file.size > 50 * 1024 * 1024) {
              setError('请选择不超过 50MB 的视频'); return;
            }
            setVideo(file.type ? file : new File([file], file.name, { type: 'video/mp4' }));
            setVideoProgress(0);
          }} />
        {videoPreview && <video src={videoPreview} controls playsInline preload="metadata" style={{ width: '100%', maxHeight: 300 }} />}
        {video && <p>{video.name} · {(video.size / 1024 / 1024).toFixed(1)}MB
          {sending && ` · 上传 ${videoProgress}%`}
          <button type="button" className="link-button" disabled={sending} onClick={() => setVideo(null)}>移除</button>
        </p>}
      </section>

      <details className="card">
        <summary>附加留言（可选）</summary>
        <h2>写一句话</h2>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS + 20))}
          maxLength={MAX_MESSAGE_CHARS + 20}
          placeholder="例如：奶奶，这是我今天出去玩的照片。"
          rows={3}
          disabled={sending}
        />
        <p className="muted">还可输入 {Math.max(0, remaining)} 个字（最多 {MAX_MESSAGE_CHARS} 字）</p>
      </details>

      {!video && <details className="card">
        <summary>附加录音（可选）</summary>
        {!recordingSupported && (
          <p className="muted">当前浏览器不支持录音，不影响发送照片。可以用系统浏览器（Chrome / Safari）录音。</p>
        )}
        {recordingSupported && (
          <div className="voice-row">
            <button type="button" className={recording ? 'danger-button' : 'primary-button'} disabled={sending}
              style={{ touchAction: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
              aria-label="按住说话，松开结束录音" aria-pressed={recording}
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => { if (!e.isPrimary || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); void startRecording(); }}
              onPointerUp={() => void stopRecording()} onPointerCancel={() => void stopRecording()}
              onLostPointerCapture={() => void stopRecording()} onBlur={() => void stopRecording()}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) void startRecording(); } }}
              onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); void stopRecording(); } }}>
              {recordingPending ? '正在打开麦克风…' : recording ? `松开结束（${formatDuration(elapsedMs)} / 0:30）` : voice ? '按住重新录音' : '按住说话'}
            </button>
            {voice && !recording && (
              <>
                <audio controls src={voice.previewUrl} />
                <span className="muted">{formatDuration(voice.durationMs)}</span>
                <button type="button" className="link-button" onClick={removeVoice} disabled={sending}>
                  重录
                </button>
              </>
            )}
          </div>
        )}
      </details>}

      {error && (
        <p className="error-text" role="alert">
          {error}
          {photos.some((p) => p.uploadedKey) && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onSubmit} disabled={sending}>
                重试
              </button>
            </>
          )}
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <button
        type="button"
        className="primary-button send-button"
        onClick={onSubmit}
        disabled={sending || recording || recordingPending || (photos.length === 0 && !video)}
      >
        {sending ? '发送中…' : '发送给奶奶'}
      </button>
    </main>
  );
}
