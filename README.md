<p align="center">
  <img src=".github/assets/mark.svg" width="96" alt="">
</p>

<h1 align="center">Minca</h1>

<p align="center">
  <strong>A local-first protocol for groups.</strong><br>
  Your account is a code you keep. Your group's data lives in signed spaces that sync<br>
  straight between devices. Every app is a view onto that data, never its owner.
</p>

<p align="center">
  <a href="https://minca.social">Website</a> ·
  <a href="https://app.minca.social">Open the app</a> ·
  <a href="packages/core/docs/README.md">Docs</a> ·
  <a href="spec/README.md">Spec</a> ·
  <a href="spec/threat-model.md">Threat model</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@minca/core"><img src="https://img.shields.io/npm/v/@minca/core?color=2340d6&label=%40minca%2Fcore" alt="npm"></a>
  <a href="https://github.com/leifriksheim/minca/actions/workflows/check.yml"><img src="https://github.com/leifriksheim/minca/actions/workflows/check.yml/badge.svg" alt="Check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4e8f6c" alt="MIT license"></a>
</p>

---

A minca (minka) is the Andean custom of everyone turning out to build what
serves them all. Minca gives a club, a street or a crew a place to talk, plan
and get things done that belongs to them: no company in the middle, no server
that holds the truth, and no app that can lock their data in.

- **You hold your account.** It's a 16-byte seed, written down as a recovery
  code. The same code is the same person on any device, in any app.
- **Every record is signed, and every device checks it.** A space's roles and
  rules live in the space. Each peer applies them the same way, so there is no
  server to trust and none to write.
- **Private means encrypted before it leaves.** Private spaces are sealed end
  to end. An invite link carries the key, so sharing never goes through a
  server.
- **Works offline.** Devices sync directly over WebRTC when they can reach each
  other. Relays only introduce them.
- **Apps get a pass, not your keys.** An app or an AI agent writes under a
  short note from your account, for the spaces you pick, and you can revoke it.

> [!WARNING]
> Minca is early. It works, and it's still changing: the wire format and the
> APIs may break before v1. It has had no external security audit yet, and a
> leaked seed can't be rotated. [The threat model](spec/threat-model.md) says
> what holds today and what doesn't.

## Start here

