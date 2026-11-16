# @minca/session

How a [Minca](https://minca.dev) app connects to a person's account home,
and runs its node in a worker.

```ts
import { createMincaConnection } from '@minca/session';

const connection = createMincaConnection({
  home: 'https://home.minca.social/connect',
  request: { name: 'Todo', access: 'write', scope: 'spaces' },
});
```

It also has the pieces signing in is made of: grants and their checks,
connecting a program by code, pairing a phone, and where accounts are kept.
A worker script runs the node off the page's main thread:

```ts
// minca-worker.ts
import '@minca/session/worker';
```

See [building an app](https://minca.dev/building-an-app/).
