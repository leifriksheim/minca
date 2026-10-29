# Running a host for other people

What to do before `minca host` takes anyone's money, and what to do when
something goes wrong. How to run it is in the [README](README.md#hosting-other-peoples-spaces).

## What it costs to run

Measured with `tests/bench/host-load.ts` (1,000 spaces over 20 accounts, 20
records each, plus each account's registry, contacts and carry space: 1,060
spaces), on an M-series Mac, the host run from source under `tsx`:

|                                      |                       |
| ------------------------------------ | --------------------- |
| Memory, nothing carried              | 112 MB                |
| Memory, carrying 1,060 with peers on | 488 MB (0.36 MB each) |
| Memory after a restart, no peers     | 381 MB (0.25 MB each) |
| A restart, until every space is open | 33 s                  |
| Disk                                 | 35 MB (33 KB each)    |

So memory is the limit, not disk: a 512 MB machine carries about 1,000
spaces, and 1 GB about 2,500. An account holds three spaces of its own besides
the ones it uses, so count six to ten spaces an account: 100 to 170 accounts on
the smallest Fly machine (about $3.50 a month with its volume). At $4 an
account a month, the machine is paid by its first account. Run the bench again
before raising prices or machine sizes: `node --conditions=@minca/source --import tsx tests/bench/host-load.ts 2000 40 20`.

A restart takes the host offline for about half a minute per thousand spaces,
while it opens them. Devices keep their own copies, so nothing is lost, but
deploy at a quiet hour.

TURN is not needed for a host: devices reach it over its WebSocket, never
WebRTC. It matters only for devices meeting each other.

## Limits

With `MINCA_HOST_FREE_GB` set (README, "Free within limits"), every account
is kept online for free within its room, and paying buys more. A community
pays for itself once it outgrows a free line (spec 08 §1.1). The host cannot
read a space, so the line counts what it sees: accounts that wrote there in
the window, and its size once at least two accounts write. Readers are shown
and never enforced, as anyone can make up a reader. Each limit is the host's
own, said in its description, so a home shows it next to the price and people
can compare hosts.

What the defaults cost, from the numbers above: a free account is six to ten
spaces, 2 to 4 cents a month of the smallest machine. 250 MB is far more disk
than most accounts use (33 KB a space measured), so memory stays the limit.
A community past 10 writers is a few more spaces' memory at most, but it is
what grows: that is what its fund pays for.

Counting costs nothing to see: with `BENCH_LIMITS=1` the bench runs the host
with limits on, and carrying 330 spaces it took 255 MB against 288 MB
without, and 252 MB against 253 MB after a restart, which is noise.

What to watch once limits are on:

- **The log** says each space as it goes over the line, as its grace runs
  out, and as it comes back under. In the first weeks, check how many go
  over against the defaults before the first grace period ends.
- **Going over is a notice, never a cut.** For `MINCA_HOST_GRACE_DAYS` every
  member's status names the space and the date, and the apps ask its members
  to start a fund. Past it, members' subscriptions stop carrying it. Members
  keep their copies and still sync with each other; the host keeps what it
  had, unserved, for `MINCA_HOST_KEEP_DAYS`, so a fund brings it straight back.
- **Free again** only after a whole window with every count under 80% of its
  limit, so a busy week doesn't flip it.
- **Room is kept too.** Every space an account names counts against its
  room, but communities paying for themselves. Past it, the same notice
  (`MINCA_HOST_GRACE_DAYS`, kept through dips under and new keys), then the
  host holds back its largest spaces for that account until the rest fit;
  another member with room keeps a shared one carried. A space held for
  `MINCA_HOST_KEEP_DAYS` has the host's copy deleted (devices keep theirs). An account over by
  its carry space alone is refused, and the log says so: delete its
  `room:<account DID>` entry in the host's store (and `host/rooms/` in the
  bucket) to let it back. A community's fund pays `MINCA_FUND_PER_GB` a
  month for each GB its space takes, at least one.
- **Counts reset when the disk does.** Which accounts wrote is kept on disk
  as salted hashes and not in the bucket, so a new disk counts from nothing,
  which errs toward free. Each space's date on the line is in the bucket, so
  a new disk keeps its grace clock.
- **Turning limits on** counts from that moment: no space is over on writers
  until enough people write after it, and each then gets the whole grace
  period. Paid subscriptions stay on the paid plan until their date; after
  it, one none of whose devices called for `MINCA_HOST_IDLE_DAYS` is dropped
  at the next sweep, as any free one is.
- **The limit on new subscriptions** counts the asker's address. Behind a
  proxy other than Fly's, set `MINCA_HOST_CLIENT_IP_HEADER`, or every
  newcomer shares the proxy's address and its 5 a day.

## Before launch

1. **Deploy** with `fly.toml` (commands at its top). Set `MINCA_HOST_URL` to
   the public address, and the R2 bucket, so the disk is only a cache.
