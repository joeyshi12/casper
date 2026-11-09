import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SettingsResponse, ToolsResponse, UpdateDefaultsRequest } from '@casper/shared';
import { api } from '../../api/rest.js';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { formatElapsed } from '../../util/duration.js';
import { Dropdown } from '../common/Dropdown.js';
import { ChevronRightIcon, CloseIcon, LockIcon, PlusIcon, TrashIcon } from '../common/icons.js';
import { effortName } from '../controls/Pickers.js';
import { DevicesPanel } from './DevicesPanel.js';

type Tab = 'general' | 'tools' | 'account' | 'about';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'tools', label: 'Tools' },
  { id: 'account', label: 'Account' },
  { id: 'about', label: 'About' },
];

interface Props {
  onClose: () => void;
  onLock: () => void;
}

/** Casper's settings, one tab per area. Each tab holds everything for its area, so none
 *  opens another dialog. */
export function SettingsModal({ onClose, onLock }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    api.settings().then(
      (s) => setSettings(s),
      (err: unknown) => setError(err instanceof Error ? err.message : 'Could not read the settings.'),
    );

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Portalled for the same reason as the other dialogs: the sidebar is transformed.
  return createPortal(
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-modal settings-modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="devices-head">
          <span className="devices-title">Settings</span>
          <button className="iconbtn settings-close" aria-label="Close settings" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`settings-tab${tab === t.id ? ' is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className={`settings-pane settings-pane-${tab}`} role="tabpanel">
            {error && <p className="settings-error">{error}</p>}
            {tab === 'general' && <GeneralPane settings={settings} onError={setError} onSaved={refresh} />}
            {tab === 'tools' && <ToolsPane onError={setError} />}
            {tab === 'account' && (
              <div className="settings-stack">
                <DevicesPanel onSelfRevoked={onLock} />
                <section className="settings-card" aria-label="This browser">
                  <header className="settings-card-head">
                    <span className="settings-card-title">This browser</span>
                  </header>
                  <SettingRow
                    icon={<LockIcon size={16} />}
                    label="Lock this app"
                    hint="Sign this browser out. Running chats keep going."
                  >
                    <button className="btn-sm" onClick={onLock}>
                      Lock
                    </button>
                  </SettingRow>
                </section>
              </div>
            )}
            {tab === 'about' && <AboutPane settings={settings} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SettingRow({
  icon,
  label,
  hint,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-item">
      {icon && <span className="settings-item-icon">{icon}</span>}
      <span className="settings-item-text">
        <span className="settings-item-name">{label}</span>
        {hint && <span className="settings-item-desc">{hint}</span>}
      </span>
      <span className="setting-control">{children}</span>
    </div>
  );
}

function GeneralPane({
  settings,
  onError,
  onSaved,
}: {
  settings: SettingsResponse | null;
  onError: (message: string | null) => void;
  onSaved: () => void;
}) {
  const models = useStore((s) => s.models);
  const agents = useStore((s) => s.agents);
  const model = models.find((m) => m.isDefault);
  const levels = model?.effortLevels ?? [];

  const save = async (change: UpdateDefaultsRequest) => {
    onError(null);
    try {
      await api.updateDefaults(change);
      // The pickers take their defaults from these lists.
      sessionController.loadPickers();
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the setting.');
    }
  };

  return (
    <div className="settings-stack">
      <p className="settings-note">These are kiro&rsquo;s own defaults, so the kiro CLI uses them too.</p>
      <section className="settings-card settings-card-menus" aria-label="Defaults for new chats">
        <header className="settings-card-head">
          <span className="settings-card-title">Defaults for new chats</span>
        </header>
        <SettingRow label="Model" hint="The model a new chat starts on.">
          <Dropdown
            ariaLabel="Default model"
            value={model?.modelId}
            onChange={(modelId) => void save({ modelId })}
            options={models.map((m) => ({ value: m.modelId, label: m.modelName, hint: `${m.rateMultiplier}x` }))}
          />
        </SettingRow>
        {/* Always shown, so changing the model never changes the card's height. */}
        <SettingRow label="Effort" hint="How long the model thinks before it answers.">
          {model && levels.length > 0 ? (
            <Dropdown
              ariaLabel="Default effort"
              value={model.defaultEffort}
              onChange={(level) => void save({ effort: { modelId: model.modelId, level } })}
              options={levels.map((l) => ({ value: l, label: effortName(l) }))}
            />
          ) : (
            <span className="setting-none">Not set for this model</span>
          )}
        </SettingRow>
        <SettingRow label="Agent" hint="The agent a new chat uses.">
          <Dropdown
            ariaLabel="Default agent"
            value={settings?.defaultAgentId}
            onChange={(agentId) => void save({ agentId })}
            options={agents.map((a) => ({ value: a.id, label: a.name }))}
          />
        </SettingRow>
      </section>
    </div>
  );
}

function AboutPane({ settings }: { settings: SettingsResponse | null }) {
  if (!settings) return <p className="settings-note">Loading…</p>;
  const s = settings.server;
  const cards: { title: string; rows: [string, string][] }[] = [
    {
      title: 'Versions',
      rows: [
        ['Casper', s.version],
        ['kiro-cli', s.kiroVersion ?? 'unknown'],
        ['kiro-cli path', s.kiroBin],
      ],
    },
    {
      title: 'Server',
      rows: [
        ['Listening on', `${s.host}:${s.port}`],
        ['Login', s.authEnabled ? 'Required' : 'Off'],
        ['Live sessions', `${s.liveSessions} of ${s.maxLiveSessions}`],
        ['Running for', formatElapsed(s.uptimeMs / 1000)],
      ],
    },
    {
      title: 'Folders',
      rows: [
        ['File access root', s.fileRoot],
        ['Default folder', s.defaultCwd],
        ['Data folder', s.dataDir],
        ['Config file', s.configFile],
      ],
    },
  ];
  return (
    <div className="settings-stack">
      <p className="settings-note">These come from the config file and the environment, and change on a restart.</p>
      {cards.map((c) => (
        <section key={c.title} className="settings-card" aria-label={c.title}>
          <header className="settings-card-head">
            <span className="settings-card-title">{c.title}</span>
          </header>
          <dl className="settings-about">
            {c.rows.map(([k, v]) => (
              <div key={k} className="settings-about-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Splits a line of arguments on spaces, keeping quoted parts whole. */
function splitArgs(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
}

/** `KEY=value` lines. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) throw new Error(`Write each variable as NAME=value: ${t}`);
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

function ToolsPane({ onError }: { onError: (message: string | null) => void }) {
  const [tools, setTools] = useState<ToolsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', args: '', env: '' });

  const refresh = () =>
    api.tools().then(setTools, (err: unknown) => onError(err instanceof Error ? err.message : 'Could not read the tools.'));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    onError(null);
    try {
      await run();
      await refresh();
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const target = form.target.trim();
  const isUrl = /^https?:\/\//.test(target);

  const addServer = async () => {
    let env: Record<string, string>;
    try {
      env = parseEnv(form.env);
    } catch (err) {
      onError((err as Error).message);
      return;
    }
    const ok = await act(() =>
      api.addMcpServer({
        name: form.name.trim(),
        ...(isUrl ? { url: target } : { command: target, args: splitArgs(form.args) }),
        ...(Object.keys(env).length ? { env } : {}),
      }),
    );
    if (ok) {
      setAdding(false);
      setForm({ name: '', target: '', args: '', env: '' });
    }
  };

  if (!tools) return <p className="settings-note">Loading…</p>;
  return (
    <div className="settings-stack">
      <p className="settings-note">kiro reads these when a session starts: a new chat, or an open one after Reload.</p>

      <section className="settings-card" aria-label="MCP servers">
        <header className="settings-card-head">
          <span className="settings-card-title">
            MCP servers <span className="settings-count">{tools.mcpServers.length}</span>
          </span>
          {!adding && (
            <button className="btn-sm tools-add" onClick={() => setAdding(true)}>
              <PlusIcon size={13} />
              Add server
            </button>
          )}
        </header>

        {adding && (
          <div className="mcp-form">
            <label className="mcp-field">
              <span>Name</span>
              <input
                className="settings-input"
                aria-label="Server name"
                placeholder="figma"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="mcp-field">
              <span>Command or URL</span>
              <input
                className="settings-input"
                aria-label="Command or URL"
                placeholder="npx, or https://…"
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
              />
            </label>
            {!isUrl && (
              <label className="mcp-field mcp-field-wide">
                <span>Arguments</span>
                <input
                  className="settings-input"
                  aria-label="Arguments"
                  placeholder="-y figma-developer-mcp --stdio"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                />
              </label>
            )}
            <label className="mcp-field mcp-field-wide">
              <span>Environment</span>
              <textarea
                className="settings-input settings-mono-input"
                aria-label="Environment variables"
                placeholder={'API_KEY=…  (one per line)'}
                rows={2}
                value={form.env}
                onChange={(e) => setForm({ ...form, env: e.target.value })}
              />
            </label>
            <div className="mcp-form-actions mcp-field-wide">
              <button className="btn-sm btn-ghost" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button
                className="btn-sm btn-primary"
                disabled={busy || !form.name.trim() || !target}
                onClick={() => void addServer()}
              >
                Add server
              </button>
            </div>
          </div>
        )}

        {tools.mcpServers.length === 0 ? (
          <p className="settings-empty">No servers in ~/.kiro/settings/mcp.json.</p>
        ) : (
          tools.mcpServers.map((m) => (
            <div className={`settings-item${m.disabled ? ' is-off' : ''}`} key={m.name}>
              <span className="settings-item-text">
                <span className="settings-item-name">
                  {m.name}
                  <span className="tools-tag">{m.url ? 'HTTP' : 'stdio'}</span>
                  {m.disabled && <span className="tools-tag is-off">Off</span>}
                </span>
                <code className="settings-item-detail">{m.url ?? [m.command, ...m.args].join(' ')}</code>
                {m.envKeys.length > 0 && <span className="settings-item-env">env: {m.envKeys.join(', ')}</span>}
              </span>
              <span className="settings-item-actions">
                <label className="switch" title={m.disabled ? 'Turn on' : 'Turn off'}>
                  <input
                    type="checkbox"
                    aria-label={`Use ${m.name}`}
                    checked={!m.disabled}
                    disabled={busy}
                    onChange={(e) => void act(() => api.setMcpServerDisabled(m.name, !e.target.checked))}
                  />
                  <span className="switch-track" aria-hidden />
                </label>
                <button
                  className="iconbtn tools-remove"
                  aria-label={`Remove ${m.name}`}
                  title="Remove"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${m.name} from kiro's MCP servers?`)) void act(() => api.removeMcpServer(m.name));
                  }}
                >
                  <TrashIcon size={15} />
                </button>
              </span>
            </div>
          ))
        )}
      </section>

      <section className="settings-card" aria-label="Skills">
        <header className="settings-card-head">
          <span className="settings-card-title">
            Skills <span className="settings-count">{tools.skills.length}</span>
          </span>
          <span className="settings-card-where">~/.kiro/skills</span>
        </header>
        {tools.skills.length === 0 ? (
          <p className="settings-empty">No skills in ~/.kiro/skills.</p>
        ) : (
          tools.skills.map((sk) => (
            <a className="settings-item settings-item-link" key={sk.path} href={api.previewUrl('', sk.path)} target="_blank" rel="noopener noreferrer">
              <span className="settings-item-text">
                <span className="settings-item-name">{sk.name}</span>
                {sk.description && <span className="settings-item-desc">{sk.description}</span>}
              </span>
              <ChevronRightIcon size={14} className="settings-item-chevron" />
            </a>
          ))
        )}
      </section>
    </div>
  );
}
