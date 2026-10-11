# 01 — Identity

An account is 16 random bytes. Every key the account uses is derived from them,
so the same 16 bytes give the same identity on any device and any origin. This
part specifies the seed and its written form, every key derived from it, how
keys become DIDs, how the root key delegates to the keys that actually sign
(UCANs), the two ways anything is sealed (envelopes), how the seed is stored
locked on a device, and how a second device receives an account (pairing).

```
seed (16 bytes)
 ├─ HKDF "weave/p256-identity-key/v1" ─▶ root key (P-256, ECDSA) ─▶ account DID (did:key:zDn…)
 │                                         └─ signs UCANs ─▶ session / app / agent keys ─▶ sign records
 ├─ HKDF "weave/p256-contact-key/v1"  ─▶ contact key (P-256, ECDH)
 │                                         ├─ HKDF "weave/p256-door-key/v1|<door>"      ─▶ door key per door (ECDH)
 │                                         └─ HKDF "weave/p256-door-sign-key/v1|<door>" ─▶ door signing key per door (ECDSA)
 ├─ HKDF "weave/local-key/v1"        ─▶ local key (AES-256): seals this device's storage; never handed out
 └─ HKDF "weave/account-key/v1"      ─▶ account key (32 bytes): what an app given the whole account holds
                                           ├─ HKDF "weave/p256-member-key/v1|<space>" ─▶ member key per space
                                           └─ HKDF "weave/account-registry/…", "weave/contacts/…" ─▶ account spaces
```

Conventions (MUST/SHOULD, encodings, canonical JSON) are those of the
[spec README](README.md). In this part:

- **HKDF(ikm, label, L)** is HKDF-SHA256 (RFC 5869) with an **empty salt**
  (zero-length, which RFC 5869 treats as 32 zero bytes), `info` = the UTF-8
  bytes of `label`, output length `L` bytes.
- **CID(bytes)** is `"b"` followed by the RFC 4648 base32 encoding of
  SHA-256(bytes), lowercase, without padding — always 53 characters. (It is
  "CID-like", not a real multiformats CID; [02 — Records](02-records.md) uses
  the same function.)
- **n** is the order of the P-256 group:
  `ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551`.

---

## 1. The seed

An account **seed** is exactly 16 bytes (128 bits) from a cryptographically
secure random source. It is the account: anything that holds the seed can act
as the account, and nothing else can.

- A new account MUST generate its seed with a CSPRNG
  (`crypto.getRandomValues`).
- The seed MUST NOT be stored in the clear. It is stored only as _wraps_
  (§11), or held in memory while unlocked, or written down by the person as a
  recovery code (§2).
- The seed never leaves the account home (the page or process that unlocked
  it) except as a recovery code or sealed in a pairing handover (§15). Apps receive
  delegations (§7), never the seed ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md)).

> Rationale: one secret, everything derived, means recovery is "type 26
> characters" on any device, with no server and no backup of anything else.

_Source:_ `packages/core/src/identity/recovery-code.ts` (`generateSeed`, `RECOVERY_SEED_BYTES`).
_Tests:_ `packages/core/tests/recovery-code.test.ts`, `packages/core/tests/identity.test.ts`.

---

## 2. Recovery codes

The **recovery code** is the seed written out. It is not a backup of the seed
and does not unlock anything stored: it _is_ the seed.

### 2.1 Alphabet

Crockford base32, 32 symbols, value = index:

```
0123456789ABCDEFGHJKMNPQRSTVWXYZ
```

(`I`, `L`, `O`, `U` are not symbols.)

### 2.2 Encoding

1. Take the 16 seed bytes as a 128-bit big-endian bit string.
2. Split it into 5-bit groups, most significant first. The last group has 3
   bits; pad it on the right with two `0` bits. This gives **26 symbols**.
3. Group the symbols in fours, from the left, joined with `-`. The result is
   six groups of four and one of two: `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`
   (32 characters).

Encoders MUST emit uppercase, hyphen-grouped form as above.

### 2.3 Decoding

1. **Normalize:** uppercase; remove every `-` and every whitespace character
   (`\s`); then substitute `O→0`, `I→1`, `L→1`, `U→V`.
2. **Validate:** the result MUST be exactly 26 characters, each in the
   alphabet. Otherwise the code is invalid.
3. Concatenate the 5-bit values and take the first 128 bits as the seed. The
   two trailing padding bits are ignored.

There is **no checksum**. Validation checks only length and alphabet; a
mistyped symbol decodes to a different, valid seed and therefore a different
DID. Because the two padding bits are ignored, the last symbol has four
spellings that decode to the same seed (see the example).

> Rationale: the code has to survive a password manager and a human copying it
> by hand; case, spacing and the O/0, I/1/L slips are forgiven. A caller that
> expects a particular account detects a wrong code by comparing the derived
> DID with the one it expected (`session/auth.ts` does this).

> **Planned: a check character.** A typo today signs in to a new, empty
> account. The plan adds one Crockford check symbol, so a mistyped code is
> refused instead of opening a different account. The format is pre-release
> and may change; no migration is needed. _Open:_ whether to reuse
> Crockford's mod-37 check symbol (which adds `*~$=U` to the alphabet) or a
> check computed over the 26 symbols in the existing alphabet, and whether to
> add a version marker at the same time. Replaces the "checksum" line in §16.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

### 2.4 Example

|                               |                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------- |
| seed (hex)                    | `00112233445566778899aabbccddeeff`                                           |
| recovery code                 | `008J-4CT4-ANK7-F24S-NAXW-SQFE-ZW`                                           |
| also decodes to the same seed | `008j 4ct4 ank7 f24s naxw sqfe zw`, `…-ZZ` (padding bits differ)             |
| recorded example (tests)      | `K7N6-ERYP-68TZ-A7HN-VJW3-QWKN-CG` → seed `99ea6763d63235f51e35dcb83bf27564` |

_Source:_ `packages/core/src/identity/recovery-code.ts`.
_Tests:_ `packages/core/tests/recovery-code.test.ts`, `packages/core/tests/identity.test.ts` ("a known recovery code derives its recorded DID").

---

## 3. Deriving P-256 keys

Every signing or key-agreement key in Weave that is not freshly random is
derived from bytes by one of two procedures.

### 3.1 `ScalarFrom(okm)`

Given 48 bytes `okm`:

```
d = (OS2IP(okm) mod (n − 1)) + 1          // OS2IP: big-endian unsigned integer
```

`d` is the private scalar, in `[1, n−1]`; the public key is `Q = d·G`. This is
the FIPS 186-5 Appendix A.2.1 method (48 = 32 + 16 bytes, so the bias is
negligible). The reference implementation calls
`p256.utils.randomSecretKey(okm)` from `@noble/curves`, which computes exactly
this.

### 3.2 `P256KeyFrom(ikm)` — the identity derivation

```
okm = HKDF(ikm, "weave/p256-identity-key/v1", 48)
d   = ScalarFrom(okm)
```

`ikm` MUST be at least 16 uniformly random bytes. This is what
`CryptoProvider.deriveKeyPairFromSeed` does. It is used for:

| Key                                   | `ikm`                                             |
| ------------------------------------- | ------------------------------------------------- |
| **Root key** (the account identity)   | the 16-byte seed                                  |
| Space invite key ([03](03-spaces.md)) | `HKDF(inviteSecret, "weave/space-invite/v1", 32)` |
| Space read key ([03](03-spaces.md))   | `HKDF(rawSpaceKey, "weave/space-read/v1", 32)`    |

The contact key and member keys (§10) use `ScalarFrom` directly, with their own
labels, without the identity label.

**Derivation is frozen.** Changing the label, the length, or the reduction
changes every account's DID. The recorded vectors in `packages/core/tests/identity.test.ts`
MUST keep passing.

### 3.3 Example (root key)

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| seed           | `00112233445566778899aabbccddeeff`                                                                 |
| okm (48 bytes) | `40e656dfd00c34bd5fd78eafc9af158eeef351b1e9d6444662df48544eaa7db00a50db9fe92caeb7c4e3e16db0f14dd4` |
| d              | `b8b27c37818b648e8cc2546eb327c6dcd27fd7cc1119666230e7826360508a75`                                 |
| Q, compressed  | `029084c70c6acbeb1bfbab099abb469443aa06c02bd1b02b830d846b1129d8c7fb`                               |
| DID            | `did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr`                                        |

Other recorded vectors: 16 zero bytes → `did:key:zDnaebsZZSYuq5oaFMhu2qAaAygqtwPtZwuiVJpjenjA9GwQE`;
16 `0xff` bytes → `did:key:zDnaexDGpQByMfPbsypSPAewepYNqS1yerAq5pEpDZwAmFQWS`.

