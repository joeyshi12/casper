import { createInterface } from 'node:readline';
import { handleMessage, type JsonRpcRequest } from './protocol.js';

// Replaced by the bundler with package.json's version; 'dev' when run from source.
declare const __CASPER_VERSION__: string;
const VERSION = typeof __CASPER_VERSION__ === 'string' ? __CASPER_VERSION__ : 'dev';

/**
 * MCP over stdio: newline-delimited JSON-RPC. Only protocol goes to stdout, which is
 * why kiro spawns this entry and not the CLI, which prints on first run.
 */
export function runMcpServer(): void {
  const rl = createInterface({ input: process.stdin });

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
      const res = handleMessage(req, VERSION);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      process.stderr.write(`casper-mcp: ${(err as Error).message}\n`);
      if (req.id !== undefined && req.id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32603, message: 'Internal error' },
          }) + '\n',
        );
      }
    }
  });

  // stdin closing is how the client says it's done.
  rl.on('close', () => process.exit(0));
}
