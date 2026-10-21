/**
 * A host with limits (spec 08 §1.1): an account's subscription needs no
 * payment and paying buys room; a space several accounts write in is free up
 * to a line, and past it, after a grace period, only its own subscription
 * carries it. Members never lose what they hold.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNode } from '../src/node/node.js';
import { createHostNode, spaceSubscription, type HostConfig, type HostNode } from '../src/node/host.js';
import type { P2PNode } from '../src/node/types.js';
import type { HostLimits } from '../src/session/hosting.js';
import { createIdentityManager } from '../src/identity/identity-manager.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { generateSeed } from '../src/identity/recovery-code.js';
import { deriveAccountKey } from '../src/identity/account-vault.js';
import {
  newSubscriptionSeed,
  readStatus,
  signStatus,
  subscriptionKey,
  type HostStatus,
} from '../src/session/hosting.js';
import { didOf } from '../src/identity/did.js';
import { parseSpaceInvite } from '../src/space/space-manager.js';
import { createMemoryBlobStore } from '../src/storage/blob/memory.js';
import { createFakeHub, type FakeHub } from './helpers/fake-transport.js';
import { memoryStores } from './helpers/memory-stores.js';
import { until } from './helpers/until.js';
import { joined } from './helpers/joined.js';
import { hold } from './helpers/hold.js';
import { team } from '../src/space/presets.js';

const provider = createP256Provider();
const DAY = 86_400;
const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((node) => node.close()));
});

const onHub = (hub: FakeHub) => ({
  transports: (spaceId: string, sessionDid: string) => [hub.transport(sessionDid, spaceId)],
});

async function account() {
  const manager = createIdentityManager();
  const seed = generateSeed();
  const identity = await manager.fromSeed(seed);
  return {
    did: identity.did,
    signer: createLocalRootSigner(identity, manager.getProvider()),
    accountKey: await deriveAccountKey(seed),
  };
}
type Account = Awaited<ReturnType<typeof account>>;

async function device(me: Account, hub: FakeHub): Promise<P2PNode> {
  const node = await createNode({
    signer: me.signer,
    stores: memoryStores(),
    accountKey: me.accountKey,
    watchIntervalMs: 0,
    network: onHub(hub),
  });
  open.push(node);
  return node;
}

const LIMITS: HostLimits = {
  accountBytes: 1_000,
  paidAccountBytes: 10_000,
  space: { writers: 1, bytes: 500, windowDays: 30, readers: 2 },
  graceDays: 30,
  keepDays: 90,
  idleDays: 180,
};

async function host(hub: FakeHub, options: Partial<HostConfig> = {}): Promise<HostNode> {
  const node = await createHostNode({
    key: await provider.generateKeyPair(),
    stores: memoryStores(),
    network: onHub(hub),
    watchIntervalMs: 0,
    limits: LIMITS,
    ...options,
  });
  open.push(node);
  return node;
}

const carries = (node: HostNode, spaceId: string) => async () =>
  (await node.spaces()).some((space) => space.id === spaceId);
const subscriptionId = async () => (await subscriptionKey(newSubscriptionSeed())).did;
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** Alice and Bob in one space, each writing in it, each with a free subscription at the host */
async function community(
  hub: FakeHub,
  node: HostNode,
  visibility: 'private' | 'public' = 'private',
  people?: readonly [Account, Account],
) {
  const [alice, bob] = people ?? [await account(), await account()];
  const [aliceNode, bobNode] = [await device(alice, hub), await device(bob, hub)];
  const shared = await aliceNode.spaces.create({ name: 'Club', ...team, visibility });
  const invite = await aliceNode.spaces.invite(shared.id);
  await bobNode.spaces.join(invite);
  await hold(aliceNode, shared.id);
  await joined(bobNode, shared.id);
  const subscriptions = [await subscriptionId(), await subscriptionId()] as const;
  await node.subscribe(subscriptions[0]);
  await node.subscribe(subscriptions[1]);
  await node.attach(
    subscriptions[0],
    alice.did,
    (await aliceNode.carriers.add({ did: node.did, name: 'Host' })).invite,
  );
  await node.attach(
    subscriptions[1],
    bob.did,
    (await bobNode.carriers.add({ did: node.did, name: 'Host' })).invite,
  );
  await until(carries(node, shared.id), 8000, 'the shared space to be carried');
  return { alice, bob, aliceNode, bobNode, space: shared.id, invite, subscriptions };
}