_Source:_ `packages/core/src/identity/crypto-p256.ts`, `packages/core/src/identity/identity-manager.ts` (`fromSeed`, `fromRecoveryCode`).
_Tests:_ `packages/core/tests/identity.test.ts` ("deriveKeyPairFromSeed", "derivation is frozen", "noble computes the same public point Web Crypto does").

---

## 4. DIDs (`did:key`)

Every key in Weave — root, session, app, agent, invite, read — is named by a
`did:key` over its P-256 public key.

```
did = "did:key:z" ‖ base58btc( 0x80 0x24 ‖ compressedPoint )
```

- `0x80 0x24` is the unsigned-varint encoding of multicodec `p256-pub`
  (`0x1200`).
- `compressedPoint` is the 33-byte SEC1 compressed point (`0x02`/`0x03` ‖ x).
- `z` is the multibase prefix for base58btc. P-256 DIDs therefore always begin
  `did:key:zDn`.

Encoders MUST use the compressed point. Decoders:

1. MUST require the prefix `did:key:z`;
2. base58btc-decode the rest;
3. read the multicodec varint (bytes while the high bit is set, plus one);
4. treat the remainder as the public key. The implementation accepts a
   compressed (33-byte) or uncompressed (65-byte, `0x04 ‖ x ‖ y`) point and
   rejects bytes that are not a point on P-256.

Decoders SHOULD reject a multicodec other than `0x80 0x24`.

