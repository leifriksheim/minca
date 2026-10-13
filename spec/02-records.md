# 02 — Records

A **record** is a signed, versioned JSON document in a **collection** of a
**space**. This part says exactly what one looks like, how it is encoded,
hashed and signed, which of its versions counts, how each key's writes in a
collection form one line (its log) and what a fork in it proves, how records
point at each other, how a space describes its collections and their rules,
and what a peer checks before it keeps one.

Out of scope here, and specified elsewhere:

- Keys, DIDs and the delegations carried in `proof`: [01 — Identity](01-identity.md).
- Roles, the access history that `seen` refers to, encrypted bodies and space keys: [03 — Spaces](03-spaces.md).
- How versions travel and how they are stored: [05 — Sync and storage](05-sync-and-storage.md).
- Not protocol, and described in the package docs instead: querying records
  ([query format](../packages/core/docs/query-format.md)), the optional standard collections
  ([standard library](../packages/core/docs/standard-library.md)), and collections
  proposed for a space and their review ([blueprints and guides](../packages/core/docs/blueprints-and-guides.md)),
  and what a version must be to count, which readers judge and no peer
  enforces: a definition's `contract` ([09 — Contracts](09-contracts.md)).

**Terms.** A _record_ is a thing in a space, named by its `key`: a message, a
task, a vote. It changes by gaining _versions_: a _version_ is one signed state
of a record, and the unit that is hashed, signed, stored and synced. A
record's current version is what an app shows. The _author_ is the key that signed a version
(usually a session key); the _root_ is the account that key acts for, found by
walking its `proof` ([01 — Identity](01-identity.md)), or the author itself when
there is no proof. A _writer_ is whatever signs with one key; its _log_ in a
collection of a space is the line of every version that key signed there
(§4.10).

---

## 1. Canonical JSON

Every hash of, and every signature over, a JSON value in Weave is over its
**canonical form**, defined here. The canonical form of a value is a string;
its bytes are that string in UTF-8.

A value is first read as the JSON data model: objects, arrays, strings, numbers
as IEEE 754 binary64, `true`, `false`, `null`. Then:

| Value            | Canonical form                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`           | `null`                                                                                                                                                                                                                                                                                                                                                         |
| `true` / `false` | `true` / `false`                                                                                                                                                                                                                                                                                                                                               |
| number           | The ECMAScript `Number::toString` form of the binary64 value: shortest round-tripping digits, `-0` → `0`, exponent form from `1e21` upward (`1.5e+21`) and below `1e-6` (`1e-7`). NaN and ±Infinity cannot occur in JSON.                                                                                                                                      |
| string           | As ECMAScript `JSON.stringify` writes it: in double quotes; `"` → `\"`, `\` → `\\`; U+0008, U+0009, U+000A, U+000C, U+000D → `\b` `\t` `\n` `\f` `\r`; other code points below U+0020 → `\u00xx` with **lower-case** hex; a lone surrogate → `\udxxx` in lower-case hex; every other character, including `/`, non-ASCII and U+2028/U+2029, written as itself. |
| array            | `[` + canonical forms of the elements, in order, separated by `,` + `]`                                                                                                                                                                                                                                                                                        |
| object           | `{` + `"name":value` pairs, separated by `,`, members sorted by name in ascending order of **UTF-16 code units**, + `}`. Names are encoded as strings (above).                                                                                                                                                                                                 |

No whitespace appears anywhere outside strings.

- A producer MUST NOT emit an object with two members of the same name. What
  a reader does with one is not specified.
- Because the form is computed from the _parsed_ value, how a value was
  formatted on the wire does not matter: `1.0`, `1` and `1e0` are the same
  number and hash the same. A reader in a language whose JSON numbers are not
  binary64 MUST convert them to binary64 before canonicalizing, or hashes will
  differ for numbers that do not survive the round trip.

For every value that is valid I-JSON (RFC 7493: no lone surrogates, no
duplicate names), this is the same output as the JSON Canonicalization Scheme,
RFC 8785 — same number form, same string escaping, same member order.

**Example.** The value

```json
{ "b": [1, "x", null, true, { "c": 1.5e21 }], "a": "é\ud800", "B": -0, "10": 1, "9": 2, "Z": 0.1 }
```

has canonical form

```
{"10":1,"9":2,"B":0,"Z":0.1,"a":"é\ud800","b":[1,"x",null,true,{"c":1.5e+21}]}
```

(`"10"` sorts before `"9"`: names compare as strings, not numbers; upper case
sorts before lower case.)

> Rationale: sorted keys and no whitespace are the smallest rule that makes two
> independent writers produce the same bytes. Reusing ECMAScript's number and
> string output means a browser gets it from `JSON.stringify` for free.

_Source: `packages/core/src/schema/version.ts` (`canonicalize`). Tests: `packages/core/tests/validation.test.ts`, `packages/core/tests/versions.test.ts` (ids and signatures depend on it throughout)._

---

## 2. Content ids

The **id** of a version, and the content id of anything else hashed the
same way (a space's genesis, a delegation in [01](01-identity.md) §7.1 and
[03](03-spaces.md)), is:

```
id = "b" ‖ lowercase( base32( SHA-256( bytes ) ) )
```

- `base32` is the RFC 4648 §6 alphabet (`A–Z2–7`), **without padding**,
  written in lower case.
- 32 bytes of digest give 52 base32 characters, so an id is always **53
  characters**: `b` followed by 52 of `[a-z2-7]`. The last character carries
  1 bit of the digest; its 4 low bits are zero.
- For a version, `bytes` is the UTF-8 of the canonical form of its signed
  part (§3.2).

A reader decoding an id back to its digest MUST refuse anything that is not
53 characters starting with `b`, contains a character outside the alphabet
(either case is accepted), or has non-zero padding bits.

The leading `b` is the multibase prefix for base32, but an id is **not** a
CIDv1: there is no version, codec or multihash prefix before the digest.

Example: `bmzr56gi5ydwuqsqjs7jsprjcn474nxscmjjljbipkkhcp5nvh37a` (the id of the
version in §3.4).

_Source: `packages/core/src/utils/hash.ts` (`cidFromBytes`, `cidDigest`, `cidOfDigest`, `base32Encode`, `base32Decode`), `packages/core/src/schema/version.ts` (`getVersionId`). Tests: `packages/core/tests/validation.test.ts` ("rejects an id that does not match the content"), `packages/core/tests/sync.test.ts`._

---

## 3. The signed version

### 3.1 Fields

A version is a JSON object with these members. Optional members are
**absent** when they do not apply — never `null`, never `false`, never an empty
list unless a list is meant (an absent member and a present one hash differently).

| Field        | Type     | Req.       | Meaning                                                                                                                                                                                                                                           |
| ------------ | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | string   | yes        | Content id of the signed part (§2). Not itself signed.                                                                                                                                                                                            |
| `author`     | string   | yes        | The `did:key` of the P-256 key that signed ([01 — Identity](01-identity.md)).                                                                                                                                                                     |
| `collection` | string   | yes        | The collection the record is in, e.g. `app.todo.item`.                                                                                                                                                                                            |
| `space`      | string   | in a space | Id of the space it belongs to. Signed, so it cannot be replayed into another space. A peer MUST refuse a version whose `space` is not the space it arrived for.                                                                                   |
| `createdAt`  | string   | yes        | ISO 8601 time the writer's clock gave, e.g. `2026-09-26T12:00:00.000Z`. Decides no ordering (§4.3) and no standing (§9.3); for display, and as a sync hint ([05](05-sync-and-storage.md)).                                                        |
| `body`       | any JSON | whole      | The content. Not itself signed: signed through `bodyHash`. Absent on a **stub** (§4.5). `null` or absent on a delete. In a private space, a sealed body `{ "sealed", "keyId" }` ([03 — Spaces](03-spaces.md) §8.3).                               |
| `bodyHash`   | string   | not delete | Content id (§2) of the canonical body. Absent on a delete.                                                                                                                                                                                        |
| `proof`      | object   | no         | The note that lets `author` write here: one token from its account ([01 — Identity](01-identity.md) §7.5), never a list. Absent when the author signs for itself.                                                                                 |
| `key`        | string   | yes        | The record's identity within the space, stable across versions (§4.1).                                                                                                                                                                            |
| `seq`        | integer  | yes        | `0` for the first version; each later version one more than the one it replaces.                                                                                                                                                                  |
| `prev`       | string   | seq > 0    | Id of the version this one replaces.                                                                                                                                                                                                              |
| `genesis`    | string   | seq > 0    | Id of the record's first version.                                                                                                                                                                                                                 |
| `retain`     | `true`   | no         | Keep this version after it is superseded (§4.5).                                                                                                                                                                                                  |
| `log`        | object   | in a space | Its place in its writer's line for its collection in this space: `{ "n", "prev"? }`. `n` counts from 0, and `prev` names the key's version one place before in that line, absent at 0 (§4.10).                                                    |
| `seen`       | string[] | no         | Ids of the latest changes to the space's access history the writer knew of; the version is judged as of those ([03 — Spaces](03-spaces.md) §3.2). At most 64, each 1–128 characters. Absent, it is judged as having seen nothing but the genesis. |
| `deleted`    | `true`   | no         | This version deletes the record; `body` MUST be `null`.                                                                                                                                                                                           |
| `links`      | Link[]   | no         | What this record points at (§5). Public spaces only; in a private space links are sealed inside the body and this member is absent.                                                                                                               |
| `tags`       | string[] | no         | Blind topic tags (§8).                                                                                                                                                                                                                            |
| `signature`  | string   | yes        | base64url (no padding) of the 64-byte ECDSA P-256 / SHA-256 signature, IEEE P1363 form (r ‖ s), over the signed part.                                                                                                                             |

A reader MUST keep and re-hash every member it receives, including ones it does
not know: the signed part is "everything except `id`, `signature` and `body`"
(§3.2), not a fixed list.

### 3.2 What is signed

The **signed part**, or **envelope**, of a version is the version with
the `id`, `signature` and `body` members removed — every other member, known
or not. The body is signed through `bodyHash`, so the envelope checks without
it, and a version can be kept, and synced, as a stub (§4.5).

```
bodyHash = "b" ‖ base32lower( SHA-256( UTF-8( canonical( body ) ) ) )     // absent on a delete
signed   = version − { id, signature, body }
payload  = UTF-8( canonical( signed ) )
id       = "b" ‖ base32lower( SHA-256( payload ) )
signature = base64url( ECDSA-P256-SHA256-sign( authorKey, payload ) )    // 64 bytes, r ‖ s
```