/** Writes until the host has counted each writer */
async function bothWrite(node: HostNode, c: Awaited<ReturnType<typeof community>>) {
  await c.aliceNode.records.put(c.space, 'note', { text: 'from Alice' });
  await c.bobNode.records.put(c.space, 'note', { text: 'from Bob' });
  await until(async () => (await node.usage(c.space))?.writers === 2, 8000, 'both writers to be counted');
}

describe('plans', () => {
  test('an account’s subscription is active on the free plan with nothing paid, never swept for it; paid while paidUntil is ahead', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const me = await account();
    const laptop = await device(me, hub);
    const notes = await laptop.spaces.create({ name: 'Notes', visibility: 'private' });
    const id = await subscriptionId();
    const subscription = await node.subscribe(id);
    assert.equal(subscription.paidUntil, 0);
    assert.equal(node.state(subscription), 'active');
    assert.equal(node.plan(subscription), 'free');
    await node.attach(id, me.did, (await laptop.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, notes.id), 5000, 'the space to be carried without payment');

    await node.extend(id, clock + 10);
    assert.equal(node.plan((await node.get(id))!), 'paid');
    clock += 400 * DAY;
    assert.equal(node.state((await node.get(id))!), 'active', 'past paid time: free again, never lapsed');
    assert.equal(node.plan((await node.get(id))!), 'free');
    await node.seen(id);
    assert.deepEqual(await node.sweep(), []);
    assert.equal(await carries(node, notes.id)(), true);

    // A space's own subscription still needs its fund.
    const own = await node.subscribe(spaceSubscription('somespace'));
    assert.equal(node.state(own), 'lapsed');
    assert.equal(node.plan(own), null);
  });

  test('a free subscription none of whose devices called for idleDays is dropped; one that called stays', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const [quiet, calling, paying] = [await subscriptionId(), await subscriptionId(), await subscriptionId()];
    for (const id of [quiet, calling, paying]) await node.subscribe(id);
    // The first sweep counts from now, not from when they were made.
    assert.deepEqual(await node.sweep(), []);
    clock += 100 * DAY;
    await node.seen(calling);
    await node.extend(paying, clock + 400 * DAY);
    clock += 81 * DAY;
    assert.deepEqual(await node.sweep(), [quiet]);
    assert.equal(await node.get(quiet), null);
    assert.ok(await node.get(calling));
    assert.ok(await node.get(paying), 'a paid one is never dropped for being idle');
  });

  test('without limits nothing changes: an unpaid subscription is not active, and has no plan', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub, { limits: undefined });
    const subscription = await node.subscribe(await subscriptionId());
    assert.equal(node.state(subscription), 'lapsed');
    assert.equal(node.plan(subscription), null);
    assert.equal(node.limits, null);
    const free = await host(hub, { free: true });
    assert.equal(free.limits, null, 'free means no limits');
  });
});

