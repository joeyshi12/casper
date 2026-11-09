import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  McpServerInput,
  SettingsResponse,
  ToolsResponse,
  UpdateDefaultsRequest,
} from '@casper/shared';
import { config } from '../config.js';
import { listAgents } from '../session/agents.js';
import { kiroVersion, setDefaultEffort, setDefaultModel } from '../session/models.js';
import {
  addMcpServer,
  configuredDefaultAgent,
  listMcpServers,
  listSkills,
  removeMcpServer,
  setDefaultAgent,
  setMcpServerDisabled,
} from '../session/kiroTools.js';
import type { SessionManager } from '../session/SessionManager.js';

declare const __CASPER_VERSION__: string;
const VERSION = typeof __CASPER_VERSION__ === 'string' ? __CASPER_VERSION__ : 'dev';

export function registerSettingsRoutes(app: FastifyInstance, manager: SessionManager, startedAt: number): void {
  app.get('/api/settings', async (): Promise<SettingsResponse> => ({
    defaultAgentId: (await configuredDefaultAgent()) ?? config.defaultAgent,
    // The token is left out: it is a secret, and the page has no use for it.
    server: {
      version: VERSION,
      kiroVersion: await kiroVersion(),
      kiroBin: config.kiroBin,
      host: config.host,
      port: config.port,
      authEnabled: Boolean(config.token),
      fileRoot: config.fileRoot,
      defaultCwd: config.defaultCwd,
      dataDir: config.casperDataDir,
      configFile: config.configFile,
      maxLiveSessions: config.maxLiveSessions,
      liveSessions: manager.liveCount,
      uptimeMs: Date.now() - startedAt,
    },
  }));

  app.put<{ Body: UpdateDefaultsRequest }>('/api/settings/defaults', (req, reply) =>
    answer(reply, async () => {
      const body = req.body ?? {};
      if (body.agentId !== undefined) {
        const agentId = String(body.agentId);
        if (!(await listAgents()).some((a) => a.id === agentId)) throw new Error(`Unknown agent: ${agentId}`);
        await setDefaultAgent(agentId);
      }
      if (body.modelId !== undefined) await setDefaultModel(String(body.modelId), app.log);
      if (body.effort) await setDefaultEffort(String(body.effort.modelId), String(body.effort.level), app.log);
    }),
  );

  app.get('/api/tools', async (): Promise<ToolsResponse> => {
    const [mcpServers, skills] = await Promise.all([listMcpServers(), listSkills()]);
    return { mcpServers, skills };
  });

  // Everything below changes kiro's own files, so kiro reads the change when a session
  // starts: a new chat, or an open one after Reload. Adding a server lets the browser name
  // any command for kiro to run. That is no more than a chat can already do, since Casper
  // allows every tool call kiro asks about.
  app.post<{ Body: McpServerInput }>('/api/tools/mcp', (req, reply) =>
    answer(reply, () => addMcpServer(req.body ?? { name: '' })),
  );

  app.put<{ Params: { name: string }; Body: { disabled?: boolean } }>('/api/tools/mcp/:name', (req, reply) =>
    answer(reply, () => setMcpServerDisabled(req.params.name, req.body?.disabled === true)),
  );

  app.delete<{ Params: { name: string } }>('/api/tools/mcp/:name', (req, reply) =>
    answer(reply, () => removeMcpServer(req.params.name)),
  );
}

/** `{ ok: true }`, or a 400 with the error's message. */
async function answer(reply: FastifyReply, fn: () => Promise<void>) {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
}
