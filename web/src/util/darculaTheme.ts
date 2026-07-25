import type { ThemeRegistrationRaw } from 'shiki';

/**
 * Darcula (JetBrains) syntax theme for Shiki. Shiki ships no Darcula theme, so
 * this maps the common TextMate scopes to Darcula's editor colors: orange
 * keywords, green strings, blue numbers, yellow functions, purple constants,
 * and gray italic comments. The background is rendered transparent by the app
 * CSS (`.codeblock-body .shiki`), so only the token foregrounds are used here.
 */
export const darcula: ThemeRegistrationRaw = {
  name: 'darcula',
  type: 'dark',
  bg: '#2b2b2b',
  fg: '#a9b7c6',
  settings: [
    { settings: { background: '#2b2b2b', foreground: '#a9b7c6' } },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: '#808080', fontStyle: 'italic' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template', 'string.regexp'],
      settings: { foreground: '#6a8759' },
    },
    { scope: ['constant.character.escape'], settings: { foreground: '#cc7832' } },
    {
      scope: ['constant.numeric', 'constant.language', 'keyword.other.unit'],
      settings: { foreground: '#6897bb' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'storage.type',
        'storage.modifier',
        'keyword.operator.new',
      ],
      settings: { foreground: '#cc7832' },
    },
    { scope: ['keyword.operator'], settings: { foreground: '#a9b7c6' } },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call.generic',
        'entity.name.function.member',
      ],
      settings: { foreground: '#ffc66d' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.class',
        'support.type',
        'entity.other.inherited-class',
      ],
      settings: { foreground: '#a9b7c6' },
    },
    {
      scope: ['variable.language', 'variable.other.constant', 'constant.other', 'support.constant'],
      settings: { foreground: '#9876aa' },
    },
    {
      scope: ['support.type.property-name', 'meta.object-literal.key', 'variable.other.member'],
      settings: { foreground: '#9876aa' },
    },
    { scope: ['entity.name.tag', 'meta.tag'], settings: { foreground: '#e8bf6a' } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: '#bababa' } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: '#6897bb', fontStyle: 'bold' } },
    { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
    { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    { scope: ['markup.inline.raw', 'markup.fenced_code'], settings: { foreground: '#6a8759' } },
    { scope: ['markup.inserted'], settings: { foreground: '#6a8759' } },
    { scope: ['markup.deleted'], settings: { foreground: '#cc5c5c' } },
    { scope: ['invalid', 'invalid.illegal'], settings: { foreground: '#cc5c5c' } },
  ],
};
