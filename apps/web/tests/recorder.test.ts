import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_VOICE_MS, VoiceRecorder } from '../src/lib/recorder';

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] };
class Recorder {
  static isTypeSupported = () => true;
  state = 'inactive';
  ondataavailable?: (e: { data: Blob }) => void;
  onstop?: () => void;
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['test voice']) });
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers(); stopTrack.mockClear();
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('松手停止后可取得并试听录音，重复停止不丢失结果', async () => {
  const recorder = new VoiceRecorder(); await recorder.start();
  vi.advanceTimersByTime(1200);
  const first = await recorder.stop(); const second = await recorder.stop();
  expect(first.blob.size).toBeGreaterThan(0); expect(first.durationMs).toBe(1200);
  expect(second).toBe(first); expect(stopTrack).toHaveBeenCalledTimes(1);
});

it('达到 30 秒自动结束后，录音仍可获取且麦克风已释放', async () => {
  const recorder = new VoiceRecorder(); const onMax = vi.fn(); await recorder.start(onMax);
  vi.advanceTimersByTime(MAX_VOICE_MS);
  expect(onMax).toHaveBeenCalledOnce(); expect(stopTrack).toHaveBeenCalledOnce();
  const result = await recorder.stop(); expect(result.durationMs).toBe(MAX_VOICE_MS); expect(result.blob.size).toBeGreaterThan(0);
});

it('请求权限期间退出，后来授权也不能偷偷开始录音', async () => {
  let allow!: (value: typeof stream) => void;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise((resolve) => { allow = resolve; }) } });
  const recorder = new VoiceRecorder(); const pending = recorder.start();
  recorder.cancel(); allow(stream);
  await expect(pending).rejects.toThrow('录音已取消'); expect(stopTrack).toHaveBeenCalledOnce();
});