> **Known defect:** the reference decoder does not check the multicodec
> (`packages/core/src/identity/did.ts`, `didToPublicKey`), and neither does `verifyUCAN` for
> a token's `iss` (`packages/core/src/identity/ucan.ts`). A non-P-256 key fails later, only
> because it does not import as a P-256 point. A fix will reject any other
> multicodec when decoding.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20), [#19](https://github.com/leifriksheim/weave/issues/19).

> **Planned: one spelling per key.** Decoders will require the `0x80 0x24`
> prefix **and** exactly 33 compressed bytes, refusing the uncompressed form.
> Then a key has exactly one DID, and two DIDs never name the same key (which
> matters wherever DIDs are compared as strings: roots, `createdBy`, members).
> This fixes the known defect above.

Example: see §3.3; the decoded bytes are
`8024029084c70c6acbeb1bfbab099abb469443aa06c02bd1b02b830d846b1129d8c7fb`. The
did:key specification's own P-256 example,
`did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169`, round-trips.

Public keys elsewhere in Weave that are not DIDs (the contact key, member keys)
are the 33-byte compressed point, base64url.

_Source:_ `packages/core/src/identity/did.ts`, `packages/core/src/identity/crypto-p256.ts` (`exportPublicKey`, `importPublicKey`).
_Tests:_ `packages/core/tests/identity.test.ts` ("did:key", "reads the did:key specification's P-256 example").

---

## 5. Derivation labels

Every label under which bytes are derived anywhere in `packages/core/src/`. No two
_purposes_ share a label, but see the notes below the table. Parts other than
this one own the use; this table is the registry.

| Label (UTF-8)                            | Mechanism                                 | Input                                                                              | Output                 | Used for                                                     | Defined in                         | Part   |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------ | ---------------------------------- | ------ |
| `weave/p256-identity-key/v1`             | HKDF, L=48 → `ScalarFrom`                 | seed; or any `ikm` in §3.2's table                                                 | P-256 scalar           | Root key; second stage of invite and read keys               | `identity/crypto-p256.ts:11`       | 01     |
| `weave/p256-contact-key/v1`              | HKDF, L=48 → `ScalarFrom`                 | seed                                                                               | P-256 scalar (ECDH)    | Contact key                                                  | `identity/contact-key.ts:26`       | 01     |
| `weave/p256-member-key/v1\|<spaceId>`    | HKDF, L=48 → `ScalarFrom`                 | account key                                                                        | P-256 scalar (ECDH)    | Member key for one space                                     | `identity/contact-key.ts:27`       | 01, 03 |
| `weave/p256-door-key/v1\|<doorId>`       | HKDF, L=48 → `ScalarFrom`                 | contact key's 32-byte private scalar                                               | P-256 scalar (ECDH)    | Door key (knocks are sealed to it)                           | `identity/contact-key.ts:28`       | 01, 07 |
| `weave/p256-door-sign-key/v1\|<doorId>`  | HKDF, L=48 → `ScalarFrom`                 | contact key's 32-byte private scalar                                               | P-256 scalar (ECDSA)   | Door signing key (proves ownership of a door)                | `identity/contact-key.ts:29`       | 01, 07 |
| `weave/door-topic/v1\|<signKey>`         | SHA-256, base64url                        | —                                                                                  | mailbox topic          | A door's mailbox topic on a relay: a hash of its signing key | `doors/doors.ts` (`doorTopic`)     | 07     |
| `weave/local-key/v1`                     | HKDF, L=32                                | seed                                                                               | AES-256-GCM key        | Local key: this device's storage (§11.1)                     | `identity/account-vault.ts:29`     | 01, 05 |
| `weave/account-key/v1`                   | HKDF, L=32                                | seed                                                                               | 32 bytes               | Account key: root of member keys and account spaces (§11.1)  | `identity/account-vault.ts:30`     | 01, 06 |
| `weave/pairing-room/v1`                  | CID of prefix ‖ secret (no separator)     | 16-byte pairing secret                                                             | room id                | Pairing room                                                 | `identity/pairing.ts:22`           | 01     |
| `weave/pairing-key/v1\|<side>\|<O>\|<P>` | HKDF, L=32                                | pairing secret ‖ ECDH shared x                                                     | AES-256-GCM key        | Pairing messages sent by `<side>` (`offer` or `phone`)       | `identity/pairing.ts:23`           | 01     |
| `weave/pairing-code/v1\|<O>\|<P>`        | HKDF, L=4 → uint32 mod 10⁶                | pairing secret ‖ ECDH shared x                                                     | 6-digit code           | Code both screens show                                       | `identity/pairing.ts:24`           | 01     |
| `weave/space-invite/v1`                  | HKDF, L=32 → `P256KeyFrom`                | 32-byte invite secret                                                              | P-256 key              | Invite key                                                   | `space/space-access.ts:34`         | 03     |
| `weave/space-read/v1`                    | HKDF, L=32 → `P256KeyFrom`                | space key K                                                                        | P-256 key              | Read key of a private space                                  | `space/space-access.ts:33`         | 03     |
| `weave/space-seal/v1`                    | HKDF, L=32                                | space key K                                                                        | AES-256-GCM key        | Every envelope under a space key                             | `privacy/space-encryption.ts:15`   | 03     |
| `weave/space-key-id/v1`                  | HKDF, L=16, base64url                     | space key K                                                                        | key id (22 characters) | A space key's id                                             | `privacy/space-encryption.ts:16`   | 03     |
| `weave/account-registry/nonce/v1`        | HKDF, L=32, first 12 bytes, base64url     | account key                                                                        | space nonce            | Account registry space                                       | `space/account-registry.ts:79,103` | 03     |
| `weave/account-registry/key/v1`          | HKDF, L=32                                | account key                                                                        | space key K            | Account registry space                                       | `space/account-registry.ts:79,105` | 03     |
| `weave/contacts/nonce/v1`                | as above                                  | account key                                                                        | space nonce            | Contacts space                                               | `space/account-registry.ts:92,103` | 03     |
| `weave/contacts/key/v1`                  | as above                                  | account key                                                                        | space key K            | Contacts space                                               | `space/account-registry.ts:92,105` | 03     |
| `weave/topic-tags/v1`                    | HKDF → HMAC-SHA256 key                    | space key K (private) or the bytes of `weave/public-topics/v1\|<spaceId>` (public) | HMAC key               | Topic tags                                                   | `records/topics.ts:80,87`          | 02     |
| `weave-room/v1\|<spaceId>`               | SHA-256, first 20 bytes, base32 lowercase | —                                                                                  | relay room name        | A space's room on a relay                                    | `node/space-runtime.ts:255`        | 04     |
| `weave-agent-link-room-v1`               | URI-encoded CID of prefix ‖ secret        | 16-byte connect-code secret                                                        | room id                | Agent link room                                              | `session/agent-link.ts:25`         | 06     |
| `weave-agent-link-key-v1`                | HKDF, L=32                                | 16-byte connect-code secret                                                        | AES-256-GCM key        | Agent link messages                                          | `session/agent-link.ts:26`         | 06     |

Labels of sealed things: every envelope and every HPKE seal (§9) names one,
with the fields of its `bound`. _docs_ marks a label used by a convention
built on the protocol (`packages/core/docs/`), not by it; _CLI_ one only the
CLI's own node reads:

| Label                      | Primitive | `bound`                                                    | Defined in                           | Part   |
| -------------------------- | --------- | ---------------------------------------------------------- | ------------------------------------ | ------ |
| `weave/record-body/v1`     | envelope  | `space`, `collection`, `key`, `keyId`                      | `privacy/space-encryption.ts:20`     | 03     |
| `weave/earlier-keys/v1`    | envelope  | `space`, `keyId`                                           | `privacy/space-encryption.ts:22`     | 03     |
| `weave/membership/v1`      | envelope  | `space`                                                    | `privacy/space-encryption.ts:24`     | 03, 04 |
| `weave/space-key-box/v1`   | HPKE      | `space`, `keyId`, `to`                                     | `space/space-access.ts:213`          | 03     |
| `weave/vault-wrap/v1`      | envelope  | `did`, `id`, `kind`; and `salt`, `iterations` (passphrase) | `identity/account-vault.ts:32`       | 01     |
| `weave/at-rest/v1`         | envelope  | `entry`                                                    | `storage/encrypted-adapter.ts:25`    | 05     |
| `weave/pairing/v1`         | envelope  | `type`, `seq`                                              | `identity/pairing.ts:26`             | 01     |
| `weave/knock/v1`           | HPKE      | `door`                                                     | `doors/doors.ts:243`                 | 07     |
| `weave/contact-request/v1` | HPKE      | `space`, `from`, `to`                                      | `node/node.ts:1548`                  | docs   |
| `weave/direct-text/v1`     | envelope  | `space`, `from`, `to`                                      | `privacy/direct.ts:37`               | docs   |
| `weave/direct-box/v1`      | HPKE      | `space`, `from`, `to`, `reader`                            | `privacy/direct.ts:39`               | docs   |
| `weave/writer-key/v1`      | envelope  | `did`, `slot`                                              | `packages/cli/src/writer-keys.ts:27` | CLI    |

Strings that separate _signed messages_ rather than derive keys, listed so
new labels do not collide with them:

| String                                                 | Kind                                             | Defined in                                                    | Part |
| ------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- | ---- |
| `weave/space-invite/v1\|<spaceId>\|<did>`              | Message signed by an invite key                  | `space/space-access.ts:217`                                   | 03   |
| `weave/door-purge/v1\|<topic>\|<nonce>\|<ids>`         | Signed by a door signing key, checked by a relay | `doors/doors.ts` (`purgeMessage`), `packages/relay/relay.mjs` | 07   |
| `weave/knock-answer/v1\|<space>\|<account>`            | Signed by a door signing key                     | `doors/doors.ts` (`signAnswer`)                               | docs |
| `weave-peer/v3\|client\|…`, `weave-peer/v3\|server\|…` | Signed peer-auth messages                        | `network/peer-auth.ts:190,192`                                | 04   |
| `weave-mesh/v1\|…`                                     | Signed mesh proof                                | `network/peer-auth.ts:302`                                    | 04   |
| `weave-host/v1\n…`, `weave-host-status/v1\n…`          | Signed host requests and statuses                | `session/hosting.ts:78,340`                                   | 08   |

Notes:

- `weave/p256-identity-key/v1` is applied to more than one kind of input: the
  seed, and (as a second stage) invite and read secrets that were first
  expanded under their own labels. The first-stage label is what separates
  them.
- `weave/space-invite/v1` is both an HKDF label and the prefix of a signed
  message. The two uses are in different primitives and do not collide, but a
  new use MUST NOT reuse either string.
- New labels SHOULD follow the `weave/<purpose>/v<N>` form. A label of a
  sealed thing names exactly one use, and no derivation label is reused as one.

---

## 6. Keys and signers

| Key                  | How made                                                        | Lifetime                                     | Signs                                   |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| **Root key**         | `P256KeyFrom(seed)`                                             | The account's                                | UCANs only (§7)                         |
| **Session key**      | A lasting P-256 key claimed under a lock, else fresh (02 §4.10) | While the device keeps it, else one node run | Records, peer-auth messages             |
| **App key**          | Fresh random P-256 key pair kept by an app                      | Until the app forgets it                     | Records, under a grant                  |
| **Agent key**        | Fresh random P-256 key pair kept by an agent                    | Until the agent forgets it                   | Records, under a records-only note (§8) |
| **Contact key**      | `ScalarFrom(HKDF(seed, contact label, 48))`                     | The account's                                | Nothing; ECDH only (§10)                |
| **Member key**       | `ScalarFrom(HKDF(accountKey, member label, 48))`                | The account's                                | Nothing; ECDH only (§10)                |
| **Door key**         | `ScalarFrom(HKDF(contactKey, door label, 48))`                  | Until the door is closed                     | Nothing; ECDH only (§10)                |
| **Door signing key** | `ScalarFrom(HKDF(contactKey, door sign label, 48))`             | Until the door is closed                     | Purge challenges and knock answers (07) |

The root key signs exactly one kind of thing: a UCAN delegating to another key.
It MUST NOT be used to sign records directly in normal operation. (A record
with no `proof` is judged as written by its `author` key itself — see
[02 — Records](02-records.md).)

### 6.1 Root signers

Not protocol. Where the root key lives, and the interface a node asks for
notes through, are the library's: see
[Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes).

### 6.2 The session delegation

A node signs records with a session key (§6) under a note from the root
(§7) made out to it: `aud` is the session DID, `prf` is `[]`, and `fct` is
absent, or `[{"weave":"agent"}]` for an agent's own node (§8.1). Every record the
session key signs carries that leaf token, encoded, as its `proof`
([02 — Records](02-records.md)). Peers check only that the note verifies and
covers what each record needs (§7.4–§7.6, §8); which capabilities it grants, how
long it lasts and when it is renewed are the node's choice
([Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes),
[06](06-nodes-and-sessions.md)).

_Source:_ `packages/core/src/node/node.ts` (`delegate`).
_Tests:_ `packages/core/tests/node.test.ts` ("records outlive the session that wrote them").

---

## 7. UCAN delegations

A **UCAN** (also called a _note_ in the code and UI) is a JWT-shaped token by
which an issuer key grants capabilities to an audience key for a time window.
Weave uses a subset of UCAN 0.10.

> **Planned: UCAN 1.0** ([#19](https://github.com/leifriksheim/weave/issues/19)).
> Tokens move to the 1.0 format: a DAG-CBOR envelope signed with a varsig
> header, delegations with `sub`, `cmd` and a policy (`pol`) in place of
> `att`, invocations that carry their chain in `prf`, and specified
> revocation. `space:<id>` becomes a policy on `.space`, which also gives
> grants narrower than a space (§7.1) and proof chains that travel (§7.5)
> without new syntax. Issuers and verifiers switch outright, with a sync
> version bump ([05](05-sync-and-storage.md) §4): before v1 a clean break is
> preferred to a transition path. Not normative until built.

### 7.1 Format

```
token = b64u(canonicalJSON(header)) "." b64u(canonicalJSON(payload)) "." b64u(signature)
```

- `b64u` is base64url without padding.
- `canonicalJSON` is Weave's canonical JSON ([02 — Records](02-records.md)):
  object keys sorted, no whitespace, `undefined` members dropped.
- `signature` is ECDSA P-256 / SHA-256, 64-byte IEEE P1363 (`r ‖ s`), by the
  issuer's key over the UTF-8 bytes of `b64u(header) "." b64u(payload)`
  exactly as transmitted.

**Header** (fixed):

```json
{ "alg": "ES256", "typ": "JWT", "ucv": "0.10.0" }
```

**Payload:**

| Field | Type                  | Required              | Meaning                                                                        |
| ----- | --------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `iss` | string (did:key)      | yes                   | Issuer; its key signs the token                                                |
| `aud` | string (did:key)      | yes                   | Audience: the key receiving the capabilities                                   |
| `exp` | integer, Unix seconds | yes                   | Not valid at or after this time                                                |
| `nbf` | integer, Unix seconds | yes                   | Not valid before this time                                                     |
| `nnc` | string                | issuers always set it | Nonce: 8 random bytes as 16 lowercase hex characters. Not checked by verifiers |
| `att` | array of Capability   | yes                   | Capabilities granted (may be empty)                                            |
| `prf` | array of string       | yes                   | CIDs of parent tokens (§7.5); `[]` for a token issued directly by the root     |
| `fct` | array of object       | no                    | Facts. Omitted when there are none. Weave defines one fact (§8.1)              |

`nbf` is optional in UCAN 0.10 but **required** here: a verifier MUST reject a
token without a finite numeric `exp` and `nbf`.

> Rationale: records are judged at the time they claim to have been signed
> (§7.4). A token with no start would let a leaked session key back-date
> records to any time before the token existed.

**Capability:**

```json
{ "with": "<resource>", "can": "<ability>" }
```

Resources and abilities in use:

| `with`            | Meaning     |
| ----------------- | ----------- |
| `*`               | Every space |
| `space:<spaceId>` | One space   |

| `can`               | Meaning                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `record/write`      | Write records (what a record in a space requires: `{with: "space:<id>", can: "record/write"}`)              |
| `record/read`       | Read-only access (app grants with read access)                                                              |
| `record/*`          | Every `record/…` ability: records, and nothing more                                                         |
| `collection/define` | Define, change or remove a space's collections (`sys.collection`, [02](02-records.md) §6)                   |
| `access/change`     | Every other change to a space's access history: roles, members, invites, revocations, keys, relays, keepers |
| `account/write`     | Write in the account's own spaces, and open doors and knock ([07](07-doors.md))                             |
| `*`                 | Every ability                                                                                               |

What each ability permits in a space is specified in
[02 — Records](02-records.md), [03 — Spaces](03-spaces.md) and
[06](06-nodes-and-sessions.md). Which abilities a version needs, and how a
peer checks them, is §8.

> **Planned: grants narrower than a space.** The smallest resource is a whole
> space, so an app or agent granted a private space can write in every
> collection and read all of it for as long as its note lasts. A
> per-collection resource would narrow writes. Narrowing reads also needs
> keys per collection, which is [03 — Spaces](03-spaces.md)' question. Not
> designed yet: how coverage (§7.6) treats it, and the resource syntax, which
> UCAN 1.0 would make unnecessary: a policy on `.collection` narrows a
> delegation with no new syntax ([#19](https://github.com/leifriksheim/weave/issues/19)).

### 7.2 The token's CID

A token is referred to (in `prf`) by
`CID(UTF-8(token))` — the hash of the whole encoded string, signature
included.

> **Planned: one valid form per token.** ECDSA signatures are malleable: from
> a valid `(r, s)` anyone can make `(r, n − s)`, which WebCrypto also accepts,
> and a lenient base64url decoder accepts more than one spelling of the same
> bytes. Either gives a token that still verifies under a different CID.
> Revocation names a key, not a token ([03](03-spaces.md) §6.4), so a second
> form does not slip past one; but whatever names or counts a token by its
> CID, a `prf` link or a cache, sees two tokens where there is one. The plan: verifiers
> refuse a signature with `s > n/2` (high-S), issuers produce low-S only, and
> every base64url field is decoded strictly (no padding, no characters outside
> the alphabet, no non-zero trailing bits).

### 7.3 Issuing

An issuer produces a token of the form in §7.1; what a verifier checks is
§7.4–§7.6. The reference issuer's defaults, and what it refuses to issue, are
the library's: see
[Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes).

### 7.4 Verifying one token

Given a token and a time `at` (Unix seconds), a verifier:

1. MUST split on `.` into exactly three parts, and base64url/JSON-decode the
   first two.
2. MUST check that `exp` and `nbf` are finite numbers, and that
   `nbf ≤ at < exp`.
3. MUST decode `iss` as a did:key (§4), import its public key, and verify the
   signature over the first two parts as received.

The verifier does not re-canonicalize and does not check `nnc` or `fct`. A
verifier SHOULD reject a header other than the one in §7.1, and SHOULD reject
an `iss` whose multicodec is not `p256-pub` (§4).

> **Known defect:** the reference `verifyUCAN` checks neither the header
> (`alg`, `typ`, `ucv`) nor the issuer's multicodec (`packages/core/src/identity/ucan.ts`,
> `packages/core/src/identity/did.ts`). A fix will reject both. Other implementations MUST
> NOT rely on a token with a different header being accepted.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20), [#19](https://github.com/leifriksheim/weave/issues/19).

> **Planned: strict token shape.** Besides the header and the multicodec
> (the known defect above), verifiers will check the payload's shape: `att`
> is an array of `{with, can}` string pairs, `prf` an array of CID strings,
> `iss` and `aud` DIDs, `fct` (when present) an array of objects. A malformed
> token is refused rather than failing somewhere later.

Which time step 2 uses depends on what the token is relied on for:

- **A record's `proof`: no time at all.** Step 2 is skipped. Whether a
  record stands is something every peer must agree on whenever it looks, so
  no one's clock, and no time the writer claims, may decide it
  ([02 — Records](02-records.md) §9.3). A record stays valid after its note
  runs out. What ends a key's writes is a revoke of the key, with a cutoff
  at what it signed ([03 — Spaces](03-spaces.md) §6.4).
- **Anything live** (a knock, a live message, a peer's proof when it
  connects, an app checking its grant): the checking node's own clock. These
  are one node's decisions in the moment, not verdicts peers share, so a
  note that has run out stops working there on time, with no revoke needed.

So a leaked key's live use ends when its note runs out, and its records end
when its key is revoked. Signing out writes a revoke of the session key in every space
the node writes in, its carry spaces, the contacts space and the account
registry, with a cutoff at what it wrote, and a device that kept the key
forgets it (`revokeSelf`); the revokes reach other peers as that device next
syncs. _Open:_ removing a device from another one, which
needs the list of the account's session keys
([#26](https://github.com/leifriksheim/weave/issues/26)).

### 7.5 Delegation chains

A token with non-empty `prf` claims authority from its parents. The chain is
resolved from the leaf toward the root:

1. Verify the leaf (§7.4) at `at`.
2. Let `current` be the leaf. Up to **10** times:
   - If `current.prf` is empty, `current.iss` is the **root DID**. Stop: the
     chain is valid; it grants the **leaf's** `att` to the **leaf's** `aud`.
   - Resolve the token whose CID is `current.prf[0]`. If none is found, the
     chain is invalid.
   - Check the link: every CID in `current.prf` must be among the provided
     proofs (only one is provided, so in effect `prf` MUST have at most one
     entry); the parent must verify (§7.4) at the same `at`; the parent's `aud`
     MUST equal `current.iss`; every capability in `current.att` MUST be
     covered by some capability in the parent's `att` (§7.6).
   - Move to the parent.
3. A chain longer than 10 links is invalid.

Because every parent is verified at the same `at`, a child is never usable
outside its parents' windows, even though the chain check does not compare
`exp` values directly.

A record-validating peer additionally requires that the leaf's `aud` equals
the record's `author`, that some leaf capability covers the capability the
record needs, and that the root DID is allowed in the space
([02 — Records](02-records.md), [03 — Spaces](03-spaces.md)).

**How parent tokens travel is not yet specified** (§16). The rules above are
the intended check for a chain of any length up to 10.

> **Known defect:** a record carries only its leaf token in `proof`, and the
> reference wires no proof resolver for records — the capability gate
> defaults to `() => null` (`packages/core/src/validation/capability-gate.ts`),
> and `packages/core/src/network/peer-auth.ts` passes it too. So a chain deeper than one link never
> validates on a record; only tokens issued directly by the root (`prf: []`)
> do. A fix will define how parents travel and resolve them.
> Tracked in [#17](https://github.com/leifriksheim/weave/issues/17), [#19](https://github.com/leifriksheim/weave/issues/19).

#### Planned: proof chains that travel

Fixes the known defect above; replaces the first line of §16.

A record will carry, besides its leaf token, the intermediate tokens its chain
needs, so any peer can resolve the chain from the record alone, with no lookup
and no service. With that, delegations deeper than root → key work on records:
a session key delegating on to a short-lived key, an app handing a narrower
note to a helper.

What it unblocks:

- Agents' notes today are signed **root → agent key** directly, only because
  peers resolve one link (§8.1, [06](06-nodes-and-sessions.md)). With chains,
  an app could delegate to its agent itself, a narrower note than its own.
- The older idea of **roles as delegations** ("anyone the owner made a
  moderator" as a UCAN from the owner, carried in the record's proof) needed
  this. Roles now live in the space's access history
  ([03 — Spaces](03-spaces.md)) and `can:<p>` rules are built on them
  ([02 — Records](02-records.md) §7.1), so this no longer depends on chains.

Open questions:

- Where parents go: a new optional version member (for example
  `proofs: [token, …]`, parents in order), or tokens stored once per space and
  referred to by CID. The first is self-contained; the second is smaller when
  one note signs many records.
- Whether the chain depth limit of 10 (§7.5) stays, given the bytes each link
  adds to every record.
- How revocation, which names a key ([03](03-spaces.md) §6.4), treats a key
  in the middle of a chain: whether revoking it withdraws what keys it
  delegated to signed.

### 7.6 Capability coverage

A parent capability `P` covers a child capability `C` iff both hold:

- `P.with == "*"` or `P.with == C.with` (exact string match — no other
  wildcards; `space:*` is _not_ a pattern);
- `P.can == "*"`, or `P.can == C.can`, or `P.can` ends in `/*` and `C.can`
  starts with `P.can` minus its final `*` (so `record/*` covers
  `record/write` and `record/read`, but not `*`).

### 7.7 Example

Issued by the root key of §3.3 to the did:key spec's example key, with fixed
times and nonce and the agent fact:

Header JSON: `{"alg":"ES256","typ":"JWT","ucv":"0.10.0"}`

Payload JSON:

```json
{
  "att": [{ "can": "record/*", "with": "*" }],
  "aud": "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169",
  "exp": 1790000000,
  "fct": [{ "weave": "agent" }],
  "iss": "did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr",
  "nbf": 1789996100,
  "nnc": "0123456789abcdef",
  "prf": []
}
```

Encoded (ECDSA signatures are randomized, so the third part differs every
time):

```
eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsInVjdiI6IjAuMTAuMCJ9.eyJhdHQiOlt7ImNhbiI6InJlY29yZC8qIiwid2l0aCI6IioifV0sImF1ZCI6ImRpZDprZXk6ekRuYWVyRGFURjVCWEVhdkNyZlJaRWszMTZkcGJMc2ZQRFozV0o1aFJUUEZVMjE2OSIsImV4cCI6MTc5MDAwMDAwMCwiZmN0IjpbeyJ3ZWF2ZSI6ImFnZW50In1dLCJpc3MiOiJkaWQ6a2V5OnpEbmFlYUE3QmNWeEFpTGROUDE1d0x2UzZTQzF2YVFjOXpwZVZ4clVwRUM0OHl4a3IiLCJuYmYiOjE3ODk5OTYxMDAsIm5uYyI6IjAxMjM0NTY3ODlhYmNkZWYiLCJwcmYiOltdfQ.Y5L8NSDzSGQy2SbWMJyhYDV8nSOvTjySrbOoqyAIpbpdpbU5wH9MsnWQAJ15N4Z0WyTMBd70wRDB-dLaUz3Olg
```

Its CID (for this exact string): `bz2isut3y2xpj7qfz4ufmnbjpn7yitvm4hjuikxczrmawkx4ud2ca`.

_Source:_ `packages/core/src/identity/ucan.ts`, `packages/core/src/validation/capability-gate.ts`, `packages/core/src/node/space-runtime.ts` (`writeCapability`, `noteCid`).
_Tests:_ `packages/core/tests/ucan.test.ts`, `packages/core/tests/validation.test.ts`, `packages/core/tests/attacks.test.ts`.

---

## 8. What a note lets a key do

A key may do in a space what its note grants there, judged by capability
coverage (§7.6) against what each version needs. The protocol never asks what
kind of thing holds a key: a person's session, an app, an agent and a borrowed
device are told apart only by what their notes grant.

| A version in space `S`…                                                                                                     | needs `{ "with": "space:S", "can": … }` |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| any record                                                                                                                  | `record/write`                          |
| and in `sys.collection`                                                                                                     | also `collection/define`                |
| and in any other collection of the access history ([03 — Spaces](03-spaces.md))                                             | also `access/change`                    |
| and in one of the account's own spaces (its registry, its contacts space, its carry spaces; [06](06-nodes-and-sessions.md)) | also `account/write`                    |

A knock ([07 — Doors](07-doors.md)) needs `{ "with": "*", "can": "account/write" }`.

- A version with no `proof` was signed by its author key itself, which may do
  anything (§6).
- A peer MUST ignore a change to the access history whose note does not grant
  the ability it needs: it is not an event in the history, whatever the
  writer's role ([03 — Spaces](03-spaces.md)). A version in one of the
  account's own spaces whose note lacks `account/write` MUST NOT count there.
- The check reads the leaf note's `att`. A chain that verifies (§7.5) never
  grants more than its parents, so the leaf says enough.

A person's own sessions, and apps granted write, get `*`. A key the account
trusts less, such as an agent's, gets `record/*`: it writes records, and
proposes anything more for someone who may to apply
([blueprints and guides](../packages/core/docs/blueprints-and-guides.md)).

> Rationale: earlier, the protocol marked agents with a fact and refused, from
> a note that carried it, exactly these changes. That tied the protocol to one
> kind of key. Abilities say the same thing in what UCAN already has, and
> serve any key the account trusts less, a person's too.

_Source:_ `packages/core/src/identity/abilities.ts` (`noteGrants`, `DEFINE_ABILITY`, `ACCESS_ABILITY`, `ACCOUNT_ABILITY`), `packages/core/src/node/space-runtime.ts` (`accessCapability`, `buildEvent`, `judgeStanding`), `packages/core/src/doors/doors.ts` (`openKnock`), `packages/core/src/session/connect.ts` (`grantCapabilities`).
_Tests:_ `packages/core/tests/agents.test.ts` ("what counts is what the note grants, not whether it says agent", "a definition an agent signs by hand is ignored by every peer", "taking someone out of the space, signed by an agent, is ignored too", "in the account's own spaces, a version under a records-only note does not stand"), `packages/core/tests/doors.test.ts` ("needs a note that grants account/write: …").

### 8.1 The agent fact

The account may sign one fact into a note to say its key is an agent's:

```json
{ "weave": "agent" }
```

- A note is an **agent's note** iff its payload's `fct` is an array containing
  an object whose `weave` member is the string `"agent"`. Anything unparseable
  is not one.
- The fact is only meaningful in a note whose signature and chain verify
  (§7); on its own it proves nothing.
- It is a label. Apps show records written under it as "via agent"; a peer
  MUST NOT judge a version differently for carrying it. What the key may do is
  what the note grants (§8).

_Source:_ `packages/core/src/identity/agent-note.ts`, `packages/core/src/session/auth.ts` (issuing with `AGENT_FACT`).
_Tests:_ `packages/core/tests/agents.test.ts`.

---

## 9. Envelopes

Everything Weave encrypts is sealed one of two ways: under a symmetric key,
as an **envelope** (§9.1), or to a P-256 public key, with **HPKE** (§9.2).
The one exception is below.
Each use names a **label** and a **bound**: the label says what the sealed
thing is, the bound says where it belongs. Both are authenticated, so a
sealed thing opens only for the use and the place it was sealed for: moved to
another record, another space, another account or another slot, or presented
as something else, it does not open.

- A **label** is a constant string `weave/<purpose>/v1`, listed in §5 with its
  bound's fields.
- A **bound** is a flat JSON object whose values are strings or numbers. Its
  bytes are its canonical JSON ([02 — Records](02-records.md)).
- The **context** of a label and a bound is
  `UTF-8(label) ‖ 0x00 ‖ UTF-8(canonical(bound))`. A label never contains
  `0x00`, so no two (label, bound) pairs share a context.

Where a sealed thing travels as text, it is `base64url` of its bytes.

### 9.1 The envelope

Under a 32-byte AES-256-GCM key `k`:

```
nonce    = 12 random bytes, fresh for every envelope
aad      = 0x01 ‖ context(label, bound)
envelope = 0x01 ‖ nonce ‖ AES-256-GCM(k, nonce, plaintext, aad)     // ciphertext ‖ 16-byte tag
```

| Offset | Bytes | Field              |
| ------ | ----- | ------------------ |
| 0      | 1     | version, `0x01`    |
| 1      | 12    | nonce              |
| 13     | n+16  | ciphertext and tag |

A reader MUST refuse (treat as not openable) an envelope whose first byte is
not `0x01`, one shorter than 29 bytes, and one that does not authenticate under
the key, label and bound its use names. It MUST NOT fall back to reading the
bytes some other way.

Example (`packages/core/tests/envelope.test.ts`, "opens the fixed vector"):

|           |                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| key       | `000102…1f`                                                                                                                           |
| label     | `weave/record-body/v1`                                                                                                                |
| bound     | `{"space":"bexample","collection":"app.note","key":"k1","keyId":"aLhvw5pkV65_lcQHEcUOug"}`                                            |
| aad       | `0x01` ‖ `weave/record-body/v1` ‖ `0x00` ‖ `{"collection":"app.note","key":"k1","keyId":"aLhvw5pkV65_lcQHEcUOug","space":"bexample"}` |
| nonce     | `a0a1…ab`                                                                                                                             |
| plaintext | `{"body":{"text":"hi"}}`                                                                                                              |
| envelope  | `01a0a1a2a3a4a5a6a7a8a9aaab9d3a1e4221b220851947f3b67f0ee2e452c43032efcaf9fa505cbbb531a3a7173c059be663ee`                              |

### 9.2 Sealing to a key (HPKE)

To a P-256 public key (a contact, member or door key, §10), with HPKE
([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)) in base mode, single-shot:

| Parameter | Value                               |
| --------- | ----------------------------------- |
| mode      | `0x00` (base)                       |
| KEM       | `0x0010`, DHKEM(P-256, HKDF-SHA256) |
| KDF       | `0x0001`, HKDF-SHA256               |
| AEAD      | `0x0002`, AES-256-GCM               |
| `info`    | context(label, bound)               |
| `aad`     | empty                               |

```
enc, ct = SealBase(pkR, info = context(label, bound), aad = "", plaintext)
sealed  = 0x01 ‖ enc ‖ ct          // enc: the 65-byte uncompressed ephemeral point; ct includes the 16-byte tag
```

A reader MUST refuse a sealed value whose first byte is not `0x01`, one shorter
than 82 bytes, and one that does not open (`OpenBase` fails) for the recipient
key, label and bound its use names. A sealed `{"invite":"x"}` is
1 + 65 + 14 + 16 = 96 bytes.

The implementation is checked against the CFRG test vectors for this suite,
and for the same suite with AES-128-GCM (RFC 9180 Appendix A.3), in
`packages/core/tests/vectors/hpke-p256.json`.

> Rationale: one symmetric format and one public-key format, each with a
> version byte, so another implementation has two things to get right rather
> than one per use. HPKE puts the recipient's key and the ephemeral key into
> the shared secret, and is specified and tested elsewhere.

### 9.3 Every use

| Use                                  | Sealed   | Key                                         | Label                    | `bound`                                                    | Where                            |
| ------------------------------------ | -------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------- | -------------------------------- |
| A record body in a private space     | envelope | the space key's seal key                    | `weave/record-body/v1`   | `space`, `collection`, `key` (the record's), `keyId`       | [03 §8.3](03-spaces.md)          |
| Earlier keys in `sys.key`            | envelope | the new space key's seal key                | `weave/earlier-keys/v1`  | `space`, `keyId` (the new key's)                           | [03 §9.3](03-spaces.md)          |
| A reader's note, proving it may read | envelope | the seal key behind the read key it proves  | `weave/membership/v1`    | `space`                                                    | [04 §6.3](04-network.md)         |
| A space key boxed to a member        | HPKE     | the recipient's member key                  | `weave/space-key-box/v1` | `space`, `keyId`, `to` (account DID)                       | [03 §9.4](03-spaces.md)          |
| A knock                              | HPKE     | the door key                                | `weave/knock/v1`         | `door` (the door key)                                      | [07 §6](07-doors.md)             |
| A wrap of the seed                   | envelope | a device key, or a passphrase's PBKDF2 key  | `weave/vault-wrap/v1`    | `did`, `id`, `kind`; and `salt`, `iterations` (passphrase) | §11.3                            |
| A registry value at rest             | envelope | the local key                               | `weave/at-rest/v1`       | `entry` (the storage key)                                  | [05 §15](05-sync-and-storage.md) |
| A pairing message                    | envelope | the pairing key of the direction it travels | `weave/pairing/v1`       | `type`, `seq`                                              | §15.2                            |

Conventions built on the protocol use the same two primitives: direct
messages (`weave/direct-text/v1`, `weave/direct-box/v1`), contact requests
(`weave/contact-request/v1`), and the CLI's writer keys on disk
(`weave/writer-key/v1`); see `packages/core/docs/`.

> **Known defect:** the agent link ([06 §3.2](06-nodes-and-sessions.md))
> still seals its messages with plain AES-GCM under one key for both
> directions, with neither label nor bound, and the message type unbound. A
> relay can send a message back to its sender, or as another type: it can
> make an app show an agent as connected before anyone allowed it, and end
> the offer, though no note is issued. A change that moves the link onto the
> pairing channel's pattern (a key per direction, each message bound to
> `{ type, seq }`) is planned.

_Source:_ `packages/core/src/identity/envelope.ts` (`sealEnvelope`, `openEnvelope`, `boundContext`), `packages/core/src/identity/hpke.ts` (`hpkeSeal`, `hpkeOpen`, `sealTo`, `openFrom`).
_Tests:_ `packages/core/tests/envelope.test.ts`.

---

## 10. Contact keys, member keys and door keys

P-256 key-agreement keys that others seal to with HPKE (§9.2).

### 10.1 Contact key

A P-256 **key-agreement** key that lets anyone seal a message only the account
can open, while the account is offline.

```
d_contact = ScalarFrom(HKDF(seed, "weave/p256-contact-key/v1", 48))
```

- It is not the root key (one key should not both sign and decrypt) and not a
  session key (one may last only a run, and its note an hour; a request read
  next week must still open).
- The public half, as published, is `base64url(compressed point)` — 44
  characters. A valid public contact key is a string of at most 64 characters
  that decodes to a point on P-256.
- The public half is published in the account's profile record in each space
  it writes in (`sys.profile`, field `contactKey`; [03 — Spaces](03-spaces.md)).
  The private scalar stays with the account home, and is handed only to apps
  granted contacts ([06](06-nodes-and-sessions.md)).

Example (seed of §3.3): scalar
`c030558f2c355efdec2c21246e4d422143cad65af9c28532ba1a3fc34f2e0b83`, public
`AuK878OMKr6if2UO2L9nhzisStKD5W8tYM7ldyetTMdr`.

### 10.2 Member keys

One key-agreement key per account per space, to which a private space's new
keys are sealed ([03 — Spaces](03-spaces.md), `sys.box`).

```
accountKey = HKDF(seed, "weave/account-key/v1", 32)        // §11.1
d_member   = ScalarFrom(HKDF(accountKey, "weave/p256-member-key/v1|" ‖ spaceId, 48))
```

The public half has the same encoding as the contact key. Being per space, an
account home can give an app the member keys for exactly the spaces it grants.

Example: seed of §3.3, `spaceId = "bexample"` → scalar
`d6e2d8fba5a6ad5e3e1484236c85c0313a01414bf9bc95fd44e4664946fb8a48`.

### 10.3 Door keys

One key-agreement key per **door** (an address the account hands out so that
strangers can ask to become a contact; [07 — Doors](07-doors.md)):

```
d_door = ScalarFrom(HKDF(d_contact_bytes, "weave/p256-door-key/v1|" ‖ doorId, 48))
```

where `d_contact_bytes` is the contact key's 32-byte big-endian private scalar
(§10.1). Beside it, each door has a **signing key**, used only for ECDSA:

```
d_door_sign = ScalarFrom(HKDF(d_contact_bytes, "weave/p256-door-sign-key/v1|" ‖ doorId, 48))
```

Every device and app holding the contact key derives the same door keys.
Their public halves (same encoding as the contact key) say nothing about the
account behind them.

_Source:_ `packages/core/src/identity/contact-key.ts`.
_Tests:_ `packages/core/tests/contacts.test.ts` ("the contact key"), `packages/core/tests/key-change.test.ts`, `packages/core/tests/doors.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account key, and the spaces derived from it, match the spec's examples").

---

## 11. The account vault

The seed is never stored in the clear. What is stored is an **account vault**:
the account's DID and a list of **wraps**, each an encrypted copy of the seed
openable one way. The recovery code needs no wrap.

### 11.1 The local key and the account key

Two keys are derived from the seed beside the root key, each for one job:

```
localKey   = HKDF(seed, "weave/local-key/v1", 32)      // AES-256-GCM
accountKey = HKDF(seed, "weave/account-key/v1", 32)    // 32 bytes, only ever HKDF input
```

- The **local key** seals what the account's devices keep for themselves:
  the registry at rest ([05 — Sync and storage](05-sync-and-storage.md) §15).
  It MUST NOT be handed to an app or another party; an implementation SHOULD
  hold it as a non-extractable key.
- The **account key** is the root of the member keys (§10.2) and of the
  account's own spaces ([03 — Spaces](03-spaces.md) §13.1). It is what an app
  given the whole account receives ([06](06-nodes-and-sessions.md)), and what
  a node that follows the account's registry is given.

Neither is derivable from the other, so an app holding the account key reads
none of the device's storage.

Example (seed of §3.3): local key
`26e6f39b9eeff4676d4efac5cfc6d075fb3becb6ceb13f9e03f6bc3d11d34fa9`, account key
`f9b921c105dcc1f1f13b4d643cfe961701b733d3be473c1d0e416db233c5d598`.

### 11.2 Vault format (version 1)

```json
{
  "version": 1,
  "label": "Ada",
  "did": "did:key:zDnaeaA7BcVxAiLdNP15wLvS6SC1vaQc9zpeVxrUpEC48yxkr",
  "createdAt": "2026-10-11T10:15:34.694Z",
  "wraps": [
    {
      "kind": "device",
      "id": "bgRxJ2h0XcM",
      "label": "app.example",
      "rpId": "app.example",
      "deviceKeyId": "q1w2e3r4t5y6u7i8",
      "credentialId": "AbCdEf",
      "userHandle": "Zz9",
      "addedAt": "2026-10-11T10:15:34.769Z",
      "sealed": "AUZA8LNaPI83gl2TiZd5kLY3FAPWW9nZ_L-6dwATLfTn3ApNO9Me7UNtmKS8"
    },
    {
      "kind": "passphrase",
      "id": "3FhYYIDMZJI",
      "label": "Passphrase",
      "addedAt": "2026-10-11T10:15:34.694Z",
      "salt": "9ae06Gjd9kltZrGo6jupLQ",
      "iterations": 600000,
      "sealed": "AWFF7dAydbB7LQNVyPYX5ohUGrCi-n3UnxgyuWup2zlu1qBLRwtVYQft-BBr"
    }
  ]
}
```

(The passphrase wrap above opens with `hunter2 hunter2` to the seed of §3.3.)

| Field       | Type            | Meaning                                                                                   |
| ----------- | --------------- | ----------------------------------------------------------------------------------------- |
| `version`   | `1`             | Format version                                                                            |
| `label`     | string          | Display name; never part of any key                                                       |
| `did`       | string          | The DID the seed derives. Public; lets a store recognise the account without unlocking it |
| `createdAt` | ISO 8601 string |                                                                                           |
| `wraps`     | array of wrap   | May be empty: a new account has none, and is opened by its recovery code                  |

Every wrap:

| Field     | Type                         | Meaning                                                            |
| --------- | ---------------------------- | ------------------------------------------------------------------ |
| `kind`    | `"device"` \| `"passphrase"` | How it opens                                                       |
| `id`      | string                       | base64url of 8 random bytes (11 chars); distinguishes wraps        |
| `label`   | string                       | Shown when choosing                                                |
| `addedAt` | ISO 8601 string              |                                                                    |
| `sealed`  | string                       | base64url of the envelope (§9.1) around the 16-byte seed: 45 bytes |

`device` wraps add:

| Field          | Type             | Meaning                                                                               |
| -------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `rpId`         | string           | Origin (WebAuthn relying-party id, normally the hostname) whose storage holds the key |
| `deviceKeyId`  | string           | Id of the device key (§12) that opens it                                              |
| `credentialId` | string, optional | base64url id of the passkey gating it                                                 |
| `userHandle`   | string, optional | base64url user handle of that passkey                                                 |

`passphrase` wraps add:

| Field        | Type    | Meaning                                      |
| ------------ | ------- | -------------------------------------------- |
| `salt`       | string  | base64url of 16 random bytes                 |
| `iterations` | integer | PBKDF2 rounds; at least 600 000, at most 10⁷ |

### 11.3 Wrapping and unwrapping

A wrap is an envelope (§9.1) with label `weave/vault-wrap/v1` around the seed:

- **Device wrap:** key = the device key (§12); bound =
  `{ "did": <vault did>, "id": <wrap id>, "kind": "device" }`.
- **Passphrase wrap:** key =
  `PBKDF2-HMAC-SHA256(UTF-8(NFKC(passphrase)), salt, iterations, 256 bits)`;
  bound = `{ "did", "id", "kind": "passphrase", "salt", "iterations" }`, with
  the wrap's own values.

Unwrapping:

- A reader MUST refuse a passphrase wrap whose `iterations` is not an integer
  from 600 000 to 10 000 000, before running PBKDF2.
- It MUST open the envelope with the bound built from the vault's `did` and
  the wrap's own fields, so a wrap moved from another vault, or edited (its
  `id`, `kind`, `salt` or `iterations`), does not open.
- After opening, it MUST derive the DID from the seed (§3) and refuse a seed
  whose DID is not the vault's `did`, or that is not 16 bytes.
- Any of these failing is reported as `VAULT_UNLOCK_FAILED`: the wrong key or
  passphrase looks the same as a planted wrap.

### 11.4 Managing wraps

- A vault holds at most one device wrap per `rpId`: adding one replaces any
  existing device wrap for the same `rpId`, and the replaced wraps' device keys
  SHOULD be deleted.
- Removing wraps, including the last, is allowed; the account remains openable
  by its recovery code.
- When two copies of a vault are merged, wraps are unioned by `id`, subject to
  the one-device-wrap-per-`rpId` rule.

A passphrase wrap is not tied to an origin: anything that can read the vault
can try it, and a copy of the vault can be attacked offline. Which wraps a
client offers, and how it manages passwords, are the library's: see
[Ways in](../packages/core/docs/sign-in.md#ways-in).

_Source:_ `packages/core/src/identity/account-vault.ts` (`createVault`, `wrapSeedWithDeviceKey`, `unwrapSeedWithPassphrase`, `deriveLocalKey`, `deriveAccountKey`).
_Tests:_ `packages/core/tests/account-vault.test.ts` ("a wrap from another account does not open as this one", "a passphrase wrap edited to fewer rounds, another salt or another id does not open", "the account key does not open local storage").

---

## 12. Device keys

A **device key** is a random AES-256-GCM key kept by one origin (the wrap's
`rpId`). It opens the device wrap whose `deviceKeyId` names it.

|           |                                              |
| --------- | -------------------------------------------- |
| Algorithm | AES-GCM, 256 bits                            |
| Id        | base64url of 12 random bytes (16 characters) |

- A missing device key is a normal state (other browser, cleared storage): the
  wrap is unopenable here and the account falls back to its recovery code or a
  passphrase.
- Deleting the device key makes its wrap permanently unopenable.

How a device key is kept, and what that protects against, are the library's:
see [Device keys and passkeys](../packages/core/docs/sign-in.md#device-keys-and-passkeys).

### 12.1 Staying signed in (_implementation detail_)

Not protocol: see [Staying signed in](../packages/core/docs/sign-in.md#staying-signed-in).

_Source:_ `packages/core/src/identity/device-key.ts`.
_Tests:_ `packages/core/tests/account-vault.test.ts` ("wrapping a seed").

---

## 13. Passkeys and other ways to a root key

A passkey yields no key material: it is a gate in front of a device key (§12),
enforced by the client, not by cryptography. A device wrap records the passkey
that gates it in `credentialId` and `userHandle` (§11.2).

### 13.1 Passkeys are a gate

Not protocol: see [Device keys and passkeys](../packages/core/docs/sign-in.md#device-keys-and-passkeys).

### 13.2 WebAuthn parameters

Not protocol: see [Device keys and passkeys](../packages/core/docs/sign-in.md#device-keys-and-passkeys).

---

## 14. Account stores and folder accounts

Where vaults are kept. These are local storage formats; a folder's format
matters for interoperability between apps (and origins) that open the same
folder.

### 14.1 Folder layout

```
<folder>/
  accounts.json                 list of accounts, readable without unlocking
  accounts/<id>/account.json    that account's vault (§11.2)
  accounts/<id>/stores/…        that account's spaces (05)
```

`accounts.json`:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "k3j9x0q2mz7a",
      "name": "Ada",
      "did": "did:key:zDnae…",
      "createdAt": "2026-09-26T11:47:11.062Z",
      "dataPath": "accounts/k3j9x0q2mz7a/stores",
      "lastUsedAt": "2026-09-26T12:00:00.000Z"
    }
  ]
}
```

| Field        | Type                               | Meaning                                                                                                                         |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string matching `^[a-z0-9]{1,12}$` | Account id and directory name. New ids: base64url of 8 random bytes, non-alphanumerics removed, lowercased, first 12 characters |
| `name`       | string                             | Display name                                                                                                                    |
| `did`        | string                             | Account DID                                                                                                                     |
| `createdAt`  | ISO 8601                           |                                                                                                                                 |
| `dataPath`   | string                             | Where the spaces live, relative to the folder: `accounts/<id>/stores`                                                           |
| `lastUsedAt` | ISO 8601, optional                 |                                                                                                                                 |

Rules:

- Readers MUST skip rows whose `id` fails the pattern, or whose `dataPath` is
  not `accounts/<valid id>/stores` exactly (the list is a
  plain file in a folder that may be shared; a path like `../..` is an
  attack).
- A reader keeps at most one row per DID: the most recently used
  (`lastUsedAt`, else `createdAt`).
- Writing an account replaces any row with the same `id` or the same `did`.
- Removing an account removes its row and its `accounts/<id>` directory.

The list reveals how many accounts a folder holds, their names and DIDs; not
their seeds.

### 14.2 Browser store (_implementation detail_)

Not protocol: see [Account stores](../packages/core/docs/sign-in.md#account-stores).

_Source:_ `packages/core/src/identity/account-store.ts`.
_Tests:_ `packages/core/tests/account-store.test.ts`, `packages/core/tests/account-vault.test.ts` ("the account file"), `packages/cli/tests/path-safety.test.ts`.

---

## 15. Pairing

Pairing gives a second device (typically a phone, which cannot open a folder)
the account and the list of its spaces. Afterwards the phone is a full,
independent peer; the first device is not needed again.

The QR code carries a one-time secret and nothing about the account. The two
devices meet in a room named after the secret, run an ephemeral key exchange
bound to it, and both show a six-digit code. The offering device sends the
seed only after the person confirms the codes match, sealed under a key no
other exchange shares, one for each direction. A photo of the QR code is
useless once a phone has used it or a few minutes have passed, and a recording
of the room opens nothing.

### 15.1 The ticket

```json
{ "v": 2, "secret": "AAECAwQFBgcICQoLDA0ODw", "relay": "wss://relay.example" }
```

| Field    | Type   | Meaning                                                                 |
| -------- | ------ | ----------------------------------------------------------------------- |
| `v`      | `2`    | Version                                                                 |
| `secret` | string | base64url of 16 random bytes, new for every offer                       |
| `relay`  | string | A relay URL the offering device is connected to and the phone can reach |

Encoding: `base64url(UTF-8(JSON))`, placed in a URL fragment as
`<page>#pair=<ticket>` and shown as a QR code. Readers find it with
`/[#&]pair=([^&]+)/` on the fragment. A decoder MUST reject a ticket that is
not base64url JSON, whose `v` is not `2`, whose `relay` is not a string, or
whose `secret` does not decode to exactly 16 bytes (`PAIRING_TICKET_UNREADABLE`).
Version 1 tickets carried the recovery code and MUST be refused.
The page SHOULD remove the fragment from the address bar once read.

Example (the ticket above):
`eyJ2IjoyLCJzZWNyZXQiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwicmVsYXkiOiJ3c3M6Ly9yZWxheS5leGFtcGxlIn0`

The offering device MUST generate the secret with a CSPRNG for each offer and
MUST NOT derive it from the seed.

### 15.2 Room, keys and code

Both devices join mesh room ([04 — Network](04-network.md)):

```
room = CID(UTF-8("weave/pairing-room/v1") ‖ secret)     // raw concatenation
```

Example (the secret above): room `bxvuzmmg4srdji5su7e2hyj56x55ohpyaczgg6aquq6iw55bcijha`.

Each side makes an ephemeral P-256 ECDH key for this exchange only. `O` is the
offering device's public point and `P` the phone's, each as the 65-byte
uncompressed SEC 1 point (`04 ‖ x ‖ y`). With `Z` the 32-byte ECDH shared
x-coordinate:

```
ikm        = secret ‖ Z
transcript = "|" ‖ base64url(O) ‖ "|" ‖ base64url(P)
offerKey   = HKDF(ikm, "weave/pairing-key/v1|offer" ‖ transcript, 32)   // AES-256-GCM: what the offering device sends
phoneKey   = HKDF(ikm, "weave/pairing-key/v1|phone" ‖ transcript, 32)   // AES-256-GCM: what the phone sends
code       = uint32_be(HKDF(ikm, "weave/pairing-code/v1" ‖ transcript, 4)) mod 1000000,
             as 6 decimal digits, zero-padded
commitment = base64url(SHA-256(P))
```

A point that is not 65 bytes starting `04`, or that is not on the curve, MUST
be refused (`PAIRING_TICKET_UNREADABLE`).

A sealed message is an envelope (§9.1), sent as a base64url string: under the
key of the side that sends it, with label `weave/pairing/v1` and bound
`{ "type": <the message's type>, "seq": <n> }`, where `n` counts the sealed
messages that side has sent in this exchange, from 0. A receiver keeps its own
count of what it has opened from the other side, and MUST refuse a message
that does not open with the other side's key, its own type and that count; a
refused message leaves the count as it was. So a message sent back to the side
that sealed it, presented as another type, replayed or delivered out of order
does not open.

> Rationale: the secret is in `ikm`, so anyone who never saw the QR code gets
> a different key and a different code. The points are in the labels, so a
> payload sealed in one exchange opens in no other, even one with the same
> secret. The phone commits to `P` before it sees `O`, and the offering device
> sends `O` before it sees `P`, so neither side, nor anyone between them, can
> choose a key to make two different exchanges show the same code; one guess
> in a million is all that is left. The secret is high-entropy, so a PAKE
> would add nothing an HMAC or this key schedule does not. A key per
> direction, and a count in each message, mean nobody in the room can turn
> one side's message into something the other said, or say it twice.

### 15.3 The exchange

Both devices join `room` under a throwaway `did:key` of their own, not a
session DID. The offering device joins with its configured relays; the phone
joins with exactly `[ticket.relay]`. Every message is a NetworkMessage
`{ type, from, payload }`:

```
Offering device                                       Phone
  shows QR: <link>#pair=<ticket>
  joins room                                          reads ticket, joins room via ticket.relay
            ◀─────────────── peer connected ───────────────▶
                         ◀── pair:commit  { "commit": commitment }
  pair:key { "key": base64url(O) } ──▶
                         ◀── pair:reveal  { "key": base64url(P) }
  checks SHA-256(P) against the commitment
  shows code                                          shows code
  the person confirms the codes match
  pair:handover  sealed { "seed", "spaces" } ──▶
                                                      opens, checks, signs in, joins each invite
                         ◀── pair:done    sealed { "spaces": n }
```

- **Handover plaintext:** UTF-8 JSON `{ "seed": base64url(seed), "spaces":
[<invite>, …] }`, where each invite is an invite to the space ([03 —
  Spaces](03-spaces.md)), carrying whatever a peer needs to open it, including
  a private space's key. A phone MUST refuse a handover whose `seed` does not
  decode to 16 bytes, or whose `spaces` is not an array of strings.
- **Offering device:**
  - answers the **first** `pair:commit` only. From then on the offer is spent:
    it MUST NOT answer another commit, and MUST ignore `pair:reveal` and
    `pair:done` from any other peer.
  - MUST stop answering a commit after a short time with no phone (two minutes
    in this implementation), and when the person stops the offer.
  - on `pair:reveal`, MUST check the commitment and finish with a failure if it
    does not match.
  - MUST NOT send `pair:handover` until the person has confirmed that both
    screens show the same code. If they say the codes differ, it finishes and
    sends nothing.
- **Phone:** ignores messages of other types, and answers only the first
  `pair:key`. It shows the code and waits for `pair:handover` from the peer
  that sent the key. If the payload does not open, or is not a handover, it
  finishes with a failure. It sends `pair:done` after a handover it accepts.
- A device that holds an account and opens a `#pair=` link SHOULD warn before
  taking the account on: the link can come from someone else, and the code
  check cannot tell a stranger's computer from your own.

_Source:_ `packages/core/src/identity/pairing.ts`, `packages/core/src/session/pairing.ts` (`offerToPhone`, `receiveFromDesktop`), `packages/core/src/session/auth.ts` (`acceptPairing`).
_Tests:_ `packages/core/tests/pairing.test.ts` ("a message sent back to the side that sealed it does not open there", "a message relabelled as another type does not open", "a message replayed, or delivered out of order, does not open").

---

## 16. Not yet specified

- Transport of parent tokens for multi-link delegation chains: planned in
  §7.5 ("Proof chains that travel").
- A checksum or version marker for recovery codes: planned in §2.3.
- Rotation of a compromised seed. Today an account _is_ its seed; a new seed
  is a new identity. A proposal (KERI-style pre-rotation: the identifier is
  the hash of an inception event committing to the next key, with a signed
  key event log synced like records) is issue
  [#9](https://github.com/leifriksheim/weave/issues/9). It would change
  the DID format everywhere a root appears.
