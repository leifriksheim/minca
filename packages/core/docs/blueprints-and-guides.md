# Blueprints and guides

Two standard collections let a space grow new collections without anyone
deploying anything, and say how they are meant to be used.

- A **blueprint** (`std.blueprint`) is collections someone proposes: a title,
  and each collection as a full definition. Nothing is defined until someone
  who may define collections applies it (`applyBlueprint`).
- A **guide** (`std.guide`) is how some of the space's collections are meant
  to be used, in words, for whoever writes to them next, often an agent.

Neither is about any one app. An app that keeps more about itself, such as a
screen or what to notify about, keeps it in records of its own that point at
its blueprint. The example app's launcher does
(`apps/example/src/components/apps/launcher.ts`). Both records' fields are in
the [standard library](standard-library.md).

> Not protocol. This page describes the reference library, and another
> implementation may do it differently and still interoperate. What peers must
> agree on is in the [spec](https://github.com/leifriksheim/minca/blob/main/spec/README.md).

## Who proposes

Anyone in a space may write a blueprint. It is how a key that may only write
records asks for collections: an agent's, whose note grants records only, or
a person's, whose roles hold no `/collection/define`. Both take the same path, and
neither needs to know which they are. Every peer refuses a definition from a
key whose note doesn't grant `/collection/define`, so a blueprint is the only
way such a key gets a collection.

`applyBlueprint` defines each collection the space doesn't have as the
blueprint says, signed by whoever applies it. They need a grant of
`/collection/define` in the space, and a note that grants it. It defines
`std.blueprint` itself first when the space lacks it. Who may edit a
blueprint is the space's grants: under the `community` template, only its
proposer, moderators and admins.

```typescript
import { proposeCollections, reviewBlueprint, applyBlueprint } from '@minca/core/schemas';

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

- At most 10 collections per blueprint, none of them `sys.*`, none twice, and
  none with a `version`: the space decides that when it is applied
  (`checkBlueprint`).
- Through `collections_propose`, a standard collection may be given by name
  (`"std.event"`): `standardCollections` puts the library's definition in its
  place, so it is exactly the library's ([what a `std.*` name means](standard-library.md#what-a-std-name-means)).
- `copyBlueprint` proposes the same blueprint in another space, with `from`
  naming where it came from. People there decide for themselves.
- The actions are `collections_propose`, `collections_proposals` and
  `collections_apply` ([actions](actions.md)). An agent's node is not offered
  `collections_apply`.

_Source: `packages/core/src/schemas/blueprints.ts` (`checkBlueprint`, `proposeCollections`, `applyBlueprint`, `copyBlueprint`), `packages/core/src/schemas/library/collections.ts` (`blueprint`), `packages/core/src/node/actions.ts` (`collections_propose`, `collections_proposals`, `collections_apply`). Tests: `packages/core/tests/records-only.test.ts` ("collections proposed in a blueprint": "an agent proposes, someone who may define applies it, and the space then has the collections", "a person whose role holds no /collection/define proposes the same way, and someone who may applies it", "copying a blueprint into another space proposes it there, and says where it came from", "a proposal may not name the protocol's own collections, a version, or one collection twice")._

## The review

`reviewBlueprint` works out what applying a blueprint would do in a space:
each collection is `new`, the `same` as the space has it, or a `change`, with
what it allows worked out from its rules ([describing a collection](#describing-a-collection))
and, for a change, what would be different and which applied blueprints need
the collection as it is (`usedBy`). A person reads that before applying; a
blueprint is `applied` once every collection is the same.

A space that holds the library's current definition of a standard
collection meets a blueprint made against an earlier one: a `std.*`
collection is **the same** as what the space holds when the space's schema,
history, links, rules and topics are the library's. The review
never offers an earlier standard definition as a change to a space that
holds the current one, since applying it would only take the additions away.

_Source: `packages/core/src/schemas/blueprints.ts` (`reviewBlueprint`, `metByLibrary`). Tests: `packages/core/tests/records-only.test.ts` ("a proposal that changes a collection the space has says so, and says how", "a blueprint made against an earlier standard definition is met by the library's current one, not offered as a change back")._

## Updates

A blueprint is changed by proposing a new one whose `updates` is the key of
the blueprint, in the same space, that it is a new version of.

```json
{ "title": "Carpool", "collections": [ … ], "updates": "5vcfnlfrf7qnql2jhyl7erfqva" }
```

A blueprint is **superseded** when one that names it in `updates` is applied
(every collection is in the space as it says), or is itself superseded. A
superseded blueprint would only undo its update:

- `applyBlueprint` never applies a superseded blueprint.
- An app should not offer a superseded blueprint to be applied; it is
  history, which its proposer or a moderator may delete.
- `updates` must name a blueprint that is in the space; `proposeCollections`
  and `collections_propose` refuse one that does not.

Until its update is applied, the blueprint it names is still the one in use.
Without `updates`, two blueprints that need the same collection differently
each show as a change that undoes the other. So a review names the applied
blueprints that need a collection it would change (`usedBy`), and
`collections_propose` warns a proposer whose blueprint changes one without
`updates`.

> **Planned (open question):** with [`compare`](#compatible-definitions), an update's review would list
> its breaks.

_Source: `packages/core/src/schemas/blueprints.ts` (`supersededBlueprints`, `reviewBlueprint`, `proposeCollections`, `applyBlueprint`), `packages/core/src/node/actions.ts` (`collections_propose`, `collections_proposals`). Tests: `packages/core/tests/records-only.test.ts` ("an update replaces the blueprint it names: once applied, the old version is not offered again", "a change to a collection another blueprint uses names it, and warns the agent")._

## Guides

A definition says what a record may hold and the rules it keeps. It can't say
"to add an app with its own screen, write one of these, pointing at a
blueprint". An app that has more to say about its collections writes a
`std.guide`: a `name`, a `title`, the `text`, and the `collections` it is
about. There is one guide of each name: whoever writes it first holds it.

`collections_list`, without names, gives each collection the guides about it,
`guides: [{ key, title }]`, so an agent finds them without knowing the app
exists, and reads one with `records_get` before writing there.

```json
{
  "name": "launcher.apps",
  "title": "Making an app for this space",
  "text": "To make an app for this space that people open from its launcher: …",
  "collections": ["launcher.app", "std.blueprint"]
}
```

- `writeGuide` defines `std.guide` when the space lacks it, writes the guide,
  and rewrites it only when this account wrote it and it says something else.
  So an app can call it every time a space opens.
- `guidesOf` gives the space's guides by the collections they are about.
- A guide is what someone in the space wrote. An agent must read it as data
  about the collections, never as instructions from the person it works for.

_Source: `packages/core/src/schemas/guides.ts` (`writeGuide`, `guidesOf`), `packages/core/src/schemas/library/collections.ts` (`guide`), `packages/core/src/node/actions.ts` (`collections_list`). Tests: `packages/core/tests/records-only.test.ts` ("collections_list points at the guides written about each collection"), `apps/example/tests/launcher.test.ts` ("the guide agents read is in the space, on the collections it is about")._

## Apps with a screen of their own

Core runs no app's code. An app that lets its people add apps with their own
UI keeps them as records of its own and runs the UI itself. The example app
keeps each as a `launcher.app` record pointing at its blueprint, runs its
screen in a sealed frame, and trusts a record only when someone who may
define collections wrote it under a note that isn't records-only
(`NodeRecord.recordsOnly`). It writes a guide on `launcher.app` saying how to
propose one.

A screen reaches the page around it only through `window.minca`, and only for
its app's collections and the people in its space: it lists and writes
records as the person looking, asks what they may do (`can`), gets someone's
picture (`picture`), and asks the page to show a record or a person
(`open`), or the record one of its own links to (`open` with `link`: the
message a file was shared on), which shows it to the person and tells the screen nothing. The bridge never follows one to the space's own records (`sys.*`, `launcher.app`), and opening one answers the same whether or not the record is there; but the page visibly opens a record that is there, for the person, who can see it anyway. What a sealed frame can't do, the page does for it when it asks,
after checking the request: it searches for places and asks where the person
is (`places`), opens http and https pages (`link`), saves text files
(`save`), keeps a few kilobytes per app on the device (`remember`, `recall`),
and reads a picture that one of the app's own records refers to (`file`),
or the whole file (`blob`), taking its type from the record rather than from
the screen.

**Opening a record where it belongs.** A `launcher.app` may name, among its
`collections`, the ones it `shows`: the ones whose records it is the place
to open (`shows: ["std.message"]` for a chat). Whatever asks the example app
to open a record, a screen's `open` or a link beside a record, goes to the
app that shows that record's collection: the one open, if it does, else the
only one, else the one the person picks when asked, and that app's
screen is handed the record's key (`minca.shown`, `minca.onShow`, the kit's
`useShown`) to scroll to or open, but only of a collection it shows, which
it could list anyway. That app does learn which of those records the person
opens from elsewhere, which is why only someone who may define collections
adds an app. With no app that shows it, or when that app opens one of its
own (a poll's title in Polls, for its comments), the record opens beside
whatever is open. So the Files app opens a file's message in
the chat, and a chat's file in Files, without either knowing the other. An
app that names a collection in `shows` must do something with what it is
handed. The kit's `<Record>` draws any standard record as one line the same
way in every app, and opens it this way when clicked.

**Sharing a record into an app.** A screen can't list or read what its app
doesn't name, but a person can hand it one record, as a page gets only the
file a person picks for it. `minca.pick` asks the page to show a finder over
the whole space, and gives the screen the record the person chooses, or
null. The screen may then link one of its records to it with `shares`, like
a message, and anyone's screen reads it back through that link
(`minca.get(key, { link: 'shares' })`), read only. `shares` is the only role
a screen reads through: a file about a diary entry, or a reaction to it,
shares nothing, so a screen reads beyond its collections only records the
person picked, or that someone writing its collections shares (a member, an
agent, another app). That binds the screen, not its author: a member who
wrote a screen can share any record into its collections from their own
node, and the screen reads it. A shared record comes with its files' keys,
though not their bytes. A screen writes
a link only to a record of its own collections, one the person picked for
it, or one the record already has, refused alike whether or not the target
is here (so a link to a record that hasn't arrived yet waits until it has):
a screen never links out on its own, though like anything it reads, it can
copy what was shared into its own records. A screen may ask to pick as often
as it likes, and start the search from its own text; what it gets is still
only what the person chooses, in a space they can read anyway: Enter takes
the top match only once the person has typed. A chat
shares a poll without being able to read polls; `/` typed into an empty
message, or its `/` button, picks one; so does a comment box (the kit's
`useShare`).

A screen also sends live messages, kept nowhere, to the other devices that
have the same app open in the space (`live.send`, `live.on`): for cursors,
typing, who is here, or a game. Each goes as a live message of the space
([node](node.md#live-messages-and-status)) whose payload names the app by its
`launcher.app` key, and a screen hears only those naming its own app:

```json
{
  "type": "screen.live",
  "app": "aj5pakqf52uftpgarut33aqxq4.ctzz2xssv7y3alqlcepfmkdks4",
  "data": { "x": 120, "y": 48 }
}
```

A screen is handed `{ from, device, data, viaAgent }`, `from` being the
sender's account as the node proved it; a message from a peer with no account
is not passed on. One screen may send a burst of 30, then 15 a second, below
what a peer takes from another across everything, so a busy screen leaves
room for calls and the rest. An edited copy of an app is another
`launcher.app` record, so its screens don't hear the original's.

In front of every screen the example app also writes `@minca/ui`
(`packages/ui`): Preact with htm, hooks that keep records current, people's
faces, and Minca's look, so a screen is mostly what it is about. It isn't
part of the screen, so it doesn't count toward the 48 KB a screen may be.

The ready-made apps are screens too, written the same way. Adding one
defines its collections and writes a copy of it, naming where it came from
(`template: "kanban"`), and from then on the space changes its copy like any
other app.

_Source: `apps/example/src/components/apps/launcher.ts` (`addTemplate`), `apps/example/src/components/apps/screens.ts`, `apps/example/src/components/apps/ScreenFrame.tsx`, `apps/example/src/components/apps/templates/`, `apps/example/public/screen.html`, `packages/ui/src/frame/`, `packages/ui/src/guide.ts`. Tests: `apps/example/tests/launcher.test.ts` ("adding a ready-made app copies it into the space once, with its collections and first records"), `apps/example/tests/screens.test.ts` ("a screen checks, shows faces and opens things only within its app and its space", "what the page does for a screen, it does only as asked properly", "a screen can’t point a link out of its app, so it can’t probe for keys or reach what no one shared", "a record someone shared is read through the link to it, and only through that", "a screen links out only to what the person picked for it, and is handed what they picked", "the space’s own records are never picked for a screen", "a screen hears the same app's screens on other devices, as who sent it, and no other app's")._

## Describing a collection

A definition's `title` and `description` are its author's words and may say
anything. What a collection actually allows is worked out from its rules, as
fixed sentences, so a person deciding whether to add a collection reads what
every peer will enforce.

`describeCollection(definition)` returns, in this order:

1. `final`: "Nobody can change or remove a vote once it is added."
2. `onePer`: "One vote per person per poll — adding another changes the
   first." (with `@author`); otherwise "… — anyone adding another replaces the
   first.", or with `final`, "… — the first one added holds it."
3. `fixed`: "Once a poll is added, its “options” can't be changed."
4. Each condition of the contract (`contract.check`), in its own words: "Every change is checked: “…”".
5. One per declared link: "Each vote points at one thing: a poll (“about”)." or
   "A comment can point at anything in the space (“about”)."
6. `history: "all"`: "Every earlier version of a … is kept."

Who may add, change or remove records is not the definition's to say: it is
the space's grants ([spec 03 §2](https://github.com/leifriksheim/minca/blob/main/spec/03-spaces.md)),
so the description says nothing of it.

Nouns come from `title`, else the last segment of `name`; field labels from
the schema's `title`s, else the field name in words. A rule the describer does
not know must make it fail rather than stay silent.

The wording can change; that every rule produces a sentence doesn't.

_Source: `packages/core/src/records/describe.ts`. Tests: `packages/core/tests/records-only.test.ts` ("what a collection allows, in words")._

## Compatible definitions

An app decides it can open a space by finding a collection with the right
**name**. Chat opens any `std.message`, whatever its fields and rules. And a space whose definition is a little older than the
app's (a `std.message` or `std.comment` without the `shares` link) stays that way, because the
library skips a collection the space already has. Whether an app can use a
definition it did not write is a question for the app, not for peers: a peer
stores and judges every record the same way whatever the answer.

> **Planned.** Not built. Issues:
> [#11](https://github.com/leifriksheim/minca/issues/11),
> [#12](https://github.com/leifriksheim/minca/issues/12). The parts peers
> would check, content-addressed definitions and additive-only changes, are
> planned in [spec 02 §6.5](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

### The check: `compare(held, wanted)`

`held` is the definition the space has; `wanted` the one the app was built
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

An app that only shows records needs `read` empty; one that writes needs both.
Anything the checker cannot decide is a break.

- **Fields.** Reading needs every body the space accepts to be one the app
  accepts (held ⊆ wanted); writing needs wanted ⊆ held. Over the schema
  keywords a definition may use ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md))
  this is a walk of both schemas: `type` sets contained (`integer` inside
  `number`); a field one side relies on is `required` on the other; numeric
  and length ranges contained; `enum`, `const` and `oneOf` value sets
  contained; recurse into `properties` and `items`. `title`, `description`,
  `x-choicesFrom` and every other `x-*` annotation are ignored. A field only one side mentions is ignored,
  unless that side requires it or closes the schema
  (`additionalProperties: false`).
- **Links.** A link role the app uses is declared in the space; where it may
  point is contained (`["app.poll"]` is inside `"*"` for reading, not for
  writing); `"one"` is inside `"many"`. Roles the app does not know are
  ignored when reading.
- **Rules: never looser.** Stricter rules are never a safety problem (at worst
  the app cannot write, which `can` already reports), so rules are checked one
  way: the space's rule must be an **attenuation** of the app's, as in UCAN.
  `onePer`: the space promises at least the uniqueness the app relies on
  (fewer parts is a stronger promise). `fixed`: the space keeps at least the
  fields the app expects fixed. `final`: an app that relies on it needs it.
  Who may write is the space's grants, not the definition's, and is not
  compared.

### What uses it

1. **Apps open by compatibility**, not by name. A collection that exists but
   is not compatible is shown with its breaks instead of opened.
2. **Harmless updates apply themselves.** When the library's definition is
   newer and `compare(held, library)` finds no break in either direction and
   the rules are no looser, a writer allowed to change the definition writes
   it at the next version without asking. (Adding `shares` to an older
   `std.message` is this case.)
3. **Anything else asks a person.** The blueprint review shows the breaks ("a poll's
   options can now be changed after it is added"), not only "changes the
   rules".

An app should not define a `std.*` name that is not compatible with the
standard library's. Peers don't refuse one on arrival (refusing depends on
what each peer knows, and would leave peers disagreeing), so an app treats an
incompatible `std.message` as not a message.

Built so far: `collections_propose` refuses a `std.*` definition that is not exactly
the library's ([what a `std.*` name means](standard-library.md#what-a-std-name-means)).
Typed handles in the library (`node.use(space, Poll)`) would run the same check.

The plans differ in one place: this check stays on the app's side and lets a
person approve a breaking change, while #12 makes "additive" a rule peers
enforce. `compare` is the check "additive" needs, in both directions, and
identical content-addressed definitions (#11) are trivially compatible, so it
would run only on a real change.

### What "additive" means

Spec 02 §6.5 plans the rule; this is why it draws the line where it does.
Changes are classified as **oasdiff** classifies OpenAPI changes, treating a
collection's schema as a request body and a response body at once: apps write
records (a request) and apps read them (a response).

- **As a request**, a change must not **tighten**: a new required field, a
  narrower type, a smaller range or length, fewer `enum`/`const`/`oneOf`
  values, a link that may point at less. Apps on the old definition could no
  longer write.
- **As a response**, a change must not **loosen**: a field no longer
  required, a wider type, a larger range, more `enum` values, a link that may
  point at more. Apps on the old definition would meet records they misread
  (a status they don't switch on).

A change under the same name is additive when oasdiff would report no
error-level break for it on either side. Findings oasdiff reports as warnings
or information stay that. The catalogue of checks is oasdiff's, mapped onto
the schema keywords and links; a keyword it has no check for is a break.

Rules are not shape. `onePer`, `fixed` and `final` are the space's
governance, as its grants are: a space may tighten them under the
same name (at worst an app can't write, which `can` reports), and may never
loosen them past what an app relies on ("never looser", above).

### Open questions

- **Rules only apply from now on.** A space that was loose last month and
  strict today holds records written under the loose rules. Either `compare`
  looks at every definition the collection has had, or "compatible" is stated
  to describe records written from now on. Probably the second.
- **Translating instead of refusing** (lenses between versions, as in
  Cambria), so an app can read a definition it is not compatible with. Later.

## Planned: meaning-level hints

A definition says what a record may hold and the rules it keeps, not what it
means to a screen. Views derived from definitions (the blueprint review, an
app's collection views, made apps without a screen of their own) have to guess
which field is the title or that votes are shown as counts. The plan adds
optional hints to a definition:

- which field is the record's **title**;
- **tallies**: "show as a count" of records linking here, the way
  `x-choicesFrom` already makes vote-style counts possible;
- values **worked out on read**: "voting closes Friday", "who hasn't
  answered". Each reader computes them from the records and its own clock, so
  nothing has to run anywhere.

A field's kind (a person) is already its `x-kind` ([collections](collections.md#schemas)).
Like `x-choicesFrom`, hints are display only and never checked when
validating, and [`compare`](#compatible-definitions) ignores them. A hint
about one field is an `x-*` keyword on it; one about the whole record goes
in a top-level definition member, which today's peers ignore when they
don't know it ([spec 02 §6.2](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md)). Added when a derived view falls short. _Open:_ the format.
