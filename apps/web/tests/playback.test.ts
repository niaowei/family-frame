import { describe, expect, it } from 'vitest';
import { buildTtsText, PlaybackController } from '../src/frame/playback';
import type { TtsAdapter } from '../src/frame/TtsAdapter';

/**
 * 播放优先级与互斥（PRD §11/§13/§25）：
 * 真人语音 → TTS → 无声音；任何新播放前必须停止旧播放，绝不叠加。
 * 通过注入假播放器测试控制逻辑本身（E2E 另行真实验证）。
 */

function makeVoiceFake() {
  const plays: string[] = [];
  let stopCount = 0;
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  return {
    plays,
    get stopCount() {
      return stopCount;
    },
    playVoice: (source: string) =>
      new Promise<void>((resolve, reject) => {
        plays.push(source);
        pending = { resolve, reject };
      }),
    stopVoice: () => {
      stopCount += 1;
      pending?.reject(new Error('voice stopped'));
      pending = null;
    },
    startPlaying: () => {
      pending?.resolve();
      pending = null;
    },
    failPlaying: () => {
      pending?.reject(new Error('voice failed'));
      pending = null;
    },
  };
}

function makeTtsFake() {
  const speakCalls: string[] = [];
  let stopCount = 0;
  let pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  const tts: TtsAdapter = {
    supported: () => true,
    speak: (text: string) =>
      new Promise<void>((resolve, reject) => {
        speakCalls.push(text);
        pending = { resolve, reject };
      }),
    stop: () => {
      stopCount += 1;
    },
  };
  return {
    speakCalls,
    tts,
    get stopCount() {
      return stopCount;
    },
    finishTts: () => {
      pending?.resolve();
      pending = null;
    },
  };
}

describe('buildTtsText', () => {
  it('有留言：这是{成员名}发来的照片。{留言}', () => {
    expect(buildTtsText('维', '今天出去玩啦')).toBe('这是维发来的照片。今天出去玩啦');
  });

  it('没有留言 / 纯空白：不播报无意义内容', () => {
    expect(buildTtsText('维', null)).toBeNull();
    expect(buildTtsText('维', '   ')).toBeNull();
  });
});

describe('PlaybackController', () => {
  it('音频优先于 TTS：有真人语音时完全不调用 TTS', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p = controller.play({ voiceSource: 'm1', memberName: '维', messageText: '你好奶奶' });
    expect(voice.plays).toEqual(['m1']);
    expect(ttsF.speakCalls).toEqual([]); // 语音进行中不启动 TTS

    voice.startPlaying();
    expect(await p).toBe('voice');
    expect(ttsF.speakCalls).toEqual([]); // 语音成功后也不播 TTS
  });

  it('没有真人语音时 TTS 回退，文案符合格式', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p = controller.play({ voiceSource: null, memberName: '维', messageText: '今天出去玩啦' });
    expect(voice.plays).toEqual([]);
    expect(ttsF.speakCalls).toEqual(['这是维发来的照片。今天出去玩啦']);

    ttsF.finishTts();
    expect(await p).toBe('tts');
  });

  it('没有留言且无语音 → none：不播报无意义内容', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const result = await controller.play({ voiceSource: null, memberName: '维', messageText: '   ' });
    expect(result).toBe('none');
    expect(ttsF.speakCalls).toEqual([]);
  });

  it('真人语音失败 → 回退 TTS（PRD 优先级链）', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p = controller.play({ voiceSource: 'm-broken', memberName: '维', messageText: '晚安' });
    voice.failPlaying();
    // 等待拒绝微任务传播到控制器的回退逻辑
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsF.speakCalls).toEqual(['这是维发来的照片。晚安']);
    ttsF.finishTts();
    expect(await p).toBe('tts');
  });

  it('TTS 不支持（Null adapter 语义）→ none，不阻塞看照片', async () => {
    const voice = makeVoiceFake();
    const nullTts: TtsAdapter = { supported: () => false, speak: () => Promise.reject(new Error('unsupported')), stop: () => undefined };
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: nullTts });

    const result = await controller.play({ voiceSource: null, memberName: '维', messageText: '你好' });
    expect(result).toBe('none');
    expect(voice.plays).toEqual([]);
  });

  it('快速连续点击：新播放前先停止旧播放，绝不叠加', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p1 = controller.play({ voiceSource: 'm1', memberName: '维', messageText: 'A' });
    const p2 = controller.play({ voiceSource: 'm2', memberName: '维', messageText: 'B' });

    // 第二次 play 必须先停止第一次（stopVoice 已调用，旧播放 promise 被拒绝）
    expect(voice.stopCount).toBeGreaterThanOrEqual(1);
    expect(await p1).toBe('stopped');
    expect(voice.plays).toEqual(['m1', 'm2']); // 两个播放请求都发生了，但从未同时进行

    voice.startPlaying();
    expect(await p2).toBe('voice');
  });

  it('被停止的旧播放不误触发 TTS 回退、不误报 heard 状态', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p1 = controller.play({ voiceSource: 'm1', memberName: '维', messageText: 'A' });
    const p2 = controller.play({ voiceSource: null, memberName: '维', messageText: 'B' });
    await p1; // A 被停止 → stopped；其语音失败不得触发 A 的 TTS 回退
    expect(ttsF.speakCalls).toEqual(['这是维发来的照片。B']); // 只有 B 的 TTS
    ttsF.finishTts();
    expect(await p2).toBe('tts');
  });

  it('重复点击同一张照片：旧播放先停，新播放重新开始', async () => {
    const voice = makeVoiceFake();
    const ttsF = makeTtsFake();
    const controller = new PlaybackController({ playVoice: voice.playVoice, stopVoice: voice.stopVoice, tts: ttsF.tts });

    const p1 = controller.play({ voiceSource: 'm1', memberName: '维', messageText: null });
    const p2 = controller.play({ voiceSource: 'm1', memberName: '维', messageText: null });
    expect(await p1).toBe('stopped');
    voice.startPlaying();
    expect(await p2).toBe('voice');
    expect(voice.plays).toEqual(['m1', 'm1']);
    expect(ttsF.speakCalls).toEqual([]);
  });
});
