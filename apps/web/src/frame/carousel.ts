/** 已确认规则：最后一次操作后 20 分钟换图，之后每 20 分钟换图。 */
export const CAROUSEL_IDLE_MS = 20 * 60_000;
export const CAROUSEL_INTERVAL_MS = 20 * 60_000;

export function nextIndexWithWrap(currentIndex: number, total: number): number {
  if (total <= 0) return -1;
  if (currentIndex < 0) return 0;
  return (currentIndex + 1) % total;
}

export class AutoCarousel {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private photoCount = 0;
  private playing = false;
  private automatic = false;
  private lastActivity = Date.now();

  constructor(private readonly onAdvance: () => void) {}

  get isAutomatic(): boolean { return this.automatic; }

  setPhotoCount(count: number): void {
    if (count === this.photoCount) return;
    const wasEligible = this.photoCount >= 2;
    this.photoCount = count;
    if (count < 2 || !wasEligible) {
      this.automatic = false;
      this.lastActivity = Date.now();
      this.refresh();
    }
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    if (!playing) {
      this.automatic = false;
      this.lastActivity = Date.now();
    }
    this.refresh();
  }

  notifyUserActivity(): void {
    this.automatic = false;
    this.lastActivity = Date.now();
    this.refresh();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private refresh(): void {
    this.stop();
    if (this.photoCount < 2 || this.playing) return;
    const delay = this.automatic
      ? CAROUSEL_INTERVAL_MS
      : Math.max(0, CAROUSEL_IDLE_MS - (Date.now() - this.lastActivity));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.photoCount < 2 || this.playing) return;
      this.automatic = true;
      this.onAdvance();
      this.refresh();
    }, delay);
  }
}
