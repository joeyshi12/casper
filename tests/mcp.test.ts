// The MCP server: protocol, guidelines composition, and the choice template.
// Run with: npm test

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, DEFAULT_PROTOCOL_VERSION } from '../server/src/mcp/protocol.js';
import { getGuidelines, MODULES } from '../server/src/mcp/guidelines.js';
import { validateChoice } from '../server/src/mcp/choice.js';

describe('MCP server protocol', () => {
  const call = (name: string, args: Record<string, unknown>) =>
    handleMessage({ id: 1, method: 'tools/call', params: { name, arguments: args } }, '1.2.3');
  const resultOf = (res: ReturnType<typeof handleMessage>) =>
    (res?.result ?? {}) as { content?: { text: string }[]; isError?: boolean };

  it('echoes the protocol version a client asks for', () => {
    const res = handleMessage(
      { id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
      '1.2.3',
    );
    const r = res?.result as { protocolVersion: string; serverInfo: { version: string } };
    assert.equal(r.protocolVersion, '2099-01-01');
    assert.equal(r.serverInfo.version, '1.2.3');
  });

  it('falls back to a known version when the client names none', () => {
    const res = handleMessage({ id: 1, method: 'initialize', params: {} }, '1.2.3');
    assert.equal((res?.result as { protocolVersion: string }).protocolVersion, DEFAULT_PROTOCOL_VERSION);
  });

  it('answers tools/call without an initialize handshake, for stateless clients', () => {
    const res = call('read_me', { modules: ['chart'] });
    assert.equal(resultOf(res).isError, false);
  });

  it('takes no reply for notifications', () => {
    assert.equal(handleMessage({ method: 'notifications/initialized' }, '1.2.3'), null);
  });

  it('lists both tools with their required arguments', () => {
    const res = handleMessage({ id: 1, method: 'tools/list' }, '1.2.3');
    const tools = (res?.result as { tools: { name: string; inputSchema: { required: string[] } }[] }).tools;
assert.deepEqual(tools.map((t) => t.name), ['read_me', 'show_widget', 'show_choice']);
    const widget = tools[1]!;
    assert.deepEqual(widget.inputSchema.required, ['i_have_seen_read_me', 'title', 'widget_code']);
  });

  it('refuses show_widget until read_me has been acknowledged', () => {
    const res = resultOf(call('show_widget', { title: 'x', widget_code: '<p>x</p>' }));
    assert.equal(res.isError, true);
    assert.match(res.content![0]!.text, /read_me/);
  });

  it('refuses a whole document, since a widget is a fragment', () => {
    const res = resultOf(call('show_widget', {
      i_have_seen_read_me: true, title: 'x', widget_code: '<html><body><p>x</p></body></html>',
    }));
    assert.equal(res.isError, true);
    assert.match(res.content![0]!.text, /fragment/);
  });

  it('accepts a valid widget', () => {
    const res = resultOf(call('show_widget', {
      i_have_seen_read_me: true, title: 'compound_interest', widget_code: '<p>x</p>',
    }));
    assert.equal(res.isError, false);
    assert.match(res.content![0]!.text, /compound_interest/);
  });

  // The reason for a tool per template: the model gets a real schema for each,
  // where a single tool with a data object gives it nothing to follow.
  it('gives every template tool a schema with required fields', () => {
    const res = handleMessage({ id: 1, method: 'tools/list' }, '1.2.3');
    const tools = (res?.result as {
      tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[];
    }).tools;
    const byName = new Map(tools.map((t) => [t.name, t.inputSchema]));
    assert.deepEqual(byName.get('show_choice')?.required, ['question', 'options']);
    // Nested shapes are described too, not left as bare objects.
    const options = byName.get('show_choice')?.properties.options as {
      items: { required: string[] };
      maxItems: number;
    };
    assert.deepEqual(options.items.required, ['label']);
    assert.equal(options.maxItems, 6);
  });

  it('reports an unknown tool as a protocol error, not a tool result', () => {
    const res = handleMessage({ id: 1, method: 'tools/call', params: { name: 'nope' } }, '1.2.3');
    assert.equal(res?.error?.code, -32602);
  });
});

describe('widget guidelines', () => {
  it('includes each shared section once when modules overlap', () => {
    const both = getGuidelines(['interactive', 'chart']);
    assert.equal(both.split('## Components').length - 1, 1);
    assert.equal(both.split('## Colour').length - 1, 1);
    assert.match(both, /## Charts/);
  });

  it('loads only what the module needs', () => {
    const chart = getGuidelines(['chart']);
    assert.ok(!chart.includes('## Diagrams'), 'chart pulled in diagram rules');
    const diagram = getGuidelines(['diagram']);
    assert.ok(!diagram.includes('## Charts'), 'diagram pulled in chart rules');
  });

  it('always carries the core rules, whatever the module', () => {
    for (const m of MODULES) assert.match(getGuidelines([m]), /streaming|sandbox|# Widgets/i);
  });
});

describe('choice validation', () => {
  const fails = (d: unknown, match: RegExp) => {
    const problem = validateChoice(d);
    assert.ok(problem, 'expected a problem');
    assert.match(problem, match);
  };

  it('accepts a usable choice', () => {
    assert.equal(validateChoice({ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }), null);
  });

  it('rejects a choice that is not a choice', () => {
    fails({ question: 'Which?', options: [{ label: 'A' }] }, /two options/);
  });

  it('rejects more options than anyone wants to tap', () => {
    fails({ question: 'Which?', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }, /at most 6/);
  });

  it('names the option that is wrong', () => {
    fails({ question: 'Which?', options: [{ label: 'A' }, { detail: 'no label' }] }, /options\[1\]\.label/);
  });
});
