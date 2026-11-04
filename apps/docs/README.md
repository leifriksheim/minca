# minca.dev

The docs for building on Minca: `packages/core/docs` and `spec/` as a site,
with Markdown for agents. Built with Fumadocs on Next, exported as static
pages, and deployed by Netlify from `netlify.toml` here.

```bash
npm run dev -w apps/docs     # http://localhost:5187
npm run build -w apps/docs   # out/
```

The pages aren't written here. `scripts/sync.mjs` copies them in from where
they live, before each dev run or build, so change a page in
`packages/core/docs` or `spec/`. What it publishes, and in what order, comes
from the indexes: the Guides and Reference tables in
`packages/core/docs/README.md`, and the parts table in `spec/README.md`. A new
page shows once one of them links it.

Each index is a tab of the sidebar: Guides, Reference, Protocol. For each
page the script writes:

- `content/docs/<section>/<page>.md`: the page, its title from its heading
  and its description from its first paragraph.
- `public/<section>/<page>.md`: the page as plain Markdown at its URL with
  `.md` (`/guides/collections.md`), for agents.

And for agents, `public/llms.txt` (every page with a line on what it covers,
[llmstxt.org](https://llmstxt.org)) and `public/llms-full.txt` (the
overview, guides and reference in one file; the spec is left out).

Only the front page, `app/(home)/page.tsx`, is written here.
