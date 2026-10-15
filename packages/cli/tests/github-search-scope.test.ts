/**
 * A connected bot's GitHub search is held to the connection's repositories by
 * what GitHub returns, not by the query: an unclosed quote or an OR can undo
 * the scope the tool adds, and one installation may reach another community's
 * private repositories.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubTools } from '../src/connectors/github-tools.js';

const items = [
  { number: 3, title: 'Ours', state: 'open', repository_url: 'https://api.github.com/repos/acme/site' },
  {
    number: 9,
    title: 'Q3 layoffs list',
    state: 'open',
    repository_url: 'https://api.github.com/repos/acme/secret',
  },
];

test('a search shows only what is in the connection’s repositories, whatever its query does', async () => {
  const sent: string[] = [];
  const search = githubTools({
    app: { token: async () => 'ghs' },
    installation: 42,
    repos: ['acme/site'],
    mayWrite: false,
    budget: () => true,
    fetch: async (input) => {
      sent.push(input instanceof Request ? input.url : input.toString());
      return new Response(JSON.stringify({ items }));
    },
  }).find((tool) => tool.name === 'github_search');
  assert.ok(search);
  for (const query of ['layoffs "', 'layoffs OR is:private']) {
    const found = await search.run({ query });
    assert.ok(found.text.includes('Ours'), query);
    assert.ok(!found.text.includes('layoffs list'), `${query}: ${decodeURIComponent(sent.at(-1) ?? '')}`);
  }
});

test('an issue moved out of the connection’s repositories isn’t read at its old address', async () => {
  const get = githubTools({
    app: { token: async () => 'ghs' },
    installation: 42,
    repos: ['acme/site'],
    mayWrite: false,
    budget: () => true,
    // GitHub follows the move: the old address answers with the issue where it is now.
    fetch: async () => new Response(JSON.stringify(items[1])),
  }).find((tool) => tool.name === 'github_get');
  assert.ok(get);
  const found = await get.run({ repo: 'acme/site', number: 9 });
  assert.equal(found.isError, true);
  assert.ok(!found.text.includes('layoffs'));
});
