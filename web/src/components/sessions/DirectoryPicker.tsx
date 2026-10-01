import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../../api/rest.js';
import { EllipsisIcon } from '../common/icons.js';
import { PopoverMenu } from '../common/PopoverMenu.js';
import type { DirListing } from '@casper/shared';

const SEP = '/';
const TAIL = 2;

interface Props {
  /** Where to start browsing. A seed: the picker owns its position afterwards. */
  initialPath: string;
  onChange: (path: string) => void;
  onSubmit: () => void;
}

function parentOf(dir: string): string {
  if (!dir || dir === SEP) return SEP;
  const cut = dir.replace(/\/+$/, '').lastIndexOf(SEP);
  return cut <= 0 ? SEP : dir.slice(0, cut);
}

function crumbsOf(dir: string): { name: string; path: string }[] {
  const out = [{ name: SEP, path: SEP }];
  let acc = '';
  for (const part of dir.split(SEP).filter(Boolean)) {
    acc = `${acc}${SEP}${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

function nameUnder(dir: string, full: string): string {
  return full.slice(dir.length).replace(/^\/+/, '');
}

export function DirectoryPicker({ initialPath, onChange, onSubmit }: Props) {
  const [browseDir, setBrowseDir] = useState(initialPath.trim());
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [active, setActive] = useState(-1);
  const [crumbMenu, setCrumbMenu] = useState<HTMLElement | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requested = useRef('');
  const seeded = useRef(false);
  const browseDirRef = useRef(browseDir);
  browseDirRef.current = browseDir;
  // A ref so a fresh closure from the parent each render doesn't re-run the fetch.
  const report = useRef(onChange);
  report.current = onChange;

  const baseId = useId();
  const listId = `${baseId}-listbox`;

  const pathQuery = useMemo(() => {
    if (query.startsWith(SEP)) return query;
    if (!browseDir) return query;
    const base = browseDir.endsWith(SEP) ? browseDir : browseDir + SEP;
    return query ? base + query : base;
  }, [browseDir, query]);

  useEffect(() => {
    requested.current = pathQuery;
    const t = setTimeout(() => {
      api
        .listDirs(pathQuery)
        .then((r) => {
          if (requested.current !== pathQuery) return;
          setListing(r);
          // Adopt the server's resolved dir only once an empty seed, or adopting it
          // again would change pathQuery and fire a second request.
          if (!seeded.current && r.dir) {
            seeded.current = true;
            if (!browseDirRef.current) setBrowseDir(r.dir);
          }
          report.current(r.target);
        })
        .catch(() => {
          if (requested.current !== pathQuery) return;
          setListing(null);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [pathQuery]);

  const options = listing?.entries ?? [];
  const hereDir = listing?.dir ?? browseDir;
  const crumbs = crumbsOf(hereDir);
  const folded = crumbs.length > TAIL + 2;
  const hiddenCrumbs = folded ? crumbs.slice(1, -TAIL) : [];
  const tailCrumbs = folded ? crumbs.slice(-TAIL) : crumbs.slice(1);
  const root = crumbs[0]!;
  const here = crumbs[crumbs.length - 1];

  // Keeps the highlighted row visible: aria-activedescendant lets a screen reader
  // describe an option scrolled out of view otherwise.
  useEffect(() => {
    if (active < 0) return;
    const row = listRef.current?.children[active] as HTMLElement | undefined;
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const goTo = (dir: string) => {
    setBrowseDir(dir);
    setQuery('');
    setActive(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && options.length > 0) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp' && options.length > 0) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0 && !query) {
      e.preventDefault();
      goTo(parentOf(hereDir));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = active >= 0 ? options[active] : undefined;
      if (chosen) goTo(chosen);
      else onSubmit();
    } else if (e.key === 'Escape' && active >= 0) {
      e.stopPropagation();
      setActive(-1);
    }
  };

  const target = listing?.target;
  const willCreate = Boolean(target) && listing?.targetKind === 'missing';
  const isFile = Boolean(target) && listing?.targetKind === 'file';

  const crumbButton = (c: { name: string; path: string }, extra = '') => (
    <button
      type="button"
      className={`dirpick-crumb ${c === here ? 'is-here' : ''} ${extra}`}
      onClick={() => c !== here && goTo(c.path)}
      disabled={c === here}
      title={c.path}
    >
      {c.name}
    </button>
  );

  return (
    <div className="dirpick">
      {/* No horizontal scroller: an overshooting swipe fires the browser's back gesture. */}
      <div className="dirpick-crumbs">
        {crumbButton(root)}
        {hiddenCrumbs.length > 0 && (
          <button
            type="button"
            className="dirpick-crumb dirpick-more"
            aria-haspopup="menu"
            aria-expanded={crumbMenu !== null}
            aria-label={`Show ${hiddenCrumbs.length} folders above`}
            title={`${hiddenCrumbs.length} folders above`}
            onClick={(e) => setCrumbMenu(crumbMenu ? null : e.currentTarget)}
          >
            <EllipsisIcon size={15} />
          </button>
        )}
        {tailCrumbs.map((c, i) => (
          <span key={c.path} className="dirpick-crumb-wrap">
            {(i > 0 || hiddenCrumbs.length > 0) && <span className="dirpick-sep">/</span>}
            {crumbButton(c)}
          </span>
        ))}
      </div>

      {crumbMenu && (
        <PopoverMenu anchor={crumbMenu} onClose={() => setCrumbMenu(null)}>
          {hiddenCrumbs.map((c) => (
            <button
              key={c.path}
              className="menu-item"
              onClick={() => {
                setCrumbMenu(null);
                goTo(c.path);
              }}
            >
              {c.name}
            </button>
          ))}
        </PopoverMenu>
      )}

      <input
        ref={inputRef}
        className="dirpick-input"
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Working directory"
        aria-activedescendant={active >= 0 ? `${baseId}-opt-${active}` : undefined}
        value={query}
        placeholder="Search folders…"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />

      <div ref={listRef} id={listId} role="listbox" aria-label="Folders" className="dirpick-list">
        {options.map((full, i) => (
          <button
            key={full}
            id={`${baseId}-opt-${i}`}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`dirpick-opt ${i === active ? 'is-active' : ''}`}
            title={full}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => goTo(full)}
          >
            <span className="dirpick-tail">
              <span>{nameUnder(hereDir, full)}</span>
            </span>
          </button>
        ))}
        {options.length === 0 && (
          <div className="dirpick-empty">
            {query ? 'Nothing here matches.' : 'No subfolders.'}
          </div>
        )}
      </div>

      <div className="dirpick-status" aria-live="polite">
        {willCreate && <span className="dirpick-note is-new">This folder will be created</span>}
        {isFile && <span className="dirpick-note is-bad">That path is a file, not a folder</span>}
      </div>
    </div>
  );
}
