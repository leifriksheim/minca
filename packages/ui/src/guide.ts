/** How to write a screen with the kit, for an agent: the part of the screen guide about `ui` (`frame/`) */
export const UI_GUIDE = `Before the screen's scripts run, window.ui holds Preact with htm: write components, not DOM code:
  const { html, render, useState, useRecords, useCan, Person } = ui;
  function App() {
    const tasks = useRecords('app.todo.task');         // null until loaded, then kept current
    const mayAdd = useCan('create', 'app.todo.task');
    if (!tasks) return null;
    return html\`<main>
      <header>
        <h1>Tasks</h1>
        \${mayAdd && html\`<button data-intent="primary" onClick=\${() => minca.put('app.todo.task', { title: 'New' })}>Add</button>\`}
      </header>
      <ul role="list">
        \${tasks.map((t) => html\`<li class="row" data-spread key=\${t.key}>\${t.body.title} <\${Person} did=\${t.createdBy} /></li>\`)}
      </ul>
    </main>\`;
  }
  render(html\`<\${App} />\`);

ui has:
  render(tree, element?)  draws it; without an element, into its own at the page's end once ready
  html, h, Fragment, and the hooks useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useReducer
  useRecords(collection, where?)  its records, oldest first, redrawn as the space changes; null until here
  useCan(action, target)  whether the viewer may "create" in a collection, or "edit" or "delete" a record (by key);
    false until known
  usePeople()  [{ did, name }], kept current
  useName(did)  their name here, "You" for the viewer
  useFile(key, ref)  a picture the record \`key\` refers to, as a URL for <img>; null until here
  useShown()  { key } of the record this app was last asked to show (its "shows"), a new object each time;
    null until one is. Scroll to it, open it: useEffect(() => …, [shown])
  useView()  [view, go]: where in itself the screen is (null at its start); go(view, title) goes one level
    in, titled in the app's bar, whose Back comes out: never draw a back button. go(null): the start
  useMarked()  for a list, that key once data-key=\${key} is drawn, scrolled to: data-marked=\${key === marked}
    lights it up
  usePresence(state)  [{ did, device, state }] of everyone else here, each sharing a state (a cursor, "typing");
    yours sent as it changes, 10 a second at most. Once per screen
  useLive(callback)  callback({ from, device, data }) for each minca.live.send from another device, kept nowhere
  useBlob(key, ref)  the whole file, as a URL for <img>, <video> or <audio>; null until here
  <\${Avatar} did size? round? />  someone's face: their picture, or the shape their account gives. Always use it for a person
  <\${Person} did size? name? face? />  face and name (face={false}: the name alone); a click opens their card in the app
  <\${Comments} about=\${record} />  a record's comments and a box to add one, with @mentions and "/" to share
    (needs "std.comment" in collections)
  <\${Attachments} about=\${key} />  a record's files (std.file about it): pictures, videos and sound play, others save
  attach(about, files)  keeps Files (from a drop, a paste or <input type=file>) as std.file records about a record,
    or about nothing when about is null, with thumbnails; → the records written
  <\${Playable} record />  a std.file that is a video or a sound, playing where it is; fetched when played
  useSeen(ref)  whether ref's element has come into view: load large things only then
  sizeOf(bytes)  "812 KB", "3.1 MB"
  <\${Record} record=\${r} onOpen? />  any record as one line; a click opens it where it belongs, or calls
    onOpen. For records other apps own, as a shared one: minca.get(key, { link: 'shares' }), with
    onOpen=\${() => minca.open({ record: key, link: 'shares' })}
  useShare()  sharing into what you send, as chat and comments do: share.pick() asks the person for a
    record (a "/" button), onChange=\${(next) => setDraft(share.typed(draft, next))} does the same for "/"
    typed into an empty box; put share.links on what you send, then share.clear(). <\${Sharing} share />
    is the one waiting; <\${Shared} from=\${record} /> what a record shares
  <\${AddMenu} onShare onFiles? />  "+" for a message box: share from the space, and attach files given onFiles
  <\${EmojiPicker} onPick />  a smile button with a grid of emoji; put the one picked in the text, or react with it
  <\${Reactions} about=\${record} adding? />  emoji reactions (std.reaction), yours toggled; react(record, emoji) adds one
    (needs "std.reaction" in collections)
  A message box is one field, as in Comments: <div class="composer"> holding <\${AddMenu} />, the input, and
  <div class="composer-end"><\${EmojiPicker} /> and send (data-intent="primary" data-icon, <\${Icon} name="send" />)</div>
  <\${RowMenu} label items />  "…" ending a row (rename, edit, delete): { label, onClick, danger?, confirm? }
  <\${Modal} title onClose width?>…</\${Modal}>  a dialog, seldom: a form or a page is a view (useView)
  <\${Empty} shape? colour? title text?>…</\${Empty}>  an empty app: a shape, a title, a line on what goes here,
    and the button that starts it inside
  <\${Shape} kind colour? size? />  a Minca shape; <\${Cover} seed colour size? wide?>…</\${Cover}> a thing's picture
    (colour: cobalt, coral, peach, sage or lilac)
  <\${Icon} name size? />  what a button does, never a picture of a thing: plus close check pencil send reply chevron
    back down grip arrow search settings menu trash copy attach upload download link lock calendar clock
  <\${PlaceField} value onChange coarse? near? placeholder />  find a place by name, or use where the person is
  <\${NearButton} near onChange />  "Within 5 km of …", from useNear(): [near, setNear], remembered on this device
  placeLabel(place), distanceText(near, place), inReach(near, place), nearWhere(near)  for showing and finding places nearby
  <\${MapLink} place />  "Open map", at OpenStreetMap
  positionBetween(before?, after?)  a "position" sorting between two (either may be missing), for ordering by hand
  ago(iso)  "just now", "5m", "2d", then a date
  when  dates as std.event keeps them: shortWhen, longWhen, horizon, isOn, dayKey, icsOf, …

To show a record the way the app does, with its comments, attachments and history, call minca.open({ record: key }).

Write plain HTML from this list, no CSS, <style> or style="": say what a thing is for, never how it looks.
  <main> the column (data-wide: full width; data-fill: the window's height, its first child scrolling over a box to write in);
    <header> title + actions; <section> a group under an h2
  h1 h2 h3 p a strong code; <small> meta and hints; <mark>; <s> done; class="truncate" one line, cut short, taking a row's room
  <button> data-intent="primary" (the main one) | "subtle" (back, close) | "ghost" (toolbars, rows) | "danger" | "open" (a task, a row;
    .row lays it across) | "inline" (a word in a sentence) | "choice" (a poll option, a <progress> in it); data-icon (icon only, aria-label); aria-pressed (on/off);
    <a data-intent> a link drawn as a button;
    <div role="tablist"> of buttons, one aria-selected="true"
  <label>Name <input></label>; <fieldset><legend>; input textarea select (in a row, a field takes the room left);
    <input type="checkbox" role="switch">; <p role="alert"> an error
  <article> one thing; <ul role="list"> of <li> (a data-intent="open" button in one is the row's text);
    class="grid" tiles; class="lanes" columns scrolled across (a board); class="tag" a label or count; <aside> a notice;
    <progress> <meter> <table> <pre> <details><summary>; <figure> a picture (Cover draws one; a photo fills it, tags on top);
    <div aria-roledescription="carousel"> pictures to swipe; <div role="grid"> of role="gridcell" a month
  <div data-actions> buttons shown on hover of what holds them; aria-grabbed="true" dragged; <hr data-drop> lands here
  class="row" | "stack", data-gap="tight" | "loose", data-spread (row: first at the start, the rest at the end)
  class="lead": a page's opening buttons by its h1, larger; nowhere else
  data-tone="good|warn|danger" colours text, a tag's or aside's ground; data-hue="1"…"5" a category's tint on a tag or article, var(--hue)
Nothing else exists. Only a game or drawing styles itself, in <main data-wide>, with only var(--color-*, --text-*, --space-*, --hue), sizes in rem.
Fonts from URLs never load.`;
