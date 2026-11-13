---
name: release
description: Decide whether main needs a release, pick the version, cut it and watch it ship. Use after a PR merges into main, when asked to release, publish or ship a version, and when someone asks why a fix isn't in the npm packages, the desktop app or the extension yet.
---

# Releasing

A release is a version tag on `main`. Pushing it is all a person or an agent
does; `.github/workflows/release.yml` tests the commit, publishes `@minca/core`
and `@minca/cli` to npm, and puts the desktop app and the Chrome extension on a
GitHub Release, which installed desktop apps update themselves from.

Everything else ships without one. The site, the home, the app, the docs, the
relay, the host and the name service deploy from `main` as it changes
(`.github/workflows/deploy.yml`).

## 1. Does main need one?

```bash
git fetch origin main --tags
last=$(git describe --tags --abbrev=0 origin/main)
git log --oneline "$last"..origin/main -- \
  packages/core packages/cli packages/std packages/actions packages/auth \
  apps/desktop apps/extension apps/example apps/shared
```

Those folders are what the packages and the downloads are built from. Nothing
listed means nothing to release: say so and stop.

Release without being asked when a PR you merged, or were told has merged,
changed them and all of these hold:

- No other PR that changes them is about to merge. One release for a batch,
  not one per PR.
- The latest Check on `main` passed:
  `gh run list --workflow check.yml --branch main --limit 1`.
- The version would be a patch (step 2).

Otherwise say what is waiting and why, and leave it. When asked to release,
only the green Check is required.

## 2. Which version?

Before v1 the middle number is the breaking one.

| Bump         | When                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch`      | Fixes and features that leave everyone on the last version working.                                                                                |
| `minor`      | Someone on the last version stops working: a wire, stored or signed format changed, an export of `@minca/core` or a `minca` command went or moved. |
| `0.3.0-rc.1` | Trying a build of the downloads. It becomes a pre-release, which `latest` skips, on GitHub and on npm.                                             |

Ask before a minor. It is also when the whole-spec audit and the
`triage-issues` sweep are due (CLAUDE.md), so do those first.

## 3. Cut it

In the main checkout, on `main`:

```bash
git pull --ff-only
npm run release -- patch
```

The script refuses a dirty tree or a `main` that differs from `origin/main`.
If the tree has someone's work in it, don't stash or commit it for them: say
so and stop.

## 4. Watch it

```bash
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Then say which version shipped, with the link to its GitHub Release.

When it fails, read the failed job (`gh run view <id> --log-failed`):

- **`packages` or `build` failed**: nothing was published. If it was the
  commit, fix `main` and release the next patch; the failed number is skipped.
  If it was the runner or the network, `gh run rerun <id> --failed`.
- **`npm` or `release` failed**: some of it is out. `gh run rerun <id> --failed`
  finishes it, skipping what is already on npm.

Never move or delete a pushed tag, and never `npm unpublish`.
