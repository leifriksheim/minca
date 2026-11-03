# Calls

`@minca/calls` adds voice and video calls to a space. Anyone who belongs to
the space can start a call, join one going on, or ring one person. There is
no call server: each pair of devices talks directly, and a relay only
introduces them.

## Starting a call

Give `createCalls` your node, then start a call in a space:

```ts
import { createCalls } from '@minca/calls';

const calls = createCalls(node);
await calls.start(space.id);
```

If a call is already going on in the space, `start` joins it. Otherwise it
starts a new one. Pass `{ video: true }` to start with the camera on. By
default a call is sound only.

## In React

Put `CallsProvider` inside your `MincaProvider`, above anything that changes
when someone moves between screens. Then `useCalls` gives you the calls and
their state anywhere below it:

```tsx
import { createRoot } from 'react-dom/client';
import { MincaProvider } from '@minca/react';
import { CallsProvider, useCalls } from '@minca/calls/react';

createRoot(root).render(
  <MincaProvider node={node}>
    <CallsProvider>
      <CallButton space={space.id} />
    </CallsProvider>
  </MincaProvider>,
);

function CallButton({ space }: { space: string }) {
  const { state, calls } = useCalls();
  if (state.current?.space === space) {
    return <button onClick={() => calls?.leave()}>Leave</button>;
  }
  return <button onClick={() => calls?.start(space)}>Call</button>;
}
```

`calls` is null for a moment, until the provider has made it. A call keeps
going while the screens under the provider come and go.

## Showing a call

`state.current` is the call you're in, or null. Each device in it is one of
`people`, with its `stream` to show in a `<video>`:

```tsx
import { useCalls } from '@minca/calls/react';

function Call() {
  const { state } = useCalls();
  if (!state.current) return null;
  return state.current.people.map((person) => (
    <video
      key={person.peer}
      autoPlay
      playsInline
      ref={(video) => {
        if (video) video.srcObject = person.stream;
      }}
    />
  ));
}
```

