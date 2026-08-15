/** One scroll event, described in enough detail to tell a gesture from a reflow. */
export interface ScrollSample {
  /** scrollTop now, and as of the previous event. */
  top: number;
  prevTop: number;
  /** The largest valid scrollTop (scrollHeight - clientHeight), now and before. */
  maxTop: number;
  prevMaxTop: number;
}

/** Ignore sub-pixel and rounding noise. */
export const SCROLL_SLACK = 4;

/**
 * Whether the user scrolled up, as opposed to the browser clamping scrollTop
 * because the content got shorter. A block that collapses mid-turn - a thought
 * block committing when a tool call arrives - shrinks the scroll range and drags
 * scrollTop down with it. That is not a gesture, and must not stop the view
 * following the bottom.
 */
export function isUserScrollUp(s: ScrollSample): boolean {
  const drop = s.prevTop - s.top;
  if (drop <= SCROLL_SLACK) return false;
  const clamped = Math.max(0, s.prevMaxTop - s.maxTop);
  return drop > clamped + SCROLL_SLACK;
}
