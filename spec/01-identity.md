# 01 — Identity

An account is 16 random bytes. Every key the account uses is derived from them,
so the same 16 bytes give the same identity on any device and any origin. This
part specifies the seed and its written form, every key derived from it, how
keys become DIDs, how the root key delegates to the keys that actually sign
(notes, in a JSON profile of UCAN 1.0), the two ways anything is sealed
(envelopes), how the seed is stored locked on a device, and how a second device receives an account (pairing).

```
seed (16 bytes)
 ├─ HKDF "minca/p256-identity-key/v1" ─▶ root key (P-256, ECDSA) ─▶ account DID (did:key:zDn…)
 │                                         └─ signs notes ─▶ session / app keys ─▶ sign records
 ├─ HKDF "minca/p256-contact-key/v1"  ─▶ contact key (P-256, ECDH)
 │                                         ├─ HKDF "minca/p256-door-key/v1|<door>"      ─▶ door key per door (ECDH)
 │                                         └─ HKDF "minca/p256-door-sign-key/v1|<door>" ─▶ door signing key per door (ECDSA)
 ├─ HKDF "minca/local-key/v1"        ─▶ local key (AES-256): seals this device's storage; never handed out
 └─ HKDF "minca/account-key/v1"      ─▶ account key (32 bytes): what an app given the whole account holds
                                           ├─ HKDF "minca/p256-member-key/v1|<space>" ─▶ member key per space
                                           └─ HKDF "minca/account-registry/…", "minca/contacts/…" ─▶ account spaces
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
> Tracked in [#20](https://github.com/leifriksheim/minca/issues/20).

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

Every signing or key-agreement key in Minca that is not freshly random is
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
okm = HKDF(ikm, "minca/p256-identity-key/v1", 48)
d   = ScalarFrom(okm)
```

`ikm` MUST be at least 16 uniformly random bytes. This is what
`CryptoProvider.deriveKeyPairFromSeed` does. It is used for:

| Key                                   | `ikm`                                             |
| ------------------------------------- | ------------------------------------------------- |
| **Root key** (the account identity)   | the 16-byte seed                                  |
| Space invite key ([03](03-spaces.md)) | `HKDF(inviteSecret, "minca/space-invite/v1", 32)` |
| Space read key ([03](03-spaces.md))   | `HKDF(rawSpaceKey, "minca/space-read/v1", 32)`    |

The contact key and member keys (§10) use `ScalarFrom` directly, with their own
labels, without the identity label.

**Derivation is frozen.** Changing the label, the length, or the reduction
changes every account's DID. The recorded vectors in `packages/core/tests/identity.test.ts`
MUST keep passing.

### 3.3 Example (root key)

|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| seed           | `00112233445566778899aabbccddeeff`                                                                 |
| okm (48 bytes) | `b1fc34eb5cbbdbabadec3403288c38f11ff530ad0e5e5561c1e8a36698232fdb11c563fc83da5893315f3e37cd3ed86d` |
| d              | `686fc0350a6b8c186f7b0b7856e67534000e51f22a79609256330344e73c2dee`                                 |
| Q, compressed  | `02388118d5b41d2e75aa0732d0b00606b5c1c085aaaff729fbcfc0349aa42247e2`                               |
| DID            | `did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT`                                        |

Other recorded vectors: 16 zero bytes → `did:key:zDnaenhB7GpWm1sDUA2mcNLjbZG85bD5uv8kXnX39YE9rGV3d`;
16 `0xff` bytes → `did:key:zDnaeWqjSG4BrSYadheJUx2CC9zxRM6MznQb3bMEW51WEfsxn`.

_Source:_ `packages/core/src/identity/crypto-p256.ts`, `packages/core/src/identity/identity-manager.ts` (`fromSeed`, `fromRecoveryCode`).
_Tests:_ `packages/core/tests/identity.test.ts` ("deriveKeyPairFromSeed", "derivation is frozen", "noble computes the same public point Web Crypto does").

---

## 4. DIDs (`did:key`)

