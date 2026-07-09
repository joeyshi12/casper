// End-to-end test that drives a running server over REST + WS, covering every
// flow the web app uses. Run with: node scripts/full-e2e.mjs
import pkg from '../node_modules/ws/index.js';
const { WebSocket } = pkg;

const TOKEN = process.env.CASPER_TOKEN ?? 't';
const PORT = process.env.PORT ?? '4321';
const BASE = `http://127.0.0.1:${PORT}`;
const WSB = `ws://127.0.0.1:${PORT}`;

let pass = 0,
  fail = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    pass++;
  } else {
    console.log(`  ❌ ${msg}`);
    fail++;
  }
}

// Captured from POST /api/login and replayed as the session cookie.
let cookie = '';

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return r.status;
}

async function api(method, path, body) {
  // Mirror the web client: only send content-type when there's a body.
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

/** Open a WS, run a prompt, collect events until turn_ended (or timeout). */
function runTurn(sessionId, text, cursor = 0, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${WSB}/ws?sessionId=${sessionId}&cursor=${cursor}`,
      { headers: cookie ? { cookie } : {} },
    );
    const events = [];
    let assistantText = '';
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('turn timed out'));
    }, timeoutMs);
    ws.on('open', () => {
      if (text) ws.send(JSON.stringify({ type: 'prompt', content: [{ type: 'text', text }] }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'event') return;
      events.push(m.event);
      const p = m.event.payload;
      if (p.kind === 'session_update' && p.update.sessionUpdate === 'agent_message_chunk') {
        assistantText += p.update.content?.text ?? '';
      }
      if (p.kind === 'turn_ended' || p.kind === 'turn_error') {
        clearTimeout(timer);
        resolve({ events, assistantText, ws });
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function main() {
  const loginStatus = await login();
  ok(loginStatus === 200, `login with shared secret ok (${loginStatus})`);

  console.log('\n═══ 1. Reference data ═══');
  const health = await api('GET', '/api/health');
  ok(health.status === 200 && health.json.status === 'ok', 'health ok');
  ok(!!health.json.kiroVersion, `kiro version reported: ${health.json.kiroVersion}`);

  const models = await api('GET', '/api/models');
  ok(models.json.models?.length > 0, `models: ${models.json.models?.length}`);
  ok(models.json.models?.some((m) => m.modelId === 'auto'), 'models include auto');

  const agents = await api('GET', '/api/agents');
  ok(agents.json.agents?.length >= 3, `agents: ${agents.json.agents?.length}`);
  ok(agents.json.agents?.some((a) => a.id === 'kiro_default'), 'agents include kiro_default');

  console.log('\n═══ 2. Auth enforcement ═══');
  const noauth = await fetch(`${BASE}/api/models`);
  ok(noauth.status === 401, 'unauthenticated request rejected (401)');
  const badLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-secret' }),
  });
  ok(badLogin.status === 401, 'login with wrong secret rejected (401)');

  console.log('\n═══ 2b. Device sessions ═══');
  const devices0 = await api('GET', '/api/devices');
  ok(
    devices0.json.devices?.some((d) => d.current),
    'this device appears in the device list',
  );
  // A second login = a second device.
  const login2 = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie2 = login2.headers.get('set-cookie')?.split(';')[0];
  const devices1 = await api('GET', '/api/devices');
  ok(devices1.json.devices?.length >= 2, `second login adds a device (${devices1.json.devices?.length})`);
  // Revoke the second device; its cookie should stop working, ours keeps working.
  const other = devices1.json.devices.find((d) => !d.current);
  const rev = await api('DELETE', `/api/devices/${other.id}`);
  ok(rev.json.ok, 'revoked the other device');
  const revokedTry = await fetch(`${BASE}/api/models`, { headers: { cookie: cookie2 } });
  ok(revokedTry.status === 401, 'revoked device cookie is rejected (401)');
  const stillOk = await api('GET', '/api/models');
  ok(stillOk.status === 200, 'current device still authenticated after revoking the other');

  console.log('\n═══ 3. Session lifecycle ═══');
  const created = await api('POST', '/api/sessions', {
    agentId: 'kiro_default',
    modelId: 'claude-haiku-4.5',
  });
  const sid = created.json.summary?.sessionId;
  ok(!!sid, `created session ${sid}`);
  ok(created.json.modes?.length > 0, `session exposes ${created.json.modes?.length} modes`);

  const list = await api('GET', '/api/sessions');
  ok(list.json.sessions?.some((s) => s.sessionId === sid), 'new session appears in list');

  // Viewing detail should be fast and NOT spawn a process.
  const t0 = Date.now();
  const detail = await api('GET', `/api/sessions/${sid}`);
  const viewMs = Date.now() - t0;
  ok(detail.status === 200, 'getDetail ok');
  ok(viewMs < 500, `getDetail fast (${viewMs}ms, no spawn on view)`);

  console.log('\n═══ 4. Prompt with markdown + code + mermaid ═══');
  const turn = await runTurn(
    sid,
    'Respond with: a markdown heading, a bullet list of 2 items, a bash code block, ' +
      'and a valid mermaid flowchart (```mermaid graph TD; A-->B; ```). Keep it short.',
  );
  turn.ws.close();
  ok(
    turn.events.some((e) => e.payload.kind === 'turn_ended'),
    'turn completed (turn_ended)',
  );
  ok(turn.assistantText.length > 0, 'assistant produced text');
  ok(turn.assistantText.includes('```'), 'response contains a code fence');
  const hasMermaid = /```mermaid/.test(turn.assistantText);
  ok(hasMermaid, 'response contains a mermaid fence');
  // Metering should have arrived.
  ok(
    turn.events.some(
      (e) => e.payload.kind === 'metadata' && (e.payload.params.meteringUsage?.length ?? 0) > 0,
    ),
    'metering (credits) reported during turn',
  );

  console.log('\n═══ 5. Reconnect / replay ═══');
  // Start a turn, drop the socket after first event, reconnect with stale cursor.
  const ws1 = new WebSocket(`${WSB}/ws?sessionId=${sid}&cursor=0`, {
    headers: cookie ? { cookie } : {},
  });
  await new Promise((r, j) => {
    ws1.on('open', r);
    ws1.on('error', j);
  });
  ws1.send(
    JSON.stringify({ type: 'prompt', content: [{ type: 'text', text: 'Count 1 to 6, one per line.' }] }),
  );
  let midCursor = 0;
  await new Promise((res) => {
    let n = 0;
    ws1.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'event') {
        midCursor = m.event.seq;
        if (++n >= 1) {
          ws1.terminate();
          res();
        }
      }
    });
    setTimeout(res, 8000);
  });
  await new Promise((r) => setTimeout(r, 3000)); // turn keeps running with no client
  const replay = await runTurn(sid, null, midCursor);
  replay.ws.close();
  const seqs = replay.events.map((e) => e.seq);
  ok(
    replay.events.some((e) => e.payload.kind === 'turn_ended'),
    'reconnect replayed missed turn_ended',
  );
  ok(
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]),
    'replayed events strictly increasing (no dupes)',
  );
  ok(seqs.every((s) => s > midCursor), 'replayed events all after stale cursor');

  console.log('\n═══ 6. Model + agent switch ═══');
  const setModel = await api('POST', `/api/sessions/${sid}/model`, { modelId: 'auto' });
  ok(setModel.status === 200, 'set model ok');
  const setMode = await api('POST', `/api/sessions/${sid}/mode`, { modeId: 'kiro_default' });
  ok(setMode.status === 200, 'set agent(mode) ok');

  console.log('\n═══ 7. Delete session ═══');
  const del = await api('DELETE', `/api/sessions/${sid}`);
  ok(del.status === 200, `delete ok (status ${del.status}, body ${JSON.stringify(del.json)})`);

  console.log('\n═══ 8. Error handling ═══');
  const bad = await api('GET', '/api/sessions/does-not-exist-xyz');
  ok(bad.status === 404, 'unknown session returns 404');

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ Harness error:', err);
  process.exit(2);
});
