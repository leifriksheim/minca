import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Band, EXTERNAL, GITHUB, Page, Points, SPEC } from './Site';

/**
 * How it works, for people who want the design before the code: one section
 * per part of the spec, each naming the standards and prior work it stands
 * on, then what Minca gives up. Every claim here comes from `spec/`; when the
 * two disagree, the spec wins and this page is the bug.
 */

const specPart = (file: string) => `${GITHUB}/blob/main/spec/${file}`;

interface Point {
  readonly title: string;
  readonly body: ReactNode;
}

/** A standard or a piece of prior work a part uses, and what for */
interface Source {
  readonly name: string;
  readonly href: string;
  readonly for: string;
}

interface Part {
  readonly kicker: string;
  readonly title: string;
  readonly lead: string;
  readonly points: ReadonlyArray<Point>;
  readonly file: string;
  readonly builtOn: ReadonlyArray<Source>;
}

const rfc = (n: number) => `https://www.rfc-editor.org/rfc/rfc${n}`;
const nip = (n: string) => `https://github.com/nostr-protocol/nips/blob/master/${n}.md`;
const UCAN = 'https://github.com/ucan-wg/delegation';
const HPKE = rfc(9180);

const PARTS: ReadonlyArray<Part> = [
  {
    kicker: '01 — Identity',
    title: 'An account is a seed that you keep.',
    lead: 'Nobody hands out accounts. You make one by picking a random number, and you keep it in your password manager.',
    file: '01-identity.md',
    builtOn: [
      {
        name: 'did:key',
        href: 'https://w3c-ccg.github.io/did-key-spec/',
        for: 'an account named by its key',
      },
      { name: 'UCAN 1.0', href: UCAN, for: 'the notes that hand power to a key' },
      {
        name: 'P-256 (FIPS 186-5)',
        href: 'https://csrc.nist.gov/pubs/fips/186-5/final',
        for: 'keys and signatures',
      },
      { name: 'HKDF (RFC 5869)', href: rfc(5869), for: 'every key from one seed' },
      { name: 'HPKE (RFC 9180)', href: HPKE, for: 'sealing to a key' },
      { name: 'WebAuthn', href: 'https://www.w3.org/TR/webauthn-3/', for: 'passkeys' },
    ],
    points: [
      {
        title: 'Every key comes from one seed',
        body: 'Every key your account uses is derived from its seed. Type the same code into any device, on any site, and you’re the same person.',
      },
      {
        title: 'The account’s name is its public key',
        body: (
          <>
            Your account’s name is a <code>did:key</code>: its public key, written out. Anyone can check that
            you signed something without asking a server who you are.
          </>
        ),
      },
      {
        title: 'The root key only signs session notes',
        body: 'Your root key never signs your data. It signs an hour-long note (a UCAN 1.0 delegation, as JSON) for a session key, and the session key signs everything else. A note is one link from your account: no key below it can pass it on.',
      },
      {
        title: 'Apps sign with their own keys',
        body: 'An app or an agent signs with a key of its own, under a note from your account. It can’t pretend to be you, and its access ends when the note does.',
      },
      {
        title: 'Passkeys unlock the account on a device',
        body: 'A passkey unlocks your account on a device. It isn’t your account: passkeys belong to one site, and your account belongs to every app you use.',
      },
    ],
  },
  {
    kicker: '02 — Records',
    title: 'Records are signed, and an edit is a new version.',
    lead: 'Data is JSON, signed by whoever wrote it. An edit is a new version, and every device agrees which version is current.',
    file: '02-records.md',
    builtOn: [
      { name: 'JCS (RFC 8785)', href: rfc(8785), for: 'one canonical form of JSON' },
      { name: 'SHA-256', href: 'https://csrc.nist.gov/pubs/fips/180-4/upd1/final', for: 'ids and hashes' },
      {
        name: 'JSON Schema 2020-12',
        href: 'https://json-schema.org/draft/2020-12',
        for: 'what a collection holds',
      },
      { name: 'I-Regexp (RFC 9485)', href: rfc(9485), for: 'patterns that mean the same in every language' },
    ],
    points: [
      {
        title: 'Canonical JSON',
        body: 'JSON has one canonical form, and every hash and signature is over it. Two implementations in two languages sign the same bytes.',
      },
      {
        title: 'Which version wins',
        body: (
          <>
            The version with the higher <code>seq</code> wins; a tie goes to the lower id. Replaying an old
            version can’t roll a record back, a delete stays deleted, and two people who edited offline land
            on the same result.
          </>
        ),
      },
      {
        title: 'Schemas are stored in the space',
        body: 'A collection’s schema, links and rules are stored in the space as records too. An app that has never seen your space can open it and understand it.',
      },
      {
        title: 'Four checks on every record',
        body: 'Shape, signature, the note from the account, then the space’s grants and rules. Your own writes, a peer’s and a folder’s all go through the same checks.',
      },
      {
        title: 'Record keys name who created them',
        body: 'A record’s key names the account that created it, so nobody else can write its first version or take its name. A key anyone may write is derived from what makes the record unique, like one decision per proposal.',
      },
      {
        title: 'Records that fail their schema are kept',
        body: 'A record that doesn’t match its schema is kept and flagged. Two devices might know different versions of a schema, and refusing would leave them disagreeing forever.',
      },
    ],
  },
  {
    kicker: '03 — Spaces',
    title: 'A space holds its own rules, and every device checks them.',
    lead: 'A space holds its own rules: a constitution, the roles, who has them, and what each kind of record allows. There’s no server to ask.',
    file: '03-spaces.md',
    builtOn: [
      { name: 'UCAN policies', href: `${UCAN}#policy`, for: 'conditions on what a role may do' },
      {
        name: 'p2panda',
        href: 'https://p2panda.org',
        for: 'strong removal: a removal strikes what was done alongside it',
      },
      {
        name: 'Keyhive',
        href: 'https://www.inkandswitch.com/keyhive/notebook/',
        for: 'revocations made at the same time all stand',
      },
      {
        name: 'AES-256-GCM',
        href: 'https://csrc.nist.gov/pubs/sp/800/38/d/final',
        for: 'sealing what a space holds',
      },
      { name: 'HPKE (RFC 9180)', href: HPKE, for: 'a new key for whoever is left' },
    ],
    points: [
      {
        title: 'The constitution',
        body: 'A space is founded with a constitution: its name, whether it’s private, its first roles, and who sits at the top. Its hash is the space’s id, so nobody can swap any of it.',
      },
      {
        title: 'Founders and co-ops',
        body: 'Founders hold every command, and nobody else can remove them; they can step down. A co-op names no one at the top, and runs on its roles alone. When a space can’t be run any more, members can follow a successor.',
      },
      {
        title: 'Membership is stored as records',
        body: 'Roles, members, invites and removals are records in the space. Every record says which of those changes its writer had seen.',
      },
      {
        title: 'Every device reaches the same result',
        body: 'Every device replays that history the same way. Devices that were offline, or heard things in a different order, reach the same verdict.',
      },
      {
        title: 'Roles and grants',
        body: 'A role holds grants: a command and conditions on it, like “remove members, but not admins”. Accounts get power only from the roles they’re assigned, and nobody can give a role more than they may do themselves.',
      },
      {
        title: 'Encryption in private spaces',
        body: 'In a private space every record body is sealed in one envelope under the space key (AES-256-GCM). Who wrote it stays visible, so devices that can’t read a record can still check it was allowed.',
      },
      {
        title: 'Invite links',
        body: 'An invite link carries the space and, for a private one, its key. Sharing a space never goes through a server.',
      },
      {
        title: 'A new key after a removal',
        body: 'When someone is removed, a member who may change the key makes a new one and seals it to everyone who’s left, with HPKE. Nothing written after that is readable to them.',
      },
    ],
  },
  {
    kicker: '04 — Network',
    title: 'Devices connect directly, and relays help them find each other.',
    lead: 'Devices talk to each other directly, over WebRTC in the browser or a WebSocket to an always-on node. Relays only help them meet.',
    file: '04-network.md',
    builtOn: [
      { name: 'WebRTC', href: 'https://www.w3.org/TR/webrtc/', for: 'browsers talking directly' },
      { name: 'ICE (RFC 8445)', href: rfc(8445), for: 'finding a way through' },
      { name: 'TURN (RFC 8656)', href: rfc(8656), for: 'when there is no direct way' },
      { name: 'WebSocket (RFC 6455)', href: rfc(6455), for: 'relays, and always-on nodes' },
    ],
    points: [
      {
        title: 'What a relay can and can’t do',
        body: 'A relay holds no data and has no say. The worst a lying relay can do is fail to introduce you, or introduce the wrong peer, and the handshake catches that.',
      },
      {
        title: 'Rooms are named by a hash',
        body: 'Devices in a space meet in a room named after a hash of its id. The relay sees who’s in the same room, not which space it is.',
      },
      {
        title: 'The handshake',
        body: 'Before any data moves, each side signs with the key its name says it has. In a private space, each also proves it can read the space.',
      },
      {
        title: 'Introductions through peers',
        body: 'Once you’re connected to one device, it can introduce you to the next, so you only need a relay for the first. Use several relays at once, or the ones a space names.',
      },
    ],
  },
  {
    kicker: '05 — Sync and storage',
    title: 'Devices send each other only what the other is missing.',
    lead: 'Devices compare what they hold, per collection, and send only the difference. No central log, no merge server.',
    file: '05-sync-and-storage.md',
    builtOn: [
      {
        name: 'Negentropy',
        href: 'https://github.com/hoytech/negentropy',
        for: 'range-based set reconciliation',
      },
      { name: 'Nostr NIP-77', href: nip('77'), for: 'its wire format, as Nostr uses it' },
    ],
    points: [
      {
        title: 'Set reconciliation',
        body: 'Devices swap a fingerprint per collection, and Negentropy narrows down exactly what each side is missing. Two copies of 2,000 records that differ by one exchange under 8 KB.',
      },
      {
        title: 'Time is only used for sorting',
        body: 'Time only helps sort things for comparing. It never decides what wins, so a device with a wrong clock only slows down its own changes.',
      },
      {
        title: 'Keepers',
        body: 'A space can name keepers that hold every record, like a host or the browser extension. Apps can then keep just what they use, and hold on to their writes until enough keepers have them.',
      },
      {
        title: 'Where data is stored',
        body: 'Data lives in the browser for one site, or in a folder on your computer that every app you use shares. Its keys are sealed under your account.',
      },
    ],
  },
  {
    kicker: '06 — Nodes, sessions and apps',
    title: 'Apps, agents and servers all run the same node.',
    lead: 'A node is the whole stack in one object. A browser tab, the command line, an always-on server and an agent all run the same one.',
    file: '06-nodes-and-sessions.md',
    builtOn: [
      { name: 'UCAN 1.0', href: UCAN, for: 'what an app or an agent may do' },
      {
        name: 'MCP',
        href: 'https://modelcontextprotocol.io',
        for: 'every action, as a tool an agent can call',
      },
      {
        name: 'WebMCP',
        href: 'https://github.com/webmachinelearning/webmcp',
        for: 'the same tools, in the page',
      },
    ],
    points: [
      {
        title: 'JSON in and out',
        body: 'Everything a node does takes and returns plain JSON, so each operation is also a CLI command, an MCP tool and a WebMCP tool.',
      },
      {
        title: 'The account home',
        body: 'Apps never get your seed. They ask your account home, a page you chose, which signs a note for the app’s own key: the spaces you pick, for a week at a time. A program you trust less, like an agent, gets records only.',
      },
      {
        title: 'Disconnecting an app',
        body: 'Disconnecting an app writes a revocation into every space it could change. From then on, nothing it writes counts anywhere.',
      },
      {
        title: 'Hosts',
        body: 'A host keeps your spaces online while your devices sleep. It holds them encrypted, with no key that opens them and no right to sign anything.',
      },
    ],
  },
  {
    kicker: '07 — Inbox',
    title: 'People reach you through an inbox address you can replace.',
    lead: 'Your name is on everything you sign, so knowing it shouldn’t be enough to reach you. Your inbox is an address you hand out, and can replace.',
    file: '07-inbox.md',
    builtOn: [
      { name: 'Nostr outbox (NIP-65)', href: nip('65'), for: 'an address that names its own relays' },
      { name: 'SimpleX', href: 'https://simplex.chat', for: 'an address that is a queue, not an identity' },
      {
        name: 'AT Protocol handles',
        href: 'https://atproto.com/specs/handle',
        for: 'a name that leads to an inbox',
      },
      { name: 'HPKE (RFC 9180)', href: HPKE, for: 'knocks only your inbox can open' },
    ],
    points: [
      {
        title: 'What an inbox code holds',
        body: 'An inbox code holds two keys made for it and up to three relays, signed by one of them. Your account isn’t in it, and no relay learns it.',
      },
      {
        title: 'Knocks',
        body: 'Someone with the code leaves a knock in the relays’ mailboxes: a signed invite to a new space for two, sealed to your inbox. The relay keeps it for up to two weeks and can’t read it or fake it.',
      },
      {
        title: 'Accepting a knock',
        body: 'Accepting joins the space. Only you could open the invite, so whoever joins is you, and only then does the knocker learn whose inbox it was.',
      },
      {
        title: 'Staying reachable',
        body: 'An inbox names its own relays, like Nostr’s outbox model, and it’s a queue you can replace rather than an identity, like SimpleX. As long as one of its relays is up, it works.',
      },
    ],
  },
  {
    kicker: '08 — Hosting',
    title: 'A host keeps spaces online but can’t read them.',
    lead: 'A host keeps your spaces online while every device sleeps. You pay it like any service, and it holds what it carries encrypted.',
    file: '08-hosting.md',
    builtOn: [
      { name: 'Stripe Checkout', href: 'https://docs.stripe.com/payments/checkout', for: 'paying by card' },
      { name: 'ERC-20', href: 'https://eips.ethereum.org/EIPS/eip-20', for: 'paying in USDC, on Base' },
      {
        name: 'EIP-681',
        href: 'https://eips.ethereum.org/EIPS/eip-681',
        for: 'a payment request a wallet can scan',
      },
    ],
    points: [
      {
        title: 'Paying without giving your name',
        body: 'Each account pays under a key it made for that host. The host learns a subscription, not who pays.',
      },
      {
        title: 'Space funds',
        body: 'A space can have a fund anyone in it adds to, so keeping it online doesn’t fall on one person.',
      },
      {
        title: 'Card or USDC',
        body: 'A host answers with a payment page, or a request a wallet can pay in USDC. Either way, it’s an ordinary service you can leave.',
      },
      {
        title: 'Bots',
        body: 'A host can run bots for a space, paid from its fund. A bot holds a role like anyone, and your device tells you the host can read what the bot can before it asks for one.',
      },
    ],
  },
  {
    kicker: '09 — Contracts',
    title: 'Contracts are rules every device checks the same way.',
    lead: 'A collection’s contract says what a version must be to count: conditions over its body, the version before it, and records it cites as evidence.',
    file: '09-contracts.md',
    builtOn: [
      { name: 'CEL', href: 'https://github.com/google/cel-spec', for: 'a strict subset, with cost limits' },
    ],
    points: [
      {
        title: 'Failing versions are kept',
        body: 'A version that fails its contract is still kept and synced. It just doesn’t count, on any device, so devices never disagree about what they hold.',
      },
      {
        title: 'Evidence is cited',
        body: 'The writer cites the records that prove it, like the ballots behind a decision. Readers only check what was cited, so the verdict doesn’t depend on what each device happens to have.',
      },
      {
        title: 'Fixed limits',
        body: 'Contracts are a small subset of CEL with fixed limits, so every device gets the same answer, whenever it looks.',
      },
      {
        title: 'Lines',
        body: 'A line makes one account’s versions in a collection a single sequence. Two versions after the same one cancel each other, so spending twice gets you nothing.',
      },
    ],
  },
];

