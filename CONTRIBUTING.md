# Contributing to Minca

Minca is a protocol first and a library second. [`spec/`](spec/README.md) says
what goes over the wire, what is stored, what is signed and what every peer
must check; `packages/core/src/` is its reference implementation. Read the part
of the spec, or the page of [the docs](packages/core/docs/README.md), a change
touches before changing the code.

[CLAUDE.md](CLAUDE.md) holds the working rules in full, for people and coding
agents alike: types, style, dependencies, and how the spec and the code change
together.

## Running it locally

Node 22 or later.

```bash
npm install     # one install for the whole workspace: core, CLI, relay and the apps
npm run dev
```

That starts everything, with coloured output per part, and Ctrl-C stops it all:

| Part   | Where                 | What                                                                                                                         |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| app    | http://localhost:5173 | The app (app.minca.social)                                                                                                   |
| home   | http://localhost:5174 | The account home it connects to                                                                                              |
| site   | http://localhost:5185 | The website (minca.social)                                                                                                   |
| node   | port 8787             | An always-on node that is also the relay; a throwaway identity on first run (`packages/cli/.env.dev`, data in `.minca-dev/`) |
| host   | http://localhost:8788 | `minca host`, what "Keep my spaces online" uses and what spaces chip in for; settings in `packages/cli/.env.host.dev`        |
| stripe | —                     | Only when you add a Stripe test key: forwards Stripe's webhooks to the host                                                  |

`npm run signal` runs the relay alone. Trying it all out, payments included,
is in [apps/example](apps/example/README.md).

Everything imports the protocol by name, `@minca/core`, and only through what
it exports. Inside the workspace, the `@minca/source` export condition resolves
those imports to `packages/core/src`, so the apps, the CLI and the tests run on
the source with no build step; published copies use `dist`. The CLI bundles the
protocol and the relay into one file, so `npx @minca/cli` and the single-file
binaries need nothing else.

## Checks

```bash
npm test             # every workspace: core's tests, then the CLI's
npm run scenarios    # kinds of community written as tests (scenarios/README.md)
npm run check        # typecheck, lint, format and unused code, as CI runs it
# one test file, from packages/core
node --experimental-vm-modules --import tsx --test tests/sync.test.ts
```

A pre-commit hook runs oxlint and Prettier on staged files.

The tests are the executable half of the spec. They cover key derivation
(checked against the public keys Web Crypto generates for the same private
scalars, and pinned to recorded DIDs so an accidental change can't slip
through), recovery codes, account vaults, data folders with several writers,
spaces, invites and encrypt-then-sign, UCAN delegations, phone pairing, peer
introductions, Negentropy (checked against the reference implementation), the
validation gates, and two peers reconciling, including the forged, stolen,
unauthorized and malformed versions their gatekeepers reject. Above those: the
node API and the CLI.

## Changing the protocol

A change to `spec/`, or to code or tests a spec _Source:_ line cites, is a
protocol change. It changes the spec in the same PR, and before it's merged:

1. The `protocol-reviewer` agent (`.claude/agents/protocol-reviewer.md`)
   reviews the branch adversarially, and proves each blocker with a probe test.
2. Every blocker is fixed, with its probe kept as a test. Every other finding
   is answered through the `file-issue` skill.
3. The scenarios pass.
4. The PR description says what the review found under **Adversarial review**,
   and what changes under **Threat model**. CI checks for both.

Ask the questions in [the threat model](spec/threat-model.md) while designing,
not only at review. [CLAUDE.md](CLAUDE.md#every-protocol-change-is-reviewed-adversarially)
has the details.

## Issues and pull requests

An open issue is work we mean to do before v1. Before starting, look for one
that covers it, and link it from the PR: `Fixes #N` when the PR closes it,
`Refs #N` when it only touches it. Ideas for later are filed closed with the
`idea` label.

## Releasing

`@minca/core` (`packages/core/`) and `@minca/cli` (`packages/cli/`) are
released together, always with the same version:

```bash
npm run release
```

It checks you're logged in to npm first (and runs `npm login` if not),
typechecks and runs the tests, then [bumpp](https://github.com/antfu-collective/bumpp)
asks for the next version, writes it to both packages, and commits and tags it
(`v0.1.2`), locally. Both are published (each builds itself first: `dist/` for
the core, one bundled file for the CLI), and only then are the commit and tag
pushed. The root README is `@minca/core`'s page on npm too
(`scripts/npm-readme.mjs` copies it in, with its links made absolute).

If a release stops partway (npm login, a one-time password, the network), fix
it and run `npm run release` again. It sees the version isn't fully on npm yet
and publishes what's missing, instead of bumping again.
`npm run release -- --dry-run` does everything but publish and push. The
script is `scripts/release.mjs`; bumpp's settings are in `bump.config.ts`.

The desktop app (`apps/desktop`) and the Chrome extension (`apps/extension`)
carry the same version, and the tag builds them: `.github/workflows/release.yml`
puts the Mac `.dmg`, the Windows installer (a preview), the extension's zip and
`SHA256SUMS` on a GitHub Release, each with a build attestation. Their names
don't change between releases, so the site's `/download` page links to
`releases/latest/download/<file>`. A tag with a `-` (`v0.2.0-rc.1`) makes a
pre-release, which those links skip. None of them is signed yet. Every PR
builds them too (`.github/workflows/build.yml`), the desktop app only when
something in it changes, and the Actions tab runs that workflow by hand.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
