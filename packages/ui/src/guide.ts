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
  useBlob(key, ref)                 the whole file, as a URL for <img>, <video> or <audio>; null until here
  <\${Avatar} did size? round? />   someone's face: their picture, or the shape their account gives. Always use it for a person
  <\${Person} did size? name? face? />   face and name (face={false}: the name alone); a click opens their card in the app
  <\${Comments} about=\${record} />   the comments on a record and a box to add one, with @mentions (needs "std.comment" in collections)
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
"danger" for deleting), inputs, headings and the page are styled, and these classes lay things out: card, row, stack,
muted, faint, empty, chip (a toggle pill, on with aria-pressed), label, error, ellipsis. Write as little CSS as you can; when you need colours, use the variables: var(--minca-ink),
--minca-body, --minca-muted, --minca-faint, --minca-page, --minca-card, --minca-sunken, --minca-line, --minca-accent,
--minca-danger, and corners --minca-radius-sm, -md, -lg, -pill. Fonts from URLs never load.`;
