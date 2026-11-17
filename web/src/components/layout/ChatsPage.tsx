import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ChatSummary } from '@casper/shared';
import { sessionController } from '../../state/sessionController.js';
import { pathForChat } from '../../util/route.js';
import { lastActive } from '../../util/relTime.js';
import { ConfirmDialog } from '../common/ConfirmDialog.js';
import { PopoverMenu } from '../common/PopoverMenu.js';
import { useFadingScrollbar } from '../common/useFadingScrollbar.js';
import { CheckIcon, CloseIcon, FilterIcon, MenuIcon, SearchIcon } from '../common/icons.js';

const DAY = 86_400_000;

/** The age filter: how long a chat must have been idle to be listed. */
const AGES = [
  { value: '0', label: 'Any time' },
  { value: '7', label: 'Idle a week or more' },
  { value: '30', label: 'Idle a month or more' },
  { value: '90', label: 'Idle 3 months or more' },
];

interface Props {
  chats: ChatSummary[];
  navOpen: boolean;
  onToggleNav: () => void;
  onNew: () => void;
}

/** Every chat in one list, which can be searched, filtered by age, and deleted in bulk. */
export function ChatsPage({ chats, navOpen, onToggleNav, onNew }: Props) {
  const [query, setQuery] = useState('');
  const [minAge, setMinAge] = useState('0');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const { scrolled, onScroll } = useFadingScrollbar();

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const before = Date.now() - Number(minAge) * DAY;
    return [...chats]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((c) => Date.parse(c.updatedAt) <= before)
      .filter((c) => {
        const text = `${c.title} ${c.cwd}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
  }, [chats, query, minAge]);

  // Only chats still listed count, so a filter change cannot delete something unseen.
  const picked = shown.filter((c) => selected.has(c.chatId));
  const allPicked = shown.length > 0 && picked.length === shown.length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const closeSearch = () => {
    setQuery('');
    setSearching(false);
  };

  const remove = async () => {
    setConfirming(false);
    setDeleting(true);
    setError(null);
    const failed = await sessionController.deleteChats(picked.map((c) => c.chatId));
    setDeleting(false);
    setSelected(new Set(failed));
    if (failed.length) setError(`Couldn't delete ${failed.length} of ${picked.length} chats. They are still selected.`);
    else setSelecting(false);
  };

  return (
    <main className="chatpane chats-page">
      <div className="chats-scroll fade-scroll" onScroll={onScroll}>
        <header className={`chats-head${scrolled ? ' is-scrolled' : ''}`}>
          <div className="chats-head-row">
            <button
              className="navbtn"
              onClick={onToggleNav}
              aria-label={navOpen ? 'Hide sessions' : 'Show sessions'}
              aria-expanded={navOpen}
            >
              <MenuIcon size={20} />
            </button>
            {searching ? (
              <label className="chats-search">
                <SearchIcon size={15} />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && closeSearch()}
                  onBlur={() => !query && setSearching(false)}
                  placeholder="Search chats"
                  aria-label="Search chats"
                />
                <button className="iconbtn chats-search-x" onClick={closeSearch} aria-label="Close search">
                  <CloseIcon size={14} />
                </button>
              </label>
            ) : (
              <>
                <h1 className="chats-heading">Chats</h1>
                <button className="iconbtn chats-icon" onClick={() => setSearching(true)} aria-label="Search chats" title="Search">
                  <SearchIcon size={17} />
                </button>
              </>
            )}
            <button
              className={`iconbtn chats-icon${minAge !== '0' ? ' is-on' : ''}`}
              onClick={(e) => setFilterAnchor(filterAnchor ? null : e.currentTarget)}
              aria-label="Filter by age"
              aria-haspopup="menu"
              aria-expanded={!!filterAnchor}
              title={AGES.find((a) => a.value === minAge)?.label}
            >
              <FilterIcon size={16} />
            </button>
            {selecting ? (
              <button className="btn-ghost chats-btn" onClick={stopSelecting}>
                Cancel
              </button>
            ) : (
              <button className="btn-ghost chats-btn" onClick={() => setSelecting(true)} disabled={chats.length === 0}>
                Select
              </button>
            )}
            <button className="btn-primary chats-btn" onClick={onNew}>
              New
            </button>
          </div>

          {selecting && (
            <div className="chats-selectbar">
              <button
                className="chats-check-all"
                onClick={() => setSelected(allPicked ? new Set() : new Set(shown.map((c) => c.chatId)))}
                disabled={shown.length === 0}
              >
                {allPicked ? 'Clear selection' : `Select all ${shown.length}`}
              </button>
              <span className="chats-count">{picked.length} selected</span>
              <button
                className="btn-danger chats-btn"
                onClick={() => setConfirming(true)}
                disabled={picked.length === 0 || deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
          {error && (
            <p className="chats-error" role="alert">
              {error}
            </p>
          )}
        </header>

        <div className="chats-body">
        <ul className="chats-list">
          {shown.map((c) => {
            const on = selected.has(c.chatId);
            const body = (
              <>
                {selecting && (
                  <span className={`chats-box${on ? ' is-on' : ''}`} aria-hidden>
                    {on && <CheckIcon size={12} />}
                  </span>
                )}
                <span className="chats-title">{c.title}</span>
                {c.running && <span className="chats-running">Running</span>}
                <span className="chats-time">{lastActive(c.updatedAt)}</span>
              </>
            );
            return (
              <li key={c.chatId}>
                {selecting ? (
                  <button className="chats-row" onClick={() => toggle(c.chatId)} aria-pressed={on}>
                    {body}
                  </button>
                ) : (
                  <Link className="chats-row" to={pathForChat(c.chatId)} onClick={() => sessionController.markLoading(c.chatId)}>
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        {shown.length === 0 && (
          <p className="chats-empty">{chats.length === 0 ? 'No chats yet.' : 'No chats match.'}</p>
        )}
        </div>
      </div>

      {filterAnchor && (
        <PopoverMenu anchor={filterAnchor} onClose={() => setFilterAnchor(null)}>
          {AGES.map((a) => (
            <button
              key={a.value}
              className="menu-item chats-age"
              role="menuitemradio"
              aria-checked={a.value === minAge}
              onClick={() => {
                setMinAge(a.value);
                setFilterAnchor(null);
              }}
            >
              <span>{a.label}</span>
              {a.value === minAge && <CheckIcon size={14} />}
            </button>
          ))}
        </PopoverMenu>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete ${picked.length} ${picked.length === 1 ? 'chat' : 'chats'}?`}
          message="They and their history will be permanently deleted. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </main>
  );
}
