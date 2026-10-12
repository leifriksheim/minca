/**
 * The space's constitution, for now its genesis (spec 03 §1.2, §2.1): the
 * founding roles and their grants are part of the id, so nobody who hands a
 * space on can change who founded it or with which grants.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assignKey, checkSpace, removalKey, spaceGenesis, spaceIdOf } from '../src/space/space-access.js';
import { deriveReadKey } from '../src/space/space-access.js';
import { spaceKeyFromRaw } from '../src/privacy/space-encryption.js';
import { createP256Provider } from '../src/identity/crypto-p256.js';
import { canonicalize } from '../src/schema/version.js';
import { checkFoundingRoles, COLLECTION_DEFINE, ROLE_ASSIGN } from '../src/space/grants.js';
import { community, solo, team } from '../src/space/presets.js';
import type { Space, SpaceRole } from '../src/types.js';

const CREATOR = 'did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg';
const EDITOR: SpaceRole = {
  name: 'editor',
  title: 'Editor',
  grants: [
    { cmd: '/record', pol: [] },
    { cmd: COLLECTION_DEFINE, pol: [] },
    { cmd: ROLE_ASSIGN, pol: [['==', '.role', 'editor']] },
  ],
};

describe('the genesis examples (03 §1.2)', () => {
  const fixed = {
    creator: CREATOR,
    roles: [EDITOR],
    createdAt: '2026-01-01T00:00:00.000Z',
    nonce: 'AAECAwQFBgcICQoL',
  };

  test('public', async () => {
    const genesis = spaceGenesis({ ...fixed, visibility: 'public' });
    assert.equal(
      canonicalize(genesis),
      '{"createdAt":"2026-01-01T00:00:00.000Z","creator":"did:key:zDnaeZLoH5izvFBqsJ62j3zJ2DYJWASAB7QFmkYR6aeAzhCLg","nonce":"AAECAwQFBgcICQoL","roles":[{"grants":[{"cmd":"/record","pol":[]},{"cmd":"/collection/define","pol":[]},{"cmd":"/role/assign","pol":[["==",".role","editor"]]}],"name":"editor","title":"Editor"}],"v":3,"visibility":"public"}',
    );
    assert.equal(await spaceIdOf(genesis), 'bzwgno6q3imhf6eirh7hbowfzmdva6qcfqd7dfrprl6p77jjrrr7q');
  });

  test('private, with the key of 03 §8.1', async () => {
    const key = await spaceKeyFromRaw(
      new Uint8Array(32).map((_, i) => 0xff - i),
      fixed.createdAt,
    );
    const readKey = (await deriveReadKey(key, createP256Provider())).did;
    const genesis = spaceGenesis({ ...fixed, visibility: 'private', readKey, encryptionKeyId: key.id });
    assert.equal(key.id, 'aLhvw5pkV65_lcQHEcUOug');
    assert.equal(await spaceIdOf(genesis), 'bvm5is7n2nm7ex3vy7hn2yllhsoi3dxezkrwvv6thhlfb5dioxdta');
  });
});

describe('founding roles', () => {
  test('the templates are well formed', () => {
    for (const preset of [solo, team, community]) assert.equal(checkFoundingRoles(preset.roles), null);
  });

  test('a malformed role, grant or nesting is refused', () => {
    const bad = (role: unknown) => checkFoundingRoles([role]);
    assert.match(String(bad({ ...EDITOR, rank: 3 })), /no field rank/);
    assert.match(String(bad({ ...EDITOR, name: 'Editor' })), /role name/);
    assert.match(String(bad({ ...EDITOR, grants: [{ cmd: 'record', pol: [] }] })), /command path/);
    assert.match(String(bad({ ...EDITOR, grants: [{ cmd: '/record', pol: [['??']] }] })), /operator/i);
    assert.match(
      String(bad({ ...EDITOR, grants: [{ cmd: '/record', pol: [], exp: 1 }] })),
      /only cmd and pol/,
    );
    assert.match(String(bad({ ...EDITOR, nests: ['editor'] })), /nests other roles/);
    assert.match(String(checkFoundingRoles([EDITOR, EDITOR])), /share a name/);
  });

  test('changing a founding grant changes the id: a space handed on can’t be given more power', async () => {
    const space = {
      ...spaceGenesis({
        creator: CREATOR,
        roles: [EDITOR],
        createdAt: 'x',
        nonce: 'n',
        visibility: 'public',
      }),
    };
    const id = await spaceIdOf(space);
    const real: Space = {
      id,
      name: 'Plans',
      creator: CREATOR,
      roles: [EDITOR],
      createdAt: 'x',
      nonce: 'n',
      visibility: 'public',
    };
    assert.equal(await checkSpace(real), null);
    const widened = { ...real, roles: [{ ...EDITOR, grants: [{ cmd: '/', pol: [] }] }] };
    assert.match(String(await checkSpace(widened)), /id does not match/);
  });
});

describe('access record keys (03 §3.1)', () => {
  test('an assignment names the account and the role; a removal, the account', async () => {
    assert.equal(await assignKey(CREATOR, 'editor'), 'assign:0ce7d5918bd19e9cbf36c04809fd02ff2b61e3af');
    assert.equal(await removalKey(CREATOR), 'remove:4ac5085b5ad9c944bd682566b17bbfd1da9c5dab');
  });
});
