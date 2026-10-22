# Liquid

An assembly decides together: anyone can vote on a proposal, or trust a person
or a party with their vote, topic by topic, and take it back. It is an app of
its own on Minca, a reference for what can be built on the protocol: it
connects to the person's account home, asks only for the spaces it decides in,
and keeps everything in collections of its own.

- `src/schema.ts`: its collections, rules and contracts.
- `src/tally.ts`: how every device counts the votes the same way; `src/duties.ts`,
  the votes a device casts for those who follow someone.
- `src/model.ts`: the assembly as the screens read it.
- `src/setup.ts`: making a space an assembly, the first time someone who may
  define collections opens it.
- `src/App.tsx`: connecting, and picking the space.

What it can't promise is on its own **?** page.

```bash
npm run dev -w @minca/liquid    # http://localhost:5186, with `npm run dev` running for the home and node
npm test -w @minca/liquid
```