Every key in Minca — root, session, app, invite, read — is named by a
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
> (`packages/core/src/identity/did.ts`, `didToPublicKey`). A non-P-256 key
> fails later, only because it does not import as a P-256 point. A
> delegation's `iss` and `aud` are checked already: a P-256 `did:key` in its
> one spelling (§7.1, `isP256Did` in `packages/core/src/identity/ucan.ts`). A
> fix will reject any other multicodec when decoding.
> Tracked in [#20](https://github.com/leifriksheim/minca/issues/20).

> **Planned: one spelling per key.** Decoders will require the `0x80 0x24`
> prefix **and** exactly 33 compressed bytes, refusing the uncompressed form.
> Then a key has exactly one DID, and two DIDs never name the same key (which
> matters wherever DIDs are compared as strings: roots, `createdBy`, members).
> This fixes the known defect above.

Example: see §3.3; the decoded bytes are
`802402388118d5b41d2e75aa0732d0b00606b5c1c085aaaff729fbcfc0349aa42247e2`. The
did:key specification's own P-256 example,
`did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169`, round-trips.

Public keys elsewhere in Minca that are not DIDs (the contact key, member keys)
are the 33-byte compressed point, base64url.

_Source:_ `packages/core/src/identity/did.ts`, `packages/core/src/identity/crypto-p256.ts` (`exportPublicKey`, `importPublicKey`).
_Tests:_ `packages/core/tests/identity.test.ts` ("did:key", "reads the did:key specification's P-256 example").

---

## 5. Derivation labels

Every label under which bytes are derived anywhere in `packages/core/src/`. No two
_purposes_ share a label, but see the notes below the table. Parts other than
this one own the use; this table is the registry.

| Label (UTF-8)                            | Mechanism                                 | Input                                                                                            | Output                     | Used for                                                                | Defined in                          | Part   |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------- | ----------------------------------- | ------ |
| `minca/p256-identity-key/v1`             | HKDF, L=48 → `ScalarFrom`                 | seed; or any `ikm` in §3.2's table                                                               | P-256 scalar               | Root key; second stage of invite and read keys                          | `identity/crypto-p256.ts:11`        | 01     |
| `minca/p256-contact-key/v1`              | HKDF, L=48 → `ScalarFrom`                 | seed                                                                                             | P-256 scalar (ECDH)        | Contact key                                                             | `identity/contact-key.ts:26`        | 01     |
| `minca/p256-member-key/v1\|<spaceId>`    | HKDF, L=48 → `ScalarFrom`                 | account key                                                                                      | P-256 scalar (ECDH)        | Member key for one space                                                | `identity/contact-key.ts:27`        | 01, 03 |
| `minca/p256-door-key/v1\|<doorId>`       | HKDF, L=48 → `ScalarFrom`                 | contact key's 32-byte private scalar                                                             | P-256 scalar (ECDH)        | Door key (knocks are sealed to it)                                      | `identity/contact-key.ts:28`        | 01, 07 |
| `minca/p256-door-sign-key/v1\|<doorId>`  | HKDF, L=48 → `ScalarFrom`                 | contact key's 32-byte private scalar                                                             | P-256 scalar (ECDSA)       | Door signing key (proves ownership of a door)                           | `identity/contact-key.ts:29`        | 01, 07 |
| `minca/door-topic/v1\|<signKey>`         | SHA-256, base64url                        | —                                                                                                | mailbox topic              | A door's mailbox topic on a relay: a hash of its signing key            | `doors/doors.ts` (`doorTopic`)      | 07     |
| `minca/local-key/v1`                     | HKDF, L=32                                | seed                                                                                             | AES-256-GCM key            | Local key: this device's storage (§11.1)                                | `identity/account-vault.ts:29`      | 01, 05 |
| `minca/account-key/v1`                   | HKDF, L=32                                | seed                                                                                             | 32 bytes                   | Account key: root of member keys and account spaces (§11.1)             | `identity/account-vault.ts:30`      | 01, 06 |
| `minca/pairing-room/v1`                  | CID of prefix ‖ secret (no separator)     | 16-byte pairing secret                                                                           | room id                    | Pairing room                                                            | `identity/channel.ts:39`            | 01     |
| `minca/pairing-key/v1\|<side>\|<O>\|<J>` | HKDF, L=32                                | pairing secret ‖ ECDH shared x                                                                   | AES-256-GCM key            | Pairing messages sent by `<side>` (`offer` or `join`)                   | `identity/channel.ts:40`            | 01     |
| `minca/pairing-code/v1\|<O>\|<J>`        | HKDF, L=4 → uint32 mod 10⁶                | pairing secret ‖ ECDH shared x                                                                   | 6-digit code               | Code both screens show                                                  | `identity/pairing.ts:18`            | 01     |
| `minca/code-room/v1`                     | CID of prefix ‖ secret (no separator)     | 16-byte connect-code secret                                                                      | room id                    | Room for connecting by code                                             | `identity/channel.ts:46`            | 06     |
| `minca/code-key/v1\|<side>\|<O>\|<J>`    | HKDF, L=32                                | connect-code secret ‖ ECDH shared x                                                              | AES-256-GCM key            | Connect-by-code messages sent by `<side>`                               | `identity/channel.ts:47`            | 06     |
| `minca/code-account/v1`                  | SHA-256 of prefix ‖ input, first 8 bytes  | UTF-8 account DID                                                                                | account fingerprint        | The account a connect code names                                        | `session/connect-code.ts:27`        | 06     |
| `minca/space-invite/v1`                  | HKDF, L=32 → `P256KeyFrom`                | 32-byte invite secret                                                                            | P-256 key                  | Invite key                                                              | `space/space-access.ts:28`          | 03     |
| `minca/invite-link/v1\|secret`           | HKDF, L=32                                | 16-byte short link secret                                                                        | 32-byte invite secret      | A short link's invite secret, which the invite key is derived from      | `space/invite-link.ts:177`          | 03     |
| `minca/invite-link/v1\|seal`             | HKDF, L=32                                | 16-byte short link secret                                                                        | AES-256-GCM key            | The sealed invite a short link names                                    | `space/invite-link.ts:166`          | 03     |
| `minca/invite-topic/v1\|<pin>`           | SHA-256, base64url                        | —                                                                                                | mailbox topic              | A short link's mailbox topic: a hash of its pin, which no key hashes to | `space/invite-link.ts:148`          | 03     |
| `minca/space-read/v1`                    | HKDF, L=32 → `P256KeyFrom`                | space key K                                                                                      | P-256 key                  | Read key of a private space                                             | `space/space-access.ts:27`          | 03     |
| `minca/space-seal/v1`                    | HKDF, L=32                                | space key K                                                                                      | AES-256-GCM key            | Every envelope under a space key                                        | `privacy/space-encryption.ts:15`    | 03     |
| `minca/space-key-id/v1`                  | HKDF, L=16, base64url                     | space key K                                                                                      | key id (22 characters)     | A space key's id                                                        | `privacy/space-encryption.ts:16`    | 03     |
| `minca/account-registry/nonce/v1`        | HKDF, L=32, first 12 bytes, base64url     | account key                                                                                      | space nonce                | Account registry space                                                  | `space/account-registry.ts:85,127`  | 03     |
| `minca/account-registry/key/v1`          | HKDF, L=32                                | account key                                                                                      | space key K                | Account registry space                                                  | `space/account-registry.ts:85,130`  | 03     |
| `minca/contacts/nonce/v1`                | as above                                  | account key                                                                                      | space nonce                | Contacts space                                                          | `space/account-registry.ts:98,127`  | 03     |
| `minca/contacts/key/v1`                  | as above                                  | account key                                                                                      | space key K                | Contacts space                                                          | `space/account-registry.ts:98,130`  | 03     |
| `minca/carry/nonce/v1\|<did>\|<gen>`     | as above                                  | account key                                                                                      | space nonce                | A carrier's carry space                                                 | `space/account-registry.ts:114,127` | 03, 06 |
| `minca/carry/key/v1\|<did>\|<gen>`       | as above                                  | account key                                                                                      | space key K                | A carrier's carry space                                                 | `space/account-registry.ts:114,130` | 03, 06 |
| `minca/topic-tags/v1`                    | HKDF → HMAC-SHA256 key                    | space key K (private) or the bytes of `minca/public-topics/v1\|<spaceId>` (public)               | HMAC key                   | Topic tags                                                              | `records/topics.ts:80,87`           | 02     |
| `minca/one-per/v1`                       | HKDF → HMAC-SHA256 key                    | the space's first key K₀ (private) or the bytes of `minca/public-one-per/v1\|<spaceId>` (public) | HMAC key                   | `onePer` record keys                                                    | `records/rules.ts:78,81`            | 02     |
| `minca/record-owner/v1\|<root>`          | SHA-256, first 16 bytes, base32 lowercase | —                                                                                                | owner part (26 characters) | The owner part of an owned record key                                   | `records/key.ts:54`                 | 02     |
| `minca-room/v1\|<spaceId>`               | SHA-256, first 20 bytes, base32 lowercase | —                                                                                                | relay room name            | A space's room on a relay                                               | `node/space-runtime.ts:304`         | 04     |

Labels of sealed things: every envelope and every HPKE seal (§9) names one,
with the fields of its `bound`. _docs_ marks a label used by a convention
built on the protocol (`packages/core/docs/`), not by it; _CLI_ one only the
CLI's own node reads:

| Label                      | Primitive | `bound`                                                    | Defined in                           | Part   |
| -------------------------- | --------- | ---------------------------------------------------------- | ------------------------------------ | ------ |
| `minca/record-body/v1`     | envelope  | `space`, `collection`, `key`, `keyId`                      | `privacy/space-encryption.ts:20`     | 03     |
| `minca/earlier-keys/v1`    | envelope  | `space`, `keyId`                                           | `privacy/space-encryption.ts:22`     | 03     |
| `minca/membership/v1`      | envelope  | `space`                                                    | `privacy/space-encryption.ts:24`     | 03, 04 |
| `minca/space-key-box/v1`   | HPKE      | `space`, `keyId`, `to`                                     | `space/space-access.ts:139`          | 03     |
| `minca/vault-wrap/v1`      | envelope  | `did`, `id`, `kind`; and `salt`, `iterations` (passphrase) | `identity/account-vault.ts:32`       | 01     |
| `minca/at-rest/v1`         | envelope  | `entry`                                                    | `storage/encrypted-adapter.ts:25`    | 05     |
| `minca/pairing/v1`         | envelope  | `type`, `seq`                                              | `identity/channel.ts:41`             | 01     |
| `minca/code/v1`            | envelope  | `type`, `seq`                                              | `identity/channel.ts:48`             | 06     |
| `minca/knock/v1`           | HPKE      | `door`                                                     | `doors/doors.ts:235`                 | 07     |
| `minca/contact-request/v1` | HPKE      | `space`, `from`, `to`                                      | `node/node.ts:1986`                  | docs   |
| `minca/direct-text/v1`     | envelope  | `space`, `from`, `to`                                      | `privacy/direct.ts:37`               | docs   |
| `minca/direct-box/v1`      | HPKE      | `space`, `from`, `to`, `reader`                            | `privacy/direct.ts:39`               | docs   |
| `minca/writer-key/v1`      | envelope  | `did`, `slot`                                              | `packages/cli/src/writer-keys.ts:27` | CLI    |

A short link's sealed invite (03 §7.7) is AES-256-GCM under its own seal
key with no envelope or `bound`: one key seals one invite, and the link names
it by its hash, so it can't be taken for anything else.

Strings that separate _signed messages_ rather than derive keys, listed so
new labels do not collide with them:

| String                                                 | Kind                                                   | Defined in                                                    | Part |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- | ---- |
| `minca/space-invite/v1\|<spaceId>\|<did>`              | Message signed by an invite key                        | `space/space-access.ts:143`                                   | 03   |
| `{"audience":…,"proof":"minca/connect-key/v1",…}`      | Canonical JSON signed by a key a connect request names | `session/connect.ts:282` (`keyStatement`)                     | 06   |
| `minca/door-purge/v1\|<topic>\|<nonce>\|<ids>`         | Signed by a door signing key, checked by a relay       | `doors/doors.ts` (`purgeMessage`), `packages/relay/relay.mjs` | 07   |
| `minca/knock-answer/v1\|<space>\|<account>`            | Signed by a door signing key                           | `doors/doors.ts` (`signAnswer`)                               | docs |
| `minca-peer/v3\|client\|…`, `minca-peer/v3\|server\|…` | Signed peer-auth messages                              | `network/peer-auth.ts:198,200`                                | 04   |
| `minca-mesh/v1\|…`                                     | Signed mesh proof                                      | `network/peer-auth.ts:310`                                    | 04   |
| `minca-host/v1\n…`, `minca-host-status/v1\n…`          | Signed host requests and statuses                      | `session/hosting.ts:78,340`                                   | 08   |

Notes:

- `minca/p256-identity-key/v1` is applied to more than one kind of input: the
  seed, and (as a second stage) invite and read secrets that were first
  expanded under their own labels. The first-stage label is what separates
  them.
- `minca/space-invite/v1` is both an HKDF label and the prefix of a signed
  message. The two uses are in different primitives and do not collide, but a
  new use MUST NOT reuse either string.
- New labels SHOULD follow the `minca/<purpose>/v<N>` form. A label of a
  sealed thing names exactly one use, and no derivation label is reused as one.

---

## 6. Keys and signers

| Key                  | How made                                                        | Lifetime                                     | Signs                                   |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------- | --------------------------------------- |
| **Root key**         | `P256KeyFrom(seed)`                                             | The account's                                | Notes only (§7)                         |
| **Session key**      | A lasting P-256 key claimed under a lock, else fresh (02 §4.10) | While the device keeps it, else one node run | Records, peer-auth messages             |
| **App key**          | Fresh random P-256 key pair kept by an app or other program     | Until the program forgets it                 | Records, under a grant                  |
| **Contact key**      | `ScalarFrom(HKDF(seed, contact label, 48))`                     | The account's                                | Nothing; ECDH only (§10)                |
| **Member key**       | `ScalarFrom(HKDF(accountKey, member label, 48))`                | The account's                                | Nothing; ECDH only (§10)                |
| **Door key**         | `ScalarFrom(HKDF(contactKey, door label, 48))`                  | Until the door is closed                     | Nothing; ECDH only (§10)                |
| **Door signing key** | `ScalarFrom(HKDF(contactKey, door sign label, 48))`             | Until the door is closed                     | Purge challenges and knock answers (07) |

The root key signs exactly one kind of thing: a note (§7) delegating to another key.
It MUST NOT be used to sign records directly in normal operation. (A record
with no `proof` is judged as written by its `author` key itself — see
[02 — Records](02-records.md).)

### 6.1 Root signers

Not protocol. Where the root key lives, and the interface a node asks for
notes through, are the library's: see
[Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes).

### 6.2 The session delegation

A node signs records with a session key (§6) under a note from the root
(§7) made out to it: `aud` is the session DID, `sub` the account's DID, and
the node's proof is that token. Every record the session key signs
carries the proof as its `proof` ([02 — Records](02-records.md)). Peers
check only that the note verifies and grants what each record needs
(§7.5, §8); which command it names, how long it lasts and when it is
renewed are the node's choice
([Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes),
[06](06-nodes-and-sessions.md)).

_Source:_ `packages/core/src/node/node.ts` (`delegate`).
_Tests:_ `packages/core/tests/node.test.ts` ("records outlive the session that wrote them").

---

## 7. Delegations (UCAN 1.0, JSON profile)

A **delegation** is a signed token by which an issuer key passes some of
what it may do to an audience key. A **note** is the one kind peers accept:
a delegation from the account's root key to another key (§7.5).
Minca writes them in its own **JSON profile of UCAN 1.0**: UCAN 1.0's fields
(`iss`, `aud`, `sub`, `cmd`, `pol`, `nonce`, `meta`, `exp`, `nbf`), its
command paths and its policy language, in Minca's canonical
JSON ([02](02-records.md) §1) and signed as Minca signs everything else,
instead of DAG-CBOR with a varsig header. UCAN's chains are not used: a
note is always one link.

It is **not byte-compatible** with other UCAN tools: a Minca token can't be
handed to a UCAN library, nor a UCAN token to a Minca peer. That is
deliberate. Every other signed thing in Minca is canonical JSON with a plain
ES256 signature, and DAG-CBOR and varsig would be a second encoding, a
second hash and a dependency for one kind of token. The semantics carry over
whole, so moving to the CBOR form later is a change of encoding, not of
meaning.

Minca uses delegations, not UCAN invocations: a version, a knock or a peer
proof is what the key does, and the peer that checks it fills in the
arguments a policy reads (§8). Minca's revocation is its own, a record that
names a key ([03](03-spaces.md) §6.4); UCAN's revocation spec is not used.

### 7.1 The token

A token is a JSON object with exactly three members:

```
token        = { "payload": <payload>, "sig": <signature>, "type": "minca/ucan/dlg@1" }
signed bytes = UTF-8( canonicalJSON( { "payload": <payload>, "type": "minca/ucan/dlg@1" } ) )
```

- `type` names the profile and the kind of token, as UCAN's envelope tag
  does. A peer MUST refuse any other value.
- `sig` is ECDSA P-256 / SHA-256 by the issuer's key over the signed bytes:
  64 bytes `r ‖ s` (IEEE P1363), base64url without padding, so exactly 86
  characters. `s` MUST be in the **low-S** form, `s ≤ n/2`: an issuer
  produces only that form, and a verifier MUST refuse a signature with
  `s > n/2`. Its base64url MUST be the one spelling of its bytes (no
  padding, nothing outside the alphabet, zero trailing bits).

**Payload.** Exactly these members; a verifier MUST refuse any other.

| Field   | Type                  | Required | Meaning                                                                                                    |
| ------- | --------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `iss`   | string                | yes      | Issuer: a P-256 `did:key` (§4) in its one spelling (multicodec `p256-pub`, 33-byte key). Its key signs it. |
| `aud`   | string                | yes      | Audience: who it is made out to. For a note, a P-256 `did:key` (§7.5)                                      |
| `sub`   | string                | yes      | Subject: what it is about. The account (its DID, the issuer's), or one space, `space:<id>` (§7.2)          |
| `cmd`   | string                | yes      | The command it covers, and every command under it (§7.3)                                                   |
| `pol`   | array                 | yes      | Policy: conditions on the arguments of what it is used for (§7.4). `[]` for none                           |
| `nonce` | string                | yes      | 1–64 base64url characters. Issuers use 12 random bytes. Makes each token unique; not otherwise checked     |
| `meta`  | object                | no       | Signed, and read by no peer: a peer MUST NOT judge anything differently for what `meta` holds              |
| `exp`   | integer, Unix seconds | no       | Not valid at or after this time (§7.6). A note has one                                                     |
| `nbf`   | integer, Unix seconds | no       | Not valid before this time (§7.6). A note has one                                                          |

`exp` and `nbf` are integers from 0 to 2⁵³ − 1. `exp` is never `null`: a
token time doesn't end leaves it out. `sub` is never `null`: UCAN's
_powerline_ is not used (§7.2). A token whose canonical form is longer than
16 KiB is refused.

**The token's id** is `CID(UTF-8(canonicalJSON(token)))` (the conventions above, [02](02-records.md)
§2): signature included. Since the token is read as JSON and re-canonicalized,
and its signature has one form, a token has exactly one id.

> Rationale: a malleable signature gives a second token that verifies under
> a different id, and anything that names or counts tokens by id (a cache)
> would see two where there is one. Refusing high-S closes it at the source.

### 7.2 Subjects

| `sub`          | Meaning                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| the root's DID | **The account**: everything it may do, in every space and as a whole (a knock) |
| `space:<id>`   | **One space** of the account's. `<id>` is 1–128 of `[A-Za-z0-9._~-]`           |

A DID subject MUST be the note's issuer, the account (§7.5): UCAN 1.0's own
rule that the subject is whoever began the chain, for a chain of one. A note
for **every space** is a note about the account. UCAN's `null` subject (a
powerline) adds nothing when every note is from the account it is about, so
it is refused, keeping one spelling for each meaning.

