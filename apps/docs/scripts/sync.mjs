/**
 * Copies the pages minca.dev shows from where they live, so each page has one
 * copy: packages/core/docs and spec/ stay the source, and read the same on
 * GitHub and in node_modules.
 *
 * nav.json beside this folder says how the library's pages are grouped: a
 * few to get started, then topics, each a folder whose first page opens it.
 * The spec's parts follow, in the order of the table in spec/README.md.
 *
 * Each page is written twice: into the content folder with frontmatter (its
 * title from its heading, its description from its first paragraph), and as
 * plain Markdown at its URL with `.md`, for agents. Links point at the page's
 * place on the site, or at GitHub when the site doesn't have it. /llms.txt
 * lists the Markdown pages (llmstxt.org), and /llms-full.txt is the library's
 * pages in one file; the spec is left out of it, since building an app
 * doesn't need it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const content = fileURLToPath(new URL('../content/docs', import.meta.url));
const pub = fileURLToPath(new URL('../public', import.meta.url));
const nav = JSON.parse(readFileSync(new URL('../nav.json', import.meta.url), 'utf8'));
const site = 'https://minca.dev';
const repo = 'https://github.com/leifriksheim/minca';
const github = `${repo}/blob/main/`;
const library = 'packages/core/docs';

const read = (path) => readFileSync(join(root, path), 'utf8');
const librarySource = (page) => normalize(`${library}/${page}.md`);

/** The markdown under a `## heading`, up to the next one. */
function underHeading(markdown, heading) {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`No "## ${heading}" heading to read pages from`);
  const end = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, end < 0 ? undefined : end);
}

/** The local `.md` files a stretch of markdown links to, in order. */
function linkedPages(markdown, from) {
  const linked = [];
  for (const [, target] of markdown.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;
    const path = normalize(join(dirname(from), target));
    if (!linked.includes(path)) linked.push(path);
  }
  return linked;
}

/** The slug a page gets: its file name, or its folder's for a README. */
function slugOf(path) {
  const parts = path.replace(/\.md$/, '').split('/');
  const name = parts.at(-1);
  return name === 'README' ? (parts.at(-2) ?? 'index') : name;
}

/**
 * Every page, with where it goes: `file` in the content folder, `url` on the
 * site, and `group` for llms.txt.
 */
const pages = [];
for (const item of nav.start) {
  const source = librarySource(item.page);
  const slug = item.slug ?? slugOf(source);
  pages.push({ source, url: `/${slug}/`, file: `${slug}.md`, group: 'start', ...item });
}
for (const topic of nav.topics) {
  topic.pages.forEach((page, i) => {
    const source = librarySource(page);
    // A topic opens on its first page; a topic of one page is just that page.
    const [url, file] =
      topic.pages.length === 1
        ? [`/${topic.slug}/`, `${topic.slug}.md`]
        : i === 0
          ? [`/${topic.slug}/`, `${topic.slug}/index.md`]
          : [`/${topic.slug}/${slugOf(source)}/`, `${topic.slug}/${slugOf(source)}.md`];
    pages.push({
      source,
      url,
      file,
      group: 'topics',
      icon: topic.pages.length === 1 ? topic.icon : undefined,
    });
  });
}
const specSources = [
  'spec/README.md',
  ...linkedPages(underHeading(read('spec/README.md'), 'Parts'), 'spec/README.md'),
];
for (const source of specSources) {
  const slug = source === 'spec/README.md' ? 'index' : slugOf(source);
  const url = slug === 'index' ? '/spec/' : `/spec/${slug}/`;
  pages.push({ source, url, file: `spec/${slug}.md`, group: 'spec', icon: 'FileText' });
}

