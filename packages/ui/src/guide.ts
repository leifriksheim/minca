/** How to write a screen with the kit, for an agent: the part of the screen guide about `ui` (`frame/`) */
export const UI_GUIDE = `Before the screen's own scripts run, window.ui holds Preact with htm, so write components, not DOM code:
  const { html, render, useState, useRecords, useCan, Person } = ui;
  function App() {
    const tasks = useRecords('app.todo.task');         // null until loaded, then kept current
    const mayAdd = useCan('create', 'app.todo.task');
    if (!tasks) return null;
    return html\`<div class="stack">
      \${tasks.map((t) => html\`<div class="card row" key=\${t.key}>\${t.body.title} <\${Person} did=\${t.createdBy} /></div>\`)}
      \${mayAdd && html\`<button data-variant="primary" onClick=\${() => minca.put('app.todo.task', { title: 'New' })}>Add</button>\`}
    </div>\`;
  }
  render(html\`<\${App} />\`);

ui has:
  render(tree, element?)            draws it; without an element, into one of its own at the end of the page, once the page is ready
  html, h, Fragment, and the hooks useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer
  useRecords(collection, where?)    its records, oldest first, redrawn whenever the space changes; null until here
  useCan(action, collection)        whether the person looking may "create", "edit" or "delete" there; false until known
  usePeople()                       [{ did, name }], kept current
  useName(did)                      their name here, "You" for the person looking
  useFile(key, ref)                 a picture the record \`key\` refers to, as a URL for <img>; null until here
  useShown()                        { key } of the record this app was last asked to show (its "shows"), a new object each time;
                                    null until one is. Scroll to it, open it: useEffect(() => …, [shown])
  useMarked()                       for a list, that key once the element with data-key=\${key} is drawn: scrolled to, and kept a
                                    moment, for data-marked=\${key === marked} to light it up
  usePresence(state)                [{ did, device, state }] of everyone else with this app open, each sharing their state (a cursor,
                                    what is selected, "typing"): yours goes out when it changes, ten times a second at most. Once per screen
  useLive(callback)                 callback({ from, device, data }) for each minca.live.send from another device, kept nowhere
  useBlob(key, ref)                 the whole file, as a URL for <img>, <video> or <audio>; null until here
  <\${Avatar} did size? round? />   someone's face: their picture, or the shape their account gives. Always use it for a person
  <\${Person} did size? name? face? />   face and name (face={false}: the name alone); a click opens their card in the app
  <\${Comments} about=\${record} />   the comments on a record and a box to add one, with @mentions and "/" to share something from
                                    the space (needs "std.comment" in collections)
  <\${Attachments} about=\${key} />   the files attached to a record (std.file about it): pictures, videos and sound that play, others saved
  attach(about, files)              keeps Files (from a drop, a paste or <input type=file>) as std.file records about a record,
                                    or about nothing when about is null; → the records written
  <\${Playable} record />          a std.file that is a video or a sound, playing where it is; fetched once it comes into view
  useSeen(ref)                      whether the element in ref has come into view: load something large only then
  sizeOf(bytes)                     "812 KB", "3.1 MB"
  <\${Record} record=\${r} onOpen? />  any record as one line, the same in every app: a file's picture, a task's tick, an event's
                                    time; a click opens it in the app that shows it, or calls onOpen. Use it for records of collections
                                    other apps own: a shared one, from minca.get(key, { link: 'shares' }), with
                                    onOpen=\${() => minca.open({ record: key, link: 'shares' })}
  useShare()                        sharing into what you send, as chat and comments do: share.pick() asks the person to choose a
                                    record (a "/" button), onChange=\${(next) => setDraft(share.typed(draft, next))} does the same for "/"
                                    typed into an empty box; put share.links on what you send, then share.clear(). <\${Sharing} share />
                                    is the chip of the one waiting; <\${Shared} from=\${record} /> the card of what a record shares
  <\${Modal} title onClose width?>…</\${Modal}>   a dialog over the screen
  <\${Shape} kind colour? size? />  one of Minca's shapes; <\${Cover} seed colour size? class?>…</\${Cover}> a picture for what has none
                                    (colour: cobalt, coral, peach, sage or lilac)
  <\${PlaceField} value onChange coarse? near? placeholder />   find a place by name, or use where the person is
  <\${NearButton} near onChange />  "Within 5 km of …", from useNear(): [near, setNear], remembered on this device
  placeLabel(place), distanceText(near, place), inReach(near, place), nearWhere(near)   for showing and finding places nearby
  <\${MapLink} place />             "Open map", at OpenStreetMap
  positionBetween(before?, after?)  a "position" text that sorts between two others (either may be missing), for ordering by hand
  ago(iso)                          "just now", "5m", "3h", "2d", then a date: how the app shows when something happened
  when                              dates as std.event keeps them: shortWhen, longWhen, horizon, isOn, dayKey, icsOf, …

To show a record the way the app does, with its comments, attachments and history, call minca.open({ record: key }).

The page already looks like Minca: buttons are pills (data-variant="primary" for the main action, "ghost" for quiet ones,
"danger" for deleting; data-icon makes one holding a single symbol a circle), inputs, headings and the page are styled, and these classes lay things out: card, row, stack,
muted, faint, empty, chip (a toggle pill, on with aria-pressed), label, error, ellipsis. Write as little CSS as you can; when you need colours, use the variables: var(--minca-ink),
--minca-body, --minca-muted, --minca-faint, --minca-page, --minca-card, --minca-sunken, --minca-line, --minca-accent,
--minca-danger, and corners --minca-radius-sm, -md, -lg, -pill. Fonts from URLs never load.`;