2. **A Stripe test-mode run, end to end.** With `sk_test_…` keys:
   - In a home built with `VITE_MINCA_HOST`, **More room**, add $5 with
     `4242 4242 4242 4242`. Within a minute the home should show the balance,
     and the host's log "got $5.00 by card".
   - Add every month, then stop it from the link `STRIPE_PORTAL_LINK` gives.
   - A space: **Chip in** twice; its balance moves twice.
   - Replay a webhook from Stripe's dashboard: the balance must not move again.
3. **A wallet payment on Base Sepolia** (`MINCA_WALLET_NETWORK=base-sepolia`),
   with test USDC from faucet.circle.com.
4. **Tax.** Selling a digital service to consumers makes you liable for VAT
   in the EU and UK from the first sale, and for sales tax in some US states.
   The simplest route is a merchant of record (Paddle or Lemon Squeezy), which
   sells in its own name and handles all of it; the `Billing` interface in
   `src/host.ts` is where one plugs in. Stripe Tax is the other route, but
   leaves registering and filing to you. Decide before the first real payment.
5. **Reminders by email**: set `MINCA_MAIL_API_KEY` and `MINCA_MAIL_FROM`
   with a domain verified at the mail service, and ask for one on the pay
   page to see the confirmation arrive.
6. **Terms** at `MINCA_HOST_TERMS`: what is kept (sealed spaces, a
   subscription's payment reference, an optional email), for how long after
   lapsing (the grace period, 30 days by default), and that the host cannot
   read what it keeps.

## Bots

A bot costs its model's tokens: with `MINCA_BOT_DAILY_CAP=1` a bot spends at
most $1 a day of the host's key, about $30 a month if it is busy every day,
and most are far under that. Its community's fund pays for it at
`MINCA_BOT_MARKUP` times that (default 1.5), which covers what the host pays
and leaves a margin; watch spending per bot in the host's log. Each bot is also a node in the host's process, about
the memory of the spaces it holds. Unlike the spaces a host carries, a bot's
keys are on the host's disk, in `bots/`: keep that volume as private as the
host's own key.

## Stats

Anyone can see what a host carries and takes in, so whoever is thinking of
running one sees real numbers, and whoever uses one sees it is open:

```
minca host stats https://host.minca.social
Minca host, counted 2026-10-21 14:00 UTC
  Communities    about 15
  Accounts       about 40
  Spaces         about 60
  Data kept      3.2 GB
  Bots running   about 5
  In funds       $412
  Spent a month  $9 hosting, $38 AI
  Up for         12 days
```

`--json` gives the answer of `GET /host/stats` as it is. It is totals only,
never a space id or an account. Counts are to the nearest 5 (a host with one
community shows "fewer than 3"), data to 0.1 GB and money to the dollar, and
they are counted once an hour: asked more often, a host answers the same.
While a host carries only a few communities, a live total would say when one
of them writes or leaves; rounded and hourly, it says how big the host is.
Money is what every balance and fund holds now, and what they spend a month
at the rate they spend today, on keeping spaces online and on bots' AI use.

`MINCA_HOST_STATS=off` keeps them to itself: `/host/stats` answers 404. This
is the reference host's own, not protocol: no device asks for it.

_Source: `packages/cli/src/host-stats.ts` (`createHostStats`, `statsLines`, `isHostStats`), `packages/cli/src/host.ts` (`stats`), `packages/cli/src/host-setup.ts` (`statsFromEnv`), `packages/cli/src/fund.ts` (`botsDaily`). Tests: `packages/cli/tests/host-stats.test.ts`, `packages/cli/tests/host.test.ts` ("anyone sees a host’s rounded totals…")._

## If something goes wrong

What a host holds decides what a breach can expose. It holds no account's
seed, no space's key and no note: spaces are sealed as they travel, and a host
that is fully taken over can read none of them. What it does hold:

- **Its own key** (`host-key` in the data folder). With it, someone can sign
  statuses as the host and take peers' sockets as the host.
- **Which spaces exist**, their size, when they change, and which account
  asked for which (through carry spaces).
- **Payment references**: Stripe customer ids, wallet transactions.
- **The keys of the bots it runs**, in `bots/`. With them, someone can read
  and write what those bots may, in the spaces they are in, until an admin
  removes them. After a breach, tell each community with a bot to remove it
  and add a new one.
- **Email addresses** given for reminders.
- **Mail and payment secrets** in its environment.

When a breach is suspected:

1. **Contain.** Stop the machine (`fly scale count 0`). Rotate every secret
   in its environment: Stripe keys and webhook secret, the mail service key,
   the bucket's keys.
2. **Look.** Fly's logs, the bucket's access logs, Stripe's dashboard for
   refunds or payouts you didn't make.
3. **If the host key may have leaked,** it has to change: a new key is a new
   host, and every home asks the person to use it again. Start on a fresh
   `host-key` with the same bucket; the subscriptions come back, and each
   device hands its spaces over again when it next looks. Say so on the pay
   page and by email to those who gave one.
4. **Tell people** within 72 hours when personal data was exposed (GDPR,
   Art. 33 and 34): the email addresses and payment references are personal
   data; the sealed spaces are not readable, so say that too.
5. **Write down** what happened, when it was found, and what changed.
