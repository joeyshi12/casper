import type { TranscriptItem } from '@casper/shared';

/**
 * The transcript's viewport: whether it follows new content, where it sits across
 * a prepend, and when to pull in an older page.
 *
 * All three are the same concern - each one reads and writes scrollTop - so they
 * live together rather than as arithmetic helpers called from a component that
 * keeps the interesting parts. The container arrives as a port, so a test drives
 * the whole thing with three numbers and a fake clock.
 */

/** What the viewport needs from its scroll container. */
export interface ViewportElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Sub-pixel and rounding noise to ignore when judging a scroll. */
const SLACK = 4;

/** How close to the top pulls in the previous page. */
const LOAD_OLDER_WITHIN = 300;

/** Distance from the bottom past which the jump-to-latest button appears. */
const SHOW_BUTTON_BEYOND = 240;

/** Transcript items per older page. */
const PAGE_SIZE = 80;

/** The two flags the component renders from. */
export interface ViewportFlags {
  loadingOlder: boolean;
  showScrollButton: boolean;
}

/** What the transcript looks like right now, as the viewport needs to see it. */
export interface ViewportContent {
  sessionId: string | null;
  itemCount: number;
  pendingCount: number;
  /** Older items not yet loaded, before the loaded window. */
  remainingOlder: number;
}

export interface ViewportPorts {
  /** The container, or null while it is unmounted. */
  element: () => ViewportElement | null;
  /** Older transcript items, oldest first. */
  fetchPage: (sessionId: string, offset: number, limit: number) => Promise<TranscriptItem[]>;
  /** Hand an older page to the store, which prepends it. */
  prepend: (items: TranscriptItem[]) => void;
  /** Flags changed, so the component can render them. Only called on a change. */
  onFlags: (flags: ViewportFlags) => void;
  /** Overridable so a test can step the follow loop by hand. */
  frames?: {
    request: (cb: () => void) => number;
    cancel: (handle: number) => void;
  };
  /** Follow snaps rather than eases when the user asked for reduced motion. */
  reducedMotion?: () => boolean;
}

/**
 * The [offset, offset+limit) window for the next older page, given how many older
 * items remain before the loaded window. The page nearest the loaded window goes
 * first, since scrolling up walks backwards toward index 0.
 */
function olderPageRequest(
  remainingOlder: number,
  pageSize: number,
): { offset: number; limit: number } {
  if (remainingOlder <= 0) return { offset: 0, limit: 0 };
  const offset = Math.max(0, remainingOlder - pageSize);
  return { offset, limit: remainingOlder - offset };
}

/**
 * Whether the user scrolled up, rather than the browser clamping scrollTop because
 * the content got shorter. A thought block collapsing as it commits lowers scrollTop
 * without anyone touching the wheel, and that must not stop follow.
 */
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

  /** Following the bottom as content streams in. Off until the user opts in. */
  private follow = false;
  private lastScrollTop = 0;
  private lastMaxTop = 0;
  /** Distance from the bottom captured before a page fetch, restored after it lands. */
  private anchor: number | null = null;
  private loadingOlder = false;
  private showButton = false;
  /** The session already positioned at the bottom once. */
  private initializedFor: string | null = null;
  private prevPendingCount = 0;
  private raf = 0;
  private content: ViewportContent = {
    sessionId: null,
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

  /** Each session starts with follow off and nothing in flight. */
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

  /**
   * New content arrived. On a session's first content the view jumps to the latest
   * message without turning follow on - animating a scroll through the whole
   * history is disorienting. A new pending message means the user just sent
   * something, so follow resumes to carry their message and the reply into view.
   */
  onContent(content: ViewportContent): void {
    this.content = content;
    const el = this.ports.element();
    if (!el) return;

    if (this.initializedFor !== content.sessionId && content.itemCount > 0) {
      this.initializedFor = content.sessionId;
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

  /** The container scrolled, from a gesture or from a reflow. */
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
    // Near the top: pull in the previous page. Restoring the anchor pushes the
    // view back down past this threshold, so it won't cascade.
    if (el.scrollTop < LOAD_OLDER_WITHIN) this.loadOlder();
  }

  /** The jump-to-latest button: go to the bottom and keep following. */
  jumpToLatest(): void {
    this.follow = true;
    this.setFlags({ showScrollButton: false });
    this.scheduleFollow();
  }

  /**
   * Put the view back where it was before a page was prepended. Must run before
   * paint - inserting content above without this is the jump the anchor exists to
   * prevent.
   */
  restoreAnchor(): void {
    if (this.anchor == null) return;
    const el = this.ports.element();
    if (el) el.scrollTop = el.scrollHeight - this.anchor;
    this.anchor = null;
    this.setFlags({ loadingOlder: false });
  }

  private loadOlder(): void {
    const el = this.ports.element();
    const sessionId = this.content.sessionId;
    if (!el || !sessionId || this.loadingOlder || this.content.remainingOlder <= 0) return;

    this.setFlags({ loadingOlder: true });
    const { offset, limit } = olderPageRequest(this.content.remainingOlder, PAGE_SIZE);
    this.anchor = el.scrollHeight - el.scrollTop;

    this.ports
      .fetchPage(sessionId, offset, limit)
      .then((items) => {
        // Switched sessions while the page was in flight: these items belong to a
        // transcript that is no longer on screen. Judged against the session this
        // viewport is showing, not against whatever the store now holds.
        if (this.content.sessionId !== sessionId) return this.abandonPage();
        if (items.length === 0) return this.abandonPage();
        this.ports.prepend(items); // anchor restored in restoreAnchor()
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

  /**
   * Follow the bottom with one rAF loop easing scrollTop toward it. Position-based,
   * unlike CSS smooth-scroll plus repeated scrollIntoView, which restarts an eased
   * animation from a moving target every frame and so pulses: each frame covers a
   * fraction of the remaining distance, only ever downward. It stops when caught
   * up; new content re-arms it.
   */
  private followTick = (): void => {
    this.raf = 0;
    const el = this.ports.element();
    if (!el || !this.follow) return;
    const target = this.bottomOf(el);
    const delta = target - el.scrollTop;
    if (delta <= 1 || this.ports.reducedMotion?.()) {
      el.scrollTop = target; // snap the final pixel (or all of it) and idle
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
    if (this.raf) return; // loop already running
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

  /** Emits only on a change, so the component doesn't render for nothing. */
  private setFlags(next: Partial<ViewportFlags>): void {
    const loadingOlder = next.loadingOlder ?? this.loadingOlder;
    const showScrollButton = next.showScrollButton ?? this.showButton;
    if (loadingOlder === this.loadingOlder && showScrollButton === this.showButton) return;
    this.loadingOlder = loadingOlder;
    this.showButton = showScrollButton;
    this.ports.onFlags({ loadingOlder, showScrollButton });
  }
}
