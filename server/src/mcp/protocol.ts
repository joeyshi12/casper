import { MODULES, getGuidelines } from './guidelines.js';
import { MAX_OPTIONS, validateChoice } from './choice.js';

/** Used only when a client states no version; otherwise theirs is echoed back. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

const SERVER_NAME = 'casper-generative-ui';

/** Matches the client-side ceiling in WidgetBlock; past this nothing renders. */
export const MAX_WIDGET_CHARS = 256 * 1024;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: 'read_me',
    title: 'Widget design guidelines',
    description:
      'Read the widget design guidelines. Call this once, before your first ' +
      'show_widget call, with the modules relevant to what you are about to build. ' +
      'Do not mention this call to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        modules: {
          type: 'array',
          items: { type: 'string', enum: [...MODULES] },
          minItems: 1,
          description:
            'interactive for controls, sketches and simulations, chart for data, ' +
            'diagram for structure and flow, art for illustration.',
        },
      },
      required: ['modules'],
    },
  },
  {
    name: 'show_widget',
    title: 'Show widget',
    description:
      'Render an interactive widget inline in the conversation. Pass an HTML ' +
      'fragment: no doctype, html or body tag. Style first, then content, then a ' +
      'single script last. Use this instead of describing something visual in prose.',
    inputSchema: {
      type: 'object',
      properties: {
        i_have_seen_read_me: {
          type: 'boolean',
          description: 'True only if you have already called read_me in this conversation.',
        },
        title: {
          type: 'string',
          description: 'Short snake_case identifier, e.g. compound_interest.',
        },
        widget_code: {
          type: 'string',
          description: 'The HTML fragment to render.',
        },
      },
      required: ['i_have_seen_read_me', 'title', 'widget_code'],
    },
  },
  {
    name: 'show_choice',
    title: 'Ask the user to choose',
    description:
      'Ask the user to pick from a few options, which they tap instead of typing. ' +
      'Use it wherever you would otherwise end a message asking which of several ' +
      'ways to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What they are deciding.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: MAX_OPTIONS,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short, tappable phrase.' },
              detail: { type: 'string', description: 'One line of context.' },
              prompt: {
                type: 'string',
                description: 'Message sent when tapped. Defaults to the label.',
              },
            },
            required: ['label'],
          },
        },
      },
      required: ['question', 'options'],
    },
  },
];

function ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function text(body: string, isError = false): unknown {
  return { content: [{ type: 'text', text: body }], isError };
}

function callError(id: JsonRpcResponse['id'], message: string): JsonRpcResponse {
  // A tool-level error, not a protocol one: the model should read it and retry.
  return ok(id, text(message, true));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function handleReadMe(id: JsonRpcResponse['id'], args: Record<string, unknown>): JsonRpcResponse {
  const modules = asStringArray(args.modules);
  const known = modules.filter((m) => (MODULES as readonly string[]).includes(m));
  if (known.length === 0) {
    return callError(id, `Name at least one module: ${MODULES.join(', ')}.`);
  }
  return ok(id, text(getGuidelines(known)));
}

function handleShowWidget(
  id: JsonRpcResponse['id'],
  args: Record<string, unknown>,
): JsonRpcResponse {
  if (args.i_have_seen_read_me !== true) {
    return callError(id, 'Call read_me first, then set i_have_seen_read_me to true.');
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return callError(id, 'title is required: a short snake_case identifier.');

  const code = typeof args.widget_code === 'string' ? args.widget_code : '';
  if (!code.trim()) return callError(id, 'widget_code is required.');
  if (code.length > MAX_WIDGET_CHARS) {
    return callError(
      id,
      `widget_code is ${Math.round(code.length / 1024)} KB, over the ` +
        `${MAX_WIDGET_CHARS / 1024} KB limit. Simplify it.`,
    );
  }
  if (/<(!doctype|html|head|body)\b/i.test(code)) {
    return callError(id, 'Pass a fragment, not a document: drop the doctype, html and body tags.');
  }

  // Nothing to do here: Casper renders the widget from this tool call as kiro
  // reports it, so the call itself is the delivery mechanism. This only validates
  // and tells the model what the user is now looking at.
  return ok(id, text(`Widget "${title}" is on screen. Don't repeat its content in prose.`));
}

function handleChoice(
  id: JsonRpcResponse['id'],
  args: Record<string, unknown>,
): JsonRpcResponse {
  const problem = validateChoice(args);
  if (problem) return callError(id, problem);
  // Casper renders it from this call, same as show_widget.
  return ok(id, text('Options are on screen. Wait for the user to pick one.'));
}

/**
 * One message in, one response or null for notifications. Answers whether or not
 * initialize came first, so stateless clients work too.
 */
export function handleMessage(req: JsonRpcRequest, version: string): JsonRpcResponse | null {
  const id = req.id ?? null;
  const method = req.method ?? '';
  const params = req.params ?? {};

  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      return ok(id, {
        protocolVersion: asked ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version },
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === 'read_me') return handleReadMe(id, args);
      if (name === 'show_widget') return handleShowWidget(id, args);
      if (name === 'show_choice') return handleChoice(id, args);
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    default:
      if (id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}
