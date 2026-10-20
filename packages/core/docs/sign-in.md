# Signing in

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/minca/blob/main/spec/README.md).

`createMincaAuth(config)` is the whole sign-in flow of a page that holds the
seed — an account home, or an app that signs people in itself — as a state to
read and actions to call. It is a client convenience: nothing in it goes over
the wire except what the node it starts does. An account home is a page built on it; the exchange it has with apps is
[spec 06 §2](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

## Places

A **place** is where accounts and their data are kept (`Place`):

| `kind`             | Accounts are kept                     | Data is kept                                                 |
| ------------------ | ------------------------------------- | ------------------------------------------------------------ |
| `browser`          | the browser account store (IndexedDB) | IndexedDB, per account ([stores](node.md#stores))            |
| `folder` (a _pod_) | the folder's account store            | the folder, per account, registry sealed under the local key |

A pod is a directory picked through the File System Access API. The last one
picked is remembered and re-opened without a prompt when permission is still
granted. A place holds any number of accounts; `listAccounts` returns them most
recently used first. Account files and vault formats are in [01](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

_Source: `packages/core/src/session/places.ts`. Tests: `packages/core/tests/account-store.test.ts`._

## Account stores

A folder's `accounts.json` and vault files are
[spec 01 §14.1](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).
The library lists them most recently used first (`lastUsedAt`, else
`createdAt`), and writes each file as JSON with a 2-space indent and a trailing
newline.

**In the browser**, with no folder, the same shape lives in IndexedDB database
`minca-accounts`, object store `accounts`: key `__list` holds the array of
summaries, and key `<id>` that account's vault. No other origin can edit it.

_Source: `packages/core/src/identity/account-store.ts`. Tests: `packages/core/tests/account-store.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account file")._

## Stages

`AuthState.stage` is one of:

| Stage      | Meaning                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting` | Looking for accounts and a kept sign-in.                                                                                                                   |
| `welcome`  | The place holds no accounts: create one, or "I already have one".                                                                                          |
| `existing` | Ways to an account this place does not list: open a pod, add this device from another, or the recovery code. Where data lives is asked here, not up front. |
| `signIn`   | Choose an account and unlock it.                                                                                                                           |
| `restore`  | Type the recovery code.                                                                                                                                    |
| `create`   | Name a new account.                                                                                                                                        |
| `recovery` | Signed in; `freshCode` is the recovery code to keep safe.                                                                                                  |
| `unlock`   | Signed in; choose a passkey or a password. Required.                                                                                                       |
| `pod`      | Signed in; a new account is offered a pod. Optional, and skipped with `offerPod: false`.                                                                   |
| `pair`     | Opened from a phone-pairing link ([01](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md)).                                              |
| `ready`    | Signed in; `session` is set.                                                                                                                               |

Transitions:

| From                            | Action                                                                                                                | To                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `starting`                      | `start()`, a kept sign-in for an account in the place ([the session a sign-in starts](#the-session-a-sign-in-starts)) | `ready`, or `pair` (signed in) with a pairing ticket in the URL                                                                                                          |
| `starting`                      | `start()`, no kept sign-in and a pairing ticket in the URL                                                            | `pair`                                                                                                                                                                   |
| `starting`                      | `start()`, otherwise                                                                                                  | `signIn` if the place has accounts, else `welcome`                                                                                                                       |
| `starting`                      | `start()` fails                                                                                                       | `welcome` (with `error`)                                                                                                                                                 |
| any                             | `showWelcome()` / `showExisting()` / `showRestore()` / `showSignIn()`                                                 | `welcome` / `existing` / `restore` / `signIn`                                                                                                                            |
| `welcome`, `existing`, `signIn` | `choosePod()` / `useBrowser()` while signed out                                                                       | `signIn` or `welcome`                                                                                                                                                    |
| `ready`                         | `choosePod()` while signed in                                                                                         | `ready`, with `podChoice` set; `confirmPod('combine' \| 'switch')` restarts the session in the pod                                                                       |
| `pod`                           | `choosePod()`                                                                                                         | `ready`: the new account moves into the pod without asking, and its browser copy is removed                                                                              |
| `pod`                           | `finishSetup()`                                                                                                       | `ready`                                                                                                                                                                  |
| `welcome`, `existing`, `signIn` | `startCreating()`                                                                                                     | `create`                                                                                                                                                                 |
| `signIn`                        | `signInWithPassword` / `signInWithPasskey` succeeds                                                                   | `ready`                                                                                                                                                                  |
| `signIn`, `restore`             | `signInWithCode` (or a recovery code given to `signInWithPassword`) succeeds                                          | `ready` if the account has a usable passkey or a password here; else `unlock` with `setup: 'restored'`                                                                   |
| `create`                        | `createAccount(name)`                                                                                                 | `recovery`, with `session`, `freshCode` and `setup: 'new'` set                                                                                                           |
| `recovery`                      | `codeSaved()`                                                                                                         | `unlock`                                                                                                                                                                 |
| `unlock`                        | `addPasskey()` / `setPassword(p)` succeeds                                                                            | `pod` for a new account in a browser that can open folders, unless `offerPod` is false; else `ready`                                                                     |
| `pair`                          | `acceptPairing()`                                                                                                     | once the computer confirms the code, `unlock` with `setup: 'paired'` if the account has no way in here, else `ready`; signed in to another, `pair` with `pairingArrival` |
| `pair`                          | `answerPairing(true)` / `answerPairing(false)`                                                                        | as `acceptPairing()` signed out / `ready`, the account signed in kept                                                                                                    |
| `pair`                          | `dismissPairing()`                                                                                                    | `ready` if signed in, else `signIn` / `welcome`                                                                                                                          |
| `ready`                         | `signOut()`                                                                                                           | `starting`, then `signIn` / `welcome`                                                                                                                                    |

A failed action sets `error` (`{ message, hint?, code? }`) and leaves the stage
as it was. A dismissed passkey or folder prompt sets no error.

A pod is brought up to date only by a node that has it open: this page's
while it runs, or a carrier given the folder. A page that closes once signed
in, such as an account home's connect page, passes `offerPod: false`, and
offers the pod where the person comes back instead.

_Source: `packages/core/src/session/auth.ts`. Tests: `packages/core/tests/auth.test.ts`._

## Ways in

- **The recovery code** is the seed written out, 26 characters
  ([01](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md)). It works on any site without anything stored there,
  and is for restoring, not for every day. If an account is selected and the
  code opens a different one, sign-in fails with a reason. If the code's
  account is new to this place, it is filed there with an empty vault (no
  wraps) under the selected account's name or `My account`.
- **A password** unwraps the seed from the vault's `passphrase` wrap. It
  works wherever that vault is: this browser, or a pod on any origin. The flow
  keeps one passphrase wrap as the account's password: setting one replaces
  any other, except the CLI's (label `CLI passphrase`, `CLI_PASSPHRASE_LABEL`),
  which is for unattended unlocking and is kept; the CLI account home
  (`packages/cli/src/home.ts`) makes those. Signing in by password tries every
  passphrase wrap. Any password but an empty one is taken: a copied vault can
  be guessed at offline, so the forms show how strong it is as it is typed
  (`passwordStrength`, weak under 40 bits, strong from 60) and warn, but leave
  the choice to the person. `signInWithPassword` also accepts a
  recovery code, which password managers may hold as this site's login from
  before passwords existed.
- **A passkey** is a gate, not a key: the WebAuthn ceremony proves presence,
  and the seed is unwrapped with a non-extractable device key kept in this
  site's storage, named by the vault's `device` wrap for this `rpId`
  ([device keys and passkeys](#device-keys-and-passkeys)). Only device wraps
  whose `rpId` is this site's are offered, since another origin's device key
  is unreachable from here, and only one whose device key is present in this
  browser.

A new account's seed is random. Creating one writes its vault with no wraps,
asks the browser to persist its storage (when kept in the browser), starts its
session, writes its name to `sys.profile` in the account registry, and shows
the recovery code (`freshCode`). Setting up a passkey or a password is
required before `ready`: an account with no everyday way in would be opened
with its recovery code every time, which is the habit this avoids. A page that
waits for `ready` does not see the session during `recovery`, `unlock` or
`pod`.

_Source: `packages/core/src/session/auth.ts`, `packages/core/src/session/credentials.ts`, `packages/core/src/identity/account-vault.ts` (`CLI_PASSPHRASE_LABEL`). Tests: `packages/core/tests/auth.test.ts`, `packages/core/tests/account-vault.test.ts`._

## Proving it is you

Being signed in is no proof anyone is there: a page may be left open, and a
sign-in kept for days. So whatever hands out the whole account asks again.
`auth.recoveryCode()` returns the code, and `auth.offerToPhone()` starts, only
within five minutes of `auth.confirm(proof)` succeeding, where `proof` is
`{ password }`, `{ passkey: true }` (the passkey's own check that someone is
there: a fingerprint, a face or a PIN) or `{ code }`, the recovery code itself.
`confirm` resolves false and sets `error` for a wrong answer. A new sign-in, or
signing out, asks again. The recovery code shown once when an account is made
needs no confirm.

_Source: `packages/core/src/session/auth.ts` (`confirm`, `recoveryCode`, `offerToPhone`), `apps/home/src/components/ConfirmItsYou.tsx`. Tests: `packages/core/tests/auth.test.ts` ("reading the recovery code or offering the account to a phone takes proof it is you")._

## Device keys and passkeys

A device key ([spec 01 §12](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md))
is generated non-extractable, with usages `encrypt` and `decrypt`, and kept in
IndexedDB database `minca-device-keys`, object store `keys`, key = its id,
value = the `CryptoKey`.

What that protects: someone holding a copy of the folder or the vault gets
ciphertext and no key, and because the key is non-extractable it cannot be
carried off and used elsewhere. What it does not: anything that can run script
in the origin can use the key in place without the passkey. The passkey in
front of it is enforced by this code, not by cryptography.

**Passkeys are a gate.** A passkey yields no key material here. A WebAuthn
ceremony is required before the flow reaches for a device key, and the seed
comes from the device wrap. A passkey can return a secret only through the PRF
extension, which several major credential providers do not implement or report
inconsistently, and a passkey is bound to one relying party, so an identity
derived from it would differ per origin. There is no server, so nobody verifies
the assertion's challenge or signature; the gate is that the browser completed
a user-verified ceremony for the recorded credential.

Registration (`navigator.credentials.create`):

| Option                          | Value                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rp`                            | `{ id: rpId, name: appName }` (default name `Minca`)                                                                                                              |
| `user.id`                       | 32 random bytes (kept, base64url, as the wrap's `userHandle`)                                                                                                     |
| `user.name`, `user.displayName` | The account's name                                                                                                                                                |
| `challenge`                     | 32 random bytes                                                                                                                                                   |
| `pubKeyCredParams`              | ES256 (−7), RS256 (−257)                                                                                                                                          |
| `authenticatorSelection`        | `residentKey: "required"`, `requireResidentKey: true`, `userVerification: "required"`; `authenticatorAttachment: "platform"` when a platform authenticator exists |
| `hints`                         | `["client-device"]` when preferring the platform authenticator                                                                                                    |

Assertion (`navigator.credentials.get`): random 32-byte challenge,
`userVerification: "required"`, `allowCredentials` = the wrap's `credentialId`
when known. Neither asks for the PRF extension.

Renaming an account asks the provider to relabel the passkey through the
WebAuthn Signal API (`PublicKeyCredential.signalCurrentUserDetails` with the
`userHandle`); best effort.

_Source: `packages/core/src/identity/device-key.ts`, `packages/core/src/identity/webauthn.ts`, `packages/core/src/session/auth.ts` (`passkeyGate`). Tests: `packages/core/tests/account-vault.test.ts` ("wrapping a seed"); WebAuthn itself is not exercised by tests._

## The session a sign-in starts

A sign-in starts a node with the local root signer from the seed, the account
key (`deriveAccountKey(seed)`), the contact key (`deriveContactKeyBytes(seed)`),
the place's stores for that account ([stores](node.md#stores)) and the configured network. A
page holds the local key (`deriveLocalKey(seed)`), which seals a pod's
registry, as a non-extractable `CryptoKey`, and never hands it out. The
session (`MincaSession`) is `{ account, did, sessionDid, node }`. The seed stays
inside the auth object; `recoveryCode()` returns it as a recovery code.

The account's name follows the account: on every `account` event the node's
`account.profile()` is read, and a different name is adopted locally (the vault
label and passkey labels). The name is written to the registry only at creation
and on `rename`, never on a plain start.

## Staying signed in

After an unlock, the seed may be kept on the device so a reload does not ask
again. It is wrapped with a fresh non-extractable device key, as a device wrap
labelled `stay signed in` that is kept outside any vault, and stored with an
expiry that is pushed forward each time it is used. Choices: `never`, `1d`,
`7d` (default), `30d`. A kept sign-in resumes only for the same kind of place
it was made in (`browser` or `folder`). Signing out, choosing `never`, or
finding it expired deletes the device key.

_Implementation detail:_ kept in `localStorage` as `<prefix>.stay-signed-in`
(the choice) and `<prefix>.remembered-session`:

```json
{
  "accountId": "k3j2h4g5f6d7",
  "place": "browser",
  "wrap": { "kind": "device", "...": "…" },
  "expiresAt": 1791027701000
}
```

Other keys the flow keeps: `<prefix>.last-account`, `<prefix>.storage-choice`,
and at an account home `<prefix>.connections:<accountId>` ([the account home's side](#the-account-homes-side)). `prefix`
defaults to `minca`.

_Source: `packages/core/src/session/stay-signed-in.ts`, `packages/core/src/session/auth.ts`. Tests: none._

## Moving into a pod

Picking a pod while signed in sets `podChoice` with what the pod holds
(`inspectPod`: this account's copy, other accounts, whether it is the pod in use).
`confirmPod('switch')` uses the pod's own copy and brings nothing.
`confirmPod('combine')` writes the account and a union of both vaults' wraps
into the pod, copies every space into it (`copyAccountData`, [stores](node.md#stores)), and
restarts the session there. `forgetBrowserCopy()` then deletes the browser's
copy. Other accounts in the pod are never touched.

The page writes to the pod only while it is open. A carrier given the same
folder, such as the Chrome extension, keeps it up to date while the page is
closed: it learns of the pod from its grant (`CarryGrant.pod`), so one that
connected before the move learns of it only by connecting again.

_Source: `packages/core/src/session/auth.ts` (`confirmPod`), `packages/core/src/session/places.ts`. Tests: `packages/core/tests/account.test.ts`._

## Pairing a phone

The ticket, the room and the exchange are
[spec 01 §15](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).
`offerToPhone(onStage)` starts an offer on the first configured relay and
returns `{ url, stop }`: the link for the QR code, and a way to stop. The link
holds a one-time secret, not the account. The offer answers the first phone
that turns up and nobody after it, and stops working after two minutes if no
phone has.

When the phone is there, `onStage` gets `{ kind: 'compare', code, same,
different }`. Show the six digits and ask whether the phone shows the same;
call `same()` to send the account, or `different()` to end the offer having
sent nothing. Then come `sending`, and `sent` once the phone says it arrived.
Each space goes in the handover as `node.spaces.invite(id)` with default
options.

On the phone, the `pair` stage waits for a tap, then meets the computer
(`receiveFromDesktop`) and shows the same code (`pairingStage` is `{ kind:
'confirm', code }`). Only when the person confirms on the computer does the
seed arrive; the phone then signs in with it (`sending`), joins each space in
turn (`{ kind: 'joining', joined, total }`, before each one), and ends on
`received`. It waits 60 seconds for the computer to answer, and 10 minutes for
the person to confirm. Where accounts are already kept here, `<minca-auth>`
warns before going on: a link someone else sent would put the phone in their
account.

A phone that stays signed in still gets the `pair` stage, with the kept
account's session open, and `<minca-auth>` names it; `dismissPairing()` goes
back to it. Signed in, `acceptPairing()` stops once the account arrives,
before taking it, and sets `pairingArrival` to `{ did, account }`: `account`
is the summary when this place already keeps that account, else null. The
same account as the one signed in is taken without asking, and only its
spaces are joined. `answerPairing(true)` adds the account (or, already here,
switches to it) and the one signed in stays filed, to switch back to;
`answerPairing(false)` lets it go and goes back to the account signed in.
`<minca-auth>` asks "Add this account?" or "Switch to <name>?", with the
account's avatar. Only the tab's session when the account arrives counts: a
tab that opens with no kept sign-in, or a caller that accepts before
`start()` has finished, pairs as a signed-out one does. Switching this way
starts the arriving account's session without signing the other out: its
session key is left unrevoked, as when a tab closes. `dismissPairing()` stops
a pairing at any point before the account is taken: the phone leaves the
exchange, and tells the computer nothing.

`pairingTransport` in `createMincaAuth`'s config sets how the two sides of a
pairing reach each other (default: the relay in the ticket), for tests or a
host with its own.

An account home ignores a pairing link on its connect page, so a popup an app
opened never shows a pairing screen. It is no defence: any page can open the
account page with the link instead.

The camera opens the link in a new tab, so an app that sent the person to
sign in is still waiting in another. A flow that is signed out picks up a
sign-in another tab keeps (`storage` events on the remembered session), as a
refresh would, so that tab is signed in when the person goes back to it.

A tab takes one up only once `start()` has finished, and only at `welcome`,
`existing`, or `signIn` with no account picked or the same one picked: a tab
where the person chose another account is left alone. It holds `busy`
meanwhile, so a sign-in by hand waits for it and two nodes never start in one
tab. It keeps the remembered key as it is, and gives up if the kept sign-in
changed meanwhile. When the kept sign-in goes, because the person signed out
in another tab, a tab that took it up signs out too, revoking its own key.

_Source: `packages/core/src/session/pairing.ts` (`offerToPhone`, `receiveFromDesktop`), `packages/core/src/session/auth.ts` (`start`, `offerToPhone`, `acceptPairing`), `packages/core/src/elements/minca-auth.ts`. Tests: `packages/core/tests/pairing.test.ts`, `packages/core/tests/take-up.test.ts` ("a pairing link opened where a sign-in is kept")._

## Linking to the account home

An app that links to the person's account home (for its settings, say) says
which account it acts for: `accountHomeLink(home, did, section?)` gives the
account page beside the home's connect page, with `#account=<did>` in the
fragment, after the section if there is one (`#notifications&account=…`). The
fragment never reaches the server that serves the home.

The home may be signed in to another account in that browser, or signed out.
`readAccountHint()` on the home gives the DID, or null when there is none or it
is not a P-256 `did:key`; `clearAccountHint()` takes it out of the address and
leaves the section. Any page can open the home with any DID, so a home must
treat it as a hint: say which account the app uses, pick it on the sign-in
screen, offer to switch, and never sign out or switch on the hint alone. For
an account the home doesn't keep, it must not suggest bringing it in: a
stranger could name their own account, then send a pairing link "to add this
browser" ([threat model §3.1](https://github.com/leifriksheim/minca/blob/main/spec/threat-model.md)). An
account the home keeps is named by the name it filed, never one from the
link; its avatar helps recognise it, but is no proof, since a look-alike
takes seconds to find.

_Source: `packages/core/src/session/account-hint.ts`, `apps/home/src/components/AccountHint.tsx`, `apps/example/src/components/AccountMenu.tsx`, `apps/example/src/notifications.ts`. Tests: `packages/core/tests/account-hint.test.ts`._

## The account home's side

What a home receives from an app, what it must check and what it answers are
protocol ([spec 06 §2](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)). An account home built on `createMincaAuth` does
its side with these:

**Receiving a request.** `receiveConnectRequest(timeoutMs = 10 minutes)` does
nothing without `window.opener`, says hello once, and resolves with the first request from the opener and the origin
the browser reports for it, or `null` once the opener is closed or after the
timeout. Answering closes the window 100 ms later.

**Granting.** `auth.grant({ origin, request, spaceIds, days? })` makes the
grant: `spaceIds` are the spaces the person picked, `days` their choice of
lifetime, clamped to [1/24, 365].

**Connections.** The home remembers each connection per account in
`localStorage` under `<prefix>.connections:<accountId>` (`Connection`:
`origin`, `name`, `audience`, `access`, `scope`, `carrySpace?`, `spaces`,
`grantedAt`, `expiresAt`, `via?`, `recordsOnly?`). It keeps no note:
disconnecting revokes the `audience` key, which is all a revoke names. A kept
connection with any other field (a `token` from before notes were
delegations in the UCAN 1.0 profile, say), or one of these in another
shape, is dropped when read, not read in part: its app or program connects
again.
Connecting the same origin again replaces its connection; a connection with `via: 'code'` (a
program connected by code through the app) is keyed by its audience instead,
so each such program is its own. A carrier is kept apart from the app at its
origin: connecting either replaces only its own kind, and one key is never
both. `auth.connections()` lists them.

**Disconnecting.** `auth.disconnect(origin, { byCode?, audience? })` removes
the app's connections (by default the app and every program connected through
it by code; `byCode: true` only those programs; `audience` only that key),
revokes the keys of those with `access: write`, and, unless only programs
connected by code go, removes the automations the app proposed. A carrier at
that origin stays: it goes by its key alone (`audience`), and takes nothing of
the app's with it. The app hears of it when the revokes reach it,
from this home or a device that has them: `waitMs` waits up to that long for
a peer to take them in, and `disconnect` answers whether one did (without
`waitMs`, true only means written; a read-only app or a carrier has no key to
revoke, so true there too). False means
they are still only here, and the app keeps working until this home is next
online with another of the account's devices or apps. The account home waits
5 s, and says so when nobody took them in.

**Signing out.** `auth.signOut()` forgets the unlocked account on this device,
lets apps whose time has passed go and revokes the home's own session key. An
app's note doesn't need the home signed in, so the apps connected from here
keep working until it runs out. `auth.signOut({ disconnect: true })`
disconnects them first, and the programs connected through them, with the
automations they proposed; carriers stay. The node sends nothing once it has
stopped, so it waits, up to 5 s for them all (`signOutGraceMs` in
`createMincaAuth`'s config), for a peer to take in each revoke (`spaces.revoke`
with `waitMs`), its own session key's among them. A node with no network
configured doesn't wait. With nobody reachable, they leave the next time the account signs in here. A read-only app has no key to revoke: it loses
access when its time runs out. The account home asks each time, with
disconnecting ticked, and is not ready to grant anything from the moment
signing out starts. "Use another account" on the connect page signs out
without disconnecting: switching accounts disconnects nothing.

**Proposals.** `auth.propose({ origin, request, kept? })` adds the
automations the person kept as the account's own: `kept` is the indices kept,
default all. The home lists the account's own automations by app, and the
person pauses or removes them there.

**Carriers.** `auth.grantCarry({ origin, request })` replaces any earlier
carrier from the same origin (never an app there), adds the carrier with `node.carriers.add`
([carriers and hosting](node.md#carriers-hosting-and-notifications)) and
returns the `CarryGrant`. Its connection is kept with `expiresAt: 0`, since a
carry connection never expires.

_Source: `packages/core/src/session/auth.ts` (`grant`, `grantCarry`, `propose`, `connections`, `disconnect`, `signOut`, `isConnection`), `packages/core/src/session/connect.ts` (`receiveConnectRequest`). Tests: `packages/core/tests/connect.test.ts` ("the home receiving a request", "connecting an app to an account home", "disconnecting …", "connecting a carrier to an account home", "signing out and disconnecting…", "signing out alone…"), `packages/core/tests/records-only.test.ts` ("a connection kept in an older shape is dropped, not read as the app’s own")._