### 7.3 Commands

A command is `/`, or one or more segments each written `/` and then one or
more of `a`–`z`, `0`–`9`, `.`, `_` and `-` (ASCII only), with no trailing
`/`, at most 256 characters: UCAN 1.0's form, narrowed to ASCII so that no
two spellings fold to the same command. As a pattern:
`^/$|^(/[a-z0-9._-]+)+$`. A command covers
itself and every command under it, by whole segments: `/record` covers
`/record/write` but not `/recordings`, and `/` covers everything.

| Command              | What it permits                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                  | Everything below                                                                                                                            |
| `/record`            | Every `/record/…` command: records, and nothing more                                                                                        |
| `/record/write`      | Write records (every version in a space needs it)                                                                                           |
| `/record/read`       | Nothing a peer checks: a note for an app given read access, which writes nothing                                                            |
| `/collection/define` | Define, change or remove a space's collections (`sys.collection`, [02](02-records.md) §6)                                                   |
| `/access/change`     | Every other change to a space's access history: role definitions, assignments, removals, invites, revocations, keys, relays, keepers, forks |
| `/account/write`     | Write in the account's own spaces, and open doors and knock ([07](07-doors.md))                                                             |

What each command permits in a space is specified in
[02 — Records](02-records.md), [03 — Spaces](03-spaces.md) and
[06](06-nodes-and-sessions.md). Which commands a version needs, with which
arguments, is §8.