// The API reference, generated from the code's types and doc comments by
// TypeDoc (typedoc.json), so it can't drift from it. TypeDoc names a module by
// its folder; each gets the name it is imported by, and a short path.
const modules = [
  { dir: '@minca/core', slug: 'core', title: '@minca/core' },
  { dir: 'core/src/session', slug: 'session', title: '@minca/core/session' },
  { dir: 'core/src/schemas', slug: 'schemas', title: '@minca/core/schemas' },
  { dir: 'core/src/node', slug: 'node', title: '@minca/core/node' },
  { dir: 'core/src/storage', slug: 'storage', title: '@minca/core/storage' },
  { dir: 'core/src/inbox', slug: 'inbox', title: '@minca/core/inbox' },
  { dir: 'core/src/elements', slug: 'elements', title: '@minca/core/elements' },
  { dir: 'react/src', slug: 'react', title: '@minca/react' },
  { dir: 'calls/src/react', slug: 'calls-react', title: '@minca/calls/react' },
  { dir: 'calls/src', slug: 'calls', title: '@minca/calls' },
];
const docsDir = fileURLToPath(new URL('..', import.meta.url));
const api = join(docsDir, '.api');
execFileSync(join(docsDir, 'node_modules/.bin/typedoc'), { cwd: docsDir, stdio: 'inherit' });
for (const path of readdirSync(api, { recursive: true })
  .filter((p) => p.endsWith('.md'))
  .sort()) {
  // `modules` lists `calls/src/react` before `calls/src`, so the longer one wins.
  const owner = modules.find((m) => path.startsWith(`${m.dir}/`));
  if (!owner) continue;
  const rest = path.slice(owner.dir.length + 1).replace(/\.md$/, '');
  const index = rest === 'index';
  pages.push({
    source: relative(root, join(api, path)),
    url: index ? `/api/${owner.slug}/` : `/api/${owner.slug}/${rest}/`,
    file: `api/${owner.slug}/${rest}.md`,
    group: index ? 'api' : 'api-member',
    title: index ? owner.title : undefined,
  });
}

// A library page nav.json doesn't place isn't published: say so, so it gets a place.
const placed = new Set(pages.map((page) => page.source));
for (const name of readdirSync(join(root, library))) {
  const source = `${library}/${name}`;
  if (name.endsWith('.md') && !placed.has(source)) console.warn(`Not in apps/docs/nav.json: ${source}`);
}

const urls = new Map(pages.map((page) => [page.source, page.url]));
const pageUrls = new Set(urls.values());

/** A page's URL as plain Markdown: `/collections/` is `/collections.md`. */
const markdownUrl = (url) => `${url.replace(/\/$/, '')}.md`;

/**
 * Where a link from the page at `from` should go: `toPage` turns a site URL
 * into the form the copy links with.
 */
function retarget(target, from, toPage) {
  const [path, anchor] = target.split('#');
  if (!path) return target;
  // A page links to the API reference at its address on minca.dev, which
  // works on GitHub too; on the site it is a page like the rest.
  const sitePath = path.startsWith(`${site}/`) && path.slice(site.length);
  if (sitePath && pageUrls.has(sitePath)) {
    return anchor ? `${toPage(sitePath)}#${anchor}` : toPage(sitePath);
  }
  // The reference is made from the code: a link to a name the code no longer has fails the build.
  if (sitePath && sitePath.startsWith('/api/'))
    throw new Error(`${from} links to ${path}, which the API reference doesn't have`);
  let repoPath;
  if (path.startsWith(github)) repoPath = path.slice(github.length);
  else if (path.startsWith(`${repo}/tree/main/`)) repoPath = path.slice(`${repo}/tree/main/`.length);
  else if (/^[a-z]+:/.test(path) || path.startsWith('/')) return target;
  else repoPath = relative(root, join(root, dirname(from), path));
  repoPath = repoPath.replace(/\/$/, '');
  const url = urls.get(repoPath) ?? urls.get(`${repoPath}/README.md`);
  const to = url ? toPage(url) : github + repoPath;
  return anchor ? `${to}#${anchor}` : to;
}

/**
 * An example may set the scene before a `// ---cut---` line, as Twoslash's
 * do: scripts/check-examples.mjs compiles all of it, the reader sees what
 * follows the line.
 */
function withoutSetup(markdown) {
  // Never past a closing fence, so a block without the line is left whole.
  return markdown.replace(/^(```\w+\n)(?:(?!```)[\s\S])*?^\/\/ ---cut---\n/gm, (_, fence) => fence);
}

/** Rewrites a page's links, leaving code alone. */
function rewriteLinks(markdown, from, toPage) {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      // Splitting on inline code keeps it out of the rewrite.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 ? part : part.replace(/\]\(([^)\s]+)\)/g, (_, t) => `](${retarget(t, from, toPage)})`),
        )
        .join('');
    })
    .join('\n');
}

/** Plain text of a page's first paragraph, for its description. */
function firstParagraph(body) {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|>|\||```|- |\* |\d+\. |<|Defined in)/.test(block));
  if (!paragraph) return undefined;
  const text = paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ');
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, '')}…` : text;
}

/** Writes a file, making its folder. */
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

rmSync(content, { recursive: true, force: true });
for (const page of pages) rmSync(join(pub, markdownUrl(page.url)), { force: true });
for (const dir of [...nav.topics.map((topic) => topic.slug), 'spec', 'api']) {
  rmSync(join(pub, dir), { recursive: true, force: true });
}

