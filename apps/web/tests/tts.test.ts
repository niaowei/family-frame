import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSpeechTtsAdapter } from '../src/frame/TtsAdapter';

class Utterance {
  lang = '';
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
}
let current: Utterance;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  vi.stubGlobal('window', { speechSynthesis: {
    speak: (u: Utterance) => { current = u; }, cancel: vi.fn(),
  } });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('存在 API 不代表能朗读：没有 start 回调则失败并释放等待', async () => {
  const adapter = new WebSpeechTtsAdapter();
  expect(adapter.supported()).toBe(true);
  const check = expect(adapter.speak('你好奶奶')).rejects.toThrow('start timeout');
  vi.advanceTimersByTime(5000);
  await check;
});
it('真实 start/end 回调成功完成中文播报', async () => {
  const adapter = new WebSpeechTtsAdapter();
  const result = adapter.speak('你好奶奶');
  expect(current.lang).toBe('zh-CN');
  current.onstart?.();
  vi.advanceTimersByTime(10_000);
  current.onend?.();
  await expect(result).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it('stop 在浏览器不发取消回调时仍结算旧请求', async () => {
  const adapter = new WebSpeechTtsAdapter();
  const result = expect(adapter.speak('你好')).rejects.toThrow('stopped');
  adapter.stop();
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
it('error 回调返回失败', async () => {
  const result = expect(new WebSpeechTtsAdapter().speak('你好')).rejects.toThrow('language-unavailable');
  current.onerror?.({ error: 'language-unavailable' });
  await result;
});
it('缺少 utterance API 判为不支持', () => {
  vi.stubGlobal('SpeechSynthesisUtterance', undefined);
  expect(new WebSpeechTtsAdapter().supported()).toBe(false);
});
