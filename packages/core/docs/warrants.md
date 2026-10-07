# Warrants

A **warrant** is proof that an account's key signed something every peer
refuses and no honest app would sign. Members write it down, and every member's
node checks the proof itself before it shows the account as flagged. Nothing
is done to the account automatically: what to do about it is up to whoever
manages the space.

Warrants are a standard collection, not protocol. A `std.warrant` record stands
like any record its author may write, and syncs like one. A peer that has never
heard of warrants stores and judges everything the same; it just shows no
flags.

## The record

```
std.warrant at warrant:<hex40(evidence[0].id + "|" + writer's account DID)>
{ kind, evidence: [<version>, <version>?] }        retain: true
```

`evidence[0]` is the offending version, and its signer's root is the accused
account. The key names the offending version and the warrant's writer. Only
the warrant's first version counts as proof. Any member may write a later
version or a delete of it, as for any record, and neither takes the proof back.
The writer sets `retain`, so the first version is kept whole whatever comes
after it.

| `kind`     | `evidence`                                        | Proves                                                                                                     |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `chain`    | `[v, p]`, both without bodies                     | `p.id = v.prev`, and `v` does not follow `p` (spec 02 §4.7)                                                |
| `standing` | `[v]`, without its body; not an access collection | in `v`'s own view, `v`'s root held no role, or the rules said `final`, or the rule for `create` refused it |
| `access`   | `[v]`, whole; an access collection                | in its own view, `v`'s event is refused by its author's power (spec 03 §4.5)                               |

A version's **own view** is the access changes its `seen` names and everything
they saw, replayed alone. That is what its writer's node had when it signed.
Nothing outside it can alter the verdict, so an honest writer never fails it.

## Who is flagged

`spaces.access(id).flagged` lists `{ account, key, kind, by }` for every
warrant whose proof this node checked and found to hold. To count, a warrant
must:

- be a first version, standing as a record;
- be at its key, and not against its own writer;
- have every piece of evidence be what its id names, envelope and body;
- prove its kind's check.

Anything else, whether false, malformed, or of an unknown kind, flags nobody,
and earns its writer nothing either. Several members may bring proof against
one account, so an account can appear more than once.

## Writing one

When the node refuses a version that is proof of a kind above, it writes a
warrant of its own, unless one of its own against that account stands
already. So one account's misconduct costs each member one warrant at a time.
It looks through the cheap global view first, and replays the own view only
for what that finds broken: a flag can be missed, but is never false. A race,
such as a write that crossed a removal it hadn't seen, is withdrawn, never
refused, so it earns no warrant.

An app shows the flag to whoever manages the space, who may remove the person
(`spaces.setMember(id, did, null)`). It also shows it to the account itself: a
flag against your own account usually means one of your keys is being used
somewhere it shouldn't be, and revoking that key's note (`spaces.revoke`)
takes back what it signed.

Like any record, a warrant is withdrawn when its writer is removed without
keeping it, or revokes the note it was written under ([#166](https://github.com/leifriksheim/weave/issues/166),
[#168](https://github.com/leifriksheim/weave/issues/168)). More kinds are planned in
[#148](https://github.com/leifriksheim/weave/issues/148).

_Source: `packages/core/src/records/warrant.ts` (`readWarrant`, `knownKind`), `packages/core/src/node/space-runtime.ts` (`ownView`, `warrantShape`, `warrantVerdict`, `evidenceHolds`, `violationIn`, `warrantIfDue`, `flagged`), `packages/core/src/space/space-access.ts` (`WARRANT_COLLECTION`, `warrantKey`). Tests: `packages/core/tests/warrants.test.ts`._
