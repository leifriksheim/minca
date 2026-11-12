# Signing in

Most apps connect to the person's account home
([Building an app](building-an-app.md)). This page is for a page that keeps
the account itself: an account home, or an app that signs people in on its
own. `createMincaAuth` is the whole flow, from creating an account to
pairing a phone.

## The sign-in screen

The flow is state and actions: draw a screen for each `stage`, and call an
action from its buttons. `subscribe` calls back after every change.

```js
import { createMincaAuth } from '@minca/auth';

const auth = createMincaAuth({ appName: 'Todo', network: { relays: ['wss://relay.minca.social'] } });

auth.subscribe((state) => {
  if (state.stage === 'ready') start(state.session.node);
  else draw(state); // a screen for state.stage
});
passkeyButton.addEventListener('click', () => auth.signInWithPasskey());
void auth.start();
```

In React, hand the flow to `MincaProvider`, and read it with `useMinca`:

```tsx
import { createRoot } from 'react-dom/client';
import { createMincaAuth } from '@minca/auth';
import { MincaProvider, useMinca } from '@minca/react';

const auth = createMincaAuth({ appName: 'Todo', network: { relays: ['wss://relay.minca.social'] } });

function App() {
  const { state } = useMinca();
  if (state?.stage !== 'ready') return <p>{state?.stage}</p>; // a screen for each stage
  return <p>Signed in.</p>;
}

createRoot(root).render(
  <MincaProvider auth={auth}>
    <App />
  </MincaProvider>,
);
```

