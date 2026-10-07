/**
 * What a cutoff may name is bounded (spec 03 §6.3), and shared: nobody can
 * make themselves unremovable, or crowd others out, by writing into many
 * collections. The thousand versions are signed by hand and put straight
 * into Alice's copy, as if they had synced: writing and syncing that many
 * would take most of a minute.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createP256Provider } from '../src/identity/crypto-p256.js';
import { publicKeyToDid, P256_MULTICODEC } from '../src/identity/did.js';
import { createLocalRootSigner } from '../src/identity/root-signer.js';
import { createSigner } from '../src/schema/signer.js';
import { createVersion } from '../src/schema/version.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { team } from '../src/space/presets.js';
import type { Version } from '../src/types.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { joined } from './helpers/joined.js';
import { hold, letGo } from './helpers/hold.js';
import { until } from './helpers/until.js';
import { person, type Person } from './helpers/person.js';

const provider = createP256Provider();

async function sharedWithBob() {
  const hub = createFakeHub({ latencyMs: 1 });
  const alice = await person(hub);
  const bob = await person(hub);
  const { id: space } = await alice.node.spaces.create({ name: 'Plans', ...team, visibility: 'public' });
  await bob.node.spaces.join(await alice.node.spaces.invite(space));
  await hold(alice.node, space);
  await joined(bob.node, space);
  return { hub, alice, bob, space };
}

/** One record in each of `count` collections nobody defined, signed by one key of `who`'s, put into `into`'s copy */
async function pad(who: Person, into: Person, space: string, count: number): Promise<void> {
  const pair = await provider.generateKeyPair();
  const keyDid = publicKeyToDid(await provider.exportPublicKey(pair.publicKey), P256_MULTICODEC);
  const note = await createLocalRootSigner(who.me, who.manager.getProvider()).delegate({
    audience: keyDid,
    capabilities: [{ with: `space:${space}`, can: '*' }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const seen = [...(await who.node.spaces.access(space)).heads];
  const versions: Version[] = [];
  for (let i = 0; i < count; i++) {
    const prev = versions.at(-1);
    versions.push(
      await createSigner(provider).sign(
        createVersion({
          author: keyDid,
          collection: `app.junk${i}`,
          space,
          body: { i },
          proof: note.encoded,
          seen,
          log: { n: i, ...(prev ? { prev: prev.id } : {}), c: { n: 0 } },
        }),
        pair.privateKey,
      ),
    );
  }
  await letGo(into.node, space);
  const store = createStorageProvider(await into.stores(`spaces/${space}`));
  for (const version of versions) await store.addVersion(version);
  await hold(into.node, space);
}

describe('cutoff limits', () => {
  test('nobody makes themselves unremovable by writing into more collections than a cutoff may name', async () => {
    const { alice, bob, space } = await sharedWithBob();
    await pad(bob, alice, space, 1030);
    await alice.node.spaces.setMember(space, bob.node.did, null);
    assert.equal(
      (await alice.node.spaces.access(space)).members.some((m) => m.did === bob.node.did),
      false,
    );
  });

  test('a change reaching many accounts shares what its cutoff may name: one holder’s writing can’t crowd out another’s', async () => {
    const { hub, alice, bob, space } = await sharedWithBob();
    const carol = await person(hub);
    await carol.node.spaces.join(await alice.node.spaces.invite(space));
    await joined(carol.node, space);
    const note = await carol.node.records.put(space, 'app.note', { text: 'honest' });
    await until(async () => (await alice.node.records.get(space, note.key)) !== null, 4000, 'the note');
    await pad(bob, alice, space, 1030);
    await alice.node.spaces.removeRole(space, 'editor');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.notEqual(
      await alice.node.records.get(space, note.key),
      null,
      'what Alice had seen of Carol stands',
    );
  });
});
