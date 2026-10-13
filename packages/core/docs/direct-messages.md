# Direct messages

A direct message is text only some members of a space can read: the people
it is for, and whoever wrote it. It is a `std.direct` record in the space,
so it syncs, is kept and is deleted like any other. Its text is sealed, so
the space key alone does not open it.

This is a convention built on the protocol, not part of it. Peers that have
never heard of `std.direct` sync, store and judge it like any other record,
and nothing about the space changes for them. Only apps that want to read each
other's direct messages have to agree on what follows. It uses these protocol
parts: member keys ([spec 03 §9.1](https://github.com/leifriksheim/weave/blob/main/spec/03-spaces.md)),
the space key's derivations (§8.1), the envelope and sealing to a key with
HPKE ([spec 01 §9](https://github.com/leifriksheim/weave/blob/main/spec/01-identity.md)).

One record serves every reader and every one of their devices. A fresh
**message key** seals the text once, and that key is sealed to each reader's
member key. Members publish member keys only in private spaces, so today
direct messages need a private space.

A reader can't tell that the others read the same text: AES-GCM does not
commit to its key, so a writer can seal boxes that open to different message
keys, each opening `data` to a different text
([#214](https://github.com/leifriksheim/weave/issues/214)).

## `std.direct`

```
std.direct  (topics: to; no rules; who may write one is the space's grants)
{
  to:    [<account DID>, …],               // 1–16, sorted, once each, not the writer
  data:  string ≤ 60000,                   // the text, sealed with the message key
  boxes: [{ to: <account DID>, sealed: string ≤ 1000 }, …]   // ≤ 17: one per reader
}
```

The **writer** (`from`) is the root of the record's first version. The
**readers** are every DID in `to`, and `from`.

In a private space the whole body is also encrypted with the space key, so
peers outside the space see only the envelope. Other members see `to`, `from`
and when: who wrote to whom, not what. `to` is a topic, so "direct messages to
me" is an automation of the account's own whose wake a keeper can match
without reading it ([automations](automations.md#the-accounts-own)).

## Sealing

```
bound   = { space: <spaceId>, from: <from>, to: <to joined by ","> }
k       = 32 fresh random bytes, a space key (spec 03 §8.1)
data    = base64url(envelope(sealKey(k), "weave/direct-text/v1", bound, JSON { text }))
box(r)  = HPKE(memberKey(r), "weave/direct-box/v1", { ...bound, reader: r }, JSON { key: base64url(k) })
boxes   = [ box(r) for r in to, then box(from) ]
```

`sealKey(k)` is `HKDF(k, "weave/space-seal/v1", 32)`, as for any space key;
`envelope` and `HPKE` are spec 01 §9.1 and §9.2.

`memberKey(r)` is the key `r` published in `sys.memberkey`. The writer may use
its own member key as it holds it, rather than as published, so its other
devices can read what it sent before that key has been published. A writer
must not write a direct message for someone with no member key in the space.
`text` is a string of 1–10000 characters.

Example: space `space-1`, from `did:a`, to `did:c` and `did:b`. The text is
bound to `{"from":"did:a","space":"space-1","to":"did:b,did:c"}`, and the box
for `did:b` to `{"from":"did:a","reader":"did:b","space":"space-1","to":"did:b,did:c"}`.

## Opening

A reader `r` opens a direct message only when the record verifies and stands,
its collection is `std.direct`, and `r` is `from` or is in `to`. It builds the
bound from the space the record is in, `from` and `to` as the record gives
them (sorted), then:

1. takes the box whose `to` is `r`;
2. opens it with its own member key, label `weave/direct-box/v1` and the
   bound with `reader: r`, giving a value whose `key` is a base64url string of
   32 bytes;
3. opens `data` with that key's seal key, label `weave/direct-text/v1` and
   the bound, giving an object whose `text` is a string.

If any step fails, the message is unreadable to `r`. A chat must show it as
unreadable, not drop it, the way a body a reader can't open is shown.

Binding the text to the space, the writer and who it is for means a copy
re-posted by another member, moved to another space, or with a reader added
to `to` opens nothing. Binding each box to its reader means a box can't be
moved to another reader's slot.

## `node.direct`

- `reachable(space)`: the members who have published a member key, not you.
- `send(space, to, text)`: seals and writes a `std.direct`, and defines the
  collection first when the space lacks it and you may.
- `list(space)`: every direct message by or for the account, oldest first,
  with `text: null` for one this node can't open.

They need the account's member key for the space. An agent isn't given it, so
an agent may only ask `reachable`. A bot is an account of its own and holds
one, so it reads and sends them like anyone: the actions `direct_list` and
`direct_send` ([actions](actions.md)) are offered to bots, not to agents,
and an automation set off by a direct message hands the bot the message opened.

_Source:_ `packages/core/src/node/actions.ts` (`direct_list`, `direct_send`),
`packages/core/src/node/actions.ts` (`offeredActions`), `packages/cli/src/agent-automations.ts`
(`openTrigger`, `ruleContext`). Tests: `packages/core/tests/direct.test.ts`
("the direct message actions"), `packages/cli/tests/agent-automations.test.ts`.

_Source: `packages/core/src/privacy/direct.ts` (`sealDirect`, `openDirect`, `directBound`), `packages/core/src/schemas/library/publishing.ts` (`direct`), `packages/core/src/node/node.ts` (`direct`, `directView`), `packages/core/src/node/space-runtime.ts` (`memberKeys`, `ownMemberKey`), `apps/example/src/components/apps/Chat.tsx`. Tests: `packages/core/tests/direct.test.ts`, `packages/core/tests/records-only.test.ts` ("neither sends nor reads direct messages")._

## Planned: direct messages in public spaces

Members publish member keys only in private spaces, so a public space has none
to seal to. Publishing them in every space would let members of a public space
write to each other. The text would then be protected only by the sealing
above, with `to` visible to anyone.
