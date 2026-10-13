import { useState } from 'react';
import { useConnection } from '@minca/core/react';
import { Shape, shapeFor, type ShapeKind } from '@minca/app-shared/shapes';
import type { ShapeColour } from '@minca/app-shared/tokens';
import { palette, tone } from './styles';

/** Liquid's mark: its shape, the same one a host shows for it, and its name */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <Shape {...shapeFor('liquid')} size={compact ? 32 : 24} />
      {!compact && (
        <span
          className="lq-display"
          style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.05em', lineHeight: 1 }}
        >
          Liquid
        </span>
      )}
    </span>
  );
}

/**
 * Before connecting: what this is, in one sentence and one drawing, and the
 * button that opens the person's account home. Nothing about the account is
 * typed here.
 */
export function Welcome() {
  const { connection, state } = useConnection();
  const [own, setOwn] = useState<string | null>(null);
  const expired = state.status === 'expired';
  const waiting = state.status === 'connecting' || state.status === 'starting';
  const home = new URL(state.home).host;

  return (
    <div className="lq-shell">
      <header className="lq-header" style={{ borderBottomColor: 'transparent' }}>
        <div className="lq-header-inner lq-bar">
          <Logo />
          <span style={{ flex: 1 }} />
          <a
            href="https://github.com/leifriksheim/minca"
            className="lq-muted"
            style={{ fontSize: 13, textDecoration: 'none' }}
          >
            Built on Minca
          </a>
        </div>
      </header>
      <main className="lq-main" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div
          className="lq-rise"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 18,
            paddingTop: 40,
          }}
        >
          <span className="lq-chip" style={{ height: 28, padding: '0 12px' }}>
            <Shape kind="burst" colour="peach" size={12} />
            Liquid democracy for any group
          </span>
          <h1
            className="lq-display"
            style={{
              fontSize: 'clamp(38px, 7.4vw, 64px)',
              lineHeight: 0.98,
              letterSpacing: '-0.05em',
              maxWidth: 660,
            }}
          >
            {expired ? 'Welcome back.' : 'Decide together, or trust someone who knows.'}
          </h1>
          <p style={{ fontSize: 17, lineHeight: 1.55, color: palette.ink.muted, maxWidth: 520 }}>
            {expired
              ? `Liquid’s access to ${state.grant?.name ?? 'your account'} ran out. Your account home will ask you to allow it again.`
              : 'Vote on anything yourself. When you don’t, your vote goes to the person or party you trust with that topic. Change your mind whenever you like.'}
          </p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              marginTop: 6,
              width: '100%',
              maxWidth: 340,
            }}
          >
            {own === null ? (
              <>
                <button
                  className="lq-btn"
                  data-variant="primary"
                  data-size="lg"
                  style={{ width: '100%' }}
                  disabled={waiting}
                  onClick={() => void connection.connect()}
                >
                  {state.status === 'connecting' ? 'Waiting for your account home…' : 'Connect with Minca'}
                </button>
                <p className="lq-faint" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                  Opens <strong style={{ color: palette.ink.body }}>{home}</strong> in a small window. Liquid
                  gets a note signed by your account, never your password.{' '}
                  <button className="lq-link" style={{ fontSize: 12.5 }} onClick={() => setOwn('')}>
                    Use your own home
                  </button>
                </p>
              </>
            ) : (
              <form
                style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void connection.connect(own);
                }}
              >
                <input
                  className="lq-input"
                  value={own}
                  onChange={(event) => setOwn(event.target.value)}
                  placeholder="home.example.com"
                  aria-label="Your account home’s address"
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="off"
                />
                <button className="lq-btn" data-variant="primary" disabled={waiting || !own.trim()}>
                  Connect
                </button>
                <button
                  type="button"
                  className="lq-link lq-muted"
                  style={{ fontSize: 12.5 }}
                  onClick={() => setOwn(null)}
                >
                  Use {home} instead
                </button>
              </form>
            )}
            {state.error && (
              <p role="alert" style={{ fontSize: 13, color: tone.against }}>
                {state.error}
              </p>
            )}
          </div>
        </div>

        <FlowArt />

        <div className="lq-grid" style={{ width: '100%', marginTop: 8 }}>
          {[
            [
              'Vote directly',
              'Vote before your device follows someone, and your own vote is the one that counts.',
            ],
            [
              'Delegate by topic',
              'Trust a neighbour with housing and a party with the budget. Each topic on its own.',
            ],
            [
              'Settled for good',
              'Once more than half the voters agree, it’s decided on every device, and no late vote changes it.',
            ],
          ].map(([title, text], i) => (
            <div key={title} className="lq-card lq-tile" style={{ minHeight: 0, gap: 8 }}>
              <span className="lq-cell-num">{String(i + 1).padStart(2, '0')}</span>
              <p className="lq-display" style={{ fontSize: 19, letterSpacing: '-0.03em', marginTop: 10 }}>
                {title}
              </p>
              <p className="lq-muted" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                {text}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

/** Five people, each a shape: two vote, one trusts a neighbour, two trust a party, and it all lands in one count */
function FlowArt() {
  const person = (x: number, y: number, kind: ShapeKind, colour: ShapeColour) => (
    <g key={`${x}-${y}`} transform={`translate(${x - 16} ${y - 16})`}>
      <Shape kind={kind} colour={colour} size={32} />
    </g>
  );
  const flow = (d: string, key: string, dashed = false) => (
    <path
      key={key}
      d={d}
      fill="none"
      stroke={palette.ink.strong}
      strokeWidth="1.25"
      strokeDasharray={dashed ? '4 4' : undefined}
      markerEnd="url(#lq-arrow)"
    />
  );
  return (
    <svg
      viewBox="0 0 440 210"
      className="lq-hero-art"
      style={{ margin: '48px 0 40px', overflow: 'visible' }}
      role="img"
      aria-label="Votes flowing through delegations into one count"
    >
      <defs>
        <marker
          id="lq-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0 8 4 0 8z" fill={palette.ink.strong} />
        </marker>
      </defs>
      {flow('M62 44 C 90 44, 110 64, 128 80', 'a', true)}
      {flow('M62 150 C 150 170, 250 150, 300 128', 'b')}
      {flow('M162 102 C 200 108, 250 110, 292 112', 'c')}
      {flow('M250 40 C 260 50, 262 60, 262 64', 'd', true)}
      {flow('M330 40 C 316 50, 300 58, 292 64', 'e', true)}
      {flow('M262 96 C 270 102, 280 106, 292 108', 'f')}
      {person(44, 44, 'scallop', 'cobalt')}
      {person(145, 96, 'flower', 'coral')}
      {person(44, 150, 'burst', 'peach')}
      {person(250, 22, 'clover', 'sage')}
      {person(334, 22, 'squircle', 'lilac')}
      <rect x="236" y="66" width="52" height="30" fill={palette.ink.strong} />
      <text
        x="262"
        y="86"
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        fill={palette.surface.card}
        fontFamily={palette.display}
      >
        Party
      </text>
      <rect x="300" y="92" width="120" height="58" fill={palette.surface.rule} />
      <rect
        x="296"
        y="88"
        width="120"
        height="58"
        fill={palette.surface.card}
        stroke={palette.surface.rule}
      />
      <rect x="310" y="104" width="54" height="7" fill={tone.for} />
      <rect x="364" y="104" width="22" height="7" fill={tone.against} />
      <rect x="386" y="104" width="16" height="7" fill={tone.track} />
      <text x="310" y="132" fontSize="11" fill={palette.ink.muted} fontFamily={palette.font}>
        5 of 5 counted
      </text>
      <text x="92" y="36" fontSize="10.5" fill={palette.ink.faint} fontFamily={palette.font}>
        trusts on housing
      </text>
    </svg>
  );
}
