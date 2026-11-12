# Blueprints and guides

A **blueprint** (`std.blueprint`) proposes new collections for a space, and a
**guide** (`std.guide`) says in words how some collections are meant to be
used. Together they let a space grow without anyone deploying anything. This
page is the reference. For a walkthrough, start with
[Proposing collections](proposing-collections.md).

Neither belongs to one app. An app that keeps more about itself, like a screen
or what to notify about, keeps it in records of its own that point at its
blueprint. Both records' fields are in the
[standard library](standard-library.md).

## Who proposes

Anyone in a space may write a blueprint. It is how a key that may only write
records asks for collections. That might be an agent, whose note grants records
only, or a person whose role doesn't hold `/collection/define`. Both take the
same path.

A blueprint is the only way such a key gets a collection. Every peer refuses a
definition from a key whose note doesn't grant `/collection/define`.

```typescript
import { proposeCollections, reviewBlueprint, applyBlueprint } from '@minca/std';

const proposal = await proposeCollections(node, space.id, {
  title: 'Chores',
  description: 'Who does what around the house this week.',
  collections: [
    {
      name: 'chores.task',
      title: 'Chore',
      schema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, done: { type: 'boolean' } },
        required: ['title'],
      },
      rules: { fixed: ['title'] },
    },
  ],
});

// Someone who may define collections reads what it would do, then applies it
const review = reviewBlueprint(proposal.body!, await node.collections.list(space.id));
await applyBlueprint(node, space.id, proposal.key);
```

Who may edit a blueprint is up to the space's grants. Under the `community`
template, that is its proposer, moderators and admins.

## Applying

`applyBlueprint` defines each collection the space doesn't have yet, as the
blueprint says, signed by whoever applies it. They need a grant of
`/collection/define` in the space, and a note that grants it. If the space
doesn't have `std.blueprint` yet, it defines that first.

