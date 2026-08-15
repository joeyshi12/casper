import { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';

const base = defaultSchema as Schema;
const attr = (tag: string, ...extra: string[]) => [...(base.attributes?.[tag] ?? []), ...extra];

/**
 * What raw HTML in a Markdown file is allowed to contain. Starts from GitHub's own
 * schema, which drops script, event handlers and unsafe URL protocols, and adds back
 * the presentational attributes a README banner needs.
 *
 * This matters because the file browser opens anything under fileRoot, so a Markdown
 * file is untrusted input rendered in Casper's origin, where script could call the API
 * as the signed-in user.
 */
export const MARKDOWN_HTML_SCHEMA: Schema = {
  ...base,
  attributes: {
    ...base.attributes,
    p: attr('p', 'align'),
    div: attr('div', 'align'),
    h1: attr('h1', 'align'),
    h2: attr('h2', 'align'),
    h3: attr('h3', 'align'),
    img: attr('img', 'width', 'height', 'align'),
    a: attr('a', 'align'),
  },
};
