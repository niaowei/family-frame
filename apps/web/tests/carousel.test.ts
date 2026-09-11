import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoCarousel, CAROUSEL_IDLE_MS, CAROUSEL_INTERVAL_MS, nextIndexWithWrap } from '../src/frame/carousel';

const minute = 60_000;
describe('AutoCarousel', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('20 分钟后换图，之后每 20 分钟换图', () => {
    expect(CAROUSEL_IDLE_MS).toBe(20 * minute);
    expect(CAROUSEL_INTERVAL_MS).toBe(20 * minute);
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(3);
    vi.advanceTimersByTime(19 * minute + 59_000);
    expect(carousel.isAutomatic).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(advance).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20 * minute);
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it('操作立即退出轮播，重新等 20 分钟', () => {
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(2);
    vi.advanceTimersByTime(24 * minute);
    carousel.notifyUserActivity();
    expect(carousel.isAutomatic).toBe(false);
    vi.advanceTimersByTime(19 * minute);
    carousel.notifyUserActivity();
    vi.advanceTimersByTime(20 * minute - 1);
    expect(carousel.isAutomatic).toBe(false);
    vi.advanceTimersByTime(1);
    expect(carousel.isAutomatic).toBe(true);
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it.each(['真人语音', 'TTS'])('%s 期间禁止换图，播放结束后重新等 20 分钟', () => {
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(2);
    vi.advanceTimersByTime(20 * minute - 1);
    carousel.setPlaying(true);
    vi.advanceTimersByTime(60 * minute);
    expect(advance).not.toHaveBeenCalled();
    carousel.setPlaying(false);
    vi.advanceTimersByTime(20 * minute - 1);
    expect(advance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('正常状态播放结束继续按上次操作计 idle；操作播放也退出原轮播', () => {
    const carousel = new AutoCarousel(vi.fn());
    carousel.setPhotoCount(2);
    vi.advanceTimersByTime(20 * minute);
    carousel.notifyUserActivity();
    carousel.setPlaying(true);
    vi.advanceTimersByTime(2 * minute);
    carousel.setPlaying(false);
    vi.advanceTimersByTime(20 * minute - 1);
    expect(carousel.isAutomatic).toBe(false);
    vi.advanceTimersByTime(1);
    expect(carousel.isAutomatic).toBe(true);
  });

  it('长播放结束时 idle 已满，播放结束后等 20 分钟', () => {
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(2);
    carousel.setPlaying(true);
    vi.advanceTimersByTime(30 * minute);
    carousel.setPlaying(false);
    vi.advanceTimersByTime(0);
    expect(carousel.isAutomatic).toBe(false);
    expect(advance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20 * minute);
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('%i 张不轮播，降到单张取消已有计时', (count) => {
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(count);
    vi.advanceTimersByTime(60 * minute);
    expect(carousel.isAutomatic).toBe(false);
    expect(advance).not.toHaveBeenCalled();
    carousel.setPhotoCount(3);
    vi.advanceTimersByTime(19 * minute);
    carousel.setPhotoCount(count);
    vi.advanceTimersByTime(60 * minute);
    expect(advance).not.toHaveBeenCalled();
  });

  it('feed 增加照片不重置时间；stop 清理计时器', () => {
    const advance = vi.fn();
    const carousel = new AutoCarousel(advance);
    carousel.setPhotoCount(2);
    vi.advanceTimersByTime(19 * minute);
    carousel.setPhotoCount(3);
    vi.advanceTimersByTime(minute);
    expect(carousel.isAutomatic).toBe(true);
    carousel.stop();
    vi.advanceTimersByTime(60 * minute);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});

it('自动轮播循环索引', () => {
  expect(nextIndexWithWrap(0, 3)).toBe(1);
  expect(nextIndexWithWrap(2, 3)).toBe(0);
  expect(nextIndexWithWrap(-1, 3)).toBe(0);
  expect(nextIndexWithWrap(0, 0)).toBe(-1);
});
