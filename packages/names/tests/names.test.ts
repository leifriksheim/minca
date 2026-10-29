import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey, sign } from 'node:crypto';

import {
  contactPublicKey,
  createP256Provider,
  deriveContactKeyBytes,
  deriveInboxKeyBytes,
  deriveInboxSignKeyBytes,
  deriveNameKeyBytes,
  generateSeed,
} from '@minca/core';
import {
  claimUsername,
  encodeInbox,
  parseUsername,
  resolveUsername,
  usernameUrl,
  type Username,
} from '@minca/core/inbox';
import { createNames, type NamesLimits } from '../names.mjs';

const provider = createP256Provider();

/** A name service for `localhost:<its port>`, keeping names in a folder of its own */
async function startNames(
  limits: Partial<NamesLimits> = {},
  dir = mkdtempSync(join(tmpdir(), 'minca-names-')),
) {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const domain = `localhost:${port}`;
  const url = `http://${domain}/.well-known/minca.json`;
  const names = createNames({ domain, claim: url, dir, limits: { workBits: 4, ...limits } });
  server.on('request', (req, res) => {
    if (!names.handle(req, res)) res.writeHead(404).end();
  });
  return {
    domain,
    url,
    dir,
    at: (name: string) => `${name}@${domain}`,
    close: () => {
      names.close();
      server.close();
    },
  };
}

/** Someone's contact key, an inbox code of theirs, and the name key for a username */
async function someone(username: string) {
  const contact = await deriveContactKeyBytes(generateSeed());
  return { contact, code: await inboxCode(contact, 0), nameKey: await deriveNameKeyBytes(contact, username) };
}

async function inboxCode(contact: Uint8Array, gen: number) {
  const signKey = await deriveInboxSignKeyBytes(contact, gen);
  const key = contactPublicKey(await deriveInboxKeyBytes(contact, gen));
  return encodeInbox(
    signKey,
    { key, sign: contactPublicKey(signKey), gen, places: ['wss://relay.example'] },
    provider,
  );
}