/** What it gives up, and what isn't finished */
const LIMITS: ReadonlyArray<Point> = [
  {
    title: 'What a relay sees',
    body: 'Network addresses, the session keys that join each room, and which connections meet. Not which space a room is, and nothing that passes between peers.',
  },
  {
    title: 'What a host sees',
    body: 'Which spaces exist, how big they are, when they change, and the outside of each record: who wrote it, which collection, when. Not what’s inside. Record keys and collection names still say more than they should; hiding them is planned.',
  },
  {
    title: 'Members are visible',
    body: 'Anyone holding a space can see who’s in it, even without the key. That’s how devices that can’t read a space still check who may write.',
  },
  {
    title: 'Losing the seed',
    body: 'There’s no server to reset it. And if the seed leaks, it can’t be rotated yet: a new seed is a new identity.',
  },
  {
    title: 'Removed members keep what they read',
    body: 'Whoever had a space’s key keeps what they read. Changing the key protects what comes next. An app you give a private space can read all of it.',
  },
  {
    title: 'Keepers can hold records back',
    body: 'A node that syncs with nobody else can be kept in the dark by the one it syncs with. Each writer’s versions form a numbered log, so a node that holds part of a space notices a gap, but only in ordinary collections.',
  },
  {
    title: 'No global feeds',
    body: 'Minca is for data that’s private, shared by a few people, and works offline. Public feeds at the scale of a social network are what other protocols are for.',
  },
  {
    title: 'Known defects',
    body: (
      <>
        Where our implementation does something the protocol shouldn’t need, the spec says so. For example:
        every tab of one app shares a key, so only the first gets into a space’s room; and only the browser
        that connected an app takes it back when its time runs out.
      </>
    ),
  },
];

