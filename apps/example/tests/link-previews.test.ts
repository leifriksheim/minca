/**
 * Link previews: what the app's function reads from a page, what it refuses
 * to reach, and what the app takes from its answer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import preview, { isPublicAddress, isWebAddress, readPreview } from '../netlify/functions/preview';
import { previewOf } from '@minca/app-shared/previews';

const at = new URL('https://www.example.com/post/1');

describe('link previews', () => {
  test('a page’s Open Graph tags say what it is, in either attribute order and quoting', () => {
    const page = `<!doctype html><html><head>
      <title>Not this one</title>
      <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;day&quot; out">
      <meta content='A   short
        description' property='og:description' />
      <meta property=og:site_name content=Cartoons>
      <meta property="og:image" content="/pictures/card.png">
      <meta name="twitter:card" content="summary_large_image">
    </head><body></body></html>`;
    assert.deepEqual(readPreview(page, at), {
      url: 'https://www.example.com/post/1',
      title: 'Tom & Jerry\'s "day" out',
      description: 'A short description',
      site: 'Cartoons',
      image: 'https://www.example.com/pictures/card.png',
      large: true,
    });
  });

  test('without Open Graph, Twitter’s tags, then the plain ones, then the host', () => {
    const page = `<head><title> The   title </title>
      <meta name="description" content="Plain">
      <meta name="twitter:description" content="From Twitter">
      <meta name="twitter:image" content="https://cdn.example.com/a.jpg"></head>`;
    assert.deepEqual(readPreview(page, at), {
      url: at.href,
      title: 'The title',
      description: 'From Twitter',
      site: 'example.com',
      image: 'https://cdn.example.com/a.jpg',
      large: false,
    });
  });

  test('a page that says nothing about itself has no preview, and a picture it can’t be given goes', () => {
    assert.equal(readPreview('<html><body>Hello</body></html>', at), null);
    const found = readPreview(
      '<meta property="og:title" content="Hi"><meta property="og:image" content="javascript:alert(1)">',
      at,
    );
    assert.equal(found?.image, undefined);
    assert.equal(
      readPreview(`<meta property="og:title" content="${'a'.repeat(500)}">`, at)?.title.length,
      200,
      'cut short',
    );
  });

  test('it reaches only public addresses, on the usual ports', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      'fe80::1',
      'fd00::1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      'not an address',
    ])
      assert.equal(isPublicAddress(address), false, address);
    for (const address of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      assert.equal(isPublicAddress(address), true, address);

    assert.equal(isWebAddress(new URL('https://example.com/a')), true);
    assert.equal(isWebAddress(new URL('http://example.com:443/a')), true);
    assert.equal(isWebAddress(new URL('http://example.com:9001/a')), false);
    assert.equal(isWebAddress(new URL('https://user:pass@example.com/')), false);
    assert.equal(isWebAddress(new URL('ftp://example.com/')), false);
  });

  test('the function answers anyone, refuses what isn’t a web address, and reads nothing inside', async () => {
    const ask = (url: string) =>
      preview(
        new Request(`https://app.minca.social/.netlify/functions/preview?${new URLSearchParams({ url })}`),
      );
    const refused = await ask('file:///etc/passwd');
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get('access-control-allow-origin'), '*');
    for (const inside of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://localhost/',
      'http://169.254.169.254/',
    ]) {
      const answered = await ask(inside);
      assert.equal(answered.status, 200, inside);
      assert.equal(await answered.json(), null, inside);
    }
  });

  test('the app takes from an answer only what a preview is', () => {
    assert.equal(previewOf(null), null);
    assert.equal(previewOf({ url: 'not a url', title: 'x' }), null);
    assert.equal(previewOf({ url: 'https://example.com', title: '' }), null);
    assert.deepEqual(
      previewOf({
        url: 'https://example.com',
        title: 'Hi',
        description: 7,
        site: 'Example',
        image: 'data:image/png;base64,AQID',
        large: 'yes',
      }),
      {
        url: 'https://example.com',
        title: 'Hi',
        description: '',
        site: 'Example',
        image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
        large: false,
      },
    );
    assert.equal(
      previewOf({ url: 'https://example.com', title: 'Hi', image: 'data:text/html;base64,AQID' })?.image,
      null,
    );
  });
});
