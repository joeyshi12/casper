/**
 * Wraps each word of streamed markdown in a span, so new words can fade in while the text
 * already on screen sits still.
 *
 * React's reconciliation is what makes that work: children match by index, so spans already
 * rendered keep their DOM nodes and their finished animations, and only a span appended this
 * render mounts and plays. The last word grows in place ("Hel" -> "Hello") inside its own
 * span, so it doesn't restart either. Off for settled text, which renders without any spans.
 */

/** Nodes whose text is not prose - splitting it would break highlighting or rendering. */
const SKIP = new Set(['code', 'pre', 'svg', 'math', 'style', 'script', 'textarea']);

const FADE_WORD_CLASS = 'fade-word';

/** The part of hast this needs: a node with a type, maybe children, maybe text or a tag. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Split on whitespace, keeping it: the spaces stay bare text nodes, so only words are wrapped
 * and the surrounding layout is unchanged.
 */
export function splitWords(value: string): HastNode[] {
  const out: HastNode[] = [];
  for (const part of value.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      out.push({ type: 'text', value: part });
      continue;
    }
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: [FADE_WORD_CLASS] },
      children: [{ type: 'text', value: part }],
    });
  }
  return out;
}

function walk(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  const next: HastNode[] = [];
  for (const child of children) {
    if (child.type === 'text') {
      next.push(...splitWords(child.value ?? ''));
      continue;
    }
    if (child.type === 'element' && SKIP.has(child.tagName ?? '')) {
      next.push(child);
      continue;
    }
    walk(child);
    next.push(child);
  }
  node.children = next;
}

/** rehype plugin form: mutates the tree in place. */
export function rehypeFadeWords() {
  return (tree: HastNode) => walk(tree);
}
