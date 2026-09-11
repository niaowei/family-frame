/**
 * 统一 TTS Adapter（PRD §13）。
 * 业务层只依赖 TtsAdapter 接口，禁止直接调用 speechSynthesis——
 * 未来从 PWA 切到 Android APK（M6）时只需替换 adapter，不用改业务代码。
 */

export interface TtsAdapter {
  supported(): boolean;
  /** 播报文本；resolve 表示本次播报成功执行完成，reject 表示失败（含不支持/被打断） */
  speak(text: string): Promise<void>;
  stop(): void;
}

/** 浏览器 Web Speech API 实现 */
export class WebSpeechTtsAdapter implements TtsAdapter {
  private cancelPending: (() => void) | null = null;

  supported(): boolean {
    return typeof window !== 'undefined' && !!window.speechSynthesis
      && typeof window.speechSynthesis.speak === 'function'
      && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  speak(text: string): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      if (!this.supported()) {
        reject(new Error('tts unsupported'));
        return;
      }
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      const finish = (error?: Error) => {
        clearTimeout(timer);
        utterance.onstart = utterance.onend = utterance.onerror = null;
        this.cancelPending = null;
        if (error) { synth.cancel(); reject(error); }
        else resolve();
      };
      // ponytail: 不重试不模拟点击；浏览器无回调时释放播放锁，原生 TTS 留待 APK。
      let timer = setTimeout(() => finish(new Error('tts start timeout')), 5000);
      this.cancelPending = () => finish(new Error('tts stopped'));
      utterance.onstart = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('tts end timeout')), 120_000);
      };
      utterance.onend = () => finish();
      utterance.onerror = (e) => finish(new Error(`tts error: ${e.error}`));
      try { synth.speak(utterance); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  stop(): void {
    this.cancelPending?.();
    if (this.supported()) window.speechSynthesis.cancel();
  }
}

/** 不支持 TTS 时的空实现：speak 直接失败，业务回退到「只看照片」（PRD 播放优先级第三级） */
export class NullTtsAdapter implements TtsAdapter {
  supported(): boolean {
    return false;
  }

  speak(): Promise<void> {
    return Promise.reject(new Error('tts unsupported'));
  }

  stop(): void {
    // 无操作
  }
}

/**
 * Android WebView 桥接占位（PRD §16 / M6 实现）。
 * 本阶段不实现任何 Android 原生功能；仅当未来 APK 注入 window.FamilyFrameAndroid 时才会被选中。
 */
export class AndroidBridgeTtsAdapter implements TtsAdapter {
  private bridge(): { speak?: (text: string) => void; stopSpeech?: () => void } | null {
    if (typeof window === 'undefined') return null;
    return (window as unknown as { FamilyFrameAndroid?: { speak?: (text: string) => void; stopSpeech?: () => void } })
      .FamilyFrameAndroid ?? null;
  }

  supported(): boolean {
    return typeof this.bridge()?.speak === 'function';
  }

  speak(text: string): Promise<void> {
    const bridge = this.bridge();
    if (!bridge?.speak) return Promise.reject(new Error('android bridge unavailable'));
    // M6 将补齐完成回调；当前占位在调用后立即 resolve
    bridge.speak(text);
    return Promise.resolve();
  }

  stop(): void {
    this.bridge()?.stopSpeech?.();
  }
}

/** 选择当前环境可用的 TTS 实现：Android 桥 > Web Speech > Null */
export function getTtsAdapter(): TtsAdapter {
  const android = new AndroidBridgeTtsAdapter();
  if (android.supported()) return android;
  const webSpeech = new WebSpeechTtsAdapter();
  if (webSpeech.supported()) return webSpeech;
  return new NullTtsAdapter();
}
