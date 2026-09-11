/**
 * 真人语音录制（PRD §12 / US-03）：
 * - 用 MediaRecorder.isTypeSupported() 检测格式，不写死 MIME；
 * - 最长 30 秒自动停止；
 * - 支持试听 / 重录；
 * - 不支持录音时返回 null（不阻塞照片发送）。
 */

export const MAX_VOICE_MS = 30_000;

const CANDIDATE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

export interface VoiceRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const mime of CANDIDATE_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    pickRecorderMime() !== null
  );
}

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType: string;
  private startedAt = 0;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private stream: MediaStream | null = null;
  private result: Promise<VoiceRecording> | null = null;
  private cancelled = false;

  constructor() {
    const mime = pickRecorderMime();
    if (!mime) throw new Error('当前浏览器不支持录音');
    this.mimeType = mime;
  }

  async start(onMaxReached?: () => void): Promise<void> {
    if (this.recorder) throw new Error('已在录音中');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (this.cancelled) { this.cleanup(); throw new Error('录音已取消'); }
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.result = new Promise((resolve, reject) => {
      this.recorder!.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mimeType.split(';')[0] ?? this.mimeType });
        const durationMs = Math.min(MAX_VOICE_MS, Date.now() - this.startedAt);
        this.cleanup();
        resolve({ blob, mimeType: this.mimeType, durationMs });
      };
      this.recorder!.onerror = () => { this.cleanup(); reject(new Error('录音失败，请重试')); };
    });
    void this.result.catch(() => undefined); // 错误由 stop() 交回页面，避免停止前产生未处理拒绝。
    this.startedAt = Date.now();
    this.recorder.start(250);
    this.maxTimer = setTimeout(() => {
      if (this.recorder?.state === 'recording') {
        this.recorder.stop();
        onMaxReached?.();
      }
    }, MAX_VOICE_MS);
  }

  /** 松手、时长上限或重复停止都取得同一份录音。 */
  async stop(): Promise<VoiceRecording> {
    const recorder = this.recorder;
    if (!this.result) throw new Error('没有正在进行的录音');
    if (recorder?.state === 'recording') recorder.stop();
    return this.result;
  }

  /** 取消录音（丢弃数据，不抛错） */
  cancel(): void {
    this.cancelled = true;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      // 忽略
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
