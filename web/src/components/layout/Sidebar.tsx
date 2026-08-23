import { Link } from 'react-router';
import { pathForSession } from '../../util/route.js';
import { useCallback, useEffect, useState } from 'react';
import type { SessionSummary } from '@casper/shared';
import { LockIcon, MoreIcon, PlusIcon, SearchIcon, Spinner } from '../common/icons.js';
import { PopoverMenu } from '../common/PopoverMenu.js';
import { SearchModal } from '../sessions/SearchModal.js';
import { DevicesModal } from '../sessions/DevicesModal.js';
import { ConfirmDialog } from '../common/ConfirmDialog.js';
import { relTime } from '../../util/relTime.js';

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  /** Session currently being fetched after a click, for a small inline spinner
   *  while a slow transcript hydrates. */
  loadingId: string | null;
  /** Fired on a plain left click, just before the router navigates. */
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onLock: () => void;
}

/** Session list: left of the chat on desktop, the home screen on mobile. */
export function Sidebar({
  sessions,
  activeId,
  loadingId,
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
  /** The row's ⋮ button, which the portaled menu measures itself against. */
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // PopoverMenu owns its own dismissal, so there is no blanket document listener
  // here: one would race the menu items, closing the menu before a click landed.
  const closeRowMenu = useCallback(() => {
    setMenuId(null);
    setMenuAnchor(null);
  }, []);

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
              className={`srow ${s.sessionId === activeId ? 'is-active' : ''} ${
                menuId === s.sessionId ? 'is-menu-open' : ''
              }`}
            >
              {renamingId === s.sessionId ? (
                <input
                  className="srow-rename"
                  autoFocus
                  // Start with the name selected, so typing replaces it.
                  onFocus={(e) => e.currentTarget.select()}
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
                <Link
                  className="srow-open"
                  to={pathForSession(s.sessionId)}
                  onClick={(e) => {
                    // A modified click opens a new tab; don't mark this one loading.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    onOpen(s.sessionId);
                  }}
                >
                  <span className="srow-main">
                    <span className="srow-title" title={s.title}>
                      {s.title}
                    </span>
                    <span className="srow-sub">
                      <span className="srow-agent">{s.agentId ?? 'kiro_default'}</span>
                      <span className="srow-dot">·</span>
                      {loadingId === s.sessionId && (
                        <Spinner size={11} className="srow-spinner" />
                      )}
                      <span className="srow-when">{relTime(s.updatedAt)}</span>
                    </span>
                  </span>
                </Link>
              )}

              <div className="srow-menu">
                <button
                  className="iconbtn srow-menu-btn"
                  aria-label="Session actions"
                  aria-haspopup="menu"
                  aria-expanded={menuId === s.sessionId}
                  onClick={(e) => {
                    e.stopPropagation();
                    const open = menuId === s.sessionId;
                    setMenuAnchor(open ? null : e.currentTarget);
                    setMenuId(open ? null : s.sessionId);
                  }}
                >
                  <MoreIcon size={16} />
                </button>
                {menuId === s.sessionId && (
                  <PopoverMenu anchor={menuAnchor} onClose={closeRowMenu}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setDraft(s.title);
                        setRenamingId(s.sessionId);
                        closeRowMenu();
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="menu-item menu-item-danger"
                      onClick={() => {
                        closeRowMenu();
                        setConfirmingId(s.sessionId);
                      }}
                    >
                      Delete
                    </button>
                  </PopoverMenu>
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

      {confirmingId && (
        <ConfirmDialog
          title="Delete session?"
          message="This session and its history will be permanently deleted. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const id = confirmingId;
            setConfirmingId(null);
            onDelete(id);
          }}
          onCancel={() => setConfirmingId(null)}
        />
      )}
    </aside>
  );
}
