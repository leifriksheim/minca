# The query format

This is the full reference for the query JSON that `node.records.query`,
`watch` and `useQuery` take. For a gentler start, see
[Records and queries](records-and-queries.md#querying).

A query runs against the records one node holds of one space. Peers never
exchange queries, but [automations](automations.md) and
[screens](blueprints-and-guides.md#apps-with-a-screen-of-their-own) keep them
in records, so everything that runs those must read this format the same way.

## Grammar

```
Query      = { "collection": CollName,
               ?"where":   Filter,
               ?"include": IncludeMap,
               ?"sort":    { *(Field: "asc" | "desc") },
               ?"limit":   Int≥0,
               ?"cursor":  string }

Filter     = { *( Field: Condition
                | "$and": [ *Filter ]
                | "$or":  [ *Filter ]
                | "$not": Filter ) }

Condition  = Operators          ; a non-empty object whose every member name starts with "$"
           | Value              ; anything else: deep equality

Operators  = { 1*( "$eq": Value | "$ne": Value
                 | "$gt": Value | "$gte": Value | "$lt": Value | "$lte": Value
                 | "$in": [ *Value ] | "$nin": [ *Value ]
                 | "$exists": boolean
                 | "$contains": Value ) }

Field      = MetaField | LinkField | IncludeField | Path
MetaField  = "@key" | "@author" | "@root" | "@createdBy" | "@createdAt"
           | "@updatedAt" | "@seq" | "@collection"
LinkField  = "link:" rel                  ; rel as spec 02 §5.1
IncludeField = "include:" name            ; in an automation's `holds` only: what its query included
Path       = segment *( "." segment )     ; a computed field, or into the body; not starting with "@", "$" or "link:"

IncludeMap = { *( Name: Include ) }
Include    = { "rel": string,
               ?"from":      CollName,
               ?"direction": "in" | "out",      ; default "in"
               ?"where":     Filter,
               ?"include":   IncludeMap,        ; nesting depth ≤ 3
               ?"limit":     Int≥0,
               ?"count":     boolean }
```

## Malformed queries

A query is refused before it runs, with a reason, when:

- it is not an object, or `collection` is missing or empty;
- a filter is not an object, or `$and` or `$or` is not a list;
- a member name starts with `$` and is not `$and`, `$or` or `$not`;
- a `@` field is not one of the MetaFields, or a `link:` field is malformed;
- an operator object names an unknown operator;
- an include lacks `rel`, has a `from` that isn't a string, a bad
  `direction`, or a `limit` that isn't a non-negative integer;
- includes nest more than 3 deep;
- a `sort` direction is not `asc` or `desc`, or names an unknown `@` field;
- `limit` is not a non-negative integer, or `cursor` is not a string.

## Definitions in TypeScript

In TypeScript you can pass a collection's definition as `collection` or
`from`. It is replaced by its `name` before the query runs.

With a definition, `where` and `sort` are typed from it. Each field must be a
body path, a computed field, an `@` field or a `link:<role>` it has, and each
value must have that field's type. A misspelled field, or a number compared
with a string, is a type error. A collection named by a string is untyped.

## Which records it considers

A query considers the current, non-deleted version of every record in
`collection` that stands and whose body this node can read. Records it can't
open are left out, here and in every include, so a result's `body` is never
`null`. What "stands" means is in
[spec 02 §9.5](https://github.com/leifriksheim/minca/blob/main/spec/02-records.md).

> **Planned: leaving out records that do not conform.** Today a record whose
> body or links don't fit the definition is flagged `conforms: false` but
> still counted by queries, includes and counts. The plan is to leave such
> records out unless the query asks for them, with a new optional member such
> as `"nonconforming": true`.

## Field values

| Field            | Value                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| `@key`           | the record key                                                                 |
| `@author`        | the DID that signed this version                                               |
| `@root`          | the account it acted for                                                       |
| `@createdBy`     | the root of the record's first version, or null                                |
| `@createdAt`     | `createdAt` of the record's first version, by the creator's clock              |
| `@updatedAt`     | `createdAt` of this version                                                    |
| `@seq`           | `seq`                                                                          |
| `@collection`    | `collection`                                                                   |
| `link:<rel>`     | the `to` of the record's first link with that `rel`; missing when it has none  |
| `include:<name>` | in an automation's `holds` only: what that include found, a number for a count |
| path             | a computed field, or a value in the body (see below)                           |

`link:<rel>` reads links the way contracts' `link` and `onePer` do.
`{ "link:in": key }` finds a channel's messages, and
`{ "link:in": { "$exists": false } }` the messages in no channel.

### Paths

When a path's first segment names one of the collection's
[computed fields](computed.md), the path starts from that field's value.
Otherwise it starts from the body. A body member with a computed field's name
is never read, so a writer can't stand in for what the node works out.

At each segment, the current value must be a non-null object or array, and
the segment one of its own member names, or a position in an array (`0`, `1`,
and so on, not `length`). Otherwise the value is _missing_.

## Operators

`value` is the field's value, which may be missing. `x` is the operand.
_Equal_ means deep equality: the same JSON type, objects with the same member
names in any order and equal values, arrays with equal elements in order.

| Operator                  | Holds when                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| bare value `x`            | `value` equals `x`                                                                                                     |
| `$eq`                     | `value` equals `x`                                                                                                     |
| `$ne`                     | `value` does not equal `x`. **True for a missing field.**                                                              |
| `$gt` `$gte` `$lt` `$lte` | both are numbers, or both strings, and the comparison holds. Otherwise false.                                          |
| `$in`                     | `x` is a list with an element equal to `value`, or to any element of a list `value`                                    |
| `$nin`                    | `x` is a list and `$in` does not hold. False when `x` is not a list.                                                   |
| `$exists`                 | `value` is not missing, when `x` is true; is missing, when `x` is false. `null` exists.                                |
| `$contains`               | a string `value` contains a string `x`, ignoring case; or a list `value` has an element equal to `x`. Otherwise false. |

Strings compare by UTF-16 code units. A missing value never passes `$gt`,
`$gte`, `$lt` or `$lte`.

Several operators on one field must all hold, and so must several fields in
one filter. `$and` holds when all its subfilters do, `$or` when at least one
does, `$not` when its subfilter doesn't. They nest at most 16 deep.

> **Planned: full-text search.** `$contains` scans every candidate, so it is a
> substring match, not search. Ranking and prefix matching need an index kept
> beside the records. Not designed yet, including whether peers would share
> the index, and how a private space would keep its plaintext safe.

## Sort

`sort` applies field by field, in the order the members appear in the `sort`
object. JSON member order matters here. The default is
`{ "@createdAt": "asc" }`.

Values compare like this:

- missing or `null` first;
- two numbers numerically;
- two booleans `false` before `true`;
- anything else by their string forms.

`desc` reverses a field's order, so missing values sort last. Ties always
break on `@key`, ascending, so every node holding the same records gives the
same order.

## Limit and cursor

`limit` takes at most that many records after the cursor. Without it you get
all of them. There is no maximum.

The result's `cursor` is the key of the last record returned when more
follow, else `null`. Pass it back to resume after the record with that key.

If the cursor's record is gone, the query is meant to resume from where it
would have been. How to find that place is still open.

> **Known defect:** when the cursor's record is gone, paging starts again from
> the first record, so you see records twice
> ([#20](https://github.com/leifriksheim/minca/issues/20)).

## Include

For each record returned, each named include finds related records.

- `direction: "in"`, the default, finds records with a link
  `{ rel, to: <this record's key> }`. They come ordered by `@createdAt`, then
  `@key`.
- `direction: "out"` follows this record's own links with that `rel`, in link
  order. A target this node doesn't hold finds nothing.

Either way, only current, readable, non-deleted records count, and only those
in `from` when it is given. Then `where` filters them.

With `count: true` the include's value is how many it found, after `where`
and ignoring `limit`. Otherwise it is the first `limit` of them, or all, each
expanded by its own nested `include`.

Every returned record has an `included` object. It is empty when the query
has no includes.

## Result

```json
{ "records": [ … ], "cursor": "mfrggzdfmztwq2lknnwg23tpoa", "complete": true }
```

`complete` is false only on a node that holds part of a space, while a
collection the query needs is still arriving. Each record has the shape shown
in [Records and queries](records-and-queries.md#what-a-record-looks-like).
