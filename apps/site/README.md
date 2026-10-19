# Minca site

The website at minca.social: `/` for communities (`/why` too, for older
links), `/developers`, `/protocol`, `/extension` and `/download`. The front
page and `/download` offer the desktop app for the visitor's computer
(`src/pages/downloads.ts`), from the latest GitHub Release. The app is a site of its
own ([apps/example](../example/README.md), at app.minca.social); every "Open
Minca" goes there, by `VITE_MINCA_APP`.

A Vite + React site, routed with TanStack Router (`src/router.tsx`). Links
made when the app lived here, at `/app` or with `#invite=` or `#door=` in the
fragment, go on to the app with the fragment intact.

```bash
npm run dev         # at the repository root: this site on :5185, beside the app, the home and a node
```

## Deploying it

`netlify.toml` at the repository root builds it. The downloads it offers,
the Chrome extension among them, are on the latest GitHub Release.
`public/_redirects` sends every path to `index.html`, and `public/_headers` sets
the security headers.

## Layout

```
src/
  main.tsx                 # the design system's base styles, then the router
  router.tsx               # the pages, and where old app links go
  pages/                   # the pages, and site.css
```