describe('room', () => {
  test('a space held back for one subscription’s room stays carried for another that names it', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub, { limits: { ...LIMITS, space: { ...LIMITS.space, writers: 10 } } });
    const c = await community(hub, node);
    const mine = await c.aliceNode.spaces.create({ name: 'Mine', visibility: 'private' });
    await until(carries(node, mine.id), 8000, 'Alice’s own space carried');
    // Alice is out of room: the club and her own space wait, for her.
    await node.holdForRoom(c.subscriptions[0], [c.space, mine.id]);
    await until(async () => !(await carries(node, mine.id)()), 5000, 'her own space let go');
    assert.equal(await carries(node, c.space)(), true, 'the club, which Bob names with room, stays');
  });

  test('over its room: a notice that a dip under does not reset, then the spaces held back wait until they fit', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const mirror = createMemoryBlobStore();
    const node = await host(hub, { now: () => clock, mirror });
    const me = await account();
    const laptop = await device(me, hub);
    const photos = await laptop.spaces.create({ name: 'Photos', visibility: 'private' });
    const id = await subscriptionId();
    await node.subscribe(id);
    await node.attach(id, me.did, (await laptop.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, photos.id), 5000, 'the space to be carried');
    await until(async () => (await mirror.list(`${photos.id}/`)).length > 0, 8000, 'the bucket to hold it');

    await node.setFull(id, true);
    const since = node.fullUntil((await node.get(id))!)?.since;
    assert.equal(since, clock);
    assert.equal(node.outOfRoom((await node.get(id))!), false, 'within its notice');
    // Under for an hour, over again: the same notice, not a new one.
    clock += 3600;
    await node.setFull(id, false);
    clock += 3600;
    await node.setFull(id, true);
    assert.equal(node.fullUntil((await node.get(id))!)?.since, since);

    clock += 30 * DAY;
    assert.equal(node.outOfRoom((await node.get(id))!), true);
    await node.holdForRoom(id, [photos.id]);
    await until(async () => !(await carries(node, photos.id)()), 5000, 'held back');
    assert.ok((await node.namedFor(id)).includes(photos.id), 'still named');
    assert.ok((await mirror.list(`${photos.id}/`)).length > 0, 'the host keeps its copy');

    await node.holdForRoom(id, []);
    await until(carries(node, photos.id), 5000, 'taken back once it fits');
    // A whole window fitting, and the notice goes.
    await node.setFull(id, false);
    clock += 31 * DAY;
    await node.setFull(id, false);
    assert.equal(node.fullUntil((await node.get(id))!), null);
  });

  test('a carry space over its room by itself is let go, and turned away when handed over again, under any key', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub);
    const me = await account();
    const laptop = await device(me, hub);
    const id = await subscriptionId();
    await node.subscribe(id);
    const { invite } = await laptop.carriers.add({ did: node.did, name: 'Host' });
    await node.attach(id, me.did, invite);
    await node.refuse(id);
    assert.equal((await node.get(id))?.carry, undefined);
    await assert.rejects(node.attach(id, me.did, invite), /over its room/);
    const fresh = await subscriptionId();
    await node.subscribe(fresh);
    await assert.rejects(
      node.attach(fresh, me.did, invite),
      /over its room/,
      'a new key brings nothing back',
    );
  });

  test('a refusal comes back with the bucket on a new disk', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const mirror = createMemoryBlobStore();
    const key = await provider.generateKeyPair();
    const node = await host(hub, { mirror, key });
    const me = await account();
    const laptop = await device(me, hub);
    const id = await subscriptionId();
    await node.subscribe(id);
    const { invite } = await laptop.carriers.add({ did: node.did, name: 'Host' });
    await node.attach(id, me.did, invite);
    await node.refuse(id);
    await node.close();
    open.splice(open.indexOf(node), 1);
    const again = await host(hub, { mirror, key, stores: memoryStores() });
    const fresh = await subscriptionId();
    await again.subscribe(fresh);
    await assert.rejects(again.attach(fresh, me.did, invite), /over its room/);
  });

  test('the notice is the account’s: a new subscription key starts nothing anew', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const me = await account();
    const laptop = await device(me, hub);
    const { invite } = await laptop.carriers.add({ did: node.did, name: 'Host' });
    const first = await subscriptionId();
    await node.subscribe(first);
    await node.attach(first, me.did, invite);
    await node.setFull(first, true);
    const since = node.fullUntil((await node.get(first))!)?.since;
    clock += 29 * DAY;
    await node.detach(first);
    const second = await subscriptionId();
    await node.subscribe(second);
    await node.attach(second, me.did, invite);
    await node.setFull(second, true);
    assert.equal(node.fullUntil((await node.get(second))!)?.since, since);
    clock += 2 * DAY;
    assert.equal(node.outOfRoom((await node.get(second))!), true);
  });
});