// Catalogues written from the code (scripts/catalogues.ts), for the pages
// that mark a place for one with `<!-- catalogue: name -->`.
const catalogues = JSON.parse(
  execFileSync(join(root, 'node_modules/.bin/tsx'), [join(docsDir, 'scripts/catalogues.ts')], {
    encoding: 'utf8',
  }),
);
const withCatalogues = (markdown) =>
  markdown.replace(/<!-- catalogue: (\w+) -->/g, (marker, name) => {
    if (!(name in catalogues)) throw new Error(`No catalogue called ${name}`);
    return catalogues[name];
  });

const written = pages.map((page) => {
  const markdown = withCatalogues(read(page.source));
  const heading = markdown.match(/^# (.+)$/m);
  if (!heading) throw new Error(`${page.source} has no "# " heading for its title`);
  const title = page.title ?? heading[1].replace(/`/g, '');
  const raw = withoutSetup(markdown.replace(heading[0], '')).trimStart();
  const body = rewriteLinks(raw, page.source, (url) => url);
  // A module's index opens with whatever it re-exports first: not a description.
  const description = page.group === 'api' ? undefined : firstParagraph(body);
  const frontmatter = [
    `title: ${JSON.stringify(title)}`,
    description && `description: ${JSON.stringify(description)}`,
    page.icon && `icon: ${page.icon}`,
  ].filter(Boolean);
  write(join(content, page.file), `---\n${frontmatter.join('\n')}\n---\n\n${body}`);

  const plain = `# ${title}\n\n${rewriteLinks(raw, page.source, (url) => site + markdownUrl(url))}`;
  write(join(pub, markdownUrl(page.url)), plain);
  return { ...page, title, description, plain };
});

// The sidebar: headed groups, the topics as folders, the spec's parts spread flat.
write(
  join(content, 'meta.json'),
  json({
    pages: [
      '---Get started---',
      ...pages.filter((page) => page.group === 'start').map((page) => page.file.replace(/\.md$/, '')),
      '---Docs---',
      ...nav.topics.map((topic) => topic.slug),
      '---API reference---',
      '...api',
      '---Protocol---',
      '...spec',
    ],
  }),
);
for (const topic of nav.topics.filter((topic) => topic.pages.length > 1)) {
  write(
    join(content, topic.slug, 'meta.json'),
    json({
      title: topic.title,
      icon: topic.icon,
      pages: topic.pages.slice(1).map((page) => slugOf(librarySource(page))),
    }),
  );
}
write(
  join(content, 'spec', 'meta.json'),
  json({ pages: specSources.map((s) => (s === 'spec/README.md' ? 'index' : slugOf(s))) }),
);

// Each module is one entry; its members are reached from it, and from search.
write(join(content, 'api', 'meta.json'), json({ pages: modules.map((m) => m.slug) }));
for (const mod of modules) {
  write(join(content, 'api', mod.slug, 'meta.json'), json({ title: mod.title, icon: 'Braces', pages: [] }));
}

/** One line of llms.txt. */
const entry = (page) =>
  `- [${page.title}](${site}${markdownUrl(page.url)})${page.description ? `: ${page.description}` : ''}`;
const inGroup = (group) => written.filter((page) => page.group === group).map(entry);

write(
  join(pub, 'llms.txt'),
  [
    '# Minca',
    '',
    '> Minca is a protocol for shared spaces of signed records that sync peer to peer, and `@minca/core` is its TypeScript library. An app asks the person’s account home for access to some of their spaces, then reads and writes records there. Every peer checks every record, so there is no server to write.',
    '',
    `Every page below is Markdown. Start with the first three, then the topic for the task. The protocol's specification is under Optional: it is for implementing Minca, not building on it. ${site}/llms-full.txt is every page but the spec in one file.`,
    '',
    '## Get started',
    '',
    ...inGroup('start'),
    '',
    '## Docs',
    '',
    ...inGroup('topics'),
    '',
    '## API reference',
    '',
    ...inGroup('api'),
    '',
    // llmstxt.org: what's under "Optional" may be skipped for a shorter context.
    '## Optional',
    '',
    ...inGroup('spec'),
    '',
  ].join('\n'),
);
write(
  join(pub, 'llms-full.txt'),
  written
    .filter((page) => page.group === 'start' || page.group === 'topics')
    .map((page) => `${page.plain.trimEnd()}\n\nSource: ${site}${page.url}\n`)
    .join('\n---\n\n'),
);

console.log(`Synced ${written.length} pages, and llms.txt`);
