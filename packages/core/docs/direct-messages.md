# Direct messages

A direct message is text in a space that only some of its members can read:
the people it is for, and whoever wrote it. Use it for a private word inside
a shared space. Today it needs a private space.

## Sending and reading

```typescript
const people = await node.direct.reachable(space.id); // who you can write to
await node.direct.send(space.id, people.slice(0, 1), 'See you at eight?');

const messages = await node.direct.list(space.id);
messages[0]?.text; // null when this node can't open it
```

The methods are on
[`NodeDirect`](https://minca.dev/api/core/interfaces/NodeDirect/), and each
message is a
[`DirectMessage`](https://minca.dev/api/core/interfaces/DirectMessage/).

A message is a record, so it syncs and is kept like any other. Delete its
`key` to take it back.

A message is for 1–16 people besides you, and you can only write to someone
who has a member key in the space.

## Who can read them

`node.direct` needs the account's member key for the space. An agent isn't
given one, so it may only call `reachable`.

That is the library refusing, not the sealing. An app or program granted the
whole account holds the key every member key comes from. One granted a
private space holds its member key. Either can open the account's direct
messages there with code of its own
([threat model §3.6](https://github.com/leifriksheim/minca/blob/main/spec/threat-model.md)).

A bot is an account of its own, with its own member key, so it reads and
sends them like anyone. The actions `direct_list` and `direct_send`
([actions](actions.md)) are offered to bots, not to agents. An automation set
off by a direct message hands the bot the message already opened.

## What others see

In a private space the whole body is also encrypted with the space key, so
peers outside the space see only the envelope. Other members see who wrote to
whom, and when, but not what.

`to` is a topic, so "direct messages to me" can be an automation of the
account's own, which a carrier can match without reading the message
([automations](automations.md#the-accounts-own)).

A reader can't tell that the others read the same text. A writer can seal
each reader's copy to open to a different text
([#214](https://github.com/leifriksheim/minca/issues/214)).

## How it works

One record serves every reader and every one of their devices. A fresh
**message key** seals the text once. That key is then sealed to each reader's
member key, in a **box** of their own.

This is a convention on the protocol, not part of it. Peers that have never
heard of `std.direct` sync, store and judge it like any other record. Only
apps that read each other's direct messages must agree on the format below.
It uses member keys
([spec 03 §9.1](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)),
the space key's derivations (spec 03 §8.1), and the envelope and HPKE sealing
([spec 01 §9](https://github.com/leifriksheim/minca/blob/main/spec/01-identity.md)).

## `std.direct`

```
std.direct  (topics: to; no rules; who may write one is the space's grants)
{
  to:    [<account DID>, …],               // 1–16, sorted, once each, not the writer
  data:  string ≤ 60000,                   // the text, sealed with the message key
  boxes: [{ to: <account DID>, sealed: string ≤ 1000 }, …]   // ≤ 17: one per reader
}
```

The **writer**, `from`, is the root of the record's first version. The
**readers** are every DID in `to`, and `from`.

## Sealing

```
bound   = { space: <spaceId>, from: <from>, to: <to joined by ","> }
k       = 32 fresh random bytes, a space key (spec 03 §8.1)
data    = base64url(envelope(sealKey(k), "minca/direct-text/v1", bound, JSON { text }))
box(r)  = HPKE(memberKey(r), "minca/direct-box/v1", { ...bound, reader: r }, JSON { key: base64url(k) })
boxes   = [ box(r) for r in to, then box(from) ]
```

`sealKey(k)` is `HKDF(k, "minca/space-seal/v1", 32)`, as for any space key.
`envelope` and `HPKE` are spec 01 §9.1 and §9.2.

`memberKey(r)` is the key `r` published in `sys.memberkey`. The writer may
seal its own box to its member key as it holds it, rather than as published,
so its other devices can read what it sent before that key is published. A
writer must not write a direct message for someone with no member key in the
space.

Example: space `space-1`, from `did:a`, to `did:c` and `did:b`. The text is
bound to `{"from":"did:a","space":"space-1","to":"did:b,did:c"}`, and the box
for `did:b` to `{"from":"did:a","reader":"did:b","space":"space-1","to":"did:b,did:c"}`.

## Opening

A reader `r` opens a direct message only when the record verifies and stands,
its collection is `std.direct`, and `r` is `from` or is in `to`. It builds the
bound from the space the record is in, and `from` and `to` as the record gives
them, sorted. Then it:

1. takes the box whose `to` is `r`;
2. opens it with its own member key, label `minca/direct-box/v1` and the
   bound with `reader: r`, giving a value whose `key` is a base64url string of
   32 bytes;
3. opens `data` with that key's seal key, label `minca/direct-text/v1` and
   the bound, giving an object whose `text` is a string.

If any step fails, the message is unreadable to `r`. A chat must show it as
unreadable, not drop it, the same as a body a reader can't open.

Binding the text to the space, the writer and the readers means a copy
re-posted by another member, moved to another space, or with a reader added
to `to` opens nothing. Binding each box to its reader means a box can't be
moved into another reader's slot.

## Planned: direct messages in public spaces

Members publish member keys only in private spaces, so a public space has none
to seal to. Publishing them in every space would let members of a public
space write to each other. The text would then be protected only by the
sealing above, with `to` visible to anyone.