The state also holds your own camera, whether you're muted or sharing, who
you're ringing, calls ringing you and calls going on around you. See
[`CallsState`](https://minca.dev/api/calls/interfaces/CallsState/) for every
field.

## Muting, camera and screen

```ts
import type { Calls } from '@minca/calls';
declare const calls: Calls;
// ---cut---
calls.setMuted(true);
await calls.setCamera(true);
await calls.shareScreen(); // in place of your camera
await calls.stopSharing();
```

None of these interrupt the call.

## Ringing someone

`ring` starts a call in the space and rings one person on all their devices:

```ts
import type { Calls } from '@minca/calls';
declare const calls: Calls;
// ---cut---
await calls.ring(space.id, did);
```

It rings for 45 seconds. On the other side, the call shows in
`state.ringing`, and the person answers or declines:

```ts
import type { Calls } from '@minca/calls';
declare const calls: Calls;
// ---cut---
const [incoming] = calls.getState().ringing;
if (incoming) await calls.answer(incoming.id); // or calls.decline(incoming.id)
```

When nobody answers, the call is written down as missed. Calls with more
people don't ring: a call going on shows in `state.around` for everyone with
the space open.

## Leaving

```ts
import type { Calls } from '@minca/calls';
declare const calls: Calls;
// ---cut---
await calls.leave();
```

When the last person leaves, the call is written down as ended. Missed and
ended calls are [`std.call`](../core/docs/standard-library.md#stdcall)
records, so the space keeps a history of its calls.

After a reload, `state.rejoin` is the call you were in, if it's still going
on. Call `start(rejoin.space, { call: rejoin.id })` to go back, or
`forgetRejoin()` to stop offering it. `calls.close()` leaves any call and stops listening.

## Options

`createCalls(node, options)` and `<CallsProvider options={...}>` take the
same options, listed with their defaults under
[`CallsOptions`](https://minca.dev/api/calls/interfaces/CallsOptions/). You
rarely need them, except in tests.

## Who takes part

Only members take part: the space's founders, and accounts holding a role
there. Someone who can only view the space is kept out.

A key that may write records but not define collections, such as a program
connected for records only, is kept out too. It would speak in the call as
the account. A key that only reads may take part, as an app that only reads
may. This keeps an honest records-only program out of calls. It is no
defence against a hostile app, which can ask the account for a read-only
note for the same key.

A device rings for at most 3 rings from one account in a minute.

> **Planned:** a device won't ring for someone the person has blocked. Today
> a ring is checked only for membership and rate.
> [#20](https://github.com/leifriksheim/minca/issues/20)

## How calls work

Calls are a convention on Minca, not part of the protocol. A call is live
messages in the space, plus one WebRTC connection between each pair of
devices in it. That full mesh is good for about six people with video.

The setup travels over the space's own peer connection, whose handshake
proved who is at the other end. So an offer really comes from that device. A
relay introduces devices and offers TURN, but never sees a call.

The rest of this page is what two apps must agree on to call each other.
Peers that have never heard of calls sync and judge every record the same
way.
[Live messages, spec 04](https://github.com/leifriksheim/minca/blob/main/spec/04-network.md)

## Messages

Every call message is a JSON object with a `type` and a `call` id. The id is
a string of 1 to 64 characters. The library makes 12 random bytes in
lowercase hex.

| `type`          | Sent to                             | Fields                                                              | Meaning                     |
| --------------- | ----------------------------------- | ------------------------------------------------------------------- | --------------------------- |
| `call.here`     | the space every 5 s, or one device  | `since` (ms, when the sender joined), `camera`, `muted`             | "I am in this call."        |
| `call.ring`     | one account                         |                                                                     | Ring that account's devices |
| `call.answered` | the caller's account, and one's own |                                                                     | Answered; stop ringing      |
| `call.declined` | the caller's account, and one's own |                                                                     | Declined; stop ringing      |
| `call.cancel`   | the rung account                    |                                                                     | The caller stopped ringing  |
| `call.signal`   | one device                          | `description` (`{ type: "offer" \| "answer", sdp }`) or `candidate` | Connection setup            |
| `call.leave`    | the space                           |                                                                     | "I left", without waiting   |

```json
{ "type": "call.here", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "since": 1790422901000, "camera": false, "muted": false }
{ "type": "call.signal", "call": "3f9a1c0b7e2d4a6f8b1c2d3e", "description": { "type": "offer", "sdp": "v=0\r\n…" } }
```

`candidate` is an `RTCIceCandidateInit`.

A receiver must ignore a call message when:

- its type is not one of these, or its `call` is not a valid id;
- it comes from a peer with no account (`from: null`);
- it comes from a records-only key (`recordsOnly: true`), judged on the whole
  note, so records given in another space don't count here;
- it is a `call.here`, `call.ring` or `call.signal` from an account that is
  not a member ([who takes part](#who-takes-part)).

The library caches the member list for 10 s, and asks once more for someone
not in it. A device must ignore more than 3 `call.ring`s from one account in
any 60 s, and honour `call.cancel` only from the account that rang.

## Presence

A device is in at most one call per space. A `call.here` for another call
moves it. A device not heard from for 15 s is gone: it is dropped, and the
connection to it closed. On hearing a new device's first `call.here`, a
device sends its own `call.here` straight back to it.

## Joining, and which call

`start(space)` joins the call going on in the space, the one with the lowest
id if there are several, or starts one with a new id. Joining holds the space
([holding a space](../core/docs/node.md#opening-and-holding-spaces)) for as
long as the call lasts.

When a device alone in its call hears a `call.here` for a call with a lower
id in the same space, it moves into that call. So two calls started at once
merge into one.

## Connections

- Between two devices, the one with the lower session DID, compared as
  strings, makes the offer. A device must ignore an offer from a higher
  session DID, and an answer on a connection it didn't offer or that already
  has one.
- Each connection starts with one audio and one video transceiver
  (`sendrecv`). Muting, the camera and screen sharing replace the track and
  are announced with `call.here`. They never renegotiate.
- Candidates that arrive before the remote description are queued, at most 64.
- The offering side keeps at most one connection to each device.
- When a connection fails, or its offer or answer can't be applied, the
  offering side offers again after 2 s if the other device is still in the
  call. A connection not connected 15 s after its offer counts as failed,
  since a lost offer or answer never fails on its own.
- ICE servers come from `node.iceServers()` ([node.md](../core/docs/node.md)):
  the configured ones, plus TURN servers a relay offers.

## Ringing

1. The caller joins the call, sends `call.ring` to the callee's account, and
   shows `outgoing: ringing`.
2. The callee's devices ring for 45 s, unless answered, declined or
   cancelled. A ring also stops when the caller's device leaves the call, or
   isn't heard in it for 15 s.
3. Answering stops the ringing, joins the call, and sends `call.answered` to
   the caller's account and to one's own, so the other devices stop. Joining
   a ringing call by any route answers it. Declining sends `call.declined`
   the same way.
4. On `call.answered`, the caller clears `outgoing`. On `call.declined` it
   shows `declined`, and leaves 2.5 s later if nobody else is in the call. A
   `call.here` from the rung account also clears `outgoing`, in case the
   answer was lost.
5. After 45 s unanswered, the caller sends `call.cancel`, writes a missed
   call, shows `missed`, and leaves 2.5 s later if alone.

A device must not ring again for a call it stopped ringing for in the last
90 s, since the same `call.ring` can arrive twice.

## Leaving a call

Leaving closes every connection, stops the local tracks and sends
`call.leave` to the space. If it was still ringing someone, it sends
`call.cancel` and writes a missed call. If nobody else is left, and anyone
else was ever in the call, the leaver writes an ended call. The space is let
go 1 s later, so the goodbye gets out first.

## Planned

> **Planned:** not settled.
>
> - **Ringing with the app closed.** A ring reaches only devices with the
>   space open. Reaching a closed browser or a phone needs Web Push from a
>   carrier ([spec 06 §4.4](https://github.com/leifriksheim/minca/blob/main/spec/06-nodes-and-sessions.md)).
>   Not designed yet.
> - **Big calls.** Past about six video streams, a full mesh runs out of
>   upload. A forwarding server with end-to-end encryption on top could fix
>   it, and a host could run one. Not designed.
> - **Listening without talking.** A role could grant readers a way to
>   listen, such as `/call/listen`. Open.
> - **Calls across apps.** A call lives in the app that started it. Moving it
>   between apps would need the account home to hold it. No plan yet.