A stub and the whole version have the same id and the same signature.

The id does not cover the signature, and ECDSA signatures are not unique (a
signer may produce many valid signatures, and a third party can turn one valid
signature into another). So two copies with the same `id` can carry different
signatures, one valid and one not. A peer:

- MUST verify the signature of each copy it receives, not trust an id it has
  seen before;
- MUST NOT let a refused copy cause a later copy with the same id, from anyone,
  to be refused (see §9.5);
- MAY cache a _passing_ verdict under the pair (`id`, `signature`), and use it
  only for a copy whose id it has recomputed from that copy's own signed part
  (§3.3 step 1).

### 3.3 Signing and verifying

To sign: hash the body into `bodyHash` (not on a delete), build the signed
part, canonicalize it, sign the UTF-8 bytes with the author's private key,
compute the id from the same bytes, and emit `{ id, ...signed, body,
signature }`.

To verify, in this order:

1. Recompute the id from the signed part. If it differs from `id`, the
   version is invalid.
2. Resolve `author` to a P-256 public key ([01 — Identity](01-identity.md)). If
   it cannot be resolved, the version is invalid.
3. base64url-decode `signature` and verify it over the payload. If it does not
   verify, the version is invalid.
4. If `body` is present and the version is not a delete, recompute its content
   id. If it differs from `bodyHash`, the version is invalid.

Steps 1 and 4 MUST be made on every copy, before any verdict cached by
(`id`, `signature`) is applied to it, even one whose id and signature a peer
has already verified: the pair is only a name. A copy with a rewritten
envelope (another `seen`, `key` or `retain`, say) or another body can carry the
real one's id and signature, and fails step 1 or step 4. A peer MAY cache the
verdict of steps 2–3, and anything decided from a version that passed them,
as §3.2 allows. A stub (§4.5) shares its version's id and signature but not
its body: what was decided from the stub's content, or its lack of one,
never applies to the whole version ([03](03-spaces.md) §5.2).

Whether the author was _allowed_ to write is a separate question (§9.3–9.4).

### 3.4 Example

A first version of a to-do, in a public space, signed by the key derived from
the 16-byte seed `07 07 … 07` ([01 — Identity](01-identity.md)), with no
delegation, as that key's first version in the space, at a fresh key of its
own (§4.1). The body, canonical, is `{"done":false,"text":"Buy milk"}`, so
`bodyHash` is `b47jrvlapsxwsx44hipgsfbwdbupytsv4giuf4hxgoj33hiq4oubq`. Signed
part, canonical (one line in reality, wrapped here only between members):

```
{"author":"did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
"bodyHash":"b47jrvlapsxwsx44hipgsfbwdbupytsv4giuf4hxgoj33hiq4oubq",
"collection":"app.todo.item","createdAt":"2026-09-26T12:00:00.000Z",
"key":"iz75dwgy223gqtlqlqv3qzjq4y.mfrggzdfmztwq2lknnwg23tpoa",
"links":[{"rel":"about","to":"list.groceries"}],
"log":{"n":0},"seen":["b2adwpfsyvp6w5qyvo54kgtomdh4iqdg5xhrwwyva7qq54lh74gpq"],"seq":0,
"space":"bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a"}
```

The version:

```json
{
  "id": "bmzr56gi5ydwuqsqjs7jsprjcn474nxscmjjljbipkkhcp5nvh37a",
  "author": "did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ",
  "collection": "app.todo.item",
  "createdAt": "2026-09-26T12:00:00.000Z",
  "space": "bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a",
  "key": "iz75dwgy223gqtlqlqv3qzjq4y.mfrggzdfmztwq2lknnwg23tpoa",
  "seq": 0,
  "log": { "n": 0 },
  "seen": ["b2adwpfsyvp6w5qyvo54kgtomdh4iqdg5xhrwwyva7qq54lh74gpq"],
  "links": [{ "rel": "about", "to": "list.groceries" }],
  "bodyHash": "b47jrvlapsxwsx44hipgsfbwdbupytsv4giuf4hxgoj33hiq4oubq",
  "body": { "text": "Buy milk", "done": false },
  "signature": "N2adN6lob2aMxJCp5WMu9wx6pWKkSqi6sR7KW32E28qdUvou4MqeYFxxdqiE9kbEWUZxHEwfRCGKEGYEkee0cg"
}
```

Its stub is the same object without `body`. Member order on the wire is
irrelevant. The id is reproducible from the canonical text above; the
signature is not (ECDSA uses a fresh nonce), but any valid signature verifies.

_Source: `packages/core/src/types.ts` (`Version`, `UnsignedVersion`, `Envelope`, `Link`), `packages/core/src/schema/version.ts` (`createVersion`, `bodyHashOf`, `envelopeOf`, `signedPart`, `bodyProblem`, `getVersionId`), `packages/core/src/schema/signer.ts`, `packages/core/src/validation/crypto-gate.ts`, `packages/core/src/node/space-runtime.ts` (`admit`). Tests: `packages/core/tests/validation.test.ts` ("crypto gate"), `packages/core/tests/identity.test.ts` ("versions signed by an identity verify against its DID"), `packages/core/tests/links.test.ts` ("links are signed…"), `packages/core/tests/versions.test.ts` ("the example in 02 §3.4…", "the body is signed through its hash…"), `packages/core/tests/sync.test.ts` ("drops a forged version…"), `packages/core/tests/attacks.test.ts` ("a stranger sending a mangled copy first…")._

---

## 4. A record's versions

### 4.1 Keys

A record keeps one `key` for life, and links point at keys (§5), so a comment
stays on a to-do however often the to-do changes.

- A key MUST match `^[a-z0-9:._-]{1,128}$`.
- Keys are unique within a **space**, not within a collection.

**Whose a key is.** Outside the `sys.*` collections, a record's first version
(`seq 0`) MUST be at a key of one of two kinds, told apart by their form:

| Kind       | Form                                  | Who may write its first version                                                                                           |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **owned**  | `^[a-z2-7]{26}\.[a-z0-9:._-]{1,101}$` | Only the account whose owner part it starts with                                                                          |
| **shared** | `^one:[0-9a-f]{40}$`                  | Anyone the collection's rules allow, and only in a collection whose rules in force have `onePer` (§7.3) without `@author` |

An owned key is `<owner>.<name>`. Its owner part names the creator's account:

```
owner(root) = lowercase( base32( SHA-256( UTF-8( "weave/record-owner/v1|" ‖ root ) )[0..16) ) )   // 26 characters
```

`root` is the account's root DID (§9.3), whichever of its keys signs; base32
is §2's alphabet without padding.

- A **fresh** key is an owned key whose name is 16 random bytes, base32 lower
  case without padding: `<owner>.` and 26 characters of `[a-z2-7]`.
  Writers SHOULD use fresh keys unless the key is chosen or derived for a
  reason.
- A **chosen** key is an owned key whose name an app picks, for a record there
  is one of per account by nature (`settings`). Two accounts choosing one name
  get two keys.
- A **`onePer`** key is derived from the record (§7.3): an owned key named
  `one:<hex>` when the parts include `@author`, a shared key otherwise.

Example: the root `did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ`
has owner part `iz75dwgy223gqtlqlqv3qzjq4y`. Its fresh keys look like
`iz75dwgy223gqtlqlqv3qzjq4y.mfrggzdfmztwq2lknnwg23tpoa`, and the name
`settings` chosen by it is `iz75dwgy223gqtlqlqv3qzjq4y.settings`.

**Checking.** A peer MUST refuse a first version outside `sys.*` whose key is
of neither kind, or is an owned key whose owner part is not `owner(root)` of
the version's root (§9.3). This needs only the envelope and the root, so every
peer makes it, one that can't read the body or holds only a stub included. A
peer that can read the collection's definition in force (as of `seen`) MUST
also refuse a first version at a key of a `onePer` key's form, unless those
rules have a `onePer` that gives that form: a shared key only for a `onePer`
without `@author`, and an owned key whose name matches `^one:[0-9a-f]{40}$`
only for a `onePer` with `@author`. This is judged from the definition alone,
so peers that can't derive `onePer` keys (§7.3) agree; one that can't read
the definition accepts it on the other checks. Both are judged in §9.4 step 4.
Otherwise a record in another collection could take an account's `onePer`
key, and with it the `onePer` record, for good: keys are unique in a space,
and a record keeps its collection.

**Shared keys in two collections.** A shared key carries no collection in
its form, and keys are unique in a space, so a member a collection Y allows
to create (one with a `onePer` without `@author`) can write first at the
shared key a collection X derives, from Y. X's record for those parts then
can't be written: its writer would continue Y's chain (§4.2). Only someone
who can derive X's keys can aim at one, and in a private space only readers
can. A known gap; the derived key names its collection only inside the HMAC.

**Chosen names in two collections.** An account's chosen key is the same in
every collection, so an app of the account's that writes `settings` in
`app.notes` takes the key another app of the account's would use for
`settings` in `app.todo`; the second can't write its record there (§4.2).
Only the account itself, or an app it lets write, can cause this: no one
else can write at its keys. Apps SHOULD choose names that include their
collection (`app.todo.settings`), and a writer SHOULD refuse, with a clear
error, to write a record at a key whose chain it holds in another collection.

The `sys.*` collections keep the formats their parts give them (03:
`role:…`, `member:…`, `profile:…` and the rest; `collection:<name>` for a
definition, §6): the access history is judged by its replay
([03 — Spaces](03-spaces.md) §4), and readers of the others check the root
of each version they take, not who wrote first. None of those formats is of
either kind, and a peer MUST refuse a first version in a `sys.*` collection,
known or not, at an owned or shared key. Keys are unique in a space, not in a
collection (§4.3 picks one current version at a key, whatever its
collection), so otherwise anyone could write a first version at someone's key
in a collection exempt from the check, grind its id lower, and have it read in
place of theirs.