describe('counting a space’s writers', () => {
  test('a version counts the account its note is from; one account’s two devices count once', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub);
    const c = await community(hub, node);
    // Founding and joining are each a version: both count from the start.
    await until(async () => (await node.usage(c.space))?.writers === 2, 8000, 'Alice and Bob to be counted');
    const phone = await device(c.alice, hub);
    await until(
      async () => (await phone.spaces.list()).some((space) => space.id === c.space),
      8000,
      'the phone to hold the space',
    );
    await hold(phone, c.space);
    await phone.records.put(c.space, 'note', { text: 'phone' });
    await until(
      async () => (await c.bobNode.records.list(c.space, { collection: 'note' })).length === 1,
      8000,
      'the phone’s note to reach the others',
    );
    await settle(300);
    assert.equal((await node.usage(c.space))?.writers, 2, 'two devices, one account');
  });

  test('the host’s own bots are not counted', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const [alice, bot] = [await account(), await account()];
    const node = await host(hub, { ignore: (account) => account === bot.did });
    const c = await community(hub, node, 'private', [alice, bot]);
    await c.bobNode.records.put(c.space, 'note', { text: 'the bot' });
    await until(
      async () => (await c.aliceNode.records.list(c.space, { collection: 'note' })).length === 1,
      8000,
      'the bot’s note to arrive',
    );
    await settle(300);
    assert.equal((await node.usage(c.space))?.writers, 1, 'Alice, and not the bot');
  });

  test('history is not counted while the host first catches up; after that, a backdated write counts as any', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    // The host's clock is 40 days ahead of the devices': all they write says it is 40 days old.
    let clock = Math.floor(Date.now() / 1000) + 40 * DAY;
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node);
    await settle(500);
    assert.equal((await node.usage(c.space))?.writers, 0, 'founding and joining arrived as history');

    clock += 11 * 60;
    await c.aliceNode.records.put(c.space, 'note', { text: 'a' });
    await c.bobNode.records.put(c.space, 'note', { text: 'b' });
    await until(
      async () => (await node.usage(c.space))?.writers === 2,
      8000,
      'both counted, backdated or not',
    );
    await node.evaluate();
    assert.equal((await node.overFor(c.subscriptions[0])).length, 1, 'so the space is over the line');
  });

  test('a member removed no longer counts as a writer', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub);
    const c = await community(hub, node);
    await bothWrite(node, c);
    await c.aliceNode.spaces.removeMember(c.space, c.bob.did);
    await until(async () => (await node.usage(c.space))?.writers === 1, 8000, 'Bob to stop counting');
    await c.bobNode.records.put(c.space, 'note', { text: 'still trying' }).catch(() => {});
    await settle(500);
    assert.equal((await node.usage(c.space))?.writers, 1);
  });

  test('readers alone never put a space over the line', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub, { limits: { ...LIMITS, space: { ...LIMITS.space, writers: 10 } } });
    const c = await community(hub, node, 'public');
    for (let i = 0; i < 100; i += 1) node.read(c.space, `did:key:zDnaeReader${i}`);
    assert.equal((await node.usage(c.space))?.readers, 100);
    await node.evaluate();
    assert.deepEqual(await node.overFor(c.subscriptions[0]), []);
  });
});

