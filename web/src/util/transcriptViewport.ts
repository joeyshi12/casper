import type { TranscriptItem } from '@casper/shared';

/**
 * The transcript's viewport: whether it follows new content, where it sits across
 * a prepend, and when to pull in an older page. The container arrives as a port,
 * so a test drives the whole thing with three numbers and a fake clock.
 */

export interface ViewportElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

const SLACK = 4;
const LOAD_OLDER_WITHIN = 300;
const SHOW_BUTTON_BEYOND = 240;
const PAGE_SIZE = 80;

export interface ViewportFlags {
  loadingOlder: boolean;
  showScrollButton: boolean;
}

export interface ViewportContent {
  chatId: string | null;
  itemCount: number;
  pendingCount: number;
  remainingOlder: number;
}

export interface ViewportPorts {
  element: () => ViewportElement | null;
  fetchPage: (chatId: string, offset: number, limit: number) => Promise<TranscriptItem[]>;
  prepend: (items: TranscriptItem[]) => void;
  onFlags: (flags: ViewportFlags) => void;
  /** Overridable so a test can step the follow loop by hand. */
  frames?: {
    request: (cb: () => void) => number;
    cancel: (handle: number) => void;
  };
  reducedMotion?: () => boolean;
}

/** Window for the next older page: the page nearest the loaded window goes first,
 *  since scrolling up walks backwards toward index 0. */
function olderPageRequest(
  remainingOlder: number,
  pageSize: number,
): { offset: number; limit: number } {
  if (remainingOlder <= 0) return { offset: 0, limit: 0 };
  const offset = Math.max(0, remainingOlder - pageSize);
  return { offset, limit: remainingOlder - offset };
}

/* Distinguishes the user scrolling up from the browser clamping scrollTop because
   content got shorter (e.g. a thought block collapsing), which must not stop follow. */
function isUserScrollUp(
  top: number,
  prevTop: number,
  maxTop: number,
  prevMaxTop: number,
): boolean {
  const drop = prevTop - top;
  const clamped = Math.max(0, prevMaxTop - maxTop);
  return drop > clamped + SLACK;
}

export class TranscriptViewport {
  private readonly ports: ViewportPorts;
  private readonly frames: NonNullable<ViewportPorts['frames']>;

  private follow = false;
  private lastScrollTop = 0;
  private lastMaxTop = 0;
  /** Distance from the bottom captured before a page fetch, restored after it lands. */
  private anchor: number | null = null;
  private loadingOlder = false;
  private showButton = false;
  private initializedFor: string | null = null;
  private prevPendingCount = 0;
  private raf = 0;
  private content: ViewportContent = {
    chatId: null,
    itemCount: 0,
    pendingCount: 0,
    remainingOlder: 0,
  };

  constructor(ports: ViewportPorts) {
    this.ports = ports;
    this.frames = ports.frames ?? {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (h) => cancelAnimationFrame(h),
    };
  }

  reset(): void {
    this.follow = false;
    this.prevPendingCount = 0;
    this.anchor = null;
    this.cancelFollow();
    this.setFlags({ loadingOlder: false, showScrollButton: false });
  }

  dispose(): void {
    this.cancelFollow();
  }

  /* On a session's first content the view jumps to the latest message without
     turning follow on - animating through the whole history is disorienting. */
  onContent(content: ViewportContent): void {
    this.content = content;
    const el = this.ports.element();
    if (!el) return;

    if (this.initializedFor !== content.chatId && content.itemCount > 0) {
      this.initializedFor = content.chatId;
      this.follow = false;
      el.scrollTop = this.bottomOf(el);
      this.lastScrollTop = el.scrollTop;
      this.lastMaxTop = this.bottomOf(el);
      this.prevPendingCount = content.pendingCount;
      this.setFlags({ showScrollButton: false });
      return;
    }

    if (content.pendingCount > this.prevPendingCount) this.follow = true;
    this.prevPendingCount = content.pendingCount;
    if (this.follow) this.scheduleFollow();
    else this.updateButton(el);
  }

