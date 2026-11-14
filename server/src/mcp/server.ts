import { createInterface } from 'node:readline';
import { handleMessage, type AskUser, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js';

// Replaced by the bundler with package.json's version; 'dev' when run from source.
declare const __CASPER_VERSION__: string;
const VERSION = typeof __CASPER_VERSION__ === 'string' ? __CASPER_VERSION__ : 'dev';

type Write = (message: object) => void;

/**
 * The stdio connection's state: whether the client offered form elicitation in initialize,
 * and the elicitation requests sent to it that have not been answered.
 */
export class McpConnection {
  private canElicit = false;
  private nextId = 1;
  private readonly waiting = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();

  constructor(private readonly write: Write) {}

  private readonly ask: AskUser = (params) =>
    new Promise((resolve, reject) => {
      const id = `casper-elicit-${this.nextId++}`;
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method: 'elicitation/create', params });
    });

  /** Handles one parsed line: a request or notification from the client, or the client's
   *  answer to an elicitation. */
  receive(msg: JsonRpcRequest & { result?: unknown; error?: { message?: string } }): void {
    if (msg.method === undefined) {
      const entry = this.waiting.get(String(msg.id));
      if (!entry) return;
      this.waiting.delete(String(msg.id));
      if (msg.error) entry.reject(new Error(msg.error.message ?? 'elicitation failed'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'initialize') {
      const caps = (msg.params?.capabilities ?? {}) as { elicitation?: { form?: unknown } };
      // An empty elicitation object means form support, per the MCP spec.
      this.canElicit = !!caps.elicitation && (caps.elicitation.form !== undefined || Object.keys(caps.elicitation).length === 0);
    }
    const res = handleMessage(msg, VERSION, this.canElicit ? this.ask : undefined);
    if (res instanceof Promise) void res.then((r) => this.write(r), (err: Error) => this.fail(msg, err));
    else if (res) this.write(res);
  }

  fail(req: JsonRpcRequest, err: Error): void {
    process.stderr.write(`casper-mcp: ${err.message}\n`);
    if (req.id !== undefined && req.id !== null) {
      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id, error: { code: -32603, message: 'Internal error' } };
      this.write(res);
    }
  }
}

/**
 * MCP over stdio: newline-delimited JSON-RPC. Only protocol goes to stdout, which is
 * why kiro spawns this entry and not the CLI, which prints on first run.
 */
export function runMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  const conn = new McpConnection((message) => process.stdout.write(JSON.stringify(message) + '\n'));

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      return;
    }

    try {
      conn.receive(req);
    } catch (err) {
      conn.fail(req, err as Error);
    }
  });

  // stdin closing is how the client says it's done.
  rl.on('close', () => process.exit(0));
}
