import type { TtsAdapter } from './TtsAdapter';

/**
 * 播放优先级（PRD §11 / §25）：
 *   1. 真人 voice media
 *   2. messageText + TTS（文案：这是{成员名}发来的照片。{留言}）
 *   3. 无声音，保持看照片
 * 任意时刻不允许两个声音同时播放：每次 play 前先 stop，
 * 并用序列号保证被停止的旧播放不会触发 TTS 回退或误报 heard。
 */

/** 没有留言时不播报无意义内容：返回 null 表示无可播报文本 */
export function buildTtsText(memberName: string, messageText: string | null): string | null {
  const message = messageText?.trim() ?? '';
  if (!message) return null;
  return `这是${memberName}发来的照片。${message}`;
}

export type PlayResult = 'voice' | 'tts' | 'none' | 'stopped';

export interface PlaybackDeps {
  /**
   * 播放真人语音；resolve = 已实际开始播放；reject = 失败或被 stop。
   * source 为不透明字符串（相框端传 media id，由实现层解析为可播放地址）。
   */
  playVoice(source: string): Promise<void>;
  stopVoice(): void;
  tts: TtsAdapter;
}

export interface PlayablePost {
  voiceSource?: string | null;
  memberName: string;
  messageText: string | null;
}

export class PlaybackController {
  private seq = 0;

  constructor(private readonly deps: PlaybackDeps) {}

  /** 停止当前真人音频与当前 TTS（任何新播放开始前必须调用） */
  stop(): void {
    this.seq += 1;
    this.deps.stopVoice();
    this.deps.tts.stop();
  }

  async play(post: PlayablePost): Promise<PlayResult> {
    this.stop();
    this.seq += 1;
    const seq = this.seq;

    if (post.voiceSource) {
      try {
        await this.deps.playVoice(post.voiceSource);
        return seq === this.seq ? 'voice' : 'stopped';
      } catch {
        if (seq !== this.seq) return 'stopped';
        // 真人语音失败 → 回退下一级（TTS）
      }
    }

    const text = buildTtsText(post.memberName, post.messageText);
    if (text) {
      try {
        await this.deps.tts.speak(text);
        return seq === this.seq ? 'tts' : 'stopped';
      } catch {
        if (seq !== this.seq) return 'stopped';
        // TTS 失败 → 只看照片
      }
    }
    return 'none';
  }
}