The account home draws every stage
([its screens](https://github.com/leifriksheim/minca/tree/main/apps/home/src/components));
start from those. Everything below the provider works as it does for a
connected app. The rest of this page is what each stage means and which
action moves it on.

## Places

A place is where accounts and their data are kept. There are two kinds:

| `kind`    | Accounts and data are kept in                                    |
| --------- | ---------------------------------------------------------------- |
| `browser` | IndexedDB, per account ([stores](node.md#stores))                |
| `folder`  | A folder the person picks, called a pod. The registry is sealed. |

A pod is a folder picked through the File System Access API. The last one
picked is remembered, and opened again without a prompt while the browser
still grants it. A place holds any number of accounts. `listAccounts` returns
them most recently used first.

## Stages

The flow is a state to read and actions to call. `auth.getState().stage`
says which screen it is on. It goes from `starting` through the screens of signing in or setting up,
to `ready`. What each stage means is in
[`AuthStage`](https://minca.dev/api/auth/type-aliases/AuthStage/).

Where data lives is asked at `existing`, not up front. A page that waits for
`ready` doesn't see the session during `recovery`, `unlock` or `pod`.

A failed action sets `error`, an
[`AuthError`](https://minca.dev/api/auth/interfaces/AuthError/), and stays
on the same stage. A dismissed passkey or folder prompt sets no error.

### Moving between stages

| From                            | Action                                                                      | To                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `starting`                      | `start()` with a kept sign-in here                                          | `ready`, or `pair` (signed in) with a pairing ticket in the URL                                                         |
| `starting`                      | `start()` with no kept sign-in and a pairing ticket in the URL              | `pair`                                                                                                                  |
| `starting`                      | `start()`, otherwise                                                        | `signIn` if the place has accounts, else `welcome`                                                                      |
| `starting`                      | `start()` fails                                                             | `welcome`, with `error`                                                                                                 |
| any                             | `showWelcome()`, `showExisting()`, `showRestore()`, `showSignIn()`          | that stage                                                                                                              |
| `welcome`, `existing`, `signIn` | `choosePod()` or `useBrowser()`, signed out                                 | `signIn` or `welcome`                                                                                                   |
| `welcome`                       | `reopenPod()` from a click, with `podToReopen` set                          | `ready` with a kept sign-in there, else `signIn` or `welcome`                                                           |
| `ready`                         | `choosePod()`                                                               | `ready`, with `podChoice` set ([moving into a pod](#moving-into-a-pod))                                                 |
| `pod`                           | `choosePod()`                                                               | `ready`. The new account moves into the pod, and its browser copy is removed                                            |
| `pod`                           | `finishSetup()`                                                             | `ready`                                                                                                                 |
| `welcome`, `existing`, `signIn` | `startCreating()`                                                           | `create`                                                                                                                |
| `signIn`                        | `signInWithPassword` or `signInWithPasskey` succeeds                        | `ready`                                                                                                                 |
| `signIn`, `restore`             | `signInWithCode` succeeds, or a recovery code given to `signInWithPassword` | `ready` if the account has a passkey or password here, else `unlock` with `setup: 'restored'`                           |
| `create`                        | `createAccount(name, { username? })`                                        | `recovery`, with `session`, `freshCode` and `setup: 'new'`                                                              |
| `recovery`                      | `codeSaved()`                                                               | `unlock`                                                                                                                |
| `unlock`                        | `addPasskey()` or `setPassword(p)` succeeds                                 | `ready` for a new account with a host. Else `pod` where folders can be opened, unless `offerPod` is false. Else `ready` |
| `pair`                          | `acceptPairing()`                                                           | See [pairing a phone](#pairing-a-phone)                                                                                 |
| `pair`                          | `answerPairing(true)` or `answerPairing(false)`                             | As `acceptPairing()` signed out, or `ready` keeping the account signed in                                               |
| `pair`                          | `dismissPairing()`                                                          | `ready` if signed in, else `signIn` or `welcome`                                                                        |
| `ready`                         | `signOut()`                                                                 | `starting`, then `signIn` or `welcome`                                                                                  |

### A pod that needs a click

Chrome keeps a pod's folder between visits, but not the permission to use
it, unless the person chose "Allow on every visit". Then `start()` sets
`podToReopen` to the folder's name and goes on as if there were no pod.
Offer it first on the welcome screen. `reopenPod()`, called
from that click, asks for the permission and carries on as `start()` would
have.

## Creating an account

`createAccount(name)` makes a new account with a random seed. It writes the
account's vault, asks the browser to keep its storage, starts its session,
writes its name to `sys.profile` and shows the recovery code (`freshCode`).

The person must then set up a passkey or a password before `ready`.
Otherwise they would open the account with the recovery code every time.

### Usernames

With `usernames: 'minca.social'` in the config, the create screen asks for a
username alone, and takes the account's name from it. `createAccount` claims
it in the background ([usernames](usernames.md#on-the-node)).

### Hosts

With `network.hosts`, a new account is kept online with the first host as it
is made. Nothing to choose: `hosting.use` runs in the background, tried once
more if the host doesn't answer. It does this only when the host keeps
accounts for free (`free`, or `limits`). Failing that, the account stays in
this browser, and the person can keep it online from the account page later.

`settled()` resolves once the host and any username claim are done.

### Pods

A pod is kept up to date only while a node has it open: this page, or a
carrier given the folder. So a page that closes once signed in, such as an
account home's connect page, passes `offerPod: false`. It offers the pod
where the person comes back instead.

## Ways in

There are three ways into an account.

**The recovery code** is the seed written out, 26 characters. It works on any
site with nothing stored there. It is for restoring, not for every day. If an
account is selected and the code opens a different one, sign-in fails with a
reason. If the code's account is new here, it is filed under the selected
account's name, or `My account`.

**A password** unlocks the vault. It works wherever that vault is: this
browser, or a pod on any site. An account has one password. Setting a new one
replaces the old one, but keeps the CLI's (`CLI_PASSPHRASE_LABEL`), which is
for unlocking unattended. Signing in tries every password the vault holds.

Any password but an empty one is taken. A copied vault can be guessed at
offline, so the forms show how strong a password is as it is typed
(`passwordStrength`: weak under 40 bits, strong from 60) and leave the
choice to the person. `signInWithPassword` also takes a recovery code, which
a password manager may hold from before passwords existed.

**A passkey** is a gate, not a key. The passkey proves someone is there, then
a device key kept in this browser unlocks the seed
([device keys and passkeys](#device-keys-and-passkeys)). Only passkeys made
on this site, whose device key is in this browser, are offered.

## Staying signed in

After an unlock, the account can stay signed in on this device, so a reload
doesn't ask again. The choices are `never`, `1d`, `7d` and `30d`. The default
is `7d`, and each use pushes the expiry forward.

```ts
import { createMincaAuth } from '@minca/auth';

const auth = createMincaAuth();
await auth.staySignedIn.setChoice('30d');
auth.staySignedIn.until(); // a Date, or null
```

The seed is kept wrapped with a fresh device key that can't leave the
browser. A kept sign-in resumes only in the same kind of place it was made
in. Signing out, choosing `never`, or finding it expired deletes the device
key.

A signed-out tab picks up a sign-in another tab keeps, as a reload would. It
does this only once `start()` has finished, and only at `welcome`,
`existing` or `signIn` with no account picked, or the same one picked. When
the person signs out in another tab, a tab that picked it up signs out too.

The flow keeps these in `localStorage`, where `<prefix>` is `storageKey` in
the config, default `minca`:

| Key                                | Holds                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| `<prefix>.stay-signed-in`          | The choice                                                  |
| `<prefix>.remembered-session`      | The kept sign-in (below)                                    |
| `<prefix>.last-account`            | The account used last                                       |
| `<prefix>.storage-choice`          | Where data lives                                            |
| `<prefix>.connections:<accountId>` | At an account home, its connections ([below](#connections)) |

```json
{
  "accountId": "k3j2h4g5f6d7",
  "place": "browser",
  "wrap": { "kind": "device", "...": "…" },
  "expiresAt": 1791027701000
}
```

These are implementation details. Don't read them from your app.

## Proving it is you

Being signed in is no proof anyone is there. A page may be left open, and a
sign-in kept for days. So anything that hands out the whole account, or
changes how it signs in, asks again first:

```ts
import { createMincaAuth } from '@minca/auth';

const auth = createMincaAuth();
const ok = await auth.confirm({ password: 'correct horse battery staple' });
```

The proof is the password, the passkey's own check (a fingerprint, a face or
a PIN), or the recovery code itself
([`MincaAuth.confirm`](https://minca.dev/api/auth/interfaces/MincaAuth/)).
A wrong answer resolves false and sets `error`. A passkey with nothing behind
it is no proof.

For five minutes after, these work: `recoveryCode()`, `offerToPhone()`,
`setPassword`, `addPasskey`, `removeShortcut` and `removeAccount`.
`isConfirmed()` says whether you're in that window. A new sign-in, or
signing out, asks again. The first setup of an account just made, restored
or paired needs no proof, nor does the recovery code shown when an account
is made.

### Giving apps access

Giving an app or a carrier anything (`auth.grant`, `auth.grantCarry`) takes
the same proof, or a sign-in in the last five minutes. Making the account
counts too. A passkey sign-in counts only when the passkey's own check ran. A
sign-in kept from an earlier visit doesn't count. `mayGrant()` says whether
any of these holds.

So the reference home's connect page works like signing in with Google:
choose the account, prove it is you, then allow. A suggestion from an app
already connected (`auth.propose`) gives nothing new, and needs only the
sign-in.

This keeps the seed from someone who only has the open page. It can't keep
it from a compromised page, since the seed is in the page's memory while
signed in. [Threat model §4](https://github.com/leifriksheim/minca/blob/main/spec/threat-model.md)

## Pairing a phone

Pairing moves an account from a computer to a phone with a QR code.

### On the computer

`offerToPhone(onStage)` starts an offer on the first relay, and returns
`{ url, stop }`: the link to show as a QR code, and a way to stop. The link
holds a one-time secret, not the account. The offer answers the first phone
that turns up and nobody after it. It stops after two minutes if no phone
has come.

When the phone is there, `onStage` gets `{ kind: 'compare', code, same,
different }`. Show the six digits and ask whether the phone shows the same.
Call `same()` to send the account, or `different()` to end it having sent
nothing. Then come `sending`, and `sent` once the phone says it arrived.
Each space goes along as `node.spaces.invite(id)`.

### On the phone

The phone opens the link at the `pair` stage, and waits for a tap.
`acceptPairing()` meets the computer and shows the same code
(`pairingStage` is `{ kind: 'confirm', code }`). The seed arrives only once
the person confirms on the computer. The phone then signs in, joins each
space (`{ kind: 'joining', joined, total }`), and ends on `received`.

It waits 60 seconds for the computer to answer, and 10 minutes for the
person to confirm. Where accounts are already kept, a page drawing its own
screens must warn the person before the tap that calls `acceptPairing()`: a link someone else sent would put the phone in their
account.

After that, the account goes to `unlock` with `setup: 'paired'` if it has no
way in on this phone yet, else to `ready`.

### A phone already signed in

A phone that is signed in still gets the `pair` stage. `acceptPairing()`
stops once the account arrives, before taking it, and sets `pairingArrival`
to `{ did, account }`. `account` is the summary if this place already keeps
it, else null. The same account as the one signed in is taken without
asking, and only its spaces are joined.

`answerPairing(true)` adds the account, or switches to it, and keeps the
other one filed to switch back to. `answerPairing(false)` lets it go.
Ask the person: "Add this account?" or "Switch to <name>?".

Switching doesn't sign the other account out: its session key is left as it
is, as when a tab closes. Only the session open when the account arrives
counts, so a caller that accepts before `start()` has finished pairs as a
signed-out phone.

`dismissPairing()` stops a pairing at any point before the account is taken.
The phone leaves, and tells the computer nothing.

### Pairing details

- The camera opens the link in a new tab. The tab the person started in picks
  up the new sign-in ([staying signed in](#staying-signed-in)).
- An account home ignores a pairing link on its connect page, so a popup an
  app opened never shows a pairing screen. This is no defence: any page can
  open the account page with the link.
- `pairingTransport` in the config sets how the two sides reach each other.
  The default is the relay in the ticket. It is for tests, or a host with its
  own.

The ticket and the exchange are in
[spec 01 §15](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

## Moving into a pod

Picking a pod while signed in sets `podChoice` with what the pod holds:
this account's copy, other accounts, and whether it is the pod in use. Then
the person chooses:

- `confirmPod('switch')` uses the pod's own copy and brings nothing.
- `confirmPod('combine')` copies the account and every space into the pod,
  keeps the ways in from both, and restarts the session there.

`forgetBrowserCopy()` then deletes the browser's copy. Other accounts in the
pod are never touched.

The page writes to the pod only while it is open. A carrier given the same
folder, such as the Chrome extension, keeps it up to date while the page is
closed. It learns of the pod when it connects, so one that connected before
the move must connect again.

## Removing an account

`removeAccount()` takes an account out of the browser, as clearing its site
data would. It signs out, then deletes the account's vault, its spaces' data
and what the home remembered of it.

It refuses while an app is connected from here. Only this home can disconnect
an app, so the apps go first. A revoke that only the app had taken in goes
with the account, as after a disconnect nobody heard.

Copies on other devices, carriers and hosts stay. With none, the account's
private spaces are gone, and so is anything that reached no other copy. Its
passkeys stay too, but with the vault gone they open nothing. An account kept
in a pod is not removed this way: the pod is its copy.

## Linking to the account home

A connected app opens the person's account home with
[`connection.openHome()`](building-an-app.md#the-account-home). It opens the
account page beside the connect page, with the account in the fragment, so it
never reaches the home's server: `…#notifications&account=<did>`.

On the home, `readAccountHint()` gives the DID, or null when there is none or
it isn't a P-256 `did:key`. `clearAccountHint()` takes it out of the address
and leaves the section.

Any page can open the home with any DID, so the home must treat it as a hint.
Say which account the app uses, pick it on the sign-in screen, and offer to
switch. Never sign out or switch on the hint alone. For an account the home
doesn't keep, never suggest bringing it in: a stranger could name their own
account, then send a pairing link "to add this browser". Name a kept account
by the name the home filed, never one from the link. Its avatar helps, but is
no proof. [Threat model §3.1](https://github.com/leifriksheim/minca/blob/main/spec/threat-model.md)

## Options

`createMincaAuth(config)` takes the options in
[`MincaAuthConfig`](https://minca.dev/api/auth/interfaces/MincaAuthConfig/).
Every one has a default, so `createMincaAuth()` alone signs in offline, in
this browser.

## Account stores

A folder keeps `accounts.json` and one vault file per account. The library
lists accounts most recently used first (`lastUsedAt`, else `createdAt`). It
writes each file as JSON with a 2-space indent and a trailing newline.

In the browser, the same shape lives in IndexedDB database
`minca-accounts`, object store `accounts`. Key `__list` holds the list of
accounts, and key `<id>` that account's vault. No other site can edit it.

The file formats are in
[spec 01 §14.1](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

## Device keys and passkeys

A device key is made non-extractable, for `encrypt` and `decrypt`. It is
kept in IndexedDB database `minca-device-keys`, object store `keys`, under
its id.

Someone with a copy of the folder or the vault gets ciphertext and no key.
The key can't be carried off and used elsewhere. But anything that can run
script on the site can use the key in place, without the passkey. The passkey
in front of it is enforced by this code, not by cryptography.

**Why passkeys are a gate.** A passkey gives no key material here. The flow
runs a passkey check before it reaches for a device key, and the seed comes
from the device key. A passkey could return a secret only through the PRF
extension, which several major providers don't support or report
inconsistently. And a passkey belongs to one site, so an identity made from
it would differ per site. There is no server, so nobody checks the
assertion's signature. The gate is that the browser finished a verified
passkey check for the recorded credential.

Registration (`navigator.credentials.create`):

| Option                          | Value                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `rp`                            | `{ id: rpId, name: appName }`                                                                                                                  |
| `user.id`                       | 32 random bytes, kept as the wrap's `userHandle` (base64url)                                                                                   |
| `user.name`, `user.displayName` | The account's name                                                                                                                             |
| `challenge`                     | 32 random bytes                                                                                                                                |
| `pubKeyCredParams`              | ES256 (−7), RS256 (−257)                                                                                                                       |
| `authenticatorSelection`        | `residentKey: "required"`, `requireResidentKey: true`, `userVerification: "required"`; `authenticatorAttachment: "platform"` when there is one |
| `hints`                         | `["client-device"]` when preferring the platform authenticator                                                                                 |

Assertion (`navigator.credentials.get`): a random 32-byte challenge,
`userVerification: "required"`, and `allowCredentials` set to the wrap's
`credentialId` when known. Neither asks for PRF.

Renaming an account asks the passkey provider to rename the passkey too,
through `PublicKeyCredential.signalCurrentUserDetails`. Not every provider
does.

Device keys in the vault are in
[spec 01 §12](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md).

## The session a sign-in starts

A sign-in starts a node with the account's keys, the place's stores for that
account ([stores](node.md#stores)) and the configured network. The session is a
[`MincaSession`](https://minca.dev/api/auth/interfaces/MincaSession/).

The seed stays inside the auth object. `recoveryCode()` returns it as a
recovery code. The page also holds the local key, which seals a pod's
registry, as a non-extractable `CryptoKey`, and never hands it out.

The account's name follows the account. When another device renames it, this
one takes the new name for its vault and passkeys. The name is written to the
account only when it is made and on `rename`.

## The account home's side

An account home built on `createMincaAuth` answers apps with these. What it
receives, checks and answers is protocol, in
[spec 06 §2](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md).

### Receiving a request

`receiveConnectRequest(timeoutMs)` resolves with the first request from the
window that opened this one, and the origin the browser reports for it. It
resolves `null` once the opener is closed, or after the timeout, 10 minutes
by default. Without `window.opener` it does nothing. Answering closes the
window 100 ms later.

### Granting

`auth.grant({ origin, request, spaceIds, days? })` makes the grant.
`spaceIds` are the spaces the person picked. `days` is the lifetime they
chose, from 1/24 to 365.

### Connections

`auth.connections()` lists what the home has connected, each a
[`Connection`](https://minca.dev/api/auth/interfaces/Connection/). They are kept
per account in `localStorage` under `<prefix>.connections:<accountId>`. A kept
connection in any other shape is dropped when read, and its app connects
again.

Connecting the same origin again replaces its connection and revokes nothing.
The keys it replaced go in `retired`, for disconnecting to revoke. Nothing
revokes an app just because its time has passed.

A program connected by code at the home's own origin (`via: 'code'`) is kept
by its key instead, so each such program is its own (`connectionKey`). A
carrier is kept apart from the app at its origin, and connecting one never
replaces the other.

### Disconnecting

`auth.disconnect(origin, { audience?, waitMs? })` removes the connections
from that origin, or only the one with that key. It revokes the keys of
those with `write` access and every key in their `retired`, and removes the
automations the app proposed. A carrier at that origin stays.

The app hears of it when the revokes reach it. `waitMs` waits up to that
long for a peer to take them in, and `disconnect` resolves whether one did.
False means the revokes are still only here: the app keeps working until
this home is next online with another of the account's devices or apps.
Without `waitMs`, true only means written. A read-only app or a carrier has
no key to revoke, so it is true there too. The reference home waits 5 s, and
says so when nobody took them in.

### Signing out

`auth.signOut()` forgets the account on this device and revokes the home's
own session key. Nothing it wrote is lost.

The apps connected from here keep working, since they don't need the home
signed in. Their live use stops when their time runs out, and what they
write counts until they are disconnected. `signOut({ disconnect: true })`
disconnects them first, with the programs connected through them and the
automations they proposed. Carriers stay.

Signing out waits up to 5 s (`signOutGraceMs`) for a peer to take in each
revoke, and `state.signingOut` is true meanwhile. For the home's own key it
waits only when a peer is connected as signing out starts, so signing out
alone is quick. With no network, it doesn't wait. With nobody reachable, the
revokes go out the next time the account signs in here. A read-only app has
no key to revoke, and loses access when its time runs out.

The reference home asks each time, with disconnecting unticked, since
revoking is for when something is wrong. It grants nothing once signing out
starts. Choosing another account on the connect page signs out without
disconnecting.

### Proposals

`auth.propose({ origin, request, kept? })` adds the automations the person
kept as the account's own. `kept` is the indices kept, all by default. The
home lists them by app, where the person can pause or remove them.

### Carriers

`auth.grantCarry({ origin, request })` adds a carrier with
`node.carriers.add` ([carriers](node.md#carriers-hosting-and-notifications))
and returns its `CarryGrant`. It replaces any earlier carrier from that
origin, never the app there. A carrier's connection never expires, so it is
kept with `expiresAt: 0`.
