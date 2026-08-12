/**
 * Composed per module so a chart request doesn't carry diagram rules. The text is
 * Casper's own, written for this sandbox and palette.
 */

export const MODULES = ['interactive', 'chart', 'diagram', 'art'] as const;
type Module = (typeof MODULES)[number];

const CORE = `# Widgets

A widget is a self-contained HTML fragment rendered inline in the conversation. No
doctype, html, head or body tag - just content. It is not a file and not a
deliverable; it is part of what you are saying. Reach for one when a picture
answers better than a paragraph.

## Structure, in this order

1. A short \`<style>\` block.
2. The content markup.
3. A single \`<script>\` at the end.

Order matters. Content renders as it arrives, and scripts run only once the message
is complete, so a widget whose script sits at the top looks inert until the end.

## Hard rules

- No gradients, drop shadows or blur. They flash while content is patched in.
- No HTML comments. They cost tokens and buy nothing.
- Two font weights only: 400 and 500. Never 600 or 700.
- Sentence case for every label, heading and button. Never Title Case, never ALL CAPS.
- Never hardcode a colour that has a variable below.
- Size text in px, 11 to 15 for body and labels, up to 18 for a single heading.
- Keep the whole widget under 600px tall unless the content genuinely needs more.

## The sandbox

The frame has an opaque origin. localStorage, sessionStorage, cookies and requests
to Casper all throw or fail. Hold state in a variable for the life of the page.

Libraries load from these hosts only: cdnjs.cloudflare.com, cdn.jsdelivr.net,
unpkg.com, esm.sh. Anything else is refused by the content security policy, as is
eval and new Function, so pick libraries that don't rely on them.

## Theme

The background is transparent and the app's own variables are set. Use them:

--color-text-primary, --color-text-secondary
--color-background-primary, --color-background-secondary
--color-border
--color-accent, --color-accent-alt
--color-teal, --color-green, --color-yellow, --color-orange, --color-red
--font-body, --font-mono

Read them in script with getComputedStyle(document.documentElement).getPropertyValue.

## Talking back

casper.sendPrompt(text) sends a message as if the user typed it, indistinguishable
in the transcript from one they wrote. Most widgets need no button at all. Add one
only when the obvious next step is a question they would otherwise type out by hand,
and never as decoration or to invite engagement. One at most.`;

const COLOR = `## Colour

Six accents are available: --color-accent (purple), --color-accent-alt (pink),
--color-teal, --color-green, --color-yellow, --color-orange, --color-red.

Colour encodes meaning, never sequence. If two series differ only by being
different series, use one accent at two opacities rather than two hues. Two or
three hues per widget is the ceiling.

Semantics people already expect: green for success or growth, red for error or
loss, orange for warning or pending, teal for neutral information, purple for the
primary subject.

For text on a filled background, use --color-background-primary as the text colour
rather than black. For a tint, use the accent at 12 to 20 percent opacity with the
accent itself as the border.`;

const UI = `## Components

Card: background --color-background-secondary, 1px --color-border, radius 10px,
padding 12px 14px. No shadow.

Metric: label 11px --color-text-secondary above a 20px 500-weight value. Group
metrics in a grid with 12px gaps, never a table.

Button: 12px text, background --color-background-secondary, 1px --color-border,
radius 6px, padding 5px 10px. On hover, move the border to --color-accent. Never
paint a button in an accent colour unless it is the single primary action.

Input and range: set accent-color to var(--color-accent) and let the browser style
the rest.

Table: only for genuinely tabular data. 1px --color-border between rows, no
vertical rules, 12px text, numbers right-aligned in --font-mono.

Rows of key and value: a flex row with the label in --color-text-secondary and the
value in --font-mono, separated by a border-bottom on all but the last.`;

const CHARTS = `## Charts

Chart.js from cdn.jsdelivr.net is the default choice. Load it with a script tag
before your own script; it will have finished loading by the time your script runs,
so there's no need to poll for it.

Wrap every canvas in a div with position relative and an explicit height, and set
maintainAspectRatio to false. Without both, the canvas grows without bound.

Turn the built-in legend off (plugins.legend.display false) and write the legend as
HTML if it's needed - the built-in one ignores the theme.

Grid lines in --color-border at low opacity, ticks in --color-text-secondary, 11px.
Datasets take an accent colour with borderWidth 2 and no point markers unless
individual readings matter.

Format numbers so the sign leads: -$5M, never $-5M. Abbreviate above four digits
(12.4k, 3.1M). Percentages get one decimal at most.

Pick the form from the question: trend over time is a line, comparison across
categories is a horizontal bar when labels are words, composition is a stacked bar
rather than a pie unless there are three slices or fewer.`;

const SVG = `## SVG

Set viewBox and leave width and height off, so the drawing scales to the frame.
Compute the viewBox from the content bounds and add 8 units of padding on every
side; anything drawn outside is invisible and reviewers will not see the mistake.

Text width is the usual cause of overflow. At font-size 12 with the body font,
budget 6.2px per character for lowercase and 7.4px for uppercase, then size boxes
from the longest label rather than by eye.

Connector paths need fill="none" explicitly. SVG fills paths black by default, so a
curve without it renders as a filled blob.

Define arrowheads once in defs with a marker whose fill is context-stroke, so the
head inherits the line colour instead of needing one marker per colour.

Stroke widths: 1.5 for connectors, 2 for emphasis, 1 for gridlines. Never below 1.`;

const DIAGRAMS = `## Diagrams

Two mistakes account for most bad diagrams. First, arrows that cross boxes they
have nothing to do with: trace every arrow's straight path and if it passes through
a box, route it around or move the box. Second, boxes sized by guess rather than by
the longest label they contain.

Route on the verb, not the noun. "How does a request flow" wants a sequence, "what
are the parts" wants a structural diagram, "why is it slow" wants an annotated
before and after.

Budgets: at most four boxes across one tier, at most five words in a label, at most
three tiers deep. Beyond that, split into two diagrams or drop detail.

Label every arrow that isn't obvious, in 10px --color-text-secondary. An unlabelled
arrow asserts a relationship without saying which.

Lay out left to right for flow and top to bottom for hierarchy, and keep a single
consistent gap between tiers.`;

const ART = `## Illustration

Build from geometry: circles, rounded rectangles, and paths with two or three
control points. Detail beyond that reads as noise at conversation size.

Use flat fills from the palette with no more than three colours plus a background.
Depth comes from overlap and size, never from gradients or shadows.

Animate with CSS on transform and opacity only, 0.3s or slower, and only where the
motion carries meaning. Anything faster or busier is a distraction in a chat.

For anything representational, prefer a diagram with labels. An unlabelled drawing
of a concept is decoration.`;

/** Which sections each module pulls in. Order matters; duplicates are dropped. */
const MODULE_SECTIONS: Record<Module, string[]> = {
  interactive: [UI, COLOR],
  chart: [UI, COLOR, CHARTS],
  diagram: [COLOR, SVG, DIAGRAMS],
  art: [COLOR, SVG, ART],
};

/** Core plus the requested modules' sections, each included once. */
export function getGuidelines(modules: readonly string[]): string {
  const parts = [CORE];
  const seen = new Set<string>();
  for (const mod of modules) {
    const sections = MODULE_SECTIONS[mod as Module];
    if (!sections) continue;
    for (const section of sections) {
      if (seen.has(section)) continue;
      seen.add(section);
      parts.push(section);
    }
  }
  return parts.join('\n\n');
}