### 7.4 Policies

A policy is UCAN 1.0's policy language (UCAN Delegation, "Policy"),
evaluated over canonical JSON values: a list of statements that MUST all
hold for the arguments of what the token is used for (§8).

| Statement                                             | Holds when                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `["==", sel, value]`, `["!=", sel, value]`            | The selected value is (is not) deeply equal to `value`, any JSON value                                                                           |
| `["<", sel, n]`, `["<=", …]`, `[">", …]`, `[">=", …]` | Both are numbers, and compare so; `n` MUST be a number                                                                                           |
| `["like", sel, pattern]`                              | The selected value is a string matching the glob `pattern`                                                                                       |
| `["not", stmt]`                                       | `stmt` does not hold                                                                                                                             |
| `["and", [stmt, …]]`, `["or", [stmt, …]]`             | Every (some) `stmt` holds. `and` of none holds; so does `or` of none                                                                             |
| `["all", sel, stmt]`, `["any", sel, stmt]`            | The selected value is an array, or an object (its values), and `stmt` holds for every (some) element. `all` of none holds; `any` of none doesn't |

**Selectors** are UCAN 1.0's: `.` (the arguments), `.name` (a name of
`[A-Za-z_][A-Za-z0-9_]*`), `.["any name"]` (a JSON string), `[i]` and
`[-i]` (an array element, from the end when negative), `[a:b]`, `[a:]`,
`[:b]` (an array slice, negative bounds from the end), `[]` (an array's
elements, or an object's values; what follows applies to each, and fails if
it fails for any), and `?` after a segment (null where it would fail;
repeated `?` is one). A selector starts with `.`; `..`, a trailing `.` and
anything else make it malformed. A missing member of an object is `null`;
selecting further into that `null` fails.

**Globs:** `*` matches any run of characters, including none; `\*` is a
literal `*`; every other character, a backslash before anything but `*`
included, is itself.

