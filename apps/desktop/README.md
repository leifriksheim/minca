# Minca for the desktop (prototype)

The example app in a window of its own, with no title bar. Its node runs in
the shell, not the page, so it keeps running in the menu bar when the window
closes: automations still notify, and the window opens onto a node that is
already up to date. While it runs and its connection lasts, your spaces stay
online. Built on
[Electrobun](https://electrobun.dev) 1.18, whose main process is Bun.

```bash
npm install                     # at the repository root
npm run dev -w apps/desktop     # builds the parts, then opens the app
npm test -w apps/desktop        # the popup bridge
```

`npm run parts` builds the example app and the CLI, as one file for Bun.
`VITE_MINCA_HOME` points the app at another account home:
`VITE_MINCA_HOME=http://localhost:5174/connect npm run dev` for `apps/home` on
this machine.

## Releases

`npm run build` makes the `.dmg` (in `artifacts/`). CI builds it on every PR
that touches it, and a version tag puts it on a GitHub Release as
`Minca-mac-arm64.dmg`, beside the Windows build (a preview) as
`Minca-windows-x64.zip` (`.github/workflows/build.yml`). The version is bumped
with the packages (`bump.config.ts`).

The app updates itself from the latest release (`release.baseUrl` in
`electrobun.config.ts`, `src/bun/updates.ts`). A minute after launch and every
six hours it fetches `stable-macos-arm64-update.json`; when the version there
differs, it downloads the whole app (`stable-macos-arm64-Minca.app.tar.zst`)
in the background, then shows "Restart to update to 0.1.19" and the dot in the
menu bar. It never restarts on its own, since the app's node keeps spaces
online.
"Check for updates" in the menu bar looks at once. Pre-releases aren't
`latest`, so they reach no one. It trusts what GitHub serves over HTTPS, as
the first download does.

Neither is signed with a Developer ID yet, so the site tells people how to open
it the first time. On the Mac, `scripts/sign-adhoc.ts` (Electrobun's `postWrap`
hook) signs the app ad hoc before it goes into the `.dmg`. Unsigned, its
resources aren't sealed and macOS calls a downloaded copy "damaged", with no
way to open it. Signed ad hoc, System Settings → Privacy & Security → **Open
Anyway** opens it.

The app runs on macOS 14 and later. Electrobun's Zig-built binaries (the
`.dmg`'s extractor, `libasar`, `zig-zstd`) come marked with the macOS they
were built on, 14.8, which 14.0–14.7 refuse to open; `scripts/macos-floor.ts`
(the `preBuild` hook) marks them 14.0, what the rest of the app needs.

## What it does

- Serves the example app at `http://127.0.0.1:47830`. The port is fixed: a new
  port is a new origin, and the account home knows an app by its origin.
- Runs the app's node in a process of its own (`src/bun/app-node.ts`): `minca
app-node` from the CLI (`packages/cli/src/app-node.ts`), with the Bun
  Electrobun ships. The window uses it over a port, as a page uses its
  worker (`desktopConnection` in `apps/example/src/desktop.ts`), so the window
  and the menu bar are one node with one key. Connecting opens the account
  home in a window the shell is the opener of, at the app's origin, and asks
  for a 30-day note. The window is shown who is connected, never the keys
  the grant carries.
- Seals that node's folder (`app-node/` in the app's data folder): its key,
  its grant, and its stores' registry, under a key kept in the macOS keychain
  (`Bun.secrets`, service `org.minca.desktop`) and handed to the node on
  stdin. Copied without the keychain, the folder yields no key, grant or
  private body. Renewing keeps the key; leaving an
  account (disconnecting, or the home answering as another account) forgets
  it and that account's stores, with anything written there that no peer had
  taken yet. A program
  running as you can still ask the keychain, as it can read a browser profile.
- Says in the menu bar how long the connection lasts: "Connected until Tue 21
  Oct" while it is far off; in its last two days "Connection ends tomorrow",
  "Renew connection…" and a dot beside the icon; once it has run out,
  "Paused: spaces offline until you reconnect" and "Reconnect…". One
  notification a day before the end, then nothing more. With the window
  closed, what the account's automations match shows as a notification in
  the app's own words.
- Shows it in a window with no title bar (`titleBarStyle:
'hiddenInset'`), filling the screen when it opens. An empty spot in the top 28 points drags the window, and a
  double click there zooms it. The page gets `data-desktop` on `<html>`, so
  the app can make room for the window's buttons
  (`apps/example/src/styles.ts`).
- Opens the windows the app asks for, the account home among them, through
  the popup bridge below. Links to new windows open in the person's browser.
- Puts Minca's rainbow in the menu bar (a template image, tinted like the
  others: `assets/tray.swift` draws it): Open Minca, Account settings (the
  account home in a titled window of its own), the app's connection, Quit.
  Closing the window leaves the tray and the app's node running, and hides
  the dock icon, unless "Keep in Dock" is
  checked in the menu bar (`settings.json`, `"keepInDock"`).
- Has an icon of its own in the dock: the rainbow on a warm apricot ground
  (`assets/icon.swift` draws `assets/icon.iconset`, every size macOS asks for:
  `swift apps/desktop/assets/icon.swift apps/desktop/assets/icon.iconset`).

## The popup bridge

Electrobun opens no popups: `window.open` returns `null`, in WebKit and in CEF.
The app connects by opening the account home in a popup, and the two talk
over `postMessage`, each checking `event.source` and `event.origin`
(`connectToHome()` and `receiveConnectRequest()` in
`packages/core/src/session/connect.ts`). So the shell does what a browser
would. Nothing in the app, the home or the protocol changes.

- `src/bun/page.ts`, the preload every window gets, replaces `window.open`,
  `window.opener` and, in a popup, `window.close`. What it hears from the
  shell, it dispatches as a `MessageEvent` whose `source` is the object
  `window.open` returned, or `window.opener`.
- `src/bun/bridge.ts`, in the main process, opens the windows and carries
  every message. It stamps each message with the origin the sender's window
  was opened for. It passes messages only between a window and the one that
  opened it, and only to the target origin the sender named, or `*`.

Why it can be trusted with the exchange:

- **Every window is `sandbox: true`.** Electrobun gives a page that isn't
  sandboxed, and every frame in it, a bridge that runs scripts in any other
  window by id (`webviewTagExecuteJavascript`). A mini app's screen frame could
  then reach into the home's window.
- **A message counts only by its secret.** Electrobun routes a page's events by
  a webview id the page itself supplies, so that id says nothing. Each window's
  preload carries a random secret and the one origin the window was opened for.
  It installs nothing in a frame, or in a page at any other origin, and it keeps
  `JSON.stringify` and the bridge's `postMessage` from before the page's own
  scripts run.
- **Delivery checks the origin again, in the target page,** so a window that
  has navigated elsewhere gets nothing.
- **Each window stays at its origin.** Navigation rules refuse anywhere else
  (its own `about:` and `blob:` pages aside), so the popup's title, its host,
  stays true. Links to other sites, and windows opened with `noopener`, open
  in the person's own browser: a host's checkout page gets no way back.
- **Nothing opens without a click.** Not `navigator.userActivation`: WebKit
  counts a script the shell runs as a gesture, and every message arrives as
  one. The preload notes trusted input itself, which a page can't fake, and
  the bridge caps windows (8 open from one) and browser links (one a second).
- **A window's refs are random,** so a page loaded again can't name a window
  the last one opened.

Window actions run on a later tick than the event that asked for them. Closing
a window from inside Electrobun's event callback crashes Bun.

**No SharedWorker.** WebKit here drops, without an error, any message to a
SharedWorker that holds a `CryptoKey`, and a node's worker is started with its
session key. Every page waited 30 s for a worker that never started, then ran
its node itself: "Looking for your accounts…" in the home, then "Waiting for
your account home…" in the app. The preload hides `SharedWorker`, so pages use
a dedicated worker: the app is connected about a second after it loads.
In a browser the app now keeps its key in the tabs and starts its shared
worker with none, so WebKit browsers share one node too
(`apps/example/src/minca.ts`); the home still skips shared workers in WebKit.

## Checked on macOS (arm64)

| Check                                | Result                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Connecting to an account home        | works end to end against `apps/home` on localhost: hello, request, consent, grant, the home closes, the app is connected |
| Popups the app opens from its own UI | open, close themselves, tell their opener                                                                                |
| Dragging the window by its top strip | moves it by the pointer's distance                                                                                       |
| The app in the window                | `SharedWorker`, `RTCPeerConnection`, `crypto.subtle` and `indexedDB` all work                                            |
| Closing the window                   | the tray stays, the app's node keeps running                                                                             |
| WebRTC in the app's node             | `node-datachannel` loads under Bun from the copy the app ships                                                           |
| Size                                 | 78 MB for the `.app`: 60 MB of Bun, 11 MB of main-process bundle; no Chromium                                            |

Not yet:

- **Passkeys.** An app's web view can use a passkey only for a domain the app
  is tied to (Associated Domains: a signed app, and a file on the home's
  domain), and WebKit here offers no authenticator. So the preload hides
  `PublicKeyCredential`, and the home offers a password, as in a browser with
  no passkeys. A signed app tied to the deployed home could offer them for it.
- **A real click on Connect, since the click check.** Clicks posted from a
  script don't reach the window without the Accessibility permission, so it
  needs trying by hand.
- **The shared node, end to end in the window.** `minca app-node` is tested
  over its lines, under Node and under the Bun the app ships, and the bridge
  and preload in the harness; connecting from the window, renewing from the
  menu bar and notifications with the window closed need trying by hand. A
  grant the window kept from before the shared node is not carried over:
  connect once more.
- **The app's origin is fixed.** `http://127.0.0.1:47830` is the same app on
  every device of an account, to the account home: disconnecting it on one
  disconnects it on all. And something else holding that port first stops the
  app from starting.
- **A carrier from an earlier version.** Earlier versions could run a carrier
  beside the app. Nothing runs it now: it stays listed in the account
  home until it is disconnected there, and its folder, `carrier/` in the app's
  data folder, can be deleted.
- **Only macOS was tried.**

## Electrobun's footing

- 1.18 is the last release on npm with the SDK in it. 2.x (August 2026) moved
  to its own toolchain (Hutch, the Cottontail runtime). Measured against the
  dependency bar in `CLAUDE.md`, it is mid-rewrite.
- Its main-process module imports `three` and `@babylonjs/core`, so both are
  bundled into the app's main process (most of its 11 MB).
- Its own source doesn't typecheck under this repository's settings, so
  `npm run typecheck` covers the bridge, the preload and the
  tests, not `src/bun/index.ts`.
- On first run it downloads its CLI and core binaries from GitHub releases.

## Bun.WebView

`Bun.WebView` can't do this: it is headless only (`headless: false` throws),
with no window, tray or menu.
