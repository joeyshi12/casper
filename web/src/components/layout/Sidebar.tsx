import { useEffect, useState } from 'react';
import type { SessionSummary } from '@casper/shared';
import { LockIcon, PlusIcon, SearchIcon } from '../common/icons.js';
import { SearchModal } from '../sessions/SearchModal.js';
import { DevicesModal } from '../sessions/DevicesModal.js';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onLock: () => void;
}

// Show the last one or two path segments so the directory reads at a glance.
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

function relTime(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return '';
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

/**
 * Persistent session list. Search opens a centered modal palette. On desktop
 * the sidebar sits left of the chat; on mobile it's the home screen.
 */
export function Sidebar({
  sessions,
  activeId,
  onOpen,
  onNew,
  onDelete,
  onRename,
  onLock,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Close any open row menu on an outside click.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuId]);

  // Close the account menu on an outside click.
  useEffect(() => {
    if (!accountOpen) return;
    const close = () => setAccountOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [accountOpen]);

  const commitRename = (id: string) => {
    const t = draft.trim();
    if (t) onRename(id, t);
    setRenamingId(null);
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <span className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" />
          <span className="wordmark">Casper</span>
        </span>
        <div className="sidebar-actions">
          <div className="account-menu">
            <button
              className="iconbtn iconbtn-lg"
              aria-label="Account"
              title="Account"
              onClick={(e) => {
                e.stopPropagation();
                setAccountOpen((v) => !v);
              }}
            >
              <LockIcon size={18} />
            </button>
            {accountOpen && (
              <div className="menu-list" onClick={(e) => e.stopPropagation()}>
                <button
                  className="menu-item"
                  onClick={() => {
                    setAccountOpen(false);
                    setDevicesOpen(true);
                  }}
                >
                  Devices
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setAccountOpen(false);
                    onLock();
                  }}
                >
                  Lock app
                </button>
              </div>
            )}
          </div>
          <button
            className="iconbtn iconbtn-lg"
            aria-label="Search sessions"
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon size={20} />
          </button>
          <button
            className="iconbtn iconbtn-lg"
            aria-label="New session"
            title="New session"
            onClick={onNew}
          >
            <PlusIcon size={20} />
          </button>
        </div>
      </header>

      <div className="sidebar-list">
        {sessions.length === 0 ? (
          <p className="sidebar-empty">
            No sessions yet. Start one and it keeps running while you're away.
          </p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`srow ${s.sessionId === activeId ? 'is-active' : ''}`}
            >
              {renamingId === s.sessionId ? (
                <input
                  className="srow-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(s.sessionId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(s.sessionId);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <button className="srow-open" onClick={() => onOpen(s.sessionId)}>
                  <span className="srow-main">
                    <span className="srow-title" title={s.title}>
                      {s.title}
                    </span>
                    <span className="srow-sub">
                      <span className="srow-agent">{s.agentId ?? 'kiro_default'}</span>
                      <span className="srow-dot">·</span>
                      <span>{relTime(s.updatedAt)}</span>
                    </span>
                    {s.cwd && (
                      <span className="srow-cwd" title={s.cwd}>
                        {shortCwd(s.cwd)}
                      </span>
                    )}
                  </span>
                </button>
              )}

              <div className="srow-menu">
                <button
                  className="iconbtn srow-menu-btn"
                  aria-label="Session actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuId(menuId === s.sessionId ? null : s.sessionId);
                  }}
                >
                  ⋮
                </button>
                {menuId === s.sessionId && (
                  <div className="menu-list" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuId(null);
                        setDraft(s.title);
                        setRenamingId(s.sessionId);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="menu-item menu-item-danger"
                      onClick={() => {
                        setMenuId(null);
                        onDelete(s.sessionId);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {searchOpen && (
        <SearchModal
          sessions={sessions}
          onOpen={onOpen}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {devicesOpen && (
        <DevicesModal
          onClose={() => setDevicesOpen(false)}
          onSelfRevoked={() => {
            setDevicesOpen(false);
            onLock();
          }}
        />
      )}
    </aside>
  );
}