**When a selector fails** (it finds nothing and has no `?`), the statement
it is in has **no data**. No data never holds: `not` keeps it no data (so a
missing field can't turn `not` into a pass), `and` is false if any part is
false and otherwise no data if any part is, `or` is true if any part is true
and otherwise no data if any part is, and a policy holds only if every
statement holds. `!=` is `not ==`. A comparison of the wrong types is false,
not no data.

**A missing member is not a failure.** It reads as `null`, as in UCAN, so a
negated statement about it holds: `["!=", ".role", "admin"]` and
`["not", ["==", ".role", "admin"]]` both hold for arguments with no `role`.
Only selecting further into it fails. Where an argument may be absent, a
policy that means "only these" says what is allowed, with `==` or an `or` of
`==` statements, rather than what isn't.

A policy that is not well formed (an unknown operator, the wrong number of
arguments, a malformed selector, a non-number in an inequality, a
non-string pattern, nested more than 32 deep or holding more than 256
statements) makes its token malformed: refused (§7.1).

Peers MUST evaluate a note's policy wherever they check the note (§8). The
reference passes UCAN's published policy fixtures.

> The UCAN fixtures leave some corners open; this section fixes them: `any`
> over an empty collection is false, `not` keeps no data, and slices apply to
> arrays only. The fixture file's one malformed case is corrected in the
> copy the tests use (`packages/core/tests/vectors/ucan-policy.json`).

### 7.5 Notes

What a key does carries its **proof**: one note, a token issued by the
account's root key to that key. A record carries it in `proof`
([02](02-records.md) §3.1); a knock ([07](07-doors.md)) and a peer's proof
([04](04-network.md)) carry it the same way. It is a single JSON object,
never a list.

Given a proof, and a time `at` or none (§7.6), a verifier MUST check:

1. It is one token, a JSON object in the exact form of §7.1, signed by its
   `iss` (low S), within its time bounds at `at` (§7.6). Anything else,
   a list of tokens (a chain) included, is refused.
2. It is a **note**: `aud` is a P-256 `did:key`, and `exp` and `nbf` are
   present.
3. Its `sub`, when it is a DID, equals its `iss`.

The note is then **for** its `aud`, and **from** its `iss`: the **root**,
the account it acts for.

A note **grants** a requirement (a command, a space or the account as a
whole, and arguments; §8) iff its `cmd` covers the required command; its
`sub` is the account, or `space:<S>` where the requirement is in space `S`;
and its policy holds for the arguments.

No key below the root can extend a note. A token a session or app key
signs is a note from that key, about that key's own DID: it names no
account but the key itself, and acts for no one else.

> Rationale: one link means a key can't mint keys. A stolen session or app
> key is like a stolen session token: usable, within its note, until it is
> revoked, but it can't pass its power on to keys the account never saw, so
> revoking it ([03](03-spaces.md) §6.4) takes everything it can do, with the
> one cutoff the revoke names. With chains, a revoke would also have to
> reach every key below the revoked one, and peers would have to agree on
> what of theirs counted. A key that needs a narrower key of its own (an
> app's helper, a key per tab) asks the account for a second note.

### 7.6 Time

Which time step 1 uses depends on what the proof is relied on for:

- **A record's `proof`: no time at all.** Time bounds are not checked.
  Whether a record stands is something every peer must agree on whenever it
  looks, so no one's clock, and no time the writer claims, may decide it
  ([02 — Records](02-records.md) §9.3). A record stays valid after its note
  runs out. What ends a key's writes is a revoke of the key, with a cutoff
  at what it signed ([03 — Spaces](03-spaces.md) §6.4).
- **Anything live** (a knock, a live message, a peer's proof when it
  connects, an app checking its grant): the checking node's own clock, or,
  for a knock, the time it was signed and dropped (07). The note MUST have
  `nbf ≤ at < exp` at that `at`. These are one node's decisions in the moment, not
  verdicts peers share, so a note that has run out stops working there on
  time, with no revoke needed.

So a leaked key's live use ends when its note runs out, and its records end
when its key is revoked. Signing out writes a revoke of the session key in every space
the node writes in, its carry spaces, the contacts space and the account
registry, with a cutoff at what it wrote, and a device that kept the key
forgets it (`revokeSelf`); the revokes reach other peers as that device next
syncs. _Open:_ removing a device from another one, which
needs the list of the account's session keys
([#165](https://github.com/leifriksheim/minca/issues/165)).

### 7.7 Issuing

An issuer produces tokens of the form in §7.1, low S only; what a verifier
checks is §7.5–§7.6. The reference issuer's defaults (an hour, `nbf` set
back by five minutes for clocks that disagree, the terms a home gives an
app) are the library's: see
[Root signers and notes](../packages/core/docs/node.md#root-signers-and-notes).

### 7.8 Example

Issued by the root key of §3.3 to the did:key spec's example key: records
only, in collection `app.note`, with fixed times and nonce. The signed
bytes:

```
{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT"},"type":"minca/ucan/dlg@1"}
```

One token over them (ECDSA signatures are randomized, so `sig` differs every
time it is issued; this one is low-S):

```
{"payload":{"aud":"did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169","cmd":"/record","exp":1790000000,"iss":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT","nbf":1789996100,"nonce":"AAECAwQFBgcICQoL","pol":[["==",".collection","app.note"]],"sub":"did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT"},"sig":"HBKED5Qimk7X5F0Xd79Gcm4F64GdtYbFqyt7B-kO-ZEl8e2gD3mW07VQaVYfnngREQ5FmzHLA8tCZckpLo7QDg","type":"minca/ucan/dlg@1"}
```

Its id: `bcmmtwj62gmokzcmv4h7devlpn2fgrkwof3gj6xv3lkpefcn7x6wa`. The same
token with `s` replaced by `n − s` verifies under Web Crypto, and is
refused (§7.1).

_Source:_ `packages/core/src/identity/ucan.ts` (`issueDelegation`, `verifyDelegation`, `isCommand`, `verifyNote`, `noteCovers`), `packages/core/src/identity/policy.ts` (`evaluatePolicy`, `policyProblem`), `packages/core/src/validation/capability-gate.ts`.
_Tests:_ `packages/core/tests/ucan.test.ts` ("the example of 01 §7.8", "one token, one id: the high-S form of a signature is refused", "refuses anything but its exact shape", "commands cover what is under them", "a chain is refused, however sound its links", "a subject naming an account is only ever its issuer", "what a note grants"), `packages/core/tests/policy.test.ts` (the UCAN fixtures), `packages/core/tests/validation.test.ts` ("a note is one link", "a note's policy is checked against the version"), `packages/core/tests/space-access.test.ts` ("a key cannot pass its note on"), `packages/core/tests/attacks.test.ts`.

---

## 8. What a note lets a key do

A key may do what its note grants (§7.5), judged against what each thing
it does requires: a command, where (a space `S`, or the account as a whole),
and the **arguments** the note's policy reads. The protocol never asks
what kind of thing holds a key: a person's session, an app, any other
program and a borrowed device are told apart only by what their notes grant.
A note for `/` about the whole account acts as the account itself: that key
is one of its devices. Any narrower note is an app's, whatever holds it.

| A version in space `S`…                                                         | requires (in `S`)                            | with arguments                                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| any record                                                                      | `/record/write`                              | `{ "space": S, "collection": <its collection> }`                                           |
| and in `sys.collection`                                                         | `/collection/define`                         | `{ "space": S, "collection": C }`, `C` the collection defined: its key after `collection:` |
| and in any other collection of the access history ([03 — Spaces](03-spaces.md)) | `/access/change`                             | `{ "space": S, "collection": <its collection> }`                                           |
| and about the account itself (below)                                            | `/account/write`, for the account as a whole | `{}`                                                                                       |

A version is **about the account itself** when it is in one of the
account's own spaces (its registry, its contacts space, its carry spaces;
[06](06-nodes-and-sessions.md)), or, in any space, when it is:

- a `sys.assign` or `sys.remove` naming the account that signs it: taking or
  giving up a role, joining by invite, leaving;
- a `sys.stepdown`;
- a `sys.memberkey` or `sys.profile`: what others seal to the account, and
  what they see of it;
- a `sys.revoke` of a key other than its own author: another of the
  account's keys.

So is a knock ([07 — Doors](07-doors.md)). Each requires `/account/write`
for the account as a whole, with arguments `{}`: only a note about the
account grants it, and a policy that limits it to some spaces does not hold
there.

`space` is the space's id, without `space:`. `S` is the space the version is
judged in, never one it claims. The arguments are exactly these: a policy
that reads anything else finds `null` (a missing member) or nothing.

- A version with no `proof` was signed by its author key itself, which may
  do anything (§6).
- A peer MUST ignore a change to the access history whose proof does not
  grant what it requires: it is not an event in the history, whatever the
  writer's roles ([03 — Spaces](03-spaces.md)). Any other version about the
  account itself whose proof lacks `/account/write` for the account as a
  whole MUST NOT count. Before v1 this applies to what is already stored:
  a member key, profile, joining or leaving an app wrote under a narrower
  note stops counting, and a device of the account publishes the account's
  own again when it next opens the space.

A person's own sessions, and apps granted write, get `/` about the account.
A key the account trusts less gets `/record` (a request for records only,
[06](06-nodes-and-sessions.md) §2.4): it writes records, and proposes
anything more for someone who may to apply
([blueprints and guides](../packages/core/docs/blueprints-and-guides.md)).
A note for one space is about that space (`sub: "space:<id>"`); a note for
several is about the account, with a policy naming them:
`[["or", [["==", ".space", "<id>"], …]]]`. Policies on `.collection` narrow
a note to some collections; reading stays a matter of keys
([03 — Spaces](03-spaces.md)), which a note doesn't narrow. An action about
the account as a whole (a knock, the account's own spaces) carries no
`space` argument, so `.space` reads as null there: a policy that only
excludes spaces (`["not", ["==", ".space", "<id>"]]`) holds for it. To keep
a note to some spaces, name them, as above.

A key whose note grants `/access/change` in a space with no policy on
`.collection` changes there what its account may do to others: roles,
members, invites, the space's key, relays and keepers, and a successor
(`sys.succeed`, [03](03-spaces.md) §2.5, §2.7). Its account's own place it
leaves alone unless the note is about the whole account: an app given a
space never makes the account leave or step down, never gives up its roles,
never puts a key of its own where others seal to the account, and never
revokes the account's other keys. A home that gives an app the access
command, and wants less, names the collections it may change.

> Rationale: one rule, not a command per act. Whether a key may act as the
> account is what a note about the whole account already says, so the same
> check guards the account's own spaces, its doors and its place in every
> space, and a home tells a device from an app by the note it gives.

A note carries no fact a peer reads. A peer MUST NOT judge a version, a live
message or a knock differently for anything in `meta`: what the key may do is
what the proof grants.

> Rationale: earlier, the protocol marked one kind of program with a fact,
> first refusing changes from a note that carried it and later only showing
> it as a label. Either way it tied the protocol to one kind of key. Commands
> and policies say what matters in what UCAN already has, and serve any key
> the account trusts less, a person's too.

> Rationale for one command and a policy, not a set of delegations: every
> note a home gives names one command, across one space, several or all of
> them. One subject covers one space or all; a policy on `.space` covers
> several. So one token per version, and one requirement checked against it,
> keep everything notes granted before.

_Source:_ `packages/core/src/identity/abilities.ts` (`writeRequirement`, `accessRequirement`, `ACCOUNT_REQUIREMENT`, `actsForAccount`, `noteGrants`, `noteTerms`), `packages/core/src/node/space-runtime.ts` (`aboutItself`, `buildEvent`, `judgeStanding`, `write`), `packages/core/src/doors/doors.ts` (`openKnock`), `packages/core/src/session/connect.ts` (`grantTerms`).
_Tests:_ `packages/core/tests/records-only.test.ts` ("what counts is what the note grants", "a note's policy is checked by every peer", "a definition signed by hand under a records-only note is ignored by every peer", "taking someone out of the space, under a records-only note, is ignored too", "an app given a space never changes the account's own place there: every peer ignores it", "the same change under a note about the whole account counts: that key is one of the account’s devices", "in the account's own spaces, a version under a records-only note does not stand"), `packages/core/tests/connect.test.ts` ("it lists them and opens requests sent to the account, and sees no other space"), `packages/core/tests/doors.test.ts` ("needs a note that grants /account/write: …").

---

## 9. Envelopes

Everything Minca encrypts is sealed one of two ways: under a symmetric key,
as an **envelope** (§9.1), or to a P-256 public key, with **HPKE** (§9.2).
Each use names a **label** and a **bound**: the label says what the sealed
thing is, the bound says where it belongs. Both are authenticated, so a
sealed thing opens only for the use and the place it was sealed for: moved to
another record, another space, another account or another slot, or presented
as something else, it does not open.

- A **label** is a constant string `minca/<purpose>/v1`, listed in §5 with its
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
| label     | `minca/record-body/v1`                                                                                                                |
| bound     | `{"space":"bexample","collection":"app.note","key":"k1","keyId":"bgk-m-Kq-gEGgJCOOEYNYw"}`                                            |
| aad       | `0x01` ‖ `minca/record-body/v1` ‖ `0x00` ‖ `{"collection":"app.note","key":"k1","keyId":"bgk-m-Kq-gEGgJCOOEYNYw","space":"bexample"}` |
| nonce     | `a0a1…ab`                                                                                                                             |
| plaintext | `{"body":{"text":"hi"}}`                                                                                                              |
| envelope  | `01a0a1a2a3a4a5a6a7a8a9aaab9d3a1e4221b220851947f3b67f0ee2e452c43032efca1438efe7c1526e9fe84d7b4aafc5653a`                              |

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

| Use                                  | Sealed   | Key                                         | Label                    | `bound`                                                    | Where                             |
| ------------------------------------ | -------- | ------------------------------------------- | ------------------------ | ---------------------------------------------------------- | --------------------------------- |
| A record body in a private space     | envelope | the space key's seal key                    | `minca/record-body/v1`   | `space`, `collection`, `key` (the record's), `keyId`       | [03 §8.3](03-spaces.md)           |
| Earlier keys in `sys.key`            | envelope | the new space key's seal key                | `minca/earlier-keys/v1`  | `space`, `keyId` (the new key's)                           | [03 §9.3](03-spaces.md)           |
| A reader's note, proving it may read | envelope | the seal key behind the read key it proves  | `minca/membership/v1`    | `space`                                                    | [04 §6.3](04-network.md)          |
| A space key boxed to a member        | HPKE     | the recipient's member key                  | `minca/space-key-box/v1` | `space`, `keyId`, `to` (account DID)                       | [03 §9.4](03-spaces.md)           |
| A knock                              | HPKE     | the door key                                | `minca/knock/v1`         | `door` (the door key)                                      | [07 §6](07-doors.md)              |
| A wrap of the seed                   | envelope | a device key, or a passphrase's PBKDF2 key  | `minca/vault-wrap/v1`    | `did`, `id`, `kind`; and `salt`, `iterations` (passphrase) | §11.3                             |
| A registry value at rest             | envelope | the local key                               | `minca/at-rest/v1`       | `entry` (the storage key)                                  | [05 §15](05-sync-and-storage.md)  |
| A pairing message                    | envelope | the pairing key of the direction it travels | `minca/pairing/v1`       | `type`, `seq`                                              | §15.2                             |
| A connect-by-code message            | envelope | the code key of the direction it travels    | `minca/code/v1`          | `type`, `seq`                                              | [06 §3](06-nodes-and-sessions.md) |

Conventions built on the protocol use the same two primitives: direct
messages (`minca/direct-text/v1`, `minca/direct-box/v1`), contact requests
(`minca/contact-request/v1`), and the CLI's writer keys on disk
(`minca/writer-key/v1`); see `packages/core/docs/`.

_Source:_ `packages/core/src/identity/envelope.ts` (`sealEnvelope`, `openEnvelope`, `boundContext`), `packages/core/src/identity/hpke.ts` (`hpkeSeal`, `hpkeOpen`, `sealTo`, `openFrom`).
_Tests:_ `packages/core/tests/envelope.test.ts`.

---

## 10. Contact keys, member keys and door keys

P-256 key-agreement keys that others seal to with HPKE (§9.2).

### 10.1 Contact key

A P-256 **key-agreement** key that lets anyone seal a message only the account
can open, while the account is offline.

```
d_contact = ScalarFrom(HKDF(seed, "minca/p256-contact-key/v1", 48))
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
`1d513eb757cd656fa9aee6e6f54a0506965be5279c281ae9520601bece578201`, public
`AwFM-6h0Js6WTFMPqM9EDDkDHknhhgfst2aD-fROgWoV`.

### 10.2 Member keys

One key-agreement key per account per space, to which a private space's new
keys are sealed ([03 — Spaces](03-spaces.md), `sys.box`).

```
accountKey = HKDF(seed, "minca/account-key/v1", 32)        // §11.1
d_member   = ScalarFrom(HKDF(accountKey, "minca/p256-member-key/v1|" ‖ spaceId, 48))
```

The public half has the same encoding as the contact key. Being per space, an
account home can give an app the member keys for exactly the spaces it grants.

Example: seed of §3.3, `spaceId = "bexample"` → scalar
`692597e89fbbfd804d1b090c1a02219cc869a4151860a427c724b5e397c1121a`.

### 10.3 Door keys

One key-agreement key per **door** (an address the account hands out so that
strangers can ask to become a contact; [07 — Doors](07-doors.md)):

```
d_door = ScalarFrom(HKDF(d_contact_bytes, "minca/p256-door-key/v1|" ‖ doorId, 48))
```

where `d_contact_bytes` is the contact key's 32-byte big-endian private scalar
(§10.1). Beside it, each door has a **signing key**, used only for ECDSA:

```
d_door_sign = ScalarFrom(HKDF(d_contact_bytes, "minca/p256-door-sign-key/v1|" ‖ doorId, 48))
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
localKey   = HKDF(seed, "minca/local-key/v1", 32)      // AES-256-GCM
accountKey = HKDF(seed, "minca/account-key/v1", 32)    // 32 bytes, only ever HKDF input
```

- The **local key** seals what the account's devices keep for themselves:
  the registry at rest ([05 — Sync and storage](05-sync-and-storage.md) §15).
  It MUST NOT be handed to an app or another party; an implementation SHOULD
  hold it as a non-extractable key.
- The **account key** is the root of the member keys (§10.2) and of the
  account's own spaces ([03 — Spaces](03-spaces.md) §13.1). It is what an app
  given the whole account receives ([06](06-nodes-and-sessions.md)), and what
  a node that follows the account's registry is given.

Neither is derivable from the other, but that keeps less from an app holding
the account key than it may seem. The account key opens the account's own
spaces (03 §13.1), whose versions a folder stores unsealed like any space's,
and their `sys.joined` records carry the key of every private space the
registry lists. What the local key alone keeps from such an app is the
sealed entries of the registry store ([05](05-sync-and-storage.md) §15) that
nothing else carries: invite secrets waiting to be used (`spaceinvite:`) and
the CLI's writer keys.

Example (seed of §3.3): local key
`4b41df023aa99109c19c859f1228674a607d3d5cdfc10f2d748d582636ab9a3d`, account key
`9d1e01f2d4be2c948e921ac2604087a0b1448422b20d64f88e60f63238e87c9b`.

### 11.2 Vault format (version 1)

```json
{
  "version": 1,
  "label": "Ada",
  "did": "did:key:zDnaeUEY3vrNH2aBdwvsv4qvZpDJ2qHm3Z6UFkorqWJw3CmZT",
  "createdAt": "2026-10-13T19:44:45.107Z",
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
      "id": "w09cUHjZC7k",
      "label": "Passphrase",
      "addedAt": "2026-10-13T19:44:45.107Z",
      "salt": "uSTGCMafmVGh1iPTcEQ2RA",
      "iterations": 600000,
      "sealed": "ASKGZ7foaMlbiCtMDmgwKfGzVX8nQwaEGmMnIZ6IoIObeD1jqU_MmXEvZdau"
    }
  ]
}
```

(The passphrase wrap above opens with `hunter2 hunter2` to the seed of §3.3. The device wrap's `sealed` is illustrative: its device key is not given.)

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

A wrap is an envelope (§9.1) with label `minca/vault-wrap/v1` around the seed:

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
_Tests:_ `packages/core/tests/account-vault.test.ts` ("a wrap from another account does not open as this one", "a passphrase wrap edited to fewer rounds, another salt or another id does not open", "the account key does not open the registry store's sealed entries").

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
  accounts/<id>/stores/…        that account's registry and spaces (05 §14)
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

### 15.2 The channel

Pairing runs on a **channel**: two programs that share a one-time secret and
nothing else meet in a room named after it, swap ephemeral keys, and seal
every later message to each other. Connecting a program by code runs on the
same channel with its own labels ([06 — Nodes, sessions and apps](06-nodes-and-sessions.md) §3).
Each use names a **kind**, three labels:

| Kind            | `room`                  | `key`                  | `message`          |
| --------------- | ----------------------- | ---------------------- | ------------------ |
| Pairing         | `minca/pairing-room/v1` | `minca/pairing-key/v1` | `minca/pairing/v1` |
| Connect by code | `minca/code-room/v1`    | `minca/code-key/v1`    | `minca/code/v1`    |

The side that made the secret and shows it is `offer`; the side that joins
with it is `join`. Both join mesh room ([04 — Network](04-network.md)):

```
room = CID(UTF-8(room label) ‖ secret)     // raw concatenation
```

Example (pairing, the secret above): room `bha5qohdu5w35oenvib6zfdg4blcbzc4onwelk4nium6ooen6nq7q`.

Each side makes an ephemeral P-256 ECDH key for this exchange only. `O` is the
offering side's public point and `J` the joining side's, each as the 65-byte
uncompressed SEC 1 point (`04 ‖ x ‖ y`). With `Z` the 32-byte ECDH shared
x-coordinate:

```
ikm        = secret ‖ Z
transcript = "|" ‖ base64url(O) ‖ "|" ‖ base64url(J)
offerKey   = HKDF(ikm, key label ‖ "|offer" ‖ transcript, 32)   // AES-256-GCM: what the offering side sends
joinKey    = HKDF(ikm, key label ‖ "|join" ‖ transcript, 32)    // AES-256-GCM: what the joining side sends
```

A point that is not 65 bytes starting `04`, or that is not on the curve, MUST
be refused (`PAIRING_TICKET_UNREADABLE`).

A sealed message is an envelope (§9.1), sent as a base64url string: under the
key of the side that sends it, with the kind's message label and bound
`{ "type": <the message's type>, "seq": <n> }`, where `n` counts the sealed
messages that side has sent in this exchange, from 0. A receiver keeps its own
count of what it has opened from the other side, and MUST refuse a message
that does not open with the other side's key, its own type and that count; a
refused message leaves the count as it was. So a message sent back to the side
that sealed it, presented as another type, replayed or delivered out of order
does not open.

Pairing adds a short code both screens show, and a commitment:

```
code       = uint32_be(HKDF(ikm, "minca/pairing-code/v1" ‖ transcript, 4)) mod 1000000,
             as 6 decimal digits, zero-padded
commitment = base64url(SHA-256(J))
```

> Rationale: the secret is in `ikm`, so anyone who never had it gets a
> different key and a different code. `Z` is in `ikm` too, so someone who
> records the room and learns the secret later still opens nothing. The
> points are in the labels, so a payload sealed in one exchange opens in no
> other, even one with the same secret; the kind's labels keep pairing and
> connecting by code apart. In pairing the phone commits to `J` before it
> sees `O`, and the offering device sends `O` before it sees `J`, so neither
> side, nor anyone between them, can choose a key to make two different
> exchanges show the same code; one guess in a million is all that is left.
> The secret is high-entropy, so a PAKE would add nothing an HMAC or this key
> schedule does not. A key per direction, and a count in each message, mean
> nobody in the room can turn one side's message into something the other
> said, or say it twice.

### 15.3 The exchange

Both devices join the pairing room (§15.2; the phone is the joining side)
under a throwaway `did:key` of their own, not a session DID. The offering device joins with its configured relays; the phone
joins with exactly `[ticket.relay]`. Every message is a NetworkMessage
`{ type, from, payload }`:

```
Offering device                                       Phone
  shows QR: <link>#pair=<ticket>
  joins room                                          reads ticket, joins room via ticket.relay
            ◀─────────────── peer connected ───────────────▶
                         ◀── pair:commit  { "commit": commitment }
  pair:key { "key": base64url(O) } ──▶
                         ◀── pair:reveal  { "key": base64url(J) }
  checks SHA-256(J) against the commitment
  shows code                                          shows code
  the person confirms the codes match
  pair:handover  sealed { "seed", "spaces" } ──▶
                                                      opens, checks
                         ◀── pair:done    sealed { "spaces": n }
                                                      signs in, joins each invite
```

- **Handover plaintext:** UTF-8 JSON `{ "seed": base64url(seed), "spaces":
[<invite>, …] }`, where each invite is an invite to the space ([03 —
  Spaces](03-spaces.md)), carrying whatever a peer needs to open it, including
  a private space's key. A phone MUST refuse a handover whose `seed` does not
  decode to 16 bytes, or whose `spaces` is not an array of strings.
- **Offering device:**
  - answers the **first** `pair:commit` only. From then on the offer is spent:
    it MUST NOT answer another commit, and MUST ignore `pair:reveal` and
    `pair:done` from any other peer. A commit is not authenticated, so the
    relay, or anyone in the room, can spend an offer: denial of service only.
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
  finishes with a failure. It sends `pair:done`, with the number of invites
  the handover carried, once a handover opens and checks out, before it signs
  in: it says the account arrived, not that the person kept it.
- A device that holds an account and opens a `#pair=` link SHOULD warn before
  taking the account on: the link can come from someone else, and the code
  check cannot tell a stranger's computer from your own.

_Source:_ `packages/core/src/identity/channel.ts` (`deriveChannel`, `channelRoom`, `PAIRING_CHANNEL`, `CODE_CHANNEL`), `packages/core/src/identity/pairing.ts` (`pairingCode`, `pairingCommitment`), `packages/core/src/session/channel-room.ts` (`meetOnChannel`), `packages/core/src/session/pairing.ts` (`offerToPhone`, `receiveFromDesktop`), `packages/core/src/session/auth.ts` (`start`, `acceptPairing`).
_Tests:_ `packages/core/tests/take-up.test.ts` ("a pairing link opened where a sign-in is kept"), `packages/core/tests/pairing.test.ts` ("a message sent back to the side that sealed it does not open there", "a message relabelled as another type does not open", "a message replayed, or delivered out of order, does not open", "someone who learns the secret later cannot open a recording of the exchange", "pairing and connecting by code never open each other’s messages").

---

## 16. Not yet specified

- A checksum or version marker for recovery codes: planned in §2.3.
- Rotation of a compromised seed. Today an account _is_ its seed; a new seed
  is a new identity. A proposal (KERI-style pre-rotation: the identifier is
  the hash of an inception event committing to the next key, with a signed
  key event log synced like records) is issue
  [#9](https://github.com/leifriksheim/minca/issues/9). It would change
  the DID format everywhere a root appears.