  onScroll(): void {
    const el = this.ports.element();
    if (!el) return;
    const maxTop = this.bottomOf(el);
    if (isUserScrollUp(el.scrollTop, this.lastScrollTop, maxTop, this.lastMaxTop)) {
      this.follow = false;
    }
    this.lastScrollTop = el.scrollTop;
    this.lastMaxTop = maxTop;
    this.updateButton(el);
    // Restoring the anchor pushes the view back past this threshold, so loading
    // older pages won't cascade.
    if (el.scrollTop < LOAD_OLDER_WITHIN) this.loadOlder();
  }

  jumpToLatest(): void {
    this.follow = true;
    this.setFlags({ showScrollButton: false });
    this.scheduleFollow();
  }

  /* Must run before paint - inserting content above without this is the jump
     the anchor exists to prevent. */
  restoreAnchor(): void {
    if (this.anchor == null) return;
    const el = this.ports.element();
    if (el) el.scrollTop = el.scrollHeight - this.anchor;
    this.anchor = null;
    this.setFlags({ loadingOlder: false });
  }

  private loadOlder(): void {
    const el = this.ports.element();
    const chatId = this.content.chatId;
    if (!el || !chatId || this.loadingOlder || this.content.remainingOlder <= 0) return;

    this.setFlags({ loadingOlder: true });
    const { offset, limit } = olderPageRequest(this.content.remainingOlder, PAGE_SIZE);
    this.anchor = el.scrollHeight - el.scrollTop;

    this.ports
      .fetchPage(chatId, offset, limit)
      .then((items) => {
        // Session may have switched while this was in flight; check against this
        // viewport's own chatId, not whatever the store now holds.
        if (this.content.chatId !== chatId) return this.abandonPage();
        if (items.length === 0) return this.abandonPage();
        this.ports.prepend(items);
      })
      .catch(() => {
        this.abandonPage();
        console.error('could not load earlier transcript page');
      });
  }

  private abandonPage(): void {
    this.anchor = null;
    this.setFlags({ loadingOlder: false });
  }

  /* One rAF loop easing scrollTop toward the bottom. Position-based, unlike CSS
     smooth-scroll plus repeated scrollIntoView, which restarts from a moving
     target every frame and pulses. Stops when caught up; new content re-arms it. */
  private followTick = (): void => {
    this.raf = 0;
    const el = this.ports.element();
    if (!el || !this.follow) return;
    const target = this.bottomOf(el);
    const delta = target - el.scrollTop;
    if (delta <= 1 || this.ports.reducedMotion?.()) {
      el.scrollTop = target;
      this.lastScrollTop = el.scrollTop;
      this.lastMaxTop = target;
      return;
    }
    el.scrollTop += Math.max(10, Math.ceil(delta * 0.3));
    this.lastScrollTop = el.scrollTop;
    this.lastMaxTop = target;
    this.raf = this.frames.request(this.followTick);
  };

  private scheduleFollow(): void {
    if (this.raf) return;
    this.raf = this.frames.request(this.followTick);
  }

  private cancelFollow(): void {
    if (this.raf) this.frames.cancel(this.raf);
    this.raf = 0;
  }

  private bottomOf(el: ViewportElement): number {
    return el.scrollHeight - el.clientHeight;
  }

  private updateButton(el: ViewportElement): void {
    const distanceFromBottom = this.bottomOf(el) - el.scrollTop;
    this.setFlags({ showScrollButton: distanceFromBottom > SHOW_BUTTON_BEYOND });
  }

  private setFlags(next: Partial<ViewportFlags>): void {
    const loadingOlder = next.loadingOlder ?? this.loadingOlder;
    const showScrollButton = next.showScrollButton ?? this.showButton;
    if (loadingOlder === this.loadingOlder && showScrollButton === this.showButton) return;
    this.loadingOlder = loadingOlder;
    this.showButton = showScrollButton;
    this.ports.onFlags({ loadingOlder, showScrollButton });
  }
}