/** Signs as a name key does, with node's crypto, so a test can sign whatever it likes */
function signAs(nameKey: Uint8Array, text: string): string {
  const der = Buffer.concat([
    Buffer.from('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
    Buffer.from(nameKey),
  ]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

/** A work counter reaching `bits` */
function workFor(username: string, key: string, at: number, bits: number): number {
  for (let work = 0; ; work++) {
    const hash = createHash('sha256').update(`minca/name-work/v1|${username}|${key}|${at}|${work}`).digest();
    let zero = true;
    for (let i = 0; i < bits && zero; i++) zero = ((hash[i >> 3]! >> (7 - (i & 7))) & 1) === 0;
    if (zero) return work;
  }
}

/** Posts a claim built by hand */
async function post(url: string, claim: Record<string, unknown>) {
  const answer = await fetch(url, { method: 'POST', body: JSON.stringify(claim) });
  const json: unknown = await answer.json();
  return { status: answer.status, json };
}

describe('a username', () => {
  test('is a name at a domain, in lower case, with or without a leading @', () => {
    assert.deepEqual(parseUsername('Leif@Minca.Social'), { name: 'leif', domain: 'minca.social' });
    assert.deepEqual(parseUsername(' @anna.b@example.org '), { name: 'anna.b', domain: 'example.org' });
    assert.deepEqual(parseUsername('me@localhost:8787'), { name: 'me', domain: 'localhost:8787' });
    for (const bad of [
      'leif',
      'leif@',
      '@minca.social',
      'le if@minca.social',
      'leif@minca',
      'a@b@c.d',
      'lé@minca.social',
      '.leif@minca.social',
      'leif-@minca.social',
      `${'a'.repeat(65)}@minca.social`,
      'leif@-minca.social',
    ])
      assert.equal(parseUsername(bad), null, bad);
  });

  test('is looked up over https at its domain, and over http only on this machine', () => {
    const url = (domain: string) => usernameUrl({ name: 'leif', domain } satisfies Username);
    assert.equal(url('minca.social'), 'https://minca.social/.well-known/minca.json?name=leif');
    assert.equal(url('localhost:8787'), 'http://localhost:8787/.well-known/minca.json?name=leif');
    // A domain that starts with "localhost" is someone else's.
    assert.match(url('localhost.attacker.example'), /^https:/);
    assert.match(url('localhostclub.org'), /^https:/);
  });

  test('is never an address: a domain ends in a label with a letter', () => {
    for (const bad of ['x@10.0.0.1', 'x@169.254.169.254', 'x@1.2.3.4'])
      assert.equal(parseUsername(bad), null, bad);
    assert.deepEqual(parseUsername('x@1password.com'), { name: 'x', domain: '1password.com' });
  });

  test("has a name key of its own: another for every username, and none of the inbox's", async () => {
    const contact = await deriveContactKeyBytes(generateSeed());
    const leif = contactPublicKey(await deriveNameKeyBytes(contact, 'leif@minca.social'));
    assert.notEqual(contactPublicKey(await deriveNameKeyBytes(contact, 'leif@example.org')), leif);
    assert.notEqual(contactPublicKey(await deriveInboxSignKeyBytes(contact, 0)), leif);
    assert.notEqual(contactPublicKey(contact), leif);
  });
});

describe('a name service', () => {
  let names: Awaited<ReturnType<typeof startNames>>;
  before(async () => {
    names = await startNames({ newNamesPerNetwork: 1000 });
  });
  after(() => names.close());

  test('a claimed name leads to its inbox code, to any page, and names where claims go', async () => {
    const leif = await someone(names.at('leif'));
    const until = await claimUsername(names.at('leif'), leif.contact, leif.code);
    assert.ok(until > Date.now() + 360 * 24 * 3600_000, 'held for a year');

    const answer = await fetch(usernameUrl({ name: 'leif', domain: names.domain }));
    assert.equal(answer.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await answer.json(), { names: { leif: leif.code }, claim: names.url, work: 4 });

    const found = await resolveUsername(`Leif@${names.domain}`, provider);
    assert.equal(found.code, leif.code);
    assert.deepEqual(found.inbox.places, ['wss://relay.example']);
  });

  test('only the key that holds a name changes it, renews it, or gives it up', async () => {
    const username = names.at('anna');
    const anna = await someone(username);
    const mallory = await someone(username);
    await claimUsername(username, anna.contact, anna.code);

    await assert.rejects(claimUsername(username, mallory.contact, mallory.code), /taken/);
    await assert.rejects(claimUsername(username, mallory.contact, null), /taken/);
    assert.equal((await resolveUsername(username, provider)).code, anna.code);

    // A new inbox keeps the name: the name key doesn't change with the inbox's gen.
    await claimUsername(username, anna.contact, await inboxCode(anna.contact, 1));
    assert.equal((await resolveUsername(username, provider)).inbox.gen, 1);

    await claimUsername(username, anna.contact, null);
    await assert.rejects(resolveUsername(username, provider), /doesn't know/);
  });

  test('a claim is signed by the name key over its name, domain, time and code: anything else is refused', async () => {
    const username = names.at('bea');
    const bea = await someone(username);
    const key = contactPublicKey(bea.nameKey);
    const at = Date.now();
    const work = workFor(username, key, at, 4);
    const claim = (signed: string, sent: Record<string, unknown> = {}) => ({
      name: 'bea',
      key,
      at,
      work,
      code: bea.code,
      sig: signAs(bea.nameKey, signed),
      ...sent,
    });

    const good = `minca/name-claim/v1|${username}|${at}|${bea.code}`;
    for (const [what, sent] of [
      ['another domain', claim(`minca/name-claim/v1|bea@other.example|${at}|${bea.code}`)],
      ['another time', claim(`minca/name-claim/v1|${username}|${at + 1}|${bea.code}`)],
      ['another code', claim(good, { code: 'AAAA' })],
      ['another key', claim(good, { key: contactPublicKey((await someone(username)).nameKey) })],
    ] as const)
      assert.equal((await post(names.url, sent)).status, 400, what);

    assert.equal((await post(names.url, claim(good))).status, 200);
    // The same claim again: a name takes only newer claims.
    assert.equal((await post(names.url, claim(good))).status, 409);
  });

  test("a claim's time is near ours, and it carries enough work", async () => {
    const username = names.at('cleo');
    const cleo = await someone(username);
    const key = contactPublicKey(cleo.nameKey);
    const claimAt = (at: number, work: number) => ({
      name: 'cleo',
      key,
      at,
      work,
      code: cleo.code,
      sig: signAs(cleo.nameKey, `minca/name-claim/v1|${username}|${at}|${cleo.code}`),
    });
    const old = Date.now() - 11 * 60_000;
    assert.equal((await post(names.url, claimAt(old, workFor(username, key, old, 4)))).status, 400);

    const at = Date.now();
    let lazy = 0;
    while (workFor(username, key, at, 4) === lazy) lazy++;
    const refused = await post(names.url, claimAt(at, lazy));
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.json, { error: 'Not enough work' });
  });

  test("a given-up name can't be taken back with a claim made before", async () => {
    const username = names.at('dora');
    const dora = await someone(username);
    const key = contactPublicKey(dora.nameKey);
    const at = Date.now() - 1000;
    const earlier = {
      name: 'dora',
      key,
      at,
      work: workFor(username, key, at, 4),
      code: dora.code,
      sig: signAs(dora.nameKey, `minca/name-claim/v1|${username}|${at}|${dora.code}`),
    };
    assert.equal((await post(names.url, earlier)).status, 200);
    await claimUsername(username, dora.contact, null);
    assert.equal((await post(names.url, earlier)).status, 409);
    await assert.rejects(resolveUsername(username, provider), /doesn't know/);
  });

  test("a code that doesn't check out, or is larger than an inbox code can be, is refused", async () => {
    const username = names.at('junk');
    const junk = await someone(username);
    await claimUsername(username, junk.contact, 'AAAA');
    await assert.rejects(resolveUsername(username, provider), /inbox code/);
    await assert.rejects(claimUsername(username, junk.contact, 'A'.repeat(5000)), /Not a claim/);
  });

  test('names that pass for whoever runs the service are refused', async () => {
    const them = await someone(names.at('support'));
    await assert.rejects(claimUsername(names.at('support'), them.contact, them.code), /taken/);
  });
});

describe('a name service, against what anyone can send', () => {
  test('a request target nothing can parse is answered, and the service goes on', async () => {
    const names = await startNames();
    try {
      for (const target of ['//', '/\\', '//[', '/.well-known/minca.json?name=%E0%A4%A'])
        await new Promise<void>((resolve) => {
          const port = Number(names.domain.split(':')[1]);
          request({ host: '127.0.0.1', port, path: target }, (res) => {
            res.resume();
            res.on('end', resolve);
          })
            .on('error', () => resolve())
            .end();
        });
      const leif = await someone(names.at('leif'));
      await claimUsername(names.at('leif'), leif.contact, leif.code);
    } finally {
      names.close();
    }
  });

  test('a claim it cannot write is refused, and the service goes on', async () => {
    const names = await startNames();
    chmodSync(names.dir, 0o500);
    try {
      const leif = await someone(names.at('leif'));
      await assert.rejects(claimUsername(names.at('leif'), leif.contact, leif.code), /went wrong/);
      chmodSync(names.dir, 0o700);
      await claimUsername(names.at('leif'), leif.contact, leif.code);
    } finally {
      chmodSync(names.dir, 0o700);
      names.close();
    }
  });

  test('every spelling a reader takes claims with the same key, so devices never lock each other out', async () => {
    const names = await startNames();
    try {
      const leif = await someone(names.at('leif'));
      await claimUsername(`@Leif@${names.domain}`, leif.contact, leif.code);
      await claimUsername(names.at('leif'), leif.contact, await inboxCode(leif.contact, 1));
      assert.equal((await resolveUsername(names.at('leif'), provider)).inbox.gen, 1);
    } finally {
      names.close();
    }
  });

  test('a claim made ahead of its clock is no way back to a name given up', async () => {
    const names = await startNames({ clockSkewMs: 1000 });
    try {
      const username = names.at('eve');
      const eve = await someone(username);
      const key = contactPublicKey(eve.nameKey);
      const at = Date.now() + 900;
      const ahead = {
        name: 'eve',
        key,
        at,
        work: workFor(username, key, at, 4),
        code: eve.code,
        sig: signAs(eve.nameKey, `minca/name-claim/v1|${username}|${at}|${eve.code}`),
      };
      assert.equal((await post(names.url, ahead)).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 950));
      await claimUsername(username, eve.contact, null);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.notEqual((await post(names.url, ahead)).status, 200);
      await assert.rejects(resolveUsername(username, provider), /doesn't know/);
    } finally {
      names.close();
    }
  });

  test('a reader takes an answer only with 2xx, and only so large', async () => {
    const leif = await someone('leif@localhost');
    let status = 500;
    let body = JSON.stringify({ names: { leif: leif.code } });
    const server = createServer((_req, res) => res.writeHead(status).end(body));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const at = `leif@localhost:${typeof address === 'object' && address ? address.port : 0}`;
    try {
      for (const refused of [500, 404, 302]) {
        status = refused;
        await assert.rejects(resolveUsername(at, provider), /doesn't know/, String(refused));
      }
      status = 200;
      assert.equal((await resolveUsername(at, provider)).code, leif.code);
      body = JSON.stringify({ names: { leif: leif.code }, pad: 'x'.repeat(1024 * 1024) });
      await assert.rejects(resolveUsername(at, provider), /doesn't know/);
    } finally {
      server.close();
    }
  });
});

describe('a name service, kept', () => {
  test('one address claims only a few new names a day; renewing one held is not a new one', async () => {
    const names = await startNames({ newNamesPerNetwork: 2 });
    try {
      const one = await someone(names.at('one'));
      await claimUsername(names.at('one'), one.contact, one.code);
      const two = await someone(names.at('two'));
      await claimUsername(names.at('two'), two.contact, two.code);
      const three = await someone(names.at('three'));
      await assert.rejects(claimUsername(names.at('three'), three.contact, three.code), /Too many/);
      await claimUsername(names.at('one'), one.contact, one.code);
    } finally {
      names.close();
    }
  });

  test('holds no more names than its limit', async () => {
    const names = await startNames({ maxNames: 1, newNamesPerNetwork: 10 });
    try {
      const one = await someone(names.at('one'));
      await claimUsername(names.at('one'), one.contact, one.code);
      const two = await someone(names.at('two'));
      await assert.rejects(claimUsername(names.at('two'), two.contact, two.code), /No more names/);
    } finally {
      names.close();
    }
  });

  test('names outlive a restart, and lapse when their year is up', async () => {
    const first = await startNames({ lifetimeMs: 1500 });
    const kept = await someone(first.at('kept'));
    await claimUsername(first.at('kept'), kept.contact, kept.code);
    first.close();

    const second = await startNames({}, first.dir);
    try {
      // Another port, so another domain: the name is the same, at the new one.
      const json: unknown = await (await fetch(usernameUrl({ name: 'kept', domain: second.domain }))).json();
      assert.deepEqual(json, { names: { kept: kept.code }, claim: second.url, work: 4 });
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await assert.rejects(resolveUsername(second.at('kept'), provider), /doesn't know/);
      // Lapsed, it is anyone's.
      const next = await someone(second.at('kept'));
      await claimUsername(second.at('kept'), next.contact, next.code);
    } finally {
      second.close();
    }
  });

  test("a lookup that is redirected is refused: the name's domain must answer itself", async () => {
    const server = createServer((_req, res) =>
      res.writeHead(302, { location: 'https://elsewhere.example/' }).end(),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await assert.rejects(resolveUsername(`leif@localhost:${port}`, provider), /doesn't know/);
    } finally {
      server.close();
    }
  });
});