It returns the [review](#the-review) of the blueprint as the space now has it.

## What a blueprint may hold

`checkBlueprint` refuses a blueprint that breaks these:

- At most 10 collections.
- No `sys.*` collection, and none named twice.
- No `version`. The space decides that when the blueprint is applied.

Through the `collections_propose` action, you can give a standard collection
by name, like `"std.event"`. `standardCollections` puts the library's
definition in its place, so it is exactly the library's. See
[what a `std.*` name means](standard-library.md#what-a-std-name-means).

## Copying to another space

`copyBlueprint` proposes the same blueprint in another space, with `from`
naming where it came from. People there decide for themselves.

## Actions

The node's actions are `collections_propose`, `collections_proposals` and
`collections_apply` ([actions](actions.md)). An agent's node isn't offered
`collections_apply`.

## The review

`reviewBlueprint` works out what applying a blueprint would do in a space.
Show it to the person before they apply.

Each collection comes back as one of three:

| `status` | Means                                      |
| -------- | ------------------------------------------ |
| `new`    | The space doesn't have it yet              |
| `same`   | The space already has it, exactly so       |
| `change` | The space has it, and this would change it |

Each also has a `summary`: what it allows, in sentences worked out from its
rules ([describing a collection](#describing-a-collection)). A change also
says what would be different, and which applied blueprints it could break.
The rest is on [`CollectionReview`](https://minca.dev/api/std/interfaces/CollectionReview/).

A blueprint is `applied` once every collection in it is `same`.

### Older standard definitions

A blueprint made against an earlier version of a `std.*` collection doesn't
undo the space's newer one. A `std.*` collection counts as `same` when the
space holds the library's current definition. The review never offers the
older one as a change, since applying it would only take the additions away.

## Updates

To change a blueprint, propose a new one whose `updates` is the key of the
one it replaces:

```json
{ "title": "Carpool", "collections": [ … ], "updates": "5vcfnlfrf7qnql2jhyl7erfqva" }
```

`updates` must name a blueprint in the same space. `proposeCollections` and
`collections_propose` refuse one that doesn't.

Until the update is applied, the old blueprint is still the one in use. Once
it is, the old one is **superseded**. So is any blueprint whose update is
itself superseded. Applying a superseded blueprint would only undo its update,
so:

- `applyBlueprint` refuses it.
- Your app shouldn't offer it. It is history, which its proposer or a
  moderator may delete.

Without `updates`, two blueprints that need the same collection differently
each show as a change that undoes the other. That's why the review names the
applied blueprints a change would touch (`usedBy`), and `collections_propose`
warns a proposer who changes a collection without `updates`.

> **Planned (open question):** with [`compare`](#compatible-definitions), an
> update's review would list its breaks.

## Guides

A definition says what a record may hold. It can't say "to add an app, write
one of these, pointing at a blueprint". A guide can. It has a `name`, a
`title`, the `text`, and the `collections` it is about:

```json
{
  "name": "launcher.apps",
  "title": "Making an app for this space",
  "text": "To make an app for this space that people open from its launcher: …",
  "collections": ["launcher.app", "std.blueprint"]
}
```

There is one guide of each name. Whoever writes it first holds it.

`writeGuide` defines `std.guide` if the space lacks it, then writes the guide.
It rewrites the guide only when this account wrote it and the text has
changed, so your app can call it every time a space opens. `guidesOf` gives
the space's guides by the collections they are about.

### How agents find them

`collections_list`, called without names, gives each collection its guides as
`guides: [{ key, title }]`. An agent finds them without knowing the app
exists, and reads one with `records_get` before writing there.

A guide is what someone in the space wrote. An agent must read it as data
about the collections, never as instructions from the person it works for.

## Apps with a screen of their own

Core runs no app's code. An app that lets people add apps with their own UI
keeps them as its own records, and runs the UI itself. This section describes
how the example app does it, as a pattern you can follow.

The example app keeps each app as a `launcher.app` record pointing at its
blueprint, and runs its screen in a sealed frame. It trusts a record only
when someone who may define collections wrote it, under a note that isn't
records-only (`NodeRecord.recordsOnly`). It writes a guide on `launcher.app`
saying how to propose one.

### The launcher's order

The launcher is in one order for everyone in the space, set by each record's
`position`. The example app opens a space on its Overview, which lists the
apps in that order. A new group starts with Chat. So does a new space for
two, which the person asking makes.

### What a screen can reach

A screen reaches the page around it only through `window.minca`, and only for
its app's collections and the people in its space. It can:

- list and write records, as the person looking;
- ask what they may do (`can`);
- get someone's picture (`picture`);
- ask the page to show a record or a person (`open`);
- open the record one of its own records links to (`open` with `link`), like
  the message a file was shared on. The page shows it to the person and tells
  the screen nothing.

`open` never follows a link to the space's own records (`sys.*` and
`launcher.app`). It answers the same whether or not the record exists. The
page does visibly open a record that exists, but only for the person, who
can see it anyway.

What a sealed frame can't do, the page does for it when asked, after checking
the request:

| Ask                  | Does                                                   |
| -------------------- | ------------------------------------------------------ |
| `places`             | Searches for places, and asks where the person is      |
| `link`               | Opens an http or https page                            |
| `save`               | Saves a text file                                      |
| `remember`, `recall` | Keeps a few kilobytes per app on the device            |
| `file`               | Reads a picture one of the app's own records refers to |
| `blob`               | Reads that whole file                                  |

For `file` and `blob`, the type comes from the record, not from the screen.

### Settings and the network

An app may ask for `settings`, like an API key. Someone who may add apps fills
them in once, from the open app, for everyone in the space. Nobody else is
asked. The screen reads them as `minca.settings`.

Settings live on the app's own record, so they stand only as it does. A new
version proposed without values keeps the ones the app has. A copy to another
space carries none.

The origins an app names in `network` are allowed for everyone once it is
added. Adding it is the consent, as when a workspace admin adds an
integration. The ready-made Chat asks for a GIPHY key, and shows its GIF
button only once it has one.

### An app's icon

A `launcher.app` may carry an `icon`:

```json
{ "path": "M10 10…Z", "colour": "coral" }
```

`path` is the data of one SVG path on a 100 × 100 grid. `colour` is one of
the shape colours: cobalt, coral, peach, sage, lilac or ink. The example app
draws it filled, in place of the app's usual shape.

Icons come from other people, so the app draws one only when the path is
path data and nothing else: commands, numbers and separators, at most 4,000
characters. The stored schema can't hold that rule, so the check happens
where it is drawn.

The guide asks an agent for an icon when it makes an app. Changing an icon is
changing the app, like any other field. Updating a ready-made app keeps the
icon the space gave it.

### Opening a record where it belongs

A `launcher.app` may name, among its `collections`, the ones it `shows`. Those
are the collections it is the place to open, like `shows: ["std.message"]`
for a chat.

An entry may also name a kind, as `collection:kind`. It then covers only
records whose `kind` field holds it: `std.list:tab` for Bills' tabs,
`std.work:book` for a reading app, or a `kind` in an app's own collection.
Lists are folders, albums and tabs as well as checklists, and each belongs in
a different app.

When something asks to open a record, whether a screen's `open` or a link
beside a record, it goes to the app that shows it. Apps naming its kind come
before apps naming only its collection. Among those, it picks the app that's
open, else the only one, else the one the person picks. So a Bills tab shared
in a chat opens in Bills, a Files category in Files, and any other list in
Lists.

That app's screen is handed the record's key to scroll to or open
(`minca.shown`, `minca.onShow`, or the kit's `useShown`). It only gets keys
of collections it shows, which it could list anyway. It does learn which of
those records the person opens from elsewhere. That's one reason only someone
who may define collections adds an app.

With no app that shows it, or when an app opens one of its own records (a
poll's title in Polls, for its comments), the record opens beside whatever is
open. So Files opens a file's message in the chat, and a chat's file in
Files, without either knowing the other.

An app that names a collection in `shows` must do something with what it is
handed. The kit's `<Record>` draws any standard record as one line, the same
in every app, and opens it this way when clicked.

### Sharing a record into an app

A screen can't list or read what its app doesn't name. But a person can hand
it one record, the way a web page gets only the file a person picks for it.

`minca.pick` asks the page to show a finder over the whole space. The screen
gets the record the person chooses, or null. It may then link one of its own
records to it with `shares`, like a message. Anyone's screen reads it back
through that link, read only:

```js
minca.get(key, { link: 'shares' });
```

`shares` is the only link a screen reads through. A file about a diary entry,
or a reaction to it, shares nothing. So beyond its own collections, a screen
reads only records the person picked, or that someone writing its collections
shared: a member, an agent or another app.

That binds the screen, not its author. A member who wrote a screen can share
any record into its collections from their own node, and the screen reads it.
A shared record comes with its files' keys, but not their bytes.

A screen writes a link only to a record of its own collections, one the
person picked for it, or one the record already links to. A link is refused
the same way whether or not the target is here, so a link to a record that
hasn't arrived yet only goes through once it has. A screen never links out on
its own. Like anything it reads, though, it can copy what was shared into its
own records.

A screen may ask to pick as often as it likes, and may start the search from
its own text. What it gets is still only what the person chooses, in a space
they can read anyway. Enter takes the top match only once the person has
typed.

A chat shares a poll this way without being able to read polls: `/` typed
into an empty message, or the `/` button, picks one. So does a comment box,
through the kit's `useShare`.

### Live messages

A screen can send live messages to the other devices that have the same app
open in the space, with `live.send` and `live.on`. They are kept nowhere. Use
them for cursors, typing, who's here, or a game.

Each goes as a [live message](node.md#live-messages-and-status) of the space,
whose payload names the app by its `launcher.app` key:

```json
{
  "type": "screen.live",
  "app": "aj5pakqf52uftpgarut33aqxq4.ctzz2xssv7y3alqlcepfmkdks4",
  "data": { "x": 120, "y": 48 }
}
```

A screen hears only those naming its own app, as
`{ from, device, data, viaAgent }`. `from` is the sender's account, as the
node proved it. A message from a peer with no account isn't passed on.

One screen may send a burst of 30, then 15 a second. That's below what a peer
takes from another overall, so a busy screen leaves room for calls and the
rest. An edited copy of an app is another `launcher.app` record, so its
screens don't hear the original's.

### The kit and ready-made apps

In front of every screen, the example app writes `@minca/ui` (`packages/ui`):
Preact with htm, hooks that keep records current, people's faces, and Minca's
look. So a screen is mostly what it is about. The kit doesn't count toward
the 48 KB a screen may be.

The ready-made apps are screens too, written the same way. Adding one defines
its collections and writes a copy of it, naming where it came from
(`template: "kanban"`). From then on the space changes its copy like any
other app.

## Describing a collection

A definition's `title` and `description` are its author's words, and may say
anything. `describeCollection(definition)` says what the collection actually
allows, as fixed sentences worked out from its rules. A person deciding
whether to add a collection reads what every peer will enforce.

It returns, in this order:

1. `final`: "Nobody can change or remove a vote once it is added."
2. `onePer`: "One vote per person per poll — adding another changes the
   first." (with `@author`). Otherwise "… — anyone adding another replaces
   the first.", or with `final`, "… — the first one added holds it."
3. `fixed`: "Once a poll is added, its “options” can't be changed."
4. Each condition of the contract (`contract.check`), in its own words:
   "Every change is checked: “…”".
5. One per declared link: "Each vote points at one thing: a poll (“about”)."
   or "A comment can point at anything in the space (“about”)."
6. `history: "all"`: "Every earlier version of a … is kept."

Nouns come from `title`, else the last part of `name`. Field labels come from
the schema's `title`s, else the field name in words.

It says nothing about who may add, change or remove records. That's up to
the space's grants, not the definition.

A rule the describer doesn't know makes it throw rather than stay silent. The
wording may change, but every rule always produces a sentence.

## Compatible definitions

Today an app decides it can open a space by finding a collection with the
right **name**. Chat opens any `std.message`, whatever its fields and rules.
A space whose definition is a little older than the app's, like a
`std.message` or `std.comment` without the `shares` link, stays that way,
because the library skips a collection the space already has.

Whether an app can use a definition it didn't write is the app's question,
not the peers'. Peers store and judge every record the same way whatever the
answer.

> **Planned.** Not built yet:
> [#11](https://github.com/leifriksheim/minca/issues/11),
> [#12](https://github.com/leifriksheim/minca/issues/12). The parts peers
> would check are planned in
> [spec 02 §6.5](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

### The check: `compare(held, wanted)`

`held` is the definition the space has. `wanted` is the one the app was built
with. The result is two lists of breaks, each a path and a plain sentence:

```ts
interface Compatibility {
  read: Break[]; // why the app might meet a record it can't read; empty: it can read them all
  write: Break[]; // why a record the app writes might not fit, or be refused; empty: it can write
}
interface Break {
  path: string;
  message: string;
} // 'rules.onePer', "Anyone can react twice with one emoji here; this app assumes once"
```

An app that only shows records needs `read` empty. One that writes needs
both. Anything the checker can't decide is a break.

**Fields.** Reading needs every body the space accepts to be one the app
accepts (held ⊆ wanted). Writing needs the reverse (wanted ⊆ held). The check
walks both schemas:

- `type` sets are contained (`integer` is inside `number`);
- a field one side relies on is `required` on the other;
- numeric and length ranges are contained;
- `enum`, `const` and `oneOf` value sets are contained;
- it recurses into `properties` and `items`.

`title`, `description`, `x-choicesFrom` and every other `x-*` annotation are
ignored. So is a field only one side mentions, unless that side requires it
or closes the schema with `additionalProperties: false`.

**Links.** A link role the app uses must be declared in the space. Where it
may point must be contained: `["app.poll"]` is inside `"*"` for reading, not
for writing. `"one"` is inside `"many"`. Roles the app doesn't know are
ignored when reading.

**Rules: never looser.** Stricter rules are never a safety problem. At worst
the app can't write, which `can` already reports. So rules are checked one
way: the space's rule must be an **attenuation** of the app's, as in UCAN.

- `onePer`: the space promises at least the uniqueness the app relies on.
  Fewer parts is a stronger promise.
- `fixed`: the space keeps at least the fields the app expects fixed.
- `final`: an app that relies on it needs it.

Who may write is the space's grants, so it isn't compared.

### What uses it

1. **Apps open by compatibility**, not by name. A collection that exists but
   isn't compatible is shown with its breaks instead of opened.
2. **Harmless updates apply themselves.** When the library's definition is
   newer, `compare(held, library)` finds no break either way, and the rules
   are no looser, a writer allowed to change the definition writes it at the
   next version without asking. Adding `shares` to an older `std.message` is
   this case.
3. **Anything else asks a person.** The blueprint review shows the breaks,
   like "a poll's options can now be changed after it is added", not just
   "changes the rules".

Your app shouldn't define a `std.*` name that isn't compatible with the
standard library's. Peers don't refuse one when it arrives, since that would
depend on what each peer knows and leave them disagreeing. So an app treats
an incompatible `std.message` as not a message.

Built so far: `collections_propose` refuses a `std.*` definition that isn't
exactly the library's
([what a `std.*` name means](standard-library.md#what-a-std-name-means)).
Typed handles in the library (`node.use(space, Poll)`) would run the same
check.

The plans differ in one place. This check stays on the app's side and lets a
person approve a breaking change. #12 makes "additive" a rule peers enforce.
`compare` is the check "additive" needs, in both directions. Identical
content-addressed definitions (#11) are trivially compatible, so it would run
only on a real change.

### What "additive" means

Spec 02 §6.5 plans the rule. This is why it draws the line where it does.

Changes are classified the way **oasdiff** classifies OpenAPI changes. A
collection's schema is treated as a request body and a response body at
once, because apps both write records and read them.

- **As a request**, a change must not **tighten**: a new required field, a
  narrower type, a smaller range or length, fewer `enum`/`const`/`oneOf`
  values, a link that may point at less. Apps on the old definition could no
  longer write.
- **As a response**, a change must not **loosen**: a field no longer
  required, a wider type, a larger range, more `enum` values, a link that may
  point at more. Apps on the old definition would meet records they misread,
  like a status they don't handle.

A change under the same name is additive when oasdiff would report no
error-level break on either side. Its warnings and information stay that. The
catalogue of checks is oasdiff's, mapped onto the schema keywords and links.
A keyword it has no check for is a break.

Rules aren't shape. `onePer`, `fixed` and `final` are the space's governance,
like its grants. A space may tighten them under the same name, since at worst
an app can't write, which `can` reports. It may never loosen them past what
an app relies on.

### Open questions

- **Rules only apply from now on.** A space that was loose last month and
  strict today holds records written under the loose rules. Either `compare`
  looks at every definition the collection has had, or "compatible" describes
  only records written from now on. Probably the second.
- **Translating instead of refusing.** Lenses between versions, as in
  Cambria, would let an app read a definition it isn't compatible with.
  Later.

## Planned: meaning-level hints

A definition says what a record may hold and the rules it keeps, not what it
means to a screen. Views built from definitions, like the blueprint review or
made apps without a screen of their own, have to guess which field is the
title, or that votes show as counts. The plan adds optional hints:

- which field is the record's **title**;
- **tallies**: show the records linking here as a count, the way
  `x-choicesFrom` already allows vote-style counts;
- values **worked out on read**, like "voting closes Friday" or "who hasn't
  answered". Each reader computes them from the records and its own clock, so
  nothing has to run anywhere.

A field's kind, like a person, is already its `x-kind`
([collections](collections.md#schemas)). Hints are display only, like
`x-choicesFrom`. They are never checked when validating, and
[`compare`](#compatible-definitions) ignores them. A hint about one field is
an `x-*` keyword on it. One about the whole record is a top-level member of
the definition, which today's peers ignore. They'll be added when a derived
view falls short. The format is still open.