| I want to…                         | Go to                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Use it** with my group           | [app.minca.social](https://app.minca.social) in the browser, or [the desktop app and the Chrome extension](https://minca.social/download) |
| **Build an app** on it             | [`@minca/core`](#build-an-app) and [its guides](packages/core/docs/README.md)                                                             |
| **Connect an AI agent** or a bot   | [`@minca/cli`](packages/cli/README.md): `minca connect`, then Claude Code, Cursor or any MCP client reads and writes as you               |
| **Keep spaces online** on a server | [`minca run`](packages/cli/README.md#the-always-on-node), an always-on node that adds uptime, never authority                             |
| **Implement the protocol**         | [The spec](spec/README.md): bytes on the wire, what is signed, what every peer checks                                                     |
| **Contribute**                     | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                                        |

## Build an app

```bash
npm install @minca/core
```

A node is the whole stack in one object: it signs, stores, encrypts, checks
and syncs. Its API is plain data in and out.

```typescript
import {
  createNode,
  createIdentityManager,
  createLocalRootSigner,
  generateSeed,
  seedToRecoveryCode,
  indexedDBStores,
  rolePresets,
} from '@minca/core';

// 1. An account is a seed. Show its recovery code once; the person keeps it.
const seed = generateSeed();
console.log(seedToRecoveryCode(seed)); // 'K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG'
const manager = createIdentityManager();
const me = await manager.fromSeed(seed);

// 2. A node for that account, syncing through a relay.
const node = await createNode({
  signer: createLocalRootSigner(me, manager.getProvider()),
  stores: indexedDBStores('groceries'),
  network: { relays: ['wss://relay.minca.social'] },
});

// 3. A private space, encrypted end to end, with a team's roles.
const space = await node.spaces.create({ name: 'Groceries', visibility: 'private', ...rolePresets.team });

// 4. Signed records. An edit is the next version of the same key.
const milk = await node.records.put(space.id, 'app.todo.item', { text: 'Milk', done: false });
await node.records.update(space.id, milk.key, { text: 'Milk', done: true });

// 5. A live query: it runs again whenever a change arrives, from here or a friend's phone.
node.records.watch(space.id, { collection: 'app.todo.item' }, (result) => render(result.records));

// 6. The invite is the key. A friend calls node.spaces.join(invite) and joins as an editor.
const invite = await node.spaces.invite(space.id);
```

Most apps never hold the seed at all. They ask the person's account home,
which signs a note for the app's own key, for the spaces the person picks:

```tsx
import { createMincaConnection } from '@minca/core/session';
import { MincaProvider, useConnection } from '@minca/react';

const connection = createMincaConnection({
  home: 'https://home.minca.social/connect', // a suggestion: the person may use their own
  request: { name: 'Todo', access: 'write', scope: 'spaces' },
  network: { relays: ['wss://relay.minca.social'] },
});

function App() {
  const { connection, state } = useConnection();
  if (state.status !== 'ready')
    return <button onClick={() => connection.connect()}>Connect with Minca</button>;
  return <Todos />; // useQuery(space, { collection: 'app.todo.item' }) keeps it live
}

createRoot(root).render(
  <MincaProvider connection={connection}>
    <App />
  </MincaProvider>,
);
```

[Building an app](packages/core/docs/building-an-app.md) goes on from there:
signing in, collections and their rules, queries, React hooks. The guides ship
in the package, so a coding agent finds the ones for the installed version in
`node_modules/@minca/core/docs/`.

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│                        Applications                          │
├──────────────┬───────────┬────────────┬──────────┬───────────┤
│   Accounts   │  Spaces   │ Validation │ Privacy  │   Sync    │
│ seed, vault, │ founders, │ crypto →   │ envelope │ Negentropy│
│ root signer, │ roles ×   │ structural │ + HPKE,  │ per       │
│ UCAN, pairing│ grants    │ → UCAN     │ per space│ collection│
├──────────────┴───────────┴────────────┴──────────┴───────────┤
│    Storage: signed versions + plain index over an adapter    │
│    IndexedDB (per origin) · data folder (shared by origins)  │
├──────────────────────────────────────────────────────────────┤
│    Network: WebRTC data channels                             │
│    several relays at once · peers introduce peers            │
├──────────────────────────────────────────────────────────────┤
│    Web Crypto · WebAuthn · IndexedDB · File System Access ·  │
│    WebRTC · @noble/curves · @scure/base                      │
└──────────────────────────────────────────────────────────────┘
```

**Keys sign.** The seed derives a root key, a `did:key`. The root key never
signs data: it signs an hour-long note (a UCAN 1.0 delegation) for a session
key, and the session key signs everything else.
→ [01 Identity](spec/01-identity.md)

**Records carry their history.** A record is a JSON body with a key that stays
the same across edits; each edit is a new signed version over canonical JSON,
so two implementations sign the same bytes. A collection's schema and rules
are records in the space too.
→ [02 Records](spec/02-records.md)

**Spaces hold.** A space starts from a constitution whose hash is its id. Its
roles, grants, members and removals are records every device replays the same
way, so devices that heard things in a different order reach the same verdict.
Removing someone changes the key.
→ [03 Spaces](spec/03-spaces.md)

**Devices check.** Every version that arrives, from a peer, a folder or your
own app, goes through the same gates: shape, signature, the note from the
account, then the space's grants and rules.
→ [02 Records §9](spec/02-records.md#9-validation-what-a-peer-checks-before-keeping-a-version)

**Relays introduce, they don't decide.** A relay holds no data and has no say;
the handshake catches a lying one. Peers then sync each collection with
Negentropy, so syncing costs about as much as what changed.
→ [04 Network](spec/04-network.md), [05 Sync and storage](spec/05-sync-and-storage.md)

The [protocol page](https://minca.social/protocol) walks through the same
design with pictures.

### What it's for, and what it isn't

Minca is for data that's private, shared by a few people, and works offline.
It isn't for public feeds at the scale of a social network. There's no server
to reset an account: lose the seed and the account is gone. And reading can't
be undone: whoever had a space's key keeps what they read. The
[threat model](spec/threat-model.md) lists every such limit, with its issue.

## In this repository

One npm workspace. Everything imports the protocol as `@minca/core`.

| Folder                                                                                 |                                                                                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`spec/`](spec/README.md)                                                              | The protocol specification and its threat model                                                |
| [`packages/core`](packages/core/docs/README.md)                                        | **`@minca/core`**, the reference implementation. Start here                                    |
| [`packages/cli`](packages/cli/README.md)                                               | **`@minca/cli`**: `minca`, the always-on node, hosting, agents and MCP                         |
| [`packages/relay`](packages/relay/README.md)                                           | The signaling relay and its mailbox                                                            |
| [`apps/example`](apps/example/README.md)                                               | The Minca app, at [app.minca.social](https://app.minca.social)                                 |
| [`apps/home`](apps/home/README.md)                                                     | The account home, at [home.minca.social](https://home.minca.social)                            |
| [`apps/desktop`](apps/desktop/README.md), [`apps/extension`](apps/extension/README.md) | The desktop app and the Chrome extension                                                       |
| [`apps/site`](apps/site/README.md)                                                     | The website, [minca.social](https://minca.social)                                              |
| [`scenarios/`](scenarios/README.md)                                                    | Kinds of community written as tests: a chess club, a co-op, mutual credit, and attacks on each |

<details>
<summary><strong>Where each topic is described</strong>: the library's docs and the spec, side by side</summary>

<br>

| Topic                                                                                            | Library (how to call it)                                                                                                                                                                                                                                                                                                                | Protocol (what peers agree on)                                                           |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| The node: records and versions, live messages, holding spaces, actions                           | [node](packages/core/docs/node.md), [records and queries](packages/core/docs/records-and-queries.md), [actions](packages/core/docs/actions.md)                                                                                                                                                                                          | [02 Records](spec/02-records.md), [06 Nodes and sessions](spec/06-nodes-and-sessions.md) |
| Signing in, `<minca-auth>`, React hooks                                                          | [building an app](packages/core/docs/building-an-app.md), [sign-in](packages/core/docs/sign-in.md)                                                                                                                                                                                                                                      | [01 Identity](spec/01-identity.md)                                                       |
| The account home, app grants, keepers, topic tags, notifications                                 | [building an app](packages/core/docs/building-an-app.md), [node](packages/core/docs/node.md), [apps/home](apps/home/README.md)                                                                                                                                                                                                          | [06 Nodes and sessions](spec/06-nodes-and-sessions.md), [03 Spaces](spec/03-spaces.md)   |
| Identity: the seed, recovery code, wraps, passkeys, UCAN, root signers                           | [sign-in](packages/core/docs/sign-in.md), [node](packages/core/docs/node.md#root-signers-and-notes)                                                                                                                                                                                                                                     | [01 Identity](spec/01-identity.md)                                                       |
| Spaces: the constitution, founders, roles and grants, invites, successors, key changes, profiles | [spaces](packages/core/docs/spaces.md)                                                                                                                                                                                                                                                                                                  | [03 Spaces](spec/03-spaces.md)                                                           |
| Collections, schemas, rules, contracts and computed fields, links, queries, the standard library | [collections](packages/core/docs/collections.md), [contracts](packages/core/docs/contracts.md), [computed fields](packages/core/docs/computed.md), [query format](packages/core/docs/query-format.md), [standard library](packages/core/docs/standard-library.md), [blueprints and guides](packages/core/docs/blueprints-and-guides.md) | [02 Records](spec/02-records.md), [09 Contracts](spec/09-contracts.md)                   |
| Calls, contacts, the inbox, direct messages                                                      | [calls](packages/calls/README.md), [contacts](packages/core/docs/contacts.md), [inbox](packages/core/docs/inbox.md), [direct messages](packages/core/docs/direct-messages.md)                                                                                                                                                           | [07 Inbox](spec/07-inbox.md), [04 Network](spec/04-network.md)                           |
| Network: the relay, TURN, meeting peers, introductions, pairing a phone                          | [node](packages/core/docs/node.md#the-network), [packages/relay](packages/relay/README.md)                                                                                                                                                                                                                                              | [04 Network](spec/04-network.md)                                                         |
| Sync, storage adapters, data folders and locking them, mirrors                                   | [storage](packages/core/docs/storage.md)                                                                                                                                                                                                                                                                                                | [05 Sync and storage](spec/05-sync-and-storage.md)                                       |
| Hosting: keeping spaces online, payment, bots a host runs                                        | [packages/cli](packages/cli/README.md)                                                                                                                                                                                                                                                                                                  | [08 Hosting](spec/08-hosting.md)                                                         |
| The CLI, the always-on node, agents and MCP                                                      | [packages/cli](packages/cli/README.md), [agents](packages/core/docs/agents.md)                                                                                                                                                                                                                                                          | [06 Nodes and sessions](spec/06-nodes-and-sessions.md)                                   |
| The app, and its ready-made tools                                                                | [apps/example](apps/example/README.md), [apps/liquid](apps/liquid/README.md)                                                                                                                                                                                                                                                            | —                                                                                        |
| Planned work                                                                                     | [docs](packages/core/docs/README.md#planned-in-the-library)                                                                                                                                                                                                                                                                             | [spec](spec/README.md)                                                                   |

</details>

## Principles

- **No authority.** No server issues identities or holds the truth. An
  always-on node adds availability, never authority.
- **Apps are views.** Data lives in spaces people own, as signed records any
  app can read and verify.
- **The spec is the product.** It holds only what two implementations must
  agree on, and the tests are its executable half: every rule a peer checks
  has a test of a peer refusing what breaks it.
- **Few, boring dependencies.** Native Web APIs first; a library only where
  the problem is hard and already solved, like elliptic curves
  ([the list, and why](CLAUDE.md#dependencies)).
- **Isomorphic.** Browsers, Node and Bun, via `globalThis`.
- **Plain functions and frozen data.** No class hierarchies. Bring your own
  validator through Standard Schema (Zod, Valibot, ArkType, …).

## Contributing

Run everything locally with one install:

```bash
npm install
npm run dev     # the app, the account home, the website, a node and a host
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the rest: what runs where, the tests
and scenarios, how a protocol change is reviewed, and releasing. Bugs and
planned work are in [the issues](https://github.com/leifriksheim/minca/issues).

## Security

Please report a vulnerability privately, through
[GitHub's security advisories](https://github.com/leifriksheim/minca/security/advisories/new),
not in a public issue. What Minca defends, against whom, and where it doesn't
yet, is in [the threat model](spec/threat-model.md).

## Thanks

Minca stands on [UCAN](https://github.com/ucan-wg/spec) for delegation,
[Negentropy](https://github.com/hoytech/negentropy) for set reconciliation,
[HPKE (RFC 9180)](https://www.rfc-editor.org/rfc/rfc9180) for sealing keys,
[CEL](https://cel.dev) for contracts, and Paul Miller's audited
[noble](https://paulmillr.com/noble/) cryptography.

## License

[MIT](LICENSE)
