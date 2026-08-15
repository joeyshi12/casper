/** Sub-pixel and rounding noise to ignore. */
const SLACK = 4;

/**
 * Whether the user scrolled up, rather than the browser clamping scrollTop because
 * the content got shorter. Pass scrollTop and scrollHeight - clientHeight, each as
 * they are now and as of the previous scroll event: a drop no bigger than the range
 * lost is a reflow, not a gesture.
 */
export function isUserScrollUp(
  top: number,
  prevTop: number,
  maxTop: number,
  prevMaxTop: number,
): boolean {
  const drop = prevTop - top;
  const clamped = Math.max(0, prevMaxTop - maxTop);
  return drop > clamped + SLACK;
}
