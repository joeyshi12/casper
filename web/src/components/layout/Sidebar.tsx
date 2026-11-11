import { Link } from 'react-router';
import { pathForChat } from '../../util/route.js';
import { groupByDate } from '../../util/chatGroups.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSummary } from '@casper/shared';
import {
  CalendarIcon,
  ChevronIcon,
  GearIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
} from '../common/icons.js';
import { PopoverMenu } from '../common/PopoverMenu.js';
import { SearchModal } from '../sessions/SearchModal.js';
import { SettingsModal } from '../sessions/SettingsModal.js';
import { ConfirmDialog } from '../common/ConfirmDialog.js';

interface Props {
  sessions: ChatSummary[];
  activeId: string | null;
  /** Session currently being fetched after a click, for a small inline spinner
   *  while a slow transcript hydrates. */
  loadingId: string | null;
  /** Fired on a plain left click, just before the router navigates. */
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onLock: () => void;
}

/** Whether to group by date is a choice for this browser, so it lives in localStorage. */
const GROUPED_KEY = 'casper.groupChatsByDate';

const SCROLLBAR_IDLE_MS = 1000;

function loadGrouped(): boolean {
  try {
    return localStorage.getItem(GROUPED_KEY) === '1';
  } catch {
    return false;
  }
}

function saveGrouped(on: boolean): void {
  try {
    localStorage.setItem(GROUPED_KEY, on ? '1' : '0');
  } catch {
    // storage is blocked; the choice lasts until the page reloads
  }
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
  onPin,
  onLock,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  /** The row's ⋮ button, which the portaled menu measures itself against. */
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [grouped, setGrouped] = useState(loadGrouped);
  /** Whether the list is scrolled down, which draws a line under the header. */
  const [scrolled, setScrolled] = useState(false);
  /** Labels of the sections the user folded away, for this page load. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // PopoverMenu owns its own dismissal, so there is no blanket document listener
  // here: one would race the menu items, closing the menu before a click landed.
  const closeRowMenu = useCallback(() => {
    setMenuId(null);
    setMenuAnchor(null);
  }, []);

  // Shows the scrollbar while the list scrolls. The class is set on the element, so
  // scrolling does not re-render the sidebar.
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current);
    },
    [],
  );
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrolled(el.scrollTop > 0);
    el.classList.add('is-scrolling');
    if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current);
    scrollIdleTimer.current = setTimeout(() => el.classList.remove('is-scrolling'), SCROLLBAR_IDLE_MS);
  };

  const commitRename = (id: string) => {
    const t = draft.trim();
    if (t) onRename(id, t);
    setRenamingId(null);
  };

  const pinned = sessions.filter((s) => s.pinned);
  const unpinned = sessions.filter((s) => !s.pinned);

  const toggleGrouped = () => {
    saveGrouped(!grouped);
    setGrouped(!grouped);
  };

  const toggleCollapsed = (label: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  const groupButton = (
    <button
      className={`iconbtn sidebar-section-btn sidebar-group-btn${grouped ? ' is-on' : ''}`}
      aria-label="Group chats by date"
      aria-pressed={grouped}
      title={grouped ? 'Stop grouping by date' : 'Group by date'}
      onClick={toggleGrouped}
    >
      <CalendarIcon size={15} />
    </button>
  );

  const sectionHead = (label: string, action?: React.ReactNode, open?: boolean) => (
    <div className="sidebar-section-head">
      {open === undefined ? (
        <span className="sidebar-section-title">{label}</span>
      ) : (
        <button className="sidebar-section-toggle" aria-expanded={open} onClick={() => toggleCollapsed(label)}>
          <span className="sidebar-section-title">{label}</span>
          <ChevronIcon size={12} className={`sidebar-section-chevron${open ? '' : ' is-closed'}`} />
        </button>
      )}
      {action}
    </div>
  );

  const section = (label: string, chats: ChatSummary[], action?: React.ReactNode) => {
    const open = !collapsed.has(label);
    return (
      <section key={label} className="sidebar-section" aria-label={label}>
        {sectionHead(label, action, open)}
        {open && <div className="sidebar-list">{chats.map(renderRow)}</div>}
      </section>
    );
  };

  const renderRow = (s: ChatSummary) => (
    <div
      key={s.chatId}
      className={`srow ${s.chatId === activeId ? 'is-active' : ''} ${
        menuId === s.chatId ? 'is-menu-open' : ''
      }`}
    >
      {renamingId === s.chatId ? (
        <input
          className="srow-rename"
          autoFocus
          // Start with the name selected, so typing replaces it.
          onFocus={(e) => e.currentTarget.select()}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitRename(s.chatId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(s.chatId);
            if (e.key === 'Escape') setRenamingId(null);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <Link
          className="srow-open"
          to={pathForChat(s.chatId)}
          onClick={(e) => {
            // A modified click opens a new tab; don't mark this one loading.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            onOpen(s.chatId);
          }}
        >
          <span className="sb-icon">
            {loadingId === s.chatId ? (
              <Spinner size={12} className="srow-spinner" />
            ) : (
              <span className="srow-dot" />
            )}
          </span>
          <span className="srow-title" title={s.title}>
            {s.title}
          </span>
        </Link>
      )}

      <div className="srow-menu">
        <button
          className="iconbtn srow-menu-btn"
          aria-label="Session actions"
          aria-haspopup="menu"
          aria-expanded={menuId === s.chatId}
          onClick={(e) => {
            e.stopPropagation();
            const open = menuId === s.chatId;
            setMenuAnchor(open ? null : e.currentTarget);
            setMenuId(open ? null : s.chatId);
          }}
        >
          <MoreIcon size={16} />
        </button>
        {menuId === s.chatId && (
          <PopoverMenu anchor={menuAnchor} onClose={closeRowMenu}>
            <button
              className="menu-item"
              onClick={() => {
                closeRowMenu();
                onPin(s.chatId, !s.pinned);
              }}
            >
              {s.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setDraft(s.title);
                setRenamingId(s.chatId);
                closeRowMenu();
              }}
            >
              Rename
            </button>
            <button
              className="menu-item menu-item-danger"
              onClick={() => {
                closeRowMenu();
                setConfirmingId(s.chatId);
              }}
            >
              Delete
            </button>
          </PopoverMenu>
        )}
      </div>
    </div>
  );

  return (
    <aside className="sidebar">
      <header className={`sidebar-head${scrolled ? ' is-scrolled' : ''}`}>
        <span className="brand">
          <img className="brand-logo" src="/logo.svg" alt="" />
          <span className="wordmark">Casper</span>
        </span>
      </header>

      <div className="sidebar-scroll" onScroll={onListScroll}>
        <nav className="sidebar-nav" aria-label="Casper">
          <button className="snav-item" onClick={onNew}>
            <span className="sb-icon">
              <PlusIcon size={18} />
            </span>
            New
          </button>
          <button className="snav-item" onClick={() => setSearchOpen(true)}>
            <span className="sb-icon">
              <SearchIcon size={17} />
            </span>
            Search
          </button>
          <button className="snav-item" onClick={() => setSettingsOpen(true)}>
            <span className="sb-icon">
              <GearIcon size={17} />
            </span>
            Settings
          </button>
        </nav>

        {pinned.length > 0 && section('Pinned', pinned)}
        {sessions.length === 0 ? (
          <>
            {sectionHead('Chats', groupButton)}
            <div className="sidebar-list">
              <p className="sidebar-empty">
                No sessions yet. Start one and it keeps running while you're away.
              </p>
            </div>
          </>
        ) : grouped ? (
          groupByDate(unpinned).map((g, i) => section(g.label, g.chats, i === 0 ? groupButton : undefined))
        ) : (
          unpinned.length > 0 && section('Chats', unpinned, groupButton)
        )}
      </div>

      {searchOpen && (
        <SearchModal
          sessions={sessions}
          onOpen={onOpen}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onLock={() => {
            setSettingsOpen(false);
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
