import { TopBar } from '@minca/app-shared/TopBar';
import { useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Mark } from '@minca/app-shared/Wordmark';
import { Shape } from '@minca/app-shared/shapes';
import { type ShapeKind } from '@minca/ui/shapes';
import { SHAPE_CYCLE, type ShapeColour } from '@minca/ui/tokens';

/** The site's pages (`/`, `/developers`, `/protocol`, `/extension`, `/download`, `/install/*`), on the same design system as the app */
export const GITHUB = 'https://github.com/leifriksheim/minca';
export const SPEC = `${GITHUB}/tree/main/spec`;
/** Links off the site open in a tab of their own */
export const EXTERNAL = { target: '_blank', rel: 'noreferrer' } as const;
/** The app, a site of its own (`apps/example`), which every "Open Minca" opens */
export const APP = import.meta.env.VITE_MINCA_APP ?? 'https://app.minca.social';

type PageName = 'home' | 'developers' | 'protocol' | 'extension' | 'download' | 'mcp';

/** GitHub's mark, in the colour of the text beside it */
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** A download: an arrow into a tray, in the colour of the text beside it */
export function DownloadMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="download-mark"
    >
      <path d="M9 2.5v8.5M5 7.5l4 4 4-4M3 12.5v2.5h12v-2.5" />
    </svg>
  );
}

/** Chrome's mark, drawn simply: three sectors around a blue centre */
export function ChromeMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="chrome-mark">
      <path d="M8 8L1.07 4A8 8 0 0 1 14.93 4z" fill="#db4437" />
      <path d="M8 8l6.93-4A8 8 0 0 1 8 16z" fill="#f4b400" />
      <path d="M8 8v8A8 8 0 0 1 1.07 4z" fill="#0f9d58" />
      <circle cx="8" cy="8" r="3.7" fill="#fff" />
      <circle cx="8" cy="8" r="2.9" fill="#4285f4" />
    </svg>
  );
}

/** Three lines, or a cross while the menu they open is open (which shows is up to the CSS) */
function MenuMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden
    >
      <path className="menu-closed" d="M2.5 5h13M2.5 9h13M2.5 13h13" />
      <path className="menu-opened" d="M4 4l10 10M14 4L4 14" />
    </svg>
  );
}

/** The links in the bar: the same ones whether they sit in it or, on a phone, drop from the menu */
const NAV_LINKS: ReadonlyArray<{
  readonly to: '/download' | '/mcp' | '/developers' | '/protocol';
  readonly page: PageName;
  readonly label: string;
}> = [
  { to: '/download', page: 'download', label: 'Download' },
  { to: '/mcp', page: 'mcp', label: 'MCP' },
  { to: '/developers', page: 'developers', label: 'Developers' },
  { to: '/protocol', page: 'protocol', label: 'Protocol' },
];

const MENU = 'site-menu';

/**
 * The bar. On a wide screen its links sit in it; on a phone (site.css) the
 * same list is a popover the menu button opens, so the browser closes it on
 * Escape or a tap elsewhere and nothing here measures the screen.
 */