describe('the free line', () => {
  test('over the line: noted with a date, carried through the grace, said in every member’s status', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    const [over] = await node.overFor(c.subscriptions[0]);
    assert.deepEqual(over, { space: c.space, since: clock, until: clock + 30 * DAY, reasons: ['writers'] });
    assert.deepEqual(await node.overFor(c.subscriptions[1]), [over]);
    assert.deepEqual(
      await node.overFor(spaceSubscription(c.space)),
      [over],
      'and at the space’s own address',
    );

    clock += 29 * DAY;
    await node.evaluate();
    assert.equal(await carries(node, c.space)(), true, 'still within the grace');
  });

  test("past until, members' subscriptions no longer carry it; members keep what they hold", async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const mirror = createMemoryBlobStore();
    const node = await host(hub, { now: () => clock, mirror });
    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    await until(async () => (await mirror.list(`${c.space}/`)).length > 0, 8000, 'the bucket to hold it');
    clock += 31 * DAY;
    // Still busy as its grace runs out.
    await bothWrite(node, c);
    await until(
      async () => (await c.aliceNode.records.list(c.space, { collection: 'note' })).length === 4,
      8000,
      'every note to reach Alice',
    );
    const held = 4;
    await node.evaluate();
    await until(async () => !(await carries(node, c.space)()), 5000, 'the host to stop carrying it');
    const [over] = await node.overFor(c.subscriptions[0]);
    assert.equal(over?.space, c.space, 'still said, with the date it stopped');
    assert.ok((await node.namedFor(c.subscriptions[0])).includes(c.space), 'the subscription still names it');
    assert.ok((await mirror.list(`${c.space}/`)).length > 0, 'the bucket keeps it a while');

    // The members hold all they held, and still sync with each other.
    assert.equal((await c.aliceNode.records.list(c.space, { collection: 'note' })).length, held);
    await c.bobNode.records.put(c.space, 'note', { text: 'still here' });
    await until(
      async () => (await c.aliceNode.records.list(c.space, { collection: 'note' })).length === held + 1,
      8000,
      'Alice to get Bob’s note directly',
    );

    // After keepDays the host forgets it, and the bucket's copy goes.
    clock += 91 * DAY;
    await node.evaluate();
    assert.deepEqual(await mirror.list(`${c.space}/`), []);
  });

  test('its own subscription keeps it carried past until; paying a while does not buy the grace again', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node, 'public');
    await bothWrite(node, c);
    await node.evaluate();
    const [first] = await node.overFor(c.subscriptions[0]);
    assert.ok(first);
    const own = spaceSubscription(c.space);
    await node.extend(own, clock + 60 * DAY);
    await node.carrySpace(own, { v: 1, space: parseSpaceInvite(c.invite).space });

    clock += 45 * DAY;
    await node.evaluate();
    assert.equal(await carries(node, c.space)(), true, 'paid for: the line does not apply');
    assert.deepEqual(
      await node.overFor(c.subscriptions[0]),
      [],
      'its members hear nothing of it while it pays',
    );

    // The fund stopped at day 60: the grace it had ran out long ago.
    clock += 20 * DAY;
    await node.evaluate();
    assert.deepEqual(
      await node.overFor(c.subscriptions[0]),
      [],
      'quiet by now: under the line, nothing to tell',
    );
    assert.equal(await carries(node, c.space)(), true, 'carried still, by its own subscription’s grace');
    // Quiet since its writes left the window, then busy again: its grace is spent, so a short notice.
    clock += 31 * DAY;
    await bothWrite(node, c);
    await node.sweep();
    await node.evaluate();
    assert.equal((await node.overFor(c.subscriptions[0]))[0]?.until, clock + 7 * DAY);
    clock += 8 * DAY;
    await bothWrite(node, c);
    assert.deepEqual((await node.evaluate()).stopped, [c.space]);
    await until(async () => !(await carries(node, c.space)()), 5000, 'nobody to carry it');
  });

  test('stopped once and forgotten, a space over the line again gets no new grace', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const { keepDays: _none, ...limits } = LIMITS;
    const node = await host(hub, { now: () => clock, limits });
    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    clock += 31 * DAY;
    await bothWrite(node, c);
    assert.deepEqual((await node.evaluate()).stopped, [c.space]);
    await until(async () => !(await carries(node, c.space)()), 5000, 'stopped');

    // Forgotten at once without keepDays, so its members carry it again, counted from nothing…
    clock += 60;
    await node.evaluate();
    await until(carries(node, c.space), 8000, 'carried again for members');
    // …and once it is over again, past catching up, it gets a week's notice, not a new grace.
    clock += 11 * 60;
    await bothWrite(node, c);
    clock += 60;
    assert.deepEqual((await node.evaluate()).stopped, []);
    assert.equal((await node.overFor(c.subscriptions[0]))[0]?.until, clock + 7 * DAY);
    clock += 8 * DAY;
    await bothWrite(node, c);
    assert.deepEqual((await node.evaluate()).stopped, [c.space]);
    await until(async () => !(await carries(node, c.space)()), 5000, 'stopped again, without a new grace');
  });

  test('pushed over by joiners removed within the hour, a space is not stopped when its grace runs out', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    // The defaults' shape: the grace as long as the window.
    const node = await host(hub, {
      now: () => clock,
      limits: { ...LIMITS, space: { ...LIMITS.space, writers: 2 } },
    });
    const [alice, one, two] = [await account(), await account(), await account()];
    const aliceNode = await device(alice, hub);
    const club = await aliceNode.spaces.create({ name: 'Club', ...team, visibility: 'private' });
    await hold(aliceNode, club.id);
    const id = await subscriptionId();
    await node.subscribe(id);
    await node.attach(id, alice.did, (await aliceNode.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, club.id), 8000, 'the club to be carried');

    // Someone with the club's invite link joins twice over, and writes.
    const invite = await aliceNode.spaces.invite(club.id);
    for (const who of [one, two]) {
      const joiner = await device(who, hub);
      await joiner.spaces.join(invite);
      await joined(joiner, club.id);
      await joiner.records.put(club.id, 'note', { text: 'hi' });
    }
    await until(async () => (await node.usage(club.id))?.writers === 3, 8000, 'three writers');
    await node.evaluate();
    assert.equal((await node.overFor(id)).length, 1, 'over');

    clock += 3600;
    await aliceNode.spaces.removeMember(club.id, one.did);
    await aliceNode.spaces.removeMember(club.id, two.did);
    await until(async () => (await node.usage(club.id))?.writers === 1, 8000, 'only Alice counts');
    clock += 30 * DAY;
    assert.deepEqual((await node.evaluate()).stopped, [], 'under the line when its grace ran out');
    assert.equal(await carries(node, club.id)(), true);
    // A whole window well under, and the notice goes. (Removing them changed the key, so a look
    // that found the space being opened again judged nothing: one more after a window.)
    clock += 30 * DAY;
    await node.evaluate();
    clock += 31 * DAY;
    await node.evaluate();
    assert.deepEqual(await node.overFor(id), []);
  });

  test('a shared space handed over as someone’s carry space is refused, so every member is told of the line', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const mirror = createMemoryBlobStore();
    const node = await host(hub, { mirror });
    const c = await community(hub, node);
    await until(async () => (await mirror.list(`${c.space}/`)).length > 0, 8000, 'the bucket to hold it');
    // Someone who only holds the club's invite link, with a free subscription of their own.
    const stranger = await account();
    const theirs = await subscriptionId();
    await node.subscribe(theirs);
    await assert.rejects(node.attach(theirs, stranger.did, c.invite), /not a carry space/);
    assert.ok((await mirror.list(`${c.space}/`)).length > 0, 'the host keeps its copy');
    assert.equal(await carries(node, c.space)(), true);
    // The trick: the club itself, handed over in place of Alice's carry space.
    const id = await subscriptionId();
    await node.subscribe(id);
    await assert.rejects(
      node.attach(id, c.alice.did, await c.aliceNode.spaces.invite(c.space)),
      /not a carry space/,
    );
    assert.equal((await node.get(id))?.carry, undefined);
    // Nor did trying take the host's copy of it.
    // So the club is still Bob's to name, and he is told when it goes over.
    await bothWrite(node, c);
    await node.evaluate();
    assert.equal((await node.overFor(c.subscriptions[1]))[0]?.space, c.space);
    assert.equal(await carries(node, c.space)(), true);
  });

  test('free again after a whole window under, a space’s grace is its own again; over again after it was spent, a short notice', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node, 'public');
    await bothWrite(node, c);
    await node.evaluate();
    clock += 31 * DAY;
    await bothWrite(node, c);
    assert.deepEqual((await node.evaluate()).stopped, [c.space]);

    // Its fund pays, and it goes quiet for two windows: its line goes, and the stop with it.
    const own = spaceSubscription(c.space);
    await node.extend(own, clock + 100 * DAY);
    await node.carrySpace(own, { v: 1, space: parseSpaceInvite(c.invite).space });
    clock += 31 * DAY;
    await node.evaluate();
    clock += 31 * DAY;
    assert.deepEqual((await node.evaluate()).under, [c.space]);
    clock += 60 * DAY;
    await node.sweep();
    await node.evaluate();
    await until(carries(node, c.space), 8000, 'carried for its members again');
    await bothWrite(node, c);
    await node.evaluate();
    const [fresh] = await node.overFor(c.subscriptions[0]);
    assert.equal(fresh?.until, clock + 30 * DAY, 'a whole grace, as for any space');

    // Under before its grace runs out, then over again after: seven days' notice, not a stop.
    clock += 1 * DAY;
    await c.aliceNode.spaces.removeMember(c.space, c.bob.did);
    await until(async () => (await node.usage(c.space))?.writers === 1, 8000, 'only Alice');
    await node.evaluate();
    clock += 30 * DAY;
    await node.evaluate();
    const third = await account();
    const joiner = await device(third, hub);
    await joiner.spaces.join(c.invite);
    await joined(joiner, c.space);
    await c.aliceNode.records.put(c.space, 'note', { text: 'again' });
    await joiner.records.put(c.space, 'note', { text: 'hi' });
    await until(async () => (await node.usage(c.space))?.writers === 2, 8000, 'over again');
    const changed = await node.evaluate();
    assert.deepEqual(changed.stopped, [], 'not stopped at once');
    const [notice] = await node.overFor(c.subscriptions[0]);
    assert.equal(notice?.until, clock + 7 * DAY);
  });

  test('a space nobody names for a while keeps its line: letting go for an hour buys no new grace', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    const [first] = await node.overFor(c.subscriptions[0]);
    assert.ok(first);

    // Just before until, both members let the host go for one look, then hand it back.
    clock += 29 * DAY;
    await node.detach(c.subscriptions[0]);
    await node.detach(c.subscriptions[1]);
    await until(async () => !(await carries(node, c.space)()), 5000, 'let go');
    assert.deepEqual((await node.evaluate()).under, []);
    await node.attach(
      c.subscriptions[0],
      c.alice.did,
      (await c.aliceNode.carriers.add({ did: node.did, name: 'Host' })).invite,
    );
    await node.attach(
      c.subscriptions[1],
      c.bob.did,
      (await c.bobNode.carriers.add({ did: node.did, name: 'Host' })).invite,
    );
    await until(carries(node, c.space), 8000, 'carried again');
    await node.evaluate();
    assert.equal((await node.overFor(c.subscriptions[0]))[0]?.until, first.until, 'the same date');

    clock += 2 * DAY;
    await bothWrite(node, c);
    assert.deepEqual((await node.evaluate()).stopped, [c.space], 'stopped on the first date');
  });

  test('removing a member for an hour as the date passes buys nothing: over in its last days, it is stopped', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const node = await host(hub, { now: () => clock });
    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    clock += 25 * DAY;
    await bothWrite(node, c);
    await node.evaluate();
    // An hour before its date, Bob is removed; the look after the date finds it under.
    clock += 5 * DAY - 3600;
    await c.aliceNode.spaces.removeMember(c.space, c.bob.did);
    await until(async () => (await node.usage(c.space))?.writers === 1, 8000, 'only Alice');
    clock += 2 * 3600;
    assert.deepEqual((await node.evaluate()).stopped, [c.space], 'over five days ago: stopped all the same');
  });

  test('a device ignores an over entry or a usage not shaped as the spec says', async () => {
    const key = await provider.generateKeyPair();
    const did = await didOf(key.publicKey, provider);
    const status = {
      subscription: 'did:key:zDnaeMine',
      host: did,
      state: 'active',
      paidUntil: 0,
      renews: false,
      carrying: true,
      spaces: 1,
      at: 1,
      plan: 'gold',
      over: [
        { space: 'club', since: 1, until: 2, reasons: ['writers'] },
        { space: 'club', since: 1, until: 2, reasons: ['writers', 'vibes'] },
        { space: 'club', since: -1, until: 2, reasons: ['bytes'] },
        'nonsense',
      ],
      usage: { writers: 'many', readers: 1, bytes: 1, windowDays: 30 },
    };
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a host saying what it shouldn't
    const signed = await signStatus(status as unknown as HostStatus, key.privateKey, provider);
    const read = await readStatus(signed, did, provider);
    assert.ok(read);
    assert.deepEqual(read.over, [{ space: 'club', since: 1, until: 2, reasons: ['writers'] }]);
    assert.equal(read.usage, undefined);
    assert.equal(read.plan, undefined);
    assert.equal(read.carrying, true, 'the rest of it stands');
  });

  test('bytes count only in a space several accounts write in', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const node = await host(hub, {
      measure: async () => 10_000,
      limits: { ...LIMITS, space: { ...LIMITS.space, writers: 10 } },
    });
    const me = await account();
    const laptop = await device(me, hub);
    const big = await laptop.spaces.create({ name: 'Photos', visibility: 'private' });
    const id = await subscriptionId();
    await node.subscribe(id);
    await node.attach(id, me.did, (await laptop.carriers.add({ did: node.did, name: 'Host' })).invite);
    await until(carries(node, big.id), 5000, 'the space to be carried');
    await laptop.records.put(big.id, 'photo', { name: 'one' });
    await until(async () => (await node.usage(big.id))?.writers === 1, 8000, 'the one writer to be counted');
    await node.evaluate();
    assert.deepEqual(await node.overFor(id), [], 'one writer: never over, however large');

    const c = await community(hub, node);
    await bothWrite(node, c);
    await node.evaluate();
    assert.deepEqual((await node.overFor(c.subscriptions[0]))[0]?.reasons, ['bytes']);
  });

  test('free again only after a whole window well under; a restart keeps the clock', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    let clock = Math.floor(Date.now() / 1000);
    const stores = memoryStores();
    const key = await provider.generateKeyPair();
    const limits = { ...LIMITS, graceDays: 200 };
    const node = await host(hub, { now: () => clock, stores, key, limits });
    const c = await community(hub, node);
    await bothWrite(node, c);
    // Everything in flight arrives before the clock moves, or it counts on a later day.
    await settle(1000);
    await node.evaluate();
    const [first] = await node.overFor(c.subscriptions[0]);
    assert.ok(first);

    // The writes fall out of the window: well under from then on.
    clock += 31 * DAY;
    await node.evaluate();
    clock += 20 * DAY;
    assert.deepEqual((await node.evaluate()).under, [], 'not a whole window yet');
    assert.deepEqual(await node.overFor(c.subscriptions[0]), [], 'back under: not said to be over');

    // A restart keeps when it went under, so the window ends when it would have.
    await node.close();
    open.splice(open.indexOf(node), 1);
    const again = await host(hub, { now: () => clock, stores, key, limits });
    clock += 11 * DAY;
    await until(carries(again, c.space), 8000, 'carried again after the restart');
    assert.deepEqual((await again.evaluate()).under, [c.space]);
  });
});
