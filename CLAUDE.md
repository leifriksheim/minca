# Working on Weave

Weave is a protocol first and a library second. `spec/` says what goes over
the wire, what is stored, what is signed and what every peer must check;
`packages/core/src/` is the reference implementation, and `packages/core/docs/`
describes the library built on it. Read the part of the spec, or the page of
the docs, a change touches before changing the code.

## Layout

| Folder                                        |                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `spec/`                                       | The protocol specification, `README.md` plus parts 01–07 (normative), and its threat model.   |
| `packages/core`                               | `@weaveprotocol/core`: the protocol library, its tests (`tests/*.test.ts`) and docs (`docs/`) |
| `packages/cli`                                | `@weaveprotocol/cli`: `weave`, the always-on node, hosting, agents, MCP                       |
| `packages/relay`                              | The signaling relay and its mailbox                                                           |
| `apps/home`, `apps/example`, `apps/extension` | The account home, the website and example app, the Chrome extension                           |
| `apps/liquid`                                 | Liquid, a mini app: standalone, and inside the example (`apps/shared/src/mini-app.ts`)        |
| `apps/shared`                                 | What the apps share: styles, relay settings, components, the mini app contract                |

Everything imports the protocol as `@weaveprotocol/core`, only through what it
exports. Inside the workspace the `@weaveprotocol/source` condition resolves it
to `packages/core/src`, so nothing needs building first.

## Commands

```bash
npm install          # once, at the root
npm test             # every workspace
npm run typecheck    # every workspace, and core's tests (TypeScript 7)
npm run lint         # oxlint, type-aware (.oxlintrc.json)
npm run format       # Prettier
npm run fallow       # unused files, exports and dependencies, import cycles
npm run check        # all of the above but tests, as CI runs it
npm run dev          # node, host, home and example together (scripts/dev.mjs)
# one test file, from packages/core
node --experimental-vm-modules --import tsx --test tests/sync.test.ts
```

Releasing is `npm run release`; see the README before running it.

A pre-commit hook runs oxlint and Prettier on staged files.

## Types

Every workspace extends `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
no unused locals, `erasableSyntaxOnly`, so no enums, namespaces or parameter
properties). oxlint bans `any` and type assertions (`as Foo`; `as const` is
fine). Narrow `unknown` with a type guard, or use `satisfies`. Where a cast
truly can't be avoided, disable the rule for that line with a reason:
`// eslint-disable-next-line <rule> -- <why>` (oxlint reads ESLint's comments
and rule names).

## The spec and the code change together

The spec is strict. It holds only what two implementations must agree on to
work together: bytes on the wire, what is stored and signed, what a peer
checks or refuses, and exchanges between two parties (an app and its account
home, a carrier, a relay). What a record body means, how the library is
called and how an app shows something are not protocol, however useful: the
standard collections (`std.*`), the query format, node actions, blueprints and
guides are described in `packages/core/docs/` instead.

To tell which a change is, ask: **would a peer that has never heard of it
still sync, store and judge every record the same way?** If yes, it is a layer
on the protocol and belongs in the docs, even when it seals, signs or fixes
exact bytes that two apps must agree on. Direct messages (`std.direct`) are one.
If a peer must check, refuse or send something new, it is protocol.

What only one node ever reads is not protocol either: its own stores, caches,
timers, retry intervals, defaults and config, and the library's function
names. Those belong in the docs, or in the code alone. A number is protocol
only when the other side enforces it, like a relay's limit or a peer's
timeout. Something the devices of one account share across implementations,
like the vault, the data folder or the derived account spaces, is protocol:
two implementations must read it the same way.

- A change to anything in the spec's scope changes the spec in the same PR.
  Where the spec and the code disagree, one of them is a bug: fix it, or open
  an issue that says which.
- A change to a standard collection, the query format, the node's interface
  or an app convention changes its page in `packages/core/docs/` instead, in
  the same PR, with a _Source:_ line and tests in the same way. Those pages
  say "must" in plain words, not RFC 2119 capitals.
- Follow the conventions in `spec/README.md`: RFC 2119 words only where they
  are meant, exact formats with an example, and a _Source:_ line naming the
  files and tests for each section.
- Work that is designed but not built is a **Planned** section in the part it
  belongs to, and is listed in the Planned table in `spec/README.md`. Something
  the implementation does that the protocol should not require is a
  `> **Known defect:**` blockquote. Both link their GitHub issue when one
  exists, and every such issue links back to the section. When the work lands,
  the Planned text becomes the specification and the note goes.
- Cite code by its full path from the repository root (`packages/core/src/...`),
  in the spec, in issues and in comments, and name the function rather than a
  line. The label registry in `spec/01-identity.md` §5 is the exception: its
  `file:line` references must be kept current when the code moves.
- Tests are the executable half of the spec. A rule a peer must check gets a
  test that shows a peer refusing the thing that breaks it.

## Every protocol change is reviewed adversarially