function Nav({ page }: { page: PageName }) {
  // A link moves to another page without reloading it, so it closes the menu itself.
  const close = (event: MouseEvent<HTMLElement>) => {
    const menu = event.currentTarget;
    if (menu.matches(':popover-open')) menu.hidePopover();
  };
  return (
    <header className="nav">
      <TopBar className="nav-bar">
        <Link to="/" className="brand">
          <Mark />
          minca
        </Link>
        <nav id={MENU} className="nav-links" popover="auto" aria-label="Site" onClick={close}>
          {NAV_LINKS.map((link) => (
            <Link key={link.to} to={link.to} aria-current={page === link.page ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="nav-end">
          <a href={GITHUB} {...EXTERNAL} className="nav-icon" aria-label="GitHub">
            <GitHubMark />
          </a>
          <a href={APP} {...EXTERNAL} data-intent="primary" className="nav-open">
            Open Minca
          </a>
          <button
            type="button"
            className="nav-toggle"
            data-intent="ghost"
            data-icon
            popoverTarget={MENU}
            aria-label="Menu"
          >
            <MenuMark />
          </button>
        </div>
      </TopBar>
    </header>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <span className="footer-brand">
          <Mark size={18} />
          Many hands, one minca.
        </span>
        <span className="footer-links">
          <Link to="/">Communities</Link>
          <Link to="/developers">Developers</Link>
          <Link to="/protocol">Protocol</Link>
          <Link to="/mcp">MCP</Link>
          <Link to="/download">Download</Link>
          <Link to="/extension">Chrome extension</Link>
          <a href={SPEC} {...EXTERNAL}>
            Spec
          </a>
          <a href={GITHUB} {...EXTERNAL}>
            GitHub
          </a>
          <a href={APP} {...EXTERNAL}>
            Open Minca
          </a>
        </span>
      </div>
    </footer>
  );
}

export function Page({ page, children }: { page: PageName; children: ReactNode }) {
  return (
    <div className="site">
      <Nav page={page} />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

/** A band of a page: a kicker if it needs one, a heading and a line or two on what it is about, then the band itself */
export function Band({
  id,
  tone,
  kicker,
  title,
  intro,
  children,
}: {
  id?: string;
  /** `sunken` sets the band on the warmer paper, edged with the navy rule */
  tone?: 'sunken';
  kicker?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={tone ? `band ${tone}` : 'band'} id={id}>
      <div className="wrap">
        <div className="section-head">
          {kicker ? <div className="kicker">{kicker}</div> : null}
          <h2>{title}</h2>
          {intro}
        </div>
        {children}
      </div>
    </section>
  );
}

/** Short points side by side, each a heading and a sentence or two */
export function Points({ points }: { points: ReadonlyArray<{ title: string; body: ReactNode }> }) {
  return (
    <div className="points">
      {points.map((point) => (
        <div key={point.title}>
          <h3>{point.title}</h3>
          <p>{point.body}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Short points side by side in a ruled grid, each marked with the shape that
 * stands for it (DESIGN.md, Shapes). `columns` 3 for six points, else 4.
 */
export function Marked({
  items,
  columns,
}: {
  items: ReadonlyArray<{ title: string; body: ReactNode; shape: ShapeKind }>;
  columns?: 3;
}) {
  return (
    <div className={columns === 3 ? 'ruled marked marked-3' : 'ruled marked'}>
      {items.map((item, i) => (
        <div key={item.title}>
          <Shape kind={item.shape} className={`c-${SHAPE_CYCLE[i % SHAPE_CYCLE.length] ?? 'cobalt'}`} />
          <h3>{item.title}</h3>
          <p>{item.body}</p>
        </div>
      ))}
    </div>
  );
}

/** The index arrow keys, Home and End move to from `index`, or null for any other key */
function tabTarget(key: string, index: number, last: number): number | null {
  if (key === 'ArrowRight') return index === last ? 0 : index + 1;
  if (key === 'ArrowLeft') return index === 0 ? last : index - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/**
 * Tabs and the chosen one's panel: arrow keys, Home and End move between
 * them. The caller keeps which one is chosen.
 */
export function Tabs<
  T extends {
    readonly id: string;
    readonly name: string;
    readonly shape?: { readonly kind: ShapeKind; readonly colour: ShapeColour };
    readonly icon?: ReactNode;
  },
>({
  label,
  items,
  selected,
  onSelect,
  children,
}: {
  label: string;
  items: ReadonlyArray<T>;
  selected: string;
  onSelect: (id: string) => void;
  children: (item: T) => ReactNode;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const base = useId();
  const current = items.find((item) => item.id === selected) ?? items[0];
  const onKey = (event: KeyboardEvent, index: number) => {
    const to = tabTarget(event.key, index, items.length - 1);
    const next = to === null ? undefined : items[to];
    if (to === null || !next) return;
    event.preventDefault();
    onSelect(next.id);
    tabs.current[to]?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label}>
        {items.map((item, i) => (
          <button
            key={item.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-${item.id}-tab`}
            aria-selected={item.id === current?.id}
            aria-controls={`${base}-${item.id}`}
            tabIndex={item.id === current?.id ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {item.icon ??
              (item.shape && <Shape kind={item.shape.kind} colour={item.shape.colour} size={18} />)}
            {item.name}
          </button>
        ))}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`${base}-${current.id}`}
          aria-labelledby={`${base}-${current.id}-tab`}
          className="tab-panel"
        >
          {children(current)}
        </div>
      )}
    </>
  );
}