/** What a part stands on, each linked to the standard or the work itself */
function BuiltOn({ sources }: { sources: ReadonlyArray<Source> }) {
  return (
    <div className="built-on">
      <h3>Built on</h3>
      <ul>
        {sources.map((source) => (
          <li key={source.name}>
            <a href={source.href} {...EXTERNAL}>
              {source.name}
            </a>
            <span>{source.for}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A part's number and name, from its kicker ("01 — Identity") */
function numbered(part: Part): { num: string; name: string } {
  const [num = '', name = ''] = part.kicker.split(' — ');
  return { num, name };
}

/** The anchor a part's section has, from its file ("01-identity") */
const anchor = (part: Part) => part.file.replace(/\.md$/, '');

/** The standards a part names, short: without what's in brackets */
const standards = (part: Part) =>
  part.builtOn
    .slice(0, 3)
    .map((source) => source.name.replace(/\s*\(.*\)$/, ''))
    .join(' · ');

/** The parts, then the two notes after them, as a paper's contents */
function Contents() {
  const rows = [
    ...PARTS.map((part) => ({
      href: `#${anchor(part)}`,
      ...numbered(part),
      title: part.title,
      std: standards(part),
    })),
    { href: '#tradeoffs', num: 'A', name: 'Tradeoffs', title: 'What Minca doesn’t do.', std: '' },
    {
      href: '#planned',
      num: 'B',
      name: 'Planned',
      title: 'Designed, not built yet.',
      std: '',
    },
  ];
  return (
    <nav aria-label="Contents">
      <div className="toc-head">
        <span>Part</span>
        <span>Built on</span>
      </div>
      <ol className="toc">
        {rows.map((row) => (
          <li key={row.href}>
            <a href={row.href}>
              <span className="toc-num">{row.num}</span>
              <span className="toc-name">
                <b>{row.name}</b>
                <small>{row.title}</small>
              </span>
              <span className="toc-leader" />
              <span className="toc-std">{row.std}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Section({ part }: { part: Part }) {
  return (
    <Band id={anchor(part)} kicker={part.kicker} title={part.title} intro={<p>{part.lead}</p>}>
      <Points points={part.points} />
      <BuiltOn sources={part.builtOn} />
      <a href={specPart(part.file)} {...EXTERNAL} className="spec-link">
        Read {part.kicker} →
      </a>
    </Band>
  );
}

export function Protocol() {
  return (
    <Page page="protocol">
      <section className="hero">
        <div className="wrap">
          <h1>
            Proven protocols,
            <br />
            put together.
          </h1>
          <p>
            Minca invents as little as it can. Accounts are did:key, permissions are UCAN, rules are CEL, sync
            is Negentropy, encryption is HPKE and AES-GCM. The spec says exactly how they fit, and{' '}
            <code>@minca/core</code> packs it into one library, so people and agents can build social apps
            with no server in the middle.
          </p>
          <div className="actions">
            <a href={SPEC} {...EXTERNAL} className="btn btn-primary">
              Read the spec
            </a>
            <Link to="/developers" className="btn btn-secondary">
              Build with it
            </Link>
          </div>
        </div>
      </section>

      <Band
        kicker="Contents"
        title="The protocol in nine parts."
        intro={
          <p>
            Each section below sums up one part of the spec. The spec has the exact formats, and the tests
            behind each rule.
          </p>
        }
      >
        <Contents />
      </Band>

      {PARTS.map((part) => (
        <Section key={part.file} part={part} />
      ))}

      <Band
        id="tradeoffs"
        kicker="Tradeoffs"
        title="What Minca doesn’t do."
        intro={<p>No server means some things are harder, and some aren’t finished. Here they are.</p>}
      >
        <Points points={LIMITS} />
      </Band>

      <Band
        id="planned"
        kicker="Next"
        title="Designed, not built yet."
        intro={
          <p>
            Reading narrower than a space, files synced by hash, Web Push for closed apps, references to other
            spaces, handles like @you.bsky.social that lead to an inbox, and more.
          </p>
        }
      >
        <a href={specPart('README.md#planned-work')} {...EXTERNAL} className="spec-link">
          See everything planned →
        </a>
      </Band>

      <section className="cta">
        <div className="wrap">
          <h2>Check our work.</h2>
          <p>
            The spec has every format, every signature and every check a device makes, with the tests behind
            each rule.
          </p>
          <div className="actions">
            <a href={SPEC} {...EXTERNAL} className="btn btn-primary">
              Read the spec
            </a>
            <Link to="/developers" className="btn btn-secondary">
              For developers
            </Link>
          </div>
        </div>
      </section>
    </Page>
  );
}