Tests show a change does what its author meant. They don't show it can't be
turned against someone, so they aren't enough. A protocol change is one to
`spec/`, or to code or tests any spec _Source:_ line cites
(`packages/core/src`, `packages/core/tests`, `packages/relay`, the protocol
parts of `packages/cli`, the grant in `apps/home`, the mini app contract in
`apps/example`). Before one is called done or merged:

1. Run the `protocol-reviewer` agent (`.claude/agents/protocol-reviewer.md`)
   on the branch, with nothing about why the change is right. It works from
   the diff, the spec and `spec/threat-model.md`, and proves each blocker with
   a probe test.
2. Fix every blocker, and keep its probe as a test that fails without the
   fix. Answer every other finding: fixed, filed as an issue, or why it isn't
   one. Run the review again after fixing a blocker; fixes open holes too.
3. Put the findings and what was done about each under **Adversarial review**
   in the PR description, and say under **Threat model** what changes there.
   CI (`scripts/check-review.mjs`) fails a protocol PR without both.
4. If a guarantee in `spec/threat-model.md` changes, or a new gap opens,
   change that page in the same PR. A change to that page is reviewed against
   every "Holds" claim on it, not only the ones it touches.

Design against the threat model, not only against the issue at hand: ask its
§5 questions while designing, not only at review.

Diffs only show what changed. Before each release, and whenever the threat
model changes, audit the whole spec for soundness: one reviewer per adversary
in the threat model's §2, in parallel, each trying to break every "Holds"
claim about it and every rule it could abuse, spec against spec and spec
against code. File what they find. An audit that only looks for what went
stale is not this one.

## Issues and pull requests

Track bugs, planned work and open questions as GitHub issues (`gh issue`).
Before starting, look for an issue that covers the work. A PR links every
related issue in its description: `Fixes #N` when it closes one, `Refs #N`
when it only touches it.

## Style

Plain functions and frozen data, no class hierarchies. Isomorphic: browsers,
Node and Bun via `globalThis`, native Web APIs first. Comments and docs are
short plain sentences that say why; match the prose around you.

## Dependencies

Use a library when the problem is hard, already solved, and easy to get
subtly wrong, and only one that clears all of these:

1. **Solves something genuinely hard**: cryptographic primitives, a wire
   protocol, a spec with a long tail of edge cases. Not a helper we could
   write in an afternoon.
2. **Established**: years of releases, heavy real-world use, ideally an audit.
3. **Small and self-contained**: zero or near-zero transitive dependencies, no
   native addons in anything the browser or the compiled daemon loads.
4. **Isomorphic**: works in browsers, Node and Bun without shims.
5. **Not mid-rewrite**: a spec or major version in flux fails this.

Otherwise write the code, and test it against the real thing where one exists
(`packages/core/tests/identity.test.ts` checks our curve output against Web
Crypto's). Adding a runtime dependency means adding it to the list below, with
why it clears the bar.

What the protocol uses (`packages/core`):

- `@noble/curves` (with `@noble/hashes`), `packages/core/src/identity/crypto-p256.ts`:
  seed to P-256 key (FIPS 186-5 A.2), point compression. Audited, used by viem
  and ethers.
- `@scure/base`, `packages/core/src/identity/did.ts`: base58btc for `did:key`.
  Same author and audit as noble.
- `@cfworker/json-schema`, `packages/core/src/schema/collection-def.ts`:
  validates stored collection definitions. Interprets rather than compiles, so
  it runs under a strict CSP and in extensions.
- `aws4fetch`, `packages/core/src/storage/blob/s3.ts`: S3 SigV4 signing, whose
  rules differ in small ways between providers. `fetch` and `crypto.subtle` only.

The protocol reads validators only through the Standard JSON Schema interface,
so it needs none of Zod, Valibot or ArkType; `zod` is a dev dependency to test
that.

Elsewhere:

- `ws` in `packages/cli` and `packages/relay`: Node has a WebSocket client but
  no server.
- `@clack/prompts`, a dev dependency of `packages/cli`, bundled
  (`packages/cli/src/ask.ts`): prompts at a terminal, reading keys in raw
  mode and redrawing, which is fiddly across terminals to get right. Released
  since 2023, widely used, four tiny dependencies. Used only when stdin and
  stderr are terminals; with none, the CLI asks nothing.
- `node-datachannel` in `packages/cli`: WebRTC for `weave mcp` and headless
  nodes.
- `@anthropic-ai/sdk`, a dev dependency of `packages/cli`, bundled into
  `weave agent` only and loaded when that command runs
  (`packages/cli/src/agent-chat.ts`): the Messages API's streaming, tool use,
  retries and error types. Anthropic's own client, released since 2023, with
  two small dependencies. Never import it from `packages/core` or the apps.
  Other providers need no SDK: Chat Completions is plain `fetch`
  (`packages/cli/src/agent-openai.ts`).
- `qrcode-generator` in `apps/shared` (`apps/shared/src/Payment.tsx`): a QR code
  for a wallet to scan when paying a host. QR encoding (ISO 18004) is a spec
  with a long tail; this one has no dependencies, has been released since
  2014, and is used very widely. Apps only, never `packages/core`.
