/**
 * Places as cells: geohashes a keeper can match as topics, and the cells that
 * cover a circle, so "near here" never misses something inside it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  aroundCell,
  cellOf,
  cellsAround,
  cellsOf,
  centreOf,
  distanceKm,
  geohash,
} from '../src/schemas/geo.js';
import { listing } from '../src/schemas/library/money.js';
import { event } from '../src/schemas/library/planning.js';
import { place } from '../src/schemas/library/life.js';
import { createStorageProvider } from '../src/storage/storage-provider.js';
import { matchesRecord } from '../src/space/own-automations.js';
import { team } from '../src/space/presets.js';
import { createFakeHub } from './helpers/fake-transport.js';
import { person } from './helpers/person.js';

/** A repeatable stream of numbers in [0, 1), so a failure can be run again */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Where you end up going `km` from a point on a bearing, on the same sphere as `distanceKm` */
function travel(from: { lat: number; lon: number }, km: number, bearing: number) {
  const rad = Math.PI / 180;
  const d = km / 6371.0088;
  const lat1 = from.lat * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lon2 =
    from.lon * rad +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 / rad, lon: ((((lon2 / rad + 180) % 360) + 360) % 360) - 180 };
}

describe('geohash', () => {
  test('matches the published examples', () => {
    assert.equal(geohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
    assert.equal(geohash(42.6, -5.6, 5), 'ezs42');
    // The example in docs/standard-library.md, Places and areas.
    assert.deepEqual(cellsOf(59.9226, 10.7522), ['u4x', 'u4xs', 'u4xsu', 'u4xsus']);
  });

  test('a cell holds its point, and a shorter hash is the cell around it', () => {
    const next = random(1);
    for (let i = 0; i < 500; i++) {
      const lat = next() * 180 - 90;
      const lon = next() * 360 - 180;
      const hash = geohash(lat, lon, 9);
      const cell = cellOf(hash);
      assert.ok(cell.south <= lat && lat <= cell.north && cell.west <= lon && lon <= cell.east);
      for (let p = 1; p < 9; p++) assert.equal(geohash(lat, lon, p), hash.slice(0, p));
    }
  });

  test('refuses what is not a point or not a geohash', () => {
    assert.throws(() => geohash(91, 0, 5), RangeError);
    assert.throws(() => geohash(0, 0, 13), RangeError);
    assert.throws(() => cellOf('ua'), RangeError);
  });

  test('a cell and the eight around it tile a box three cells wide, wrapping at 180°', () => {
    const around = aroundCell('u4pruy');
    assert.equal(around.length, 9);
    assert.ok(around.includes('u4pruy'));
    const cell = cellOf('u4pruy');
    const boxes = around.map(cellOf);
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    assert.ok(close(Math.min(...boxes.map((b) => b.south)), cell.south - (cell.north - cell.south)));
    assert.ok(close(Math.max(...boxes.map((b) => b.east)), cell.east + (cell.east - cell.west)));

    const edge = geohash(10, 179.99, 5);
    assert.ok(aroundCell(edge).some((hash) => centreOf(hash).lon < -179));
    // At a pole there is nothing further north.
    assert.equal(aroundCell(geohash(89.99, 0, 3)).length, 6);
  });
});

describe('cells around a point', () => {
  test('hold everything within the radius, from the equator to the poles', () => {
    const next = random(7);
    for (let i = 0; i < 20000; i++) {
      const centre = { lat: next() * 179.8 - 89.9, lon: next() * 360 - 180 };
      const radius = 0.05 + next() * 150;
      const area = cellsAround(centre.lat, centre.lon, radius);
      if (!area) continue;
      const inside = travel(centre, next() * radius, next() * 2 * Math.PI);
      assert.ok(
        area.cells.includes(geohash(inside.lat, inside.lon, area.precision)),
        `${JSON.stringify(inside)} is ${radius} km or less from ${JSON.stringify(centre)}`,
      );
    }
  });

  test('pick the finest cells that are big enough, and give up when none are', () => {
    assert.equal(cellsAround(59.92, 10.75, 0.5)?.precision, 6);
    assert.equal(cellsAround(59.92, 10.75, 2)?.precision, 5);
    assert.equal(cellsAround(59.92, 10.75, 8)?.precision, 4);
    assert.equal(cellsAround(59.92, 10.75, 60)?.precision, 3);
    assert.equal(cellsAround(59.92, 10.75, 500), null);
    // A circle around a pole has every longitude in it.
    assert.equal(cellsAround(89.5, 0, 80), null);
    assert.equal(cellsAround(89.5, 0, 1)?.precision, 3);
  });

  test('distances are along the surface', () => {
    assert.ok(Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111.195) < 0.001);
    assert.equal(distanceKm({ lat: 59.92, lon: 10.75 }, { lat: 59.92, lon: 10.75 }), 0);
    const there = travel({ lat: 59.92, lon: 10.75 }, 42, 1);
    assert.ok(Math.abs(distanceKm({ lat: 59.92, lon: 10.75 }, there) - 42) < 1e-6);
  });
});

describe('places as topics', () => {
  test('events, listings and places say their cells as topics', () => {
    assert.deepEqual(event.topics, ['place.cells']);
    assert.deepEqual(listing.topics, ['place.cells']);
    assert.deepEqual(place.topics, ['cells']);
  });

  test('a keeper finds listings near a point by its cells, without reading them', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Market', ...team, visibility: 'private' });
    await alice.node.collections.define(space, listing);
    const since = new Date(Date.now() - 1000).toISOString();

    const at = (lat: number, lon: number) => ({ lat, lon, cells: cellsOf(lat, lon) });
    const near = await alice.node.records.put(space, listing, {
      title: 'Table',
      place: at(59.9215, 10.7585),
    });
    const far = await alice.node.records.put(space, listing, { title: 'Lamp', place: at(60.3913, 5.3221) });

    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(near.key);
    for (const cell of cellsOf(59.9215, 10.7585)) {
      assert.ok(
        stored?.tags?.includes(await alice.node.collections.tag(space, listing.name, 'place.cells', cell)),
      );
    }

    // Within 3 km of Grünerløkka: nine cells, each a tag a keeper can match.
    const area = cellsAround(59.9226, 10.7522, 3);
    assert.ok(area);
    // Any of the nine: what a carrier holds as nine tags.
    const found = [near, far].filter((record) =>
      matchesRecord(
        {
          name: 'Near',
          when: { query: { collection: listing.name, where: { 'place.cells': { $in: area.cells } } } },
          then: { kind: 'notify', text: 'Near' },
          spaces: 'all',
          since,
        },
        record,
        'did:key:zDnaeBob',
      ),
    );
    assert.deepEqual(
      found.map((record) => record.key),
      [near.key],
    );
  });

  test('a listing carries one tag per cell, four in all', async () => {
    const hub = createFakeHub({ latencyMs: 1 });
    const alice = await person(hub);
    const { id: space } = await alice.node.spaces.create({ name: 'Market', ...team, visibility: 'public' });
    await alice.node.collections.define(space, listing);
    const record = await alice.node.records.put(space, listing, {
      title: 'Bike',
      place: { lat: 59.92, lon: 10.75, cells: cellsOf(59.92, 10.75) },
    });
    const stored = await createStorageProvider(await alice.stores(`spaces/${space}`)).getCurrent(record.key);
    assert.equal(stored?.tags?.length, 4);
  });
});