> Rationale: whose a record is must follow from something no one else can
> produce. Before keys named their owner, the first version was the `seq 0`
> with the lowest id, and a member could write one for someone else's key,
> retrying `createdAt` until its id sorted lower, and become the record's
> creator ([#72](https://github.com/leifriksheim/weave/issues/72)). An owner
> part of 128 bits can't be matched by grinding accounts. Random names rather
> than time-based, so a key says nothing about when the record was made.
> The owner part says no more than the version does: its `author` and `proof`
> name the account in the clear in every space.

_Source: `packages/core/src/records/key.ts` (`keyKind`, `onePerForm`, `ownerTag`, `ownedKey`, `newRecordKey`, `ownsKey`), `packages/core/src/node/space-runtime.ts` (`keyProblem`, `onePerKeyProblem`, `judgeStanding`, `keyToWrite`, `keepsCollection`). Tests: `packages/core/tests/record-keys.test.ts` (all), `packages/core/tests/versions.test.ts` ("a fresh key is the account's owner part…")._

### 4.2 Version fields

| Version | `seq`              | `prev`                        | `genesis`                                          |
| ------- | ------------------ | ----------------------------- | -------------------------------------------------- |
| first   | `0`                | absent                        | absent                                             |
| later   | previous `seq` + 1 | id of the version it replaces | id of the first version (for seq 1 that is `prev`) |

The next version after `current` has `key = current.key`,
`seq = current.seq + 1`, `prev = current.id`, and
`genesis = current.seq == 0 ? current.id : current.genesis`.

A writer MUST derive the next version from the version it currently holds as
current — including a delete — so re-creating a deleted key produces the
version after the delete, not a new `seq 0`.

### 4.3 Which version wins

Of two versions `a` and `b` of the same key, **`a` supersedes `b` if and only if**

```
a.seq > b.seq   or   ( a.seq == b.seq  and  a.id < b.id )
```

where `a.id < b.id` compares the id strings character by character (all ids
are ASCII, so this is also byte order). The **current version** of a record is
the one no other held version supersedes.

- Every peer MUST use exactly this rule. `createdAt` MUST NOT affect it.
- Access records are the exception: which of them takes effect is decided
  by the access history's merge ([03](03-spaces.md) §4.4), not by this rule.
- Consequences: a replayed old version loses to the current one; a delete
  (which has a higher `seq`) stays deleted when an older version turns up; two
  devices that edited apart pick the same winner; the same set of versions,
  received in any order, gives the same current version.
- A writer MUST set `prev` and `seq` as in §4.2. A reader checks them on
  arrival (§4.7), so no `seq` reaches this rule that does not follow the
  version before it.

> Rationale: no clock is trusted, because every clock is whatever its writer
> typed. The rule is load-bearing forever — two peers running different rules
> would disagree about what is current.

### 4.4 Deletes

A delete is an ordinary later version with `deleted: true` and `body: null`. It
carries no `links` and no `tags`. It is judged under the collection's `delete`
rule (§7). Writing the key again produces the next version after the delete,
judged as an **edit** (only `seq 0` is a create).

A delete forgets what the record said, as every later version does: what it
supersedes is kept only as a stub (§4.5), unless its writer retained it. A
peer that was offline, or a member who joins later, receives the stubs and the
delete, and never the content (§4.9).

### 4.5 What is kept: stubs, `retain` and history `all`

When a version is superseded, a peer keeps it:

- **whole**, if it carries `retain: true`; or
- as a **stub** otherwise: the version without its `body` member. Its id,
  signature and every other member are unchanged, so it still verifies
  (§3.3).

Nothing a peer has taken in is dropped. A stub says who wrote a version and
where it sits in its record (§4.7). A first version kept as a stub still
says who created the record (§7.1).

**The first version.** Usually a record has one `seq 0`. It may have several:
two devices of one account chose the same key, or two accounts wrote first at
a shared key (§4.1). A version's first version is always the one its own
chain names: itself at `seq 0`, else the `seq 0` its `genesis` names, which
must be of the same key and collection (§4.6) and which its chain leads to
(§4.7). Every rule that asks about a record's first version asks about that
one:

- `byCreator`, the argument grants read (§7.1), and the rules checked against a first version
  (§7.3, §7.4), when judging a version;
- `@createdBy`, and when the record was created, when reading its current
  version.

No rule picks among a key's `seq 0` versions by id. At an owned key they are
all the owner's (§4.1), so they name one creator; at a shared key each chain
has its own.

Forgetting holds whoever sends what:

- A peer that holds a version of a record MUST keep an older version of it
  that arrives only as a stub, unless it is retained.
- A peer MUST NOT send a body it does not keep.
- A peer MUST refuse, on arrival, a stub of a version that carries `retain`: a
  retained version travels whole.
- When a peer holds a stub and the whole version arrives, it keeps the whole
  version if that is current or retained.

A stub that no held version supersedes is the record's current version until
its body or a later version arrives; until then the record reads as not held.

`retain` is decided by the **writer** and signed; readers never decide it from
their own view of the definition. A writer MUST set `retain: true` when:

- the collection's definition in force says `history: "all"` (§6); or
- the collection is one of the access-history collections (`sys.role`,
  `sys.assign`, `sys.remove`, `sys.invite`, `sys.revoke`, `sys.collection`,
  `sys.key`, `sys.relays`, `sys.keepers`, `sys.fork`, `sys.stepdown`, `sys.succeed`). A peer MUST refuse a version of
  one of these without `retain` ([03 — Spaces](03-spaces.md)); or
- the version is a first version (`seq 0`) and the rules in force (§7) have
  `onePer` or `fixed`. Both are checked against the first version's body,
  which every peer must be able to read, however late it joins. A peer MUST
  refuse a `seq 0` version without `retain` when the rules in force as of its
  `seen` have `onePer` or `fixed`.
  _Implementation detail:_ the reference writer also sets `retain` on
  `sys.profile`, `sys.box`, `sys.memberkey` and `sys.carrier`, and on every
  version that is not a delete when the definition in force has a `contract` (§7.6), so
  the library's checks can read the version before and cite it. Peers do not
  require it.

A record whose versions all carry `retain` has a history that can be read as
well as checked: listed newest first by §4.3, each version's `prev` is the id
of the next one, and each verifies on its own.

> Rationale: if each reader decided from the definition it happened to have
> seen, two peers would keep different sets of versions and never converge.
> Stubs rather than nothing, so that every later version can be checked
> against the one before it (§4.7) by a peer that never saw the bodies.

_Source: `packages/core/src/storage/storage-provider.ts` (`addVersion`, `demote`, `keepSuperseded`), `packages/core/src/schema/version.ts` (`isStub`, `stubOf`), `packages/core/src/node/space-runtime.ts` (`admit`, `write`, `judgeStanding`, `currentOf`, `genesisOf`), `packages/core/src/storage/mirror.ts` (`compactNow`). Tests: `packages/core/tests/versions.test.ts` ("an older version arriving after a later one is kept only as a stub", "a stub on top takes its body…", "a retained version is never cut down to a stub", "1,000 edits keep one body…", "a newcomer after a delete…"), `packages/core/tests/rules.test.ts` ("a first version its rules are checked against must be kept whole…"), `packages/core/tests/contracts.test.ts` ("keeping versions under a check whole is the writer’s part…"), `packages/core/tests/mirror.test.ts` ("compaction…")._

### 4.6 Shape of a version, alone

A peer MUST refuse, on arrival, a version that fails any of these — all
decidable from the version alone:

1. `key` is a string matching §4.1.
2. `seq` is an integer, `0 ≤ seq ≤ 2^53 − 1`.
3. If `seq == 0`: `prev` and `genesis` are absent.
4. If `seq > 0`: `prev` and `genesis` are strings, and neither equals the
   version's own `id`.
5. `seen`, if present, is a list of at most 64 strings, each 1–128 characters.
6. `deleted`, if present, is `true`; `retain`, if present, is `true`.
7. If `deleted`: `body` is absent or `null`, and `bodyHash` is absent.
   Otherwise `bodyHash` is a string of 1–128 characters.
8. `links`, if present, is well formed (§5.1).
9. If `body` is present and the version is not a delete, it hashes to
   `bodyHash` (§3.3).
10. If `retain` is present, `body` is present unless the version is a delete.
11. If `space` is present, `log` is present. If `log` is present, it is an
    object with no members but `n` and `prev`; `n` is an integer,
    `0 ≤ n ≤ 2^53 − 1`; if `n == 0`, `prev` is absent; otherwise `prev` is a
    string of 1–128 characters other than the version's own `id` (§4.10).

Checks that depend on what else a peer holds are **not** shape checks:

- A later version must follow the version its `prev` names (§4.7). If that
  is not held yet, judging waits (§9.5).
- A later version's first version is looked up by the id in `genesis`. It
  counts only if it has `seq 0`, the same `key` and the same `collection`;
  otherwise the version is refused ("the first version it names is not this
  record's"). If it is not held yet, judging waits (§9.5).
- A first version's key must be one its root may write first (§4.1).

_Source: `packages/core/src/records/version.ts` (`newRecordKey`, `supersedes`, `byVersion`, `nextVersion`, `checkVersionShape`, `checkLogShape`, `MAX_SEEN`), `packages/core/src/records/key.ts` (`RECORD_KEY_PATTERN`), `packages/core/src/schema/version.ts` (`bodyProblem`), `packages/core/src/storage/storage-provider.ts` (`addVersion`, `demote`, `keepSuperseded`), `packages/core/src/node/space-runtime.ts` (`admit`, `firstOf`, `genesisOf`, `consistent`, `write`, `after`). Tests: `packages/core/tests/versions.test.ts` (all), `packages/core/tests/writer-logs.test.ts` ("a version in a space without its place is malformed", "a version that still carries a line across collections is refused"), `packages/core/tests/attacks.test.ts` ("a version cannot escape its record's rules by naming another record as its first")._

### 4.7 Versions whose history can be checked

A later version (`seq > 0`) MUST follow the version its `prev` names. On
arrival, a peer looks that version up, whole or as a stub (§4.5):

- If it is not held, judging waits (§9.5), and the peer asks for it
  ([05](05-sync-and-storage.md)).
- Otherwise, with `P` the version `prev` names, the version is refused unless
  all of these hold:
  1. `P.key` equals `key`;
  2. `P.collection` equals `collection`;
  3. `seq` equals `P.seq + 1`;
  4. `genesis` equals `P.id` if `P.seq == 0`, else `P.genesis`.

Every version held passed the same check when it came in, so a chain that
holds link by link reaches the first version its `genesis` names (§4.5).

Example: a record's versions `A` (`seq 0`) and `B` (`seq 1`, `prev: A`,
`genesis: A`). A version with `seq: 2, prev: B, genesis: A` follows `B`. One
with `seq: 9, prev: B` is refused (3), and so is one with `seq: 2, prev: B,
genesis: B` (4).

This closes two attacks open to any member allowed to edit:

- **Freezing a record.** Writing `seq: 2^53 − 1`, which nothing can outrank,
  since `seq + 1` is not a safe integer (§4.6).
- **Moving a record.** A later version in another `collection`, taking the
  record out of the collection its rules and readers expect it in.

A first version can't move a record either: at an owned key only its owner
writes one, and a shared key is derived from its collection (§4.1, §7.3).

The ordering rule (§4.3) does not change, but which versions reach it does.
Every edit leaves a stub of the version it replaces, a few hundred bytes,
kept and synced like any version.

_Source: `packages/core/src/records/version.ts` (`chainProblem`), `packages/core/src/node/space-runtime.ts` (`chainStanding`, `admit`), `packages/core/src/sync/sync-engine.ts` (`admit`). Tests: `packages/core/tests/versions.test.ts` ("a later version must follow the version it names…"), `packages/core/tests/attacks.test.ts` ("a member cannot freeze a record by skipping ahead…")._

A long history might later be compacted by a checkpoint, in place of its
stubs: a proposal for review is in
[drafts/stub-checkpoints.md](drafts/stub-checkpoints.md). _Open:_ who may
sign a checkpoint for a record anyone may edit.

**Related.** A writer's log (§4.10) checks a different thing: one key's line
in a collection, across records, not one record's chain. It leaves §4.3
unchanged too, and its stubs are the stubs of §4.5.

### 4.8 Planned: merging inside one record

Two devices editing different fields of one record while apart make two
versions with the same `seq`, and one wins whole (§4.3): the other edit is
lost. Field-level merging, or a text CRDT for long text, would keep both. It
is a question about bodies only: storage, sync and the ordering rule stay as
they are. Not designed.

Open questions: whether a merge is a new version any reader computes the same
way (so every peer converges on it); which `prev` a merged version names when
it has two parents (and how that meets §4.7's chain check); how merging meets
`fixed` (§7.4) and encrypted bodies.

### 4.9 Deletes and edits that forget

What §4.5 promises, and what it cannot.

Nothing can take content back from a peer that already had it. What stubs do
is make honest software forget, so that nobody who did not have the content
gets it: not a member who joins later, and not a device that was offline. A
message deleted before its recipient came online does not reach them, and
editing a record to take something out (a pasted password) leaves the
original nowhere but where it already was.

In a private space `bodyHash` covers the encryption envelope, so a stub
reveals nothing more than the version did. `links` stay in the envelope of a
public space; they name records, not content.

Retained versions keep their bodies (§4.5): in a `history: "all"`
collection, in the access history, and a first version under `onePer` or
`fixed`. A delete does not strip them.

> **Known defect:** a first version refused for its topic tags (§8.4) by a
> peer that read its body can be taken in as a stub by a peer that never did,
> and later versions built on it then count there while they wait forever at
> the first peer. Tags are the one body check a stub escapes that `retain`
> does not cover. A fix will either check tags on the version that is current,
> or carry what they are checked against in the envelope.
> Tracked in [#20](https://github.com/leifriksheim/weave/issues/20).

> **Planned: forgetting in blob stores.** Segments never change and only
> their store writer compacts them ([05 §16.4](05-sync-and-storage.md)). A
> store writer's compaction writes the stubs its store holds, but a body
> superseded by someone else stays in the bucket until that store writer
> compacts. Readers keep
> only the stub on the way in; the bytes remain. Crypto-shredding, a key per
> record destroyed on delete, would reach immutable storage too; the key
> record then has the same keep-or-drop question, so it is a later addition,
> not a replacement.

_Source: as §4.5. Tests: `packages/core/tests/versions.test.ts` ("a newcomer after a delete receives what was written, as stubs, and the delete — never the body")._

### 4.10 A writer's log

A record's versions form a chain (§4.7). A key's versions in one collection
of a space form a second line, across records: its **log** in that
collection. Every version in a space carries its place in that line as `log`
(§3.1). The key's first version in a collection of a space has `n` 0. Each
later one there has `n` one more than the key's version before it in that
collection, and names that version as `prev`. A node that holds only some
collections ([05](05-sync-and-storage.md) §5) can walk the line of each one
it holds, and know which of a writer's versions there it lacks.

Example: key K writes `a` in `app.chat`, `b` in `app.photos`, `d` in
`app.chat`. Their logs: `a` `{"n":0}`; `b` `{"n":0}`; `d`
`{"n":1,"prev":a}`.

The two lines answer different questions. A record's chain says which edit
follows which; a writer's log says what one key signed in one collection, in
order. One key writes many records, and one record is written by many keys.
The ordering rule (§4.3) is unchanged: a log never decides which version
wins. Nothing orders one key's versions across collections.

A writer:

- MUST give each version it signs in a space the next place in its line for
  that collection there, and MUST NOT sign two versions at one place in a
  line. Writes by one key in one space are made one at a time.
- MUST remember the last place it used before the version leaves it, so a
  failure after signing can never hand out the same place again. A version
  refused before it leaves gives its place back.
- MUST keep its places for as long as the key can sign. A key that outlives
  the process signing with it keeps them beside the key, in the same place
  and never anywhere that could be restored to an older copy without it. A
  key made for one run, and never stored, takes its places with it when the
  run ends.
- MUST NOT let a key that outlives its process be in two places at once. It
  is held by one writer at a time, under a lock, and is never put where
  something else could sign with it too: not in the account's data folder
  ([05](05-sync-and-storage.md) §14), not in a backup, not anything that syncs.
  A writer that can't lock a key makes one for this run instead. Where
  several processes must sign with one key (every tab of an app signs with
  the app's key, 06 §2.1), they are one writer: each takes every place under
  one lock they all share, reading the last place from the storage they all
  share, never from a copy of its own.

A device that keeps its key keeps its lines in each space for as long as it
keeps the key; one that makes a key per run has a new log each run. Both are
correct, and only the first can be checked over time.

A key used by two writers at once breaks the first rule. That is what a
**fork** shows: **two versions with the same `author`, the same `space`, the
same `collection` and the same `log.n`, with different ids, each validly
signed (§3.3)**. Either may be a stub. Nothing else is needed to check one,
so a fork proven by anyone is proven to everyone.

A writer that names the wrong version as the place before breaks the line in
the same way. That is what a **break** shows: **a version `v` whose
`log.prev` is the id of a version `p` that is another key's (`p.author ≠
v.author`), another space's or another collection's, or not one place before
(`p.log.n ≠ v.log.n − 1`), both validly signed**. It proves `v`'s key wrote a
line that isn't one, in `v.collection` from `v.log.n` on. A break is checked
and proven exactly as a fork is, and below, "fork" means either.

A peer that holds both versions of a fork SHOULD prove it to the space by
writing `sys.fork` ([03](03-spaces.md) §6.5). Once a `sys.fork` for a key's
line stands, every version that key signed in that collection of the space at
the proven place or after it is **withdrawn** (§9.5), whichever branch it is
on, as for a revoked note. Versions before that place, and the key's versions
in other collections, are untouched. When several forks of one line are
proven, the lowest place counts.

Example: key K writes `v0` (`{"n":0}`) and `v1` (`{"n":1,"prev":v0}`) in
`app.chat`. A copy of K elsewhere writes `w1` (`{"n":1,"prev":v0}`) there too.
A peer holding `v1` and `w1` writes a `sys.fork` carrying both. From then on
`v0` counts at every peer, and `v1`, `w1` and anything K signs in `app.chat`
after them do not. What K signs in `app.photos` is judged as before.

> Rationale: a fork is withdrawn on both branches because no peer can tell
> which one the key's owner wrote and which a copy of the key did. A peer
> also can't refuse the second version on arrival: peers that saw the two in
> opposite orders would keep different ones, and never agree. A proof in the
> access history, replayed the same way everywhere, gives every peer the same
> answer.

> Rationale: why every key's writes, and not every account's. An account
> writes from many devices at once, often offline, so one line per account
> would fork honestly all the time. One key is one writer, so its line can be
> kept exactly, and only a key used in two places breaks it.

> Rationale: why a line per collection, and none across them. A node holding
> part of a space can walk only the lines of the collections it holds, and a
> cutoff ([03](03-spaces.md) §6.3) names places in those lines. A line across
> collections was there to catch a copy of a key: two copies that never write
> in one collection would still have forked it. Weave does not try to catch
> copied keys. A stolen key is treated like a stolen session token: what it
> signed before the owner revoked it stands, and the revoke (03 §6.4) stops
> it from then on ([threat model](threat-model.md) §3.4). A fork is what a
> line shows when a key is used in two places, not a defence that relies on
> the copy being found.

> Rationale: a key's line does not also require each version's `seen` to
> include what the version before it had seen. It would stop one key from
> writing as of an older point in the access history, but an account can
> sign a note for a new key whenever it likes, and new keys are ordinary (a
> new device, a new tab), so a writer who wants to look behind would only
> change keys; and a device that lost its copy of the history would be
> flagged for being honest. Writing as of an older point is answered where it
> matters, whatever the key: a removal or a demotion, and a change to a
> collection's rules, each takes away what it had not seen and did not keep
> ([03](03-spaces.md) §5.1, §5.2, §6.3).

> Rationale: no Merkle roots. A log could also carry a root over all the
> writer's earlier entries, so that one entry could be proven part of it
> without the rest. Each version already carries its own signature, so a
> single record needs no proof, and a node that holds a collection holds its
> stubs (§4.5) and can walk its lines. A root would only shorten proofs, at
> the price of another field every writer must keep exactly.

_Source: `packages/core/src/records/version.ts` (`checkVersionShape`, `checkLogShape`), `packages/core/src/node/writers.ts` (`createWriters`), `packages/core/src/node/writer-keys.ts` (`browserWriterKeys`), `packages/cli/src/writer-keys.ts` (`fileWriterKeys`), `packages/core/src/records/fork.ts` (`checkFork`, `breaksLine`, `forkProof`), `packages/core/src/node/space-runtime.ts` (`write`, `placeInLog`, `reportFork`, `judgeStanding`), `packages/core/src/space/roles.ts` (`judge`, `forked`). Tests: `packages/core/tests/writer-logs.test.ts` ("a version that still carries a line across collections is refused", "a fork reaches only the line it is in…"), `packages/cli/tests/writer-keys.test.ts`, `packages/core/tests/access-convergence.test.ts`._

---

## 5. Links

A link says "this record is about that one, in a named role". The subject is
always the record carrying the link.

### 5.1 Format

```json
{ "rel": "about", "to": "mfrggzdfmztwq2lknnwg23tpoa" }
```

- `rel`: lower camel case, `^[a-z][a-zA-Z0-9]{0,63}$`.
- `to`: a record key (§4.1) — never a version id.
- No other members.
- At most **32** links per version.

A version that breaks any of these is malformed (§4.6).

Links point at keys in the same space. A link to a key not held (yet) is
normal and not an error: a reaction may arrive before its post.

**Where links live.** In a public space, links are the `links` member of the
version, signed with the rest. In a private space, `links` is absent from
the version, and the links are sealed with the body: the plaintext of the
encrypted body is `{"body": <body>, "links": [<link>…]}` (`links` left out
when there are none) — see [03 — Spaces](03-spaces.md). A reader that opens a
sealed body with malformed links treats the record as having none.

A delete carries no links.

### 5.2 Link declarations

A collection declares the link roles its records may carry, in its definition
(§6):

```json
"links": {
  "about":   { "to": ["std.poll"], "cardinality": "one", "description": "The poll voted on" },
  "replyTo": { "to": "*" }
}
```

| Member        | Type                        | Meaning                                                             |
| ------------- | --------------------------- | ------------------------------------------------------------------- |
| (name)        | —                           | The `rel`, `^[a-z][a-zA-Z0-9]{0,63}$`                               |
| `to`          | `"*"` or non-empty string[] | Collections the target may be in; `"*"` for any                     |
| `cardinality` | `"one"` \| `"many"`         | How many links of this role one record may carry. Default `"many"`. |
| `description` | string                      | Optional                                                            |

A record's links **conform** when: the collection is undefined (nothing to
check), or it is defined and every link's `rel` is declared (a defined
collection without `links` declares none), every role declared `"one"` appears
at most once, and every link whose target is held, current and not deleted
points into one of the `to` collections.

Conformance is a writer's check and a reader's flag, **never a reason to refuse
a record on arrival** (§9.6): whether a link conforms depends on which
definition and which target a peer holds. A writer SHOULD NOT write links that
do not conform.

_Source: `packages/core/src/records/links.ts` (`checkLinks`, `LINK_REL_PATTERN`, `MAX_LINKS`, `LinkDeclaration`), `packages/core/src/node/space-runtime.ts` (`openBody`, `linkIssues`, `write`). Tests: `packages/core/tests/links.test.ts` (all)._

### 5.3 Planned: references to other spaces

> **Planned.** Not normative. Issue:
> [#38](https://github.com/leifriksheim/weave/issues/38). A link points only
> within its space, but following a public space, reposting from another
> space, and a list whose items live in several spaces all point elsewhere.
> The plan is a **reference**: a string naming a space and a key, such as
> `weave:<space>/<key>`, carried in a body field rather than as a link, so
> links stay same-space and checkable against the definitions (§5.2). A
> reader resolves it only if it can read that space. _Open:_ the exact form;
> whether it may pin a version; whether a private space's id in a public
> record says too much ([03 — Spaces](03-spaces.md) §8.6).

---

## 6. Collection definitions

A space describes its collections as data, so an app or program that has never
seen the space can learn what it holds.

### 6.1 The definition record

A definition is a record in the reserved collection **`sys.collection`** with
key **`collection:<name>`** and a body in the format below. It is part of the
space's access history ([03 — Spaces](03-spaces.md)): it carries `retain: true`
and `seen`, and which definition is in force is decided by replaying that
history. In a private space its body is encrypted like any other record's.

| Field         | Type                  | Req. | Meaning                                                                                                                                                                      |
| ------------- | --------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string                | yes  | Lower case, at least one dot (local to the space, §6.4): `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`. MUST NOT start with `sys.`. The record's key MUST be `collection:` + this. |
| `title`       | string                | no   | Display name                                                                                                                                                                 |
| `description` | string                | no   | The author's words                                                                                                                                                           |
| `schema`      | object                | yes  | JSON Schema for a record's `body`, in the subset of §6.2                                                                                                                     |
| `version`     | integer ≥ 1           | yes  | Shape version (§6.3)                                                                                                                                                         |
| `history`     | `"latest"` \| `"all"` | no   | Default `"latest"`. `"all"`: writers mark every version `retain` (§4.5).                                                                                                     |
| `links`       | object                | no   | Link declarations (§5.2)                                                                                                                                                     |
| `rules`       | object                | no   | §7                                                                                                                                                                           |
| `topics`      | string[]              | no   | §8                                                                                                                                                                           |
| `contract`    | any                   | no   | What a version must be to count: `check` and `line`, judged by readers ([09](09-contracts.md)); peers keep it and don't read it, its type included (§7.6)                    |

A definition body that fails any check in this section is **invalid**. A peer
MUST treat an invalid definition as no definition at all: its collection then
has no schema, no rules and no topics. The same holds for a version of a
definition record that is a delete, or whose key does not match its `name`.
Members not listed above are ignored.

Example (the standard `std.vote`, as stored):

```json
{
  "name": "std.vote",
  "title": "Vote",
  "description": "A vote on a poll: one per person, changed by voting again.",
  "schema": {
    "type": "object",
    "properties": {
      "choice": { "type": "integer", "minimum": 0, "x-choicesFrom": { "rel": "about", "field": "options" } }
    },
    "required": ["choice"]
  },
  "version": 1,
  "links": { "about": { "to": ["std.poll"], "cardinality": "one", "description": "The poll voted on" } },
  "rules": { "onePer": ["@author", "link:about"] }
}
```

### 6.2 The schema dialect

A stored schema is JSON Schema, draft 2020-12, restricted to a fixed subset so
every app in any language agrees on what it means.

**Publishing.** A definition is valid only if its `schema`, and recursively
every schema under `properties` and `items`, uses only these keywords, with
these value types:

| Keyword                                                                | Value                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `type`                                                                 | one of, or a non-empty list of: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`                      |
| `properties`                                                           | object of schemas                                                                                                        |
| `required`                                                             | list of strings                                                                                                          |
| `items`                                                                | one schema                                                                                                               |
| `enum`                                                                 | non-empty list                                                                                                           |
| `const`                                                                | any                                                                                                                      |
| `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems` | finite number                                                                                                            |
| `additionalProperties`                                                 | boolean only                                                                                                             |
| `title`, `description`                                                 | string                                                                                                                   |
| `oneOf`                                                                | non-empty list of `{ "const": …, "title"?: string, "description"?: … }` — labelled choices only, not general composition |
| `x-choicesFrom`                                                        | `{ "rel": <link role>, "field": <non-empty string> }`                                                                    |

Anything else (`pattern`, `$ref`, `format`, `anyOf`, a schema-valued
`additionalProperties`, …) makes the definition invalid. A `$schema` member is
not part of the subset.

Whether a body fits its schema is never a reason to refuse it (§9.6), so how
a reader validates a body, and what `x-choicesFrom` means to an app, are not
protocol: see [collections](../packages/core/docs/collections.md#validating).

> **Planned: `pattern` and `format`.** Left out on purpose: every member's
> app checks every record, in whatever language, regex dialects differ, and a
> slow regex such as `^(a+)+$` in a schema could freeze every member's app.
> The plan to add them:
>
> - `pattern` accepts only **I-Regexp** (RFC 9485), the regex subset that
>   means the same in every language (as JSONPath, RFC 9535, uses): no
>   backreferences, no lookaround. A definition with nested repeats such as
>   `(a+)+` is invalid, because backtracking engines can still stall on them
>   in I-Regexp. (The alternative is a linear-time matcher, a dependency.)
> - `format` accepts only formats with exact definitions: `date-time`
>   (RFC 3339), `date`, `uri`. Not `email`.
> - Compatibility and additive changes (§6.5) treat two patterns as
>   compatible only when they are identical.
>
> Older apps ignore unknown keywords when validating
> ([collections](../packages/core/docs/collections.md#validating)), and a
> record that does not fit is still kept and flagged (§9.6), so a space using
> `pattern` stays readable by an app that predates it.
>
> _Open:_ the publishing check above makes a definition that uses `pattern`
> **invalid** to an older peer, and an invalid definition counts as none
> (§6.1), so that peer would enforce none of its rules. Either the publishing
> check must tolerate these keywords before any app writes them, or such a
> definition needs a higher protocol version that older peers recognise.
> Tracked in [#163](https://github.com/leifriksheim/weave/issues/163).

### 6.3 A definition's version number

A definition's `version` is a whole number from 1. Records do not name the
definition version they were written under; a record is judged by the
definition **in force as of the access changes it saw** (`seen`), which every
peer computes the same way ([03 — Spaces](03-spaces.md) §5.2). A narrowed rule
binds what saw it.

The definition in force for a collection is the latest change to
`collection:<name>` that counted in the access-history replay — not the one
with the highest `version`. Who may make such a change is also the replay's
question: creating a definition needs a grant of `/collection/define` for it
([03](03-spaces.md) §2.3); changing or deleting one needs that grant, or being
whoever first defined it (while still a member). Deleting a definition that
doesn't exist, as of what the delete saw, is refused. A definition counts only
under a note that grants `/collection/define` ([01 — Identity](01-identity.md)
§8), whatever the writer's roles.

**Who first defined it.** A definition's key, `collection:<name>`, is the
space's, not an account's (§4.1), so two members granted `/collection/define` can each
write a first definition without having seen the other's. Of the definitions
that counted in a state, take those that saw every removal (a delete of the
definition) the one in force saw; of those, the ones that saw none of the
others are its first definitions. If they are all one account's, that
account first defined it. If they are two accounts', **no one** did, and
only someone granted `/collection/define` for it may change or delete it. No id decides, since a
writer can grind one.

**Rival changes are not picked by id.** Where more than one change to
`collection:<name>` is latest (none saw the others), the replay picks the
lowest id only when they are one account's, or when none is a delete and all
the definitions among them name the same first definer: changes by accounts
that may each change it, the definer and those granted `/collection/define`, each of which could have
been the latest alone. Otherwise, first definitions by two accounts or a
delete beside another account's change, the collection is **contested**: the
replay picks none of them, since picking by id would let whoever ground the
lower id choose the rules, or delete it. A reader opens them all. If they are
all definitions with the same body (canonical JSON, §1), as when two members
add the same app at once, that definition is in force. Otherwise **none** is,
and a peer **MUST** refuse a version in that collection whose state as of
`seen` is contested with none in force (§9.4): no one writes in a contested
collection, and no rules does not mean anything goes. A peer that can't read
them all treats the collection as having a definition it can't read.

Rivals are settled by a change that saw them all: only someone granted
`/collection/define` for it may make it, since no one first defined the
collection; it is then in force, and names no definer, or its author when it
saw a delete (a delete starts the collection afresh). Such a delete settles
them too.

Example: Alice and Mallory are both granted `/collection/define`. Alice
defines `app.poll` (`d5`) and changes it (`d6`); Mallory writes a definition
of it naming a point before Alice's, with a lower id (`d0`). Both count, no
one first defined `app.poll`, and `d6` and `d0` are both latest, so neither is
in force, since they differ. A change that saw both, by anyone granted
`/collection/define` for it, settles it. If Mallory backdates another rival
past that, the collection is out of force again until it is settled again: a
member who may define a collection can stop it, but can't choose its rules by
grinding an id, or have records written without them. Had Mallory instead
written a delete as of before Alice's definition, it would be refused: there
was nothing to delete. A member whose role holds no grant for `app.poll`, Alice
included once hers is taken, can't write a rival at all; Alice, as its first
definer, may still change it while it is hers alone.

Two members who define a collection apart with the same body leave it in
force, but with no first definer, so from then on only those granted
`/collection/define` for it may change it. A member who may define it can do
this on purpose to take a collection's definer's control away.

Peers do not check `version` against the definition it replaces. What the
library does with it: [collections](../packages/core/docs/collections.md#versions-of-a-definition).

### 6.4 Reserved names

- **`sys.*`** belongs to the protocol. A definition MUST NOT name one. Records in
  `sys.*` collections have no schema, rules or topics from a definition; their
  formats and checks are specified where they are used:
  `sys.collection` (here); the access history, keys, profiles and the account
  registry — `sys.role`, `sys.assign`, `sys.remove`, `sys.invite`, `sys.revoke`, `sys.fork`,
  `sys.stepdown`, `sys.succeed`, `sys.key`, `sys.box`, `sys.memberkey`, `sys.relays`, `sys.keepers`,
  `sys.profile`, `sys.joined` — in [03 — Spaces](03-spaces.md); carriers,
  passes and automations — `sys.carrier`, `sys.pass`, `sys.automation`,
  `sys.wake` — in [03](03-spaces.md) §13–15, and how a node uses them
  in [06 — Nodes, sessions and apps](06-nodes-and-sessions.md) §4; hosting —
  `sys.hosting` — in [08 — Hosting](08-hosting.md)
  (`sys.relays` and `sys.keepers` also in [05](05-sync-and-storage.md)).
- **`std.*`** is **not reserved**: it names the optional
  [standard library](../packages/core/docs/standard-library.md), a
  convention. (Planned to change: §6.5.)
- Any other name is the space's to use. Records in a collection nobody has
  defined are still stored and synced; they simply have no schema or rules.

Names are **local to a space**. Nothing registers or owns a name across
spaces, so a name never says what shape a collection has; its definition in
that space does.

_Source: `packages/core/src/schema/collection-def.ts` (`StoredCollection`, `CATALOG_COLLECTION`, `checkStoredCollection`, `checkPublishableSchema`), `packages/core/src/node/space-runtime.ts` (`definitionIn`, `inForce`, `loadCatalog`), `packages/core/src/space/roles.ts` (`definition` events, `mergeDefinitions`, `definerOf`, `contested`, `refusal`). Tests: `packages/core/tests/record-keys.test.ts` ("rival first definitions by two accounts name no one…", "a backdated rival with a ground-low id does not put its rules in force", "on real nodes, rivals that differ put no rules in force; rivals that agree do", "a backdated delete of nothing, however low its id, is refused", "a ground-low delete of her own rival does not win by id…", "the definer and someone who may define it changing it apart…", "on real nodes, a ground-low backdated delete can’t take a collection from its definer"), `packages/core/tests/space-catalog.test.ts` ("but refused when publishing, where the author can fix it", "names are reverse-DNS, and sys.\* is reserved", "redefining bumps the version, and only the definer or someone who may define it may"), `packages/core/tests/attacks.test.ts` ("a member cannot take down a collection's definition they did not write")._

### 6.5 Planned: compatible definitions

> **Planned.** Not normative. Issues:
> [#11](https://github.com/leifriksheim/weave/issues/11) (content-addressed
> definitions) and [#12](https://github.com/leifriksheim/weave/issues/12)
> (definition tiers, additive-only). Today any change to a definition counts
> once the access history lets its writer make it (§6.3), and an app decides
> for itself whether a space's definition is one it can use. Whether an app
> can read and write a definition it did not write, `compare(held, wanted)`,
> is the library's, not a peer's: see
> [blueprints and guides](../packages/core/docs/blueprints-and-guides.md#compatible-definitions).
> These two plans make part of it a peer's check.
>
> - **Content-addressed definitions (#11).** A definition's id is the hash of
>   its content and never changes; a new one names `supersedes: <hash>`, and
>   `sys.collection` becomes a pointer from a name to the current hash. Each
>   record may store the hash it was written against. Today a record is
>   judged by the definition in force as of `seen`, and by narrowing changes
>   it had not seen (§6.3), and names none: a
>   writer-chosen definition was removed because a writer could name an
>   older, looser one (vote ten times under a definition from before "one
>   vote per person"). So a pin **adds** a check and never removes one: a
>   pinned record is accepted only if it is valid under the pinned definition
>   **and** under the definition in force as of `seen`.
> - **Tiers and additive-only (#12).** `std.*` frozen by the spec; publisher
>   definitions under `<did>/name`, signed by the publisher and followed
>   automatically; space definitions changed by space roles. Under one name
>   only additive changes are valid, **enforced by peers**; a breaking change
>   needs a new name (`name/2`), and may ship upgrade steps as data. Peers can
>   enforce it only on something every peer sees the same way, which the
>   `supersedes` chain of #11 provides, so #12 depends on #11, and on key
>   rotation ([#9](https://github.com/leifriksheim/weave/issues/9)), because a
>   stolen publisher key could push "additive" versions spaces pick up
>   automatically.
>
> **What "additive" means.** A new definition under the same name is additive
> when every body the old schema accepts is accepted by the new one (it does
> not **tighten**: no new required field, narrower type, smaller range or
> length, fewer `enum`/`const`/`oneOf` values, or link role that may point at
> less), and the new one accepts nothing the old one would not, except in
> fields and link roles the old one did not name (it does not **loosen**: no
> field made optional, wider type, larger range, more values, or link that
> may point at more). That leaves new optional fields, new optional link
> roles, and changes to `title`, `description` and other annotations.
> Anything else needs a new name. A keyword the check has no rule for is a
> break. Rules (`onePer`, `fixed`, `final`) and the contract are the space's
> governance, not shape: under the same name
> they may tighten, never loosen. Why this line, after oasdiff:
> [blueprints and guides](../packages/core/docs/blueprints-and-guides.md#what-additive-means).

## 7. Rules

A definition's `rules` say what must be unique, which fields are fixed, and
whether a record is written once. Every peer enforces them on every version
it receives. What a version must be to count is not a rule: it is the
definition's `contract`, which peers keep but do not enforce (§7.6).

```json
"rules": {
  "onePer": ["@author", "link:about"],
  "fixed":  ["options"]
}
```

Rules say nothing about people. **Who may write** a collection's records is
the space's grants ([03 — Spaces](03-spaces.md) §2): a version invokes
`/record/write`, or `/record/delete` for a delete, with the collection,
whether its author created the record, and (to write) its body as the
arguments, and stands only if a role its author holds grants that, as of its
`seen`. "Only its creator edits it" is a policy on `.byCreator`; "moderators
delete any" is a grant to the moderators' role. A definition with `create`,
`edit` or `delete` rules, or the `permissions` an earlier format named, is
invalid (§7.5).

> Rationale: a rule names a fact any peer can check from the record. Whether
> someone may do something is a person's decision, and lives in the space's
> roles, where it can be given and taken back.

### 7.1 Whose record it is

`byCreator`, the argument a grant's policy reads ([03](03-spaces.md) §2.3),
is whether the writer's root is the root of the version's first version, the
one its own chain names (§4.5). It is true for a first version. A fact about
the record; nobody grants it.

At an owned key (§4.1), the creator is the key's owner, whatever versions are
held and in whatever order they arrived: no one else's first version stands
there. At a shared key there is no owner. Each first version there starts a
chain of its own, and the creator is whoever wrote the first version of the
chain being edited: anyone granted `/record/write` in the collection can start
another chain at the same key, and its later versions can outrank the first
(§4.3). So in a collection whose `onePer` does not name `@author`, a grant
limited by `.byCreator` keeps others from editing your version, not from
replacing it with theirs; a collection that needs one writer per key limits
who may write it at all, or names `@author`.

### 7.2 Which rules apply

For a version of a collection that has a valid definition in force (as of its
`seen`), `final` refuses every version with `seq > 0`, deletes included
(§7.4); `onePer` and `fixed` are checked on the versions §7.3 and §7.4 say.
With no definition in force, or in a `sys.*` collection, no rules apply here
(the access collections have their own checks, in
[03 — Spaces](03-spaces.md)). In a `sys.*` collection other than the access
collections, the writer's root needs only to be a member of the space as of
`seen`; in any other collection, a grant for what the version does.

### 7.3 `onePer`: unique by construction

`onePer` is a non-empty list of parts. At most one record exists per
combination of their values — not by searching other records (no peer holds
them all) but because the record's **key is derived from them**. A second
vote by the same person on the same poll _is_ the next version of the first.

Parts:

- `@author` — the writer's **root** DID (the account, not the session key).
- `link:<rel>` — the `to` of the **first** link with that `rel`.
- anything else — a **top-level** field of the body (no dotted paths).

The key is an HMAC under a key of the space's (below):

```
lines  = [ collection ]
for each part, in order:
  "@author"     → "@author=" ‖ rootDid
  "link:<rel>"  → "link:<rel>=" ‖ link.to                 (no such link → no key)
  field         → field ‖ "=" ‖ canonical(body[field])    (field absent → no key)
mac    = HMAC-SHA-256( oneKey, UTF-8( join(lines, "\n") ) )
name   = "one:" ‖ lowercase-hex( mac[0..20) )                  // 44 characters
key    = onePer includes "@author" ? owner(rootDid) ‖ "." ‖ name   // owned, §4.1
                                   : name                          // shared
```

`canonical(v)` is the canonical JSON of the value (§1), so a field holding an
object gives the same key whatever its members' order. A `null` field is
present and gives `field=null`. `owner` is §4.1's.

`oneKey` is derived as topic tags' key is (§8.2), from a key that never
changes for the space:

```
IKM    = public space:  UTF-8( "weave/public-one-per/v1|" ‖ spaceId )
         private space: the space's first key K₀, the one the genesis's encryptionKeyId names (03 §8.1)
oneKey = HKDF-SHA-256( IKM, salt = "" (zero length), info = UTF-8("weave/one-per/v1"), L = 32 ), as an HMAC-SHA-256 key
```

In a public space anyone can compute a key, as anyone can read the records.
In a private space only those holding K₀ can: every reader does, since each
later key's `earlier` carries the ones before it, and a reader takes no key
from a key change whose `earlier` leaves K₀ out (03 §9.3). It is K₀ and not
the current key so that a record's key, and with it "one per", survives a key
change. Someone who holds the ciphertext but not the key (a relay peer, a
host, a mirror's provider) can't test a guess of who voted on which poll, or
how; the owner part of a key with `@author` names its account, as the
version's `author` and `proof` already do.

Example — in the public space
`bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a`, `std.vote`
(`onePer: ["@author", "link:about"]`) by
`did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ` about the record
`iz75dwgy223gqtlqlqv3qzjq4y.poll`:

```
std.vote
@author=did:key:zDnaeSm3GDBe3cfca4gaw8nchcuzkJ2LPQiZp9tYs2bRGfQRJ
link:about=iz75dwgy223gqtlqlqv3qzjq4y.poll
```

gives `iz75dwgy223gqtlqlqv3qzjq4y.one:04b56dc63076a6a7c759e41275fbeedf0514435e`.
A `std.decision` (`onePer: ["link:about"]`) about the same record gives the
shared key `one:7c302bdcb25613e2fb9d49a41bccd0a24e1a2f24`. With the private
space key `ff fe … e0` of 03 §8.1 as K₀, the vote's key is
`iz75dwgy223gqtlqlqv3qzjq4y.one:712d97143fd66351845dee63247e1c2ddc298713`.

Checking: a peer MUST refuse a `seq 0` version of a collection with `onePer` in
force whose `key` is not the derived key (including when a part is missing and
there is no key). Whether a key of a `onePer` key's form is allowed at all, in
any collection, is §4.1's check, which needs no `oneKey`. The check is made only on `seq 0`, and only by a peer that
can read the body and holds `oneKey`; in a private space a peer without the
key accepts it on the other checks, which include whose key it is (§4.1).
Later versions keep the key they have. The first version carries `retain`
(§4.5), so a peer that joins later still has the body to check.

A writer derives the key and writes the next version after whatever it holds
at that key (§4.2) — so "adding another" is an edit of the existing record,
and the writer's grants decide whether it is allowed.

**Without `@author`** (one decision per proposal), the key is shared: any
account granted `/record/write` in the collection may write its first
version, and two who do so apart both stand, as two first versions at any key
do (§7.4). Whose such a record is, for `byCreator`, is per chain (§7.1).

> Rationale: the owner part makes "one per person" a check every peer makes,
> not only those that can read the body: no one can write a first version at
> someone else's vote, in any space. The HMAC hides the rest from those who
> can't read the space.

> **Planned: uniqueness that cannot be a key.** `onePer` works only when the
> unique parts can be known before writing ("one per person per poll").
> Uniqueness over something that cannot be derived in advance ("one booking
> per room per hour" with free-form times, a unique display name) would need a
> **deterministic fold on read** instead: every reader keeps the same one of
> the clashing records, by a rule like §4.3, and treats the rest as not
> current. Not designed. _Open:_ the rule's syntax; how a reader that holds
> only part of a collection folds; and that a definition with an unknown rule
> is invalid to older peers (§7.5), so a new rule needs care in rollout.

### 7.4 `fixed` and `final`

`fixed` is a non-empty list of top-level body fields that keep the value the
record was created with. A peer MUST refuse a later, non-delete version in
which any listed field differs from the record's first version — compared as
canonical JSON (§1), with "absent" equal to "absent" — when the first version
carries `retain` and the peer can read both bodies. A first version written
while `fixed` was in force carries `retain` (§4.5); one written before is a
stub once superseded, and nothing is compared against it, by any peer.

`final` is `true`: a record is written once. A peer MUST refuse every version
with `seq > 0` of a collection whose rules in force (as of the version's
`seen`) have `final`, deletes included, whatever the space's grants say.

```json
"rules": { "onePer": ["@author", "link:about"], "final": true }
```

It is the one way to say "nobody", whatever the space's grants say. A
`contract` (§7.6) is not enforced by peers. A vote that a
proof has counted, or the proof itself, must stay what it was.

Two first versions at one key, written apart, both stand, and the ordering
rule (§4.3) picks the current one, as for any record. `final` does not
prevent that; telling the two apart, where it matters, is the app's.

### 7.5 Checking a definition's rules

`rules` MUST be an object with no members other than `onePer`, `fixed`,
`final` and `check`, the first three valid as above (`onePer` and `fixed`:
non-empty lists of non-empty strings; `final`: `true`). A definition with
anything else, `create`, `edit` and `delete` included, is invalid (§6.1).

`check` is where an older format kept a contract, as was a top-level `line`
on the definition. Peers keep both and do not read them, so `onePer`, `fixed`
and `final` beside them still hold. Readers do not judge them: they leave the
collection's versions unjudged ([09](09-contracts.md) §1). A writer MUST NOT
put `check` in `rules`, nor `line` beside it; a contract is the definition's
`contract` (§7.6).

> Rationale: a definition with `check` in its rules was written by every
> library before the contract moved, and stores keep definitions across an
> upgrade. Were it invalid, its collection would lose its rules on every peer
> at once, and its contract with them, and what was written meanwhile would
> count.

_Source: `packages/core/src/records/rules.ts` (`checkRules`, `onePerSecret`, `onePerKey`, `changedFixedField`), `packages/core/src/node/space-runtime.ts` (`judgeStanding`, `invocationOf`, `needsOf`, `judgeContent`, `onePerKeying`, `derivedKey`, `rulesAt`, `mayNow`, `put`). Tests: `packages/core/tests/rules.test.ts` (all; "final: written once…"), `packages/core/tests/record-keys.test.ts` ("onePer keys"; "a onePer key that names its author…"; "a key in another collection"), `packages/core/tests/schemas.test.ts` ("a poll: one vote per person…")._

### 7.6 The contract

A definition may carry `contract` beside its `rules`: an object of `check`,
a list of conditions, and `line`, an object. Peers keep it as it is and do
not read it, not even its type: they never refuse, withdraw or hold back a
version because of it, and a version that fails it stands like any other.
Readers judge it, citing other versions as evidence, and count only versions
that pass; the language, citations, limits, verdicts and the line rule are in
[09 — Contracts](09-contracts.md). A peer that has never heard of contracts
syncs, stores and judges every version's standing the same.

```json
"rules": { "onePer": ["link:about"] },
"contract": { "check": [{ "that": "versions(body.votes).size() >= 10", "else": "Ten votes" }] }
```

> Rationale: a rule is what a peer refuses; a contract is what a reader
> counts. They live apart so that what peers check (§7.5) never names
> anything only readers judge.

_Source: `packages/core/src/records/rules.ts` (`checkRules`), `packages/core/src/records/contracts.ts` (`CollectionContract`, `checkContractShape`), `packages/core/src/node/space-runtime.ts` (`judgeContent`, `checksOf`). Tests: `packages/core/tests/contracts.test.ts` ("a claim with too little evidence, signed anyway, reaches every peer and counts for no reader", "a decision without its quorum, signed anyway, reaches every peer and counts for no reader"), `packages/core/tests/contracts-shape.test.ts` ("a definition with its contract in rules keeps its rules, and leaves what is written under it unjudged…")._

---

## 8. Topics and blind tags

A collection may name up to eight **topics**: body fields (`mentions`) and link
roles (`link:channel`). Each record then carries, on its outside, a keyed hash
of each value of each topic — so a keeper that cannot read a private body can
still match "messages in #design" or "messages that mention me", learning which
records share a topic but not which topic.

### 8.1 Topics

`topics` is a list of at most 8 distinct strings, each one of:

- a **field path**, matching
  `^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,3}$` (up to
  four dotted segments);
- a **link role**, `link:` followed by a role (§5.1), matching
  `^link:[a-z][a-zA-Z0-9]{0,63}$`, as `onePer` names one (§7.3).

The **values** of a field path in a body: follow the path one segment at a
time, through objects only (an array or a scalar on the way gives no values).
At the end:

- a string, a boolean, or a finite number → that one value;
- an array → each element that is a string, boolean or finite number (others skipped);
- anything else, or missing → no values.

The **values** of a link role: the `to` of **every** link of the version with
that `rel`, in any order — the links sealed with the body in a private space,
the envelope's `links` in a public one (§5.1). No link of that role → no
values.

> Rationale: a record that points at another record says so with a link, and
> everything that follows links (conformance, `onePer`, checks, queries) sees
> it. A link topic lets a keeper match on that link too, so a reference never
> has to be copied into the body to be matched without reading.

### 8.2 The tag key

```
IKM  = public space:  UTF-8( "weave/public-topics/v1|" ‖ spaceId )
       private space: the space key K (32 bytes, 03 §8.1) whose id is the body's keyId
PRK/OKM = HKDF-SHA-256( IKM, salt = "" (zero length), info = UTF-8("weave/topic-tags/v1"), L = 32 )
tagKey  = OKM, used as an HMAC-SHA-256 key
```

In a public space anyone can compute the tags, as anyone can read the records.
In a private space the key is tied to the space key the body was sealed with
([03 — Spaces](03-spaces.md)).

### 8.3 Tags

```
tag = base64url( HMAC-SHA-256( tagKey, UTF-8( collection ‖ 0x00 ‖ topic ‖ 0x00 ‖ canonical(value) ) )[0..16) )
```

— 16 bytes, 22 base64url characters. `topic` is the string as `topics` names
it: `mentions`, `link:channel`. `canonical(value)` is §1, so the string
`"design"` is hashed with its quotes and differs from the number or boolean of
the same spelling. The collection and topic are included, so one value in two
places gives two tags.

A record's `tags` are the tags of every value of every topic of it, **each
once, sorted** (ascending by UTF-16 code units), **truncated to the first 64**.
A record with no topic values carries no `tags` member. A delete carries none.

Examples, in the public space
`bimjoifogypbqrtuich3e375d67y43znkjsjnp4q4qhe7gwf7u74a`:

- collection `app.chat.message`, field `channel`, value `"design"` →
  `77UGGhMoLC5C1rXEcsqWKw`;
- collection `std.message`, topic `link:channel`, a link
  `{ "rel": "channel", "to": "mfrggzdfmztwq2lknnwg23tpoa" }` →
  `KmBza5PO__zHr48zfCH8Pw`.

### 8.4 Checking

A peer that can read a non-delete version's body, and holds the key it was
sealed with, MUST recompute its tags from its body and links under the
`topics` in force (as of `seen`) and refuse the version if the recomputed set
differs from the set in `tags` (order and duplicates ignored). With no topics in force, a version carrying
any tag is refused. A peer that cannot read the body, or holds only a stub,
does not check (see the known defect in §4.9).

To ask a keeper for records on a topic, a reader computes the tag the same way
([05 — Sync and storage](05-sync-and-storage.md)).

> Rationale: a blind index (as in CipherSweet) — equality only, never ranges or
> substrings. The keeper learns co-occurrence and frequency, nothing more.

_Source: `packages/core/src/records/topics.ts` (`checkTopics`, `topicValues`, `topicKey`, `topicTag`, `tagsFor`, `sameTags`, `MAX_TOPICS`, `MAX_TAGS`), `packages/core/src/records/links.ts` (`LINK_FIELD_PATTERN`), `packages/core/src/node/space-runtime.ts` (`tagKey`, `tagProblem`, `write`). Tests: `packages/core/tests/topics.test.ts` (all; "topic tags on links" for link roles)._

---

## 9. Validation: what a peer checks before keeping a version

A version arriving from anywhere — a peer, a folder, a mirror — or written
locally, passes the same checks. The order below is the reference order; a
version refused by any step is refused.

### 9.1 Shape

The version-alone checks of §4.6. The body is not inspected beyond its hash:
body shape against the collection's schema is **not** checked on arrival
(§9.6).

### 9.2 Signature (the crypto gate)

§3.3: the id matches the signed part, `author` resolves to a P-256 key, the
signature verifies, and a body that is present hashes to `bodyHash`.

### 9.3 Delegation (the capability gate)

Every write in space `S` requires `/record/write` in `S`, with arguments
`{ "space": S, "collection": <its collection> }` ([01 — Identity](01-identity.md)
§8). `S` is the space the peer judges it in, not the one it claims (§9.4
refuses a claim of another).

- No `proof`: the author signs for itself; its root is `author`.
- With `proof`:
  1. `createdAt` MUST parse as a time, which sync orders by (05); else
     refuse. It decides nothing else here.
  2. The note MUST be valid ([01 — Identity](01-identity.md) §7.5), judged
     with no time at all (§7.6): not its `exp` or `nbf`, not
     `createdAt`, by no one's clock. So records outlive the session that
     signed them, and every peer judges a version the same whenever it
     arrives. What ends a key's writes is a revoke ([03](03-spaces.md) §6.4).
  3. The note's audience, its `aud`, MUST equal `author`.
  4. The note MUST grant the requirement: its command, subject and policy
     (01 §7.5).
  5. The root is the note's issuer.

### 9.4 Standing (the stateful check)

Given a valid signature and root, whether the version _stands_ in this space:

1. `space` equals this space's id.
2. In a space that admits only the account itself, a note that does not grant
   `account/write`: refused ([01](01-identity.md) §8, [06](06-nodes-and-sessions.md)).
3. Access-history collections: judged by the replay ([03 — Spaces](03-spaces.md)).
4. Otherwise:
   1. The first version (§4.6) is held and is this record's, and a later
      version follows the version its `prev` names (§4.7). The reference
      checks the second for every collection, the access history's included,
      before the rest of this step. A first version is at a key its root may
      write first (§4.1): refused, never withdrawn, since nothing that arrives
      later changes whose a key is.
   2. The access state as of `seen` is known ([03](03-spaces.md)). A first
      version at a key of a `onePer` key's form is in a collection whose rules
      as of then have a `onePer` that gives that form, unless the peer can't
      read them (§4.1). The collection is not contested with no definition
      in force as of then (§6.3).
   3. The root is a member as of `seen` and holds a grant for what the version does ([03](03-spaces.md) §5.2), `final` allows it (§7.2), and the access history's own judgement of the writer passes (revoked keys, removals, roles taken — [03](03-spaces.md)).
   4. If a definition is in force and the version is not a delete: tags check (§8.4).
   5. If rules are in force: under `final`, no version with `seq > 0`, deletes included (§7.4). Then, if the version is not a delete: `retain` on a `seq 0` under `onePer` or `fixed` (§4.5); `onePer` (§7.3) on `seq 0`; `fixed` (§7.4) on `seq > 0`. The `contract` is not judged (§7.6).

   When step 3 fails only on the access history's judgement of a change that came after the version (a removal of its author, or a role taken from it, that it had not seen, a change it saw struck since, its key revoked, or its key's line in its collection proven forked at or before it: [03](03-spaces.md) §5.1 steps 2, 4 and 5, §4.10), the peer still judges steps 4 and 5, and the version is **withdrawn** if they pass, **refused** if they don't. So every peer that can read the body stores the same withdrawn versions, whatever order it checks in; a peer without the key skips what it can't read (§7.3, §8.4).

### 9.5 What a peer does with a refused version

A check can end four ways:

| Outcome       | When                                                                                                                 | What the peer does                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stands**    | every check passes                                                                                                   | Stores it; the ordering rule (§4.3) decides whether it becomes current.                                                                                                  |
| **withdrawn** | every check passes but one: a later access change took it away, or its key's log forked (§9.4, §4.10)                | Stores it and passes it on, as for one that stands. It never counts as a record (below). The library's checks may still count it as cited evidence (§7.6). Not reported. |
| **later**     | it depends on something not held: its first version, the version its `prev` names, or access changes named in `seen` | Holds it aside and re-judges waiting versions whenever something new is stored. Nothing is reported.                                                                     |
| **refused**   | any other failure                                                                                                    | Does not store it and does not pass it on. It may remember the refusal as (peer, id), only so it does not ask that peer again.                                           |

A refused version that its author's key validly signed, and that no honest
writer could have signed, is also proof against that account. The standard
library writes it down as a warrant
([warrants](../packages/core/docs/warrants.md)); that is not protocol.
Withdrawn and later versions never are proof.

A withdrawn version is kept so that every peer stores the same versions,
whatever order changes reach it in: a peer that dropped it would hold less
than peers that stored it before the change. It is also what lets the
library judge a version that cites it the same on every peer, however late
the peer joins ([09 — Contracts](09-contracts.md) §6.2).
It adds nothing a removed author could not have written while a member: it
must pass every rule as of what it claims to have seen.

A peer MUST NOT remember a refusal by id alone, and MUST NOT cache a failing
verdict: a copy with a mangled signature shares the genuine version's id
(§3.2). A peer MAY cache passing verdicts by (`id`, `signature`), applied
only to a copy that passed §3.3 steps 1 and 4 itself.

Whether a stored version stands can change as the access history grows (a
removal, a revoked key — [03](03-spaces.md)); it is then withdrawn, and stays
stored. When reading, a peer uses the
current version if it stands; otherwise the newest held version of that record
that does; otherwise the record is absent.

How the reference node holds, reports and remembers these, and its limits:
[the node](../packages/core/docs/node.md#versions-that-wait-or-are-refused).

### 9.6 What is never a reason to refuse

A peer MUST NOT refuse a version on arrival because:

- its body does not fit the collection's schema, or
- its links do not conform to the collection's link declarations, or
- its collection is not defined, or
- it fails its collection's `contract` (§7.6).

Each of these depends on which definition, schema or target a peer happens to
hold, and refusing would leave peers disagreeing forever. A reader may flag
such a record instead. A writer
checks them before signing and SHOULD NOT write what does not conform.

_Source: `packages/core/src/validation/check-version.ts` (`createVersionCheck`), `packages/core/src/validation/crypto-gate.ts`, `packages/core/src/validation/capability-gate.ts`, `packages/core/src/identity/abilities.ts` (`writeRequirement`), `packages/core/src/node/space-runtime.ts` (`judge`, `judgeStanding`, `chainStanding`, `admit`, `currentOf`, `contentIssues`), `packages/core/src/sync/sync-engine.ts` (`admit`, `retryWaiting`). Tests: `packages/core/tests/validation.test.ts` (all), `packages/core/tests/rules.test.ts` ("a forged edit is refused by every peer…", "arriving in any order"), `packages/core/tests/space-catalog.test.ts` ("a record that does not fit is kept and flagged"), `packages/core/tests/links.test.ts` ("declared links"), `packages/core/tests/topics.test.ts` ("a record whose tags don’t match…"), `packages/core/tests/contracts.test.ts` ("a claim with too little evidence, signed anyway, reaches every peer and counts for no reader"; "a proof stays a proof…"), `packages/core/tests/space-access.test.ts` ("a removed member cannot write…"), `packages/core/tests/attacks.test.ts`._

---

## 10. Limits

| Limit                       | Value                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Record key                  | 1–128 chars of `[a-z0-9:._-]`; a first version outside `sys.*` at an owned or shared key (§4.1) |
| Name in an owned key        | 1–101 chars of `[a-z0-9:._-]`                                                                   |
| `seen`                      | ≤ 64 ids, each 1–128 chars                                                                      |
| Links per version           | ≤ 32                                                                                            |
| Link role                   | `^[a-z][a-zA-Z0-9]{0,63}$`                                                                      |
| Topics per collection       | ≤ 8; a field of ≤ 4 path segments, or `link:<role>`                                             |
| Tags per version            | ≤ 64                                                                                            |
| Permission name             | `^[a-z][a-zA-Z0-9]{0,39}$`                                                                      |
| Size of a body or a version | _Not yet specified_ — no limit is enforced                                                      |
| Collection name on a record | _Not yet specified_ — only definitions constrain names; a record may name any string            |
