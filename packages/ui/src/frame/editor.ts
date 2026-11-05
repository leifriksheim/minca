/**
 * Writing Markdown without seeing it, as a chat's box does: bold shows bold and
 * code shows as code, and what the box hands back is Markdown (markdown.ts
 * draws it, here as in a message). The keys chat apps use format what is
 * selected, and so does the format menu; Markdown typed or pasted as it is
 * (**bold**, a fence, "- ") turns into what it says. "@" suggests the space's
 * people.
 */
import type { JSX } from 'preact';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { usePeople } from './hooks';
import { html } from './html';
import { markdownOf, shortLink } from './markdown';
import { useOpen } from './menus';
import type { Someone } from './minca';
import { Avatar } from './people';
import { Icon } from './shapes';

// execCommand is deprecated, yet it is still the one way to change an editable box that the browser's own undo follows.
// eslint-disable-next-line typescript/no-deprecated -- see above
const exec = (command: string, value?: string) => document.execCommand(command, false, value);

/** The element at the caret, or around it, that `selector` matches, inside a box */
function around(selector: string): HTMLElement | null {
  const node = getSelection()?.anchorNode;
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  const found = element?.closest(selector);
  return found instanceof HTMLElement && found.closest('.editor') ? found : null;
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** Inline code around what is selected, or out of it when the caret is in some; with nothing selected, code from here */
function toggleCode() {
  const code = around('code');
  if (code && !code.closest('pre')) {
    const range = document.createRange();
    range.selectNode(code);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    exec('insertText', code.textContent?.replace(/​/g, '') ?? '');
    return;
  }
  const selected = getSelection()?.toString() ?? '';
  // A zero-width space holds the caret inside empty code; Markdown leaves it out.
  exec('insertHTML', `<code>${escape(selected) || '​'}</code>​`);
  if (!selected) {
    const after = getSelection();
    const node = after?.anchorNode;
    const before =
      node instanceof Text ? node.previousSibling : node?.childNodes[(after?.anchorOffset ?? 1) - 1];
    const empty = before instanceof HTMLElement && before.tagName === 'CODE' ? before.firstChild : null;
    if (empty) after?.collapse(empty, 1);
  }
}

/** A block (a quote, a code block) around the lines selected, or back to plain lines */
const toggleBlock = (tag: string) => () => exec('formatBlock', around(tag) ? '<div>' : `<${tag}>`);

/** Each format: its name, the key with ⌘ or Ctrl that does it (Slack's), and what it does */
const FORMATS = [
  { label: 'Bold', key: 'KeyB', keys: 'B', apply: () => exec('bold') },
  { label: 'Italic', key: 'KeyI', keys: 'I', apply: () => exec('italic') },
  { label: 'Strikethrough', key: 'KeyX', shift: true, keys: '⇧X', apply: () => exec('strikeThrough') },
  { label: 'Code', key: 'KeyC', shift: true, keys: '⇧C', apply: toggleCode },
  { label: 'Code block', key: 'KeyC', shift: true, alt: true, keys: '⌥⇧C', apply: toggleBlock('pre') },
  { label: 'Quote', key: 'Digit9', shift: true, keys: '⇧9', apply: toggleBlock('blockquote') },
  {
    label: 'Bulleted list',
    key: 'Digit8',
    shift: true,
    keys: '⇧8',
    apply: () => exec('insertUnorderedList'),
  },
  { label: 'Numbered list', key: 'Digit7', shift: true, keys: '⇧7', apply: () => exec('insertOrderedList') },
];

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** Stands for the caret while the box goes to Markdown and back: a character no one types */
const CARET = '\ue000';

/** The caret's line holds only what opens a block */
const OPENING = new RegExp(`^[ \\t]*(?:\`{3,}[^\\s\`]*|~{3,}\\S*|>|[-*+]|\\d{1,9}[.)])[ \\t]*${CARET}$`, 'm');

/** What a box or a drawing shows, its spaces aside: if Markdown would draw something else, the box isn't showing it yet */
const shown = (node: Node) => (node.textContent ?? '').replace(/[\s\u200b]/g, '');

/** The node at the same place in `copy` as `node` is in `root` */
function sameIn(root: Node, copy: Node, node: Node): Node | null {
  const path: number[] = [];
  for (let at: Node | null = node; at && at !== root; at = at.parentNode)
    path.unshift([...(at.parentNode?.childNodes ?? [])].findIndex((child) => child === at));
  return path.reduce<Node | null>((into, i) => into?.childNodes[i] ?? null, copy);
}

/**
 * Draws the box as its Markdown will be drawn once sent, so what is typed as
 * Markdown (**bold**, a fence, "- ", a pasted table) shows as what it says. The
 * caret goes through as a character and is put back where it lands. Replaced
 * through the browser, so undo takes it back.
 */
function redraw(box: HTMLElement) {
  const selection = getSelection();
  const caret = selection?.focusNode;
  if (!selection || !caret || !box.contains(caret)) return;
  const copy = box.cloneNode(true);
  const at = sameIn(box, copy, caret);
  if (at instanceof Text) at.insertData(selection.focusOffset, CARET);
  else at?.insertBefore(document.createTextNode(CARET), at.childNodes[selection.focusOffset] ?? null);
  const markdown = toMarkdown(copy);
  // A line that only opens a block ("> ", "- ", a fence) waits for what goes in it
  if (OPENING.test(markdown)) return;
  const drawn = document.createElement('div');
  render(html`${markdownOf(markdown)}`, drawn);
  if (shown(drawn) === shown(copy)) return;
  selection.selectAllChildren(box);
  if (!exec('insertHTML', drawn.innerHTML)) return;
  // A browser inserts HTML as it pastes, folding a first block (a code block) into the line around it; then the
  // drawing goes in as it is, which undo doesn't follow
  if (toMarkdown(box) !== markdown) box.innerHTML = drawn.innerHTML;
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node instanceof Text; node = walk.nextNode()) {
    const offset = node.data.indexOf(CARET);
    if (offset < 0) continue;
    // A zero-width space keeps a place of its own after a mark, so what is typed next goes outside it
    node.replaceData(offset, 1, node.data.length > 1 ? '' : '\u200b');
    selection.collapse(node, node.data === '\u200b' ? 1 : offset);
    return;
  }
  // The caret was in what Markdown drops: it goes to the end, inside what is last
  let last: Node = box;
  while (last.lastChild && last.lastChild.nodeName !== 'BR') last = last.lastChild;
  if (!(last instanceof Text)) last = last.appendChild(document.createTextNode('\u200b'));
  selection.collapse(last, last instanceof Text ? last.length : 0);
}

/** Shift+Enter on an empty last line of a code block or quote leaves it, as chat apps have it */
function leaveBlock(): boolean {
  const block = around('pre, blockquote');
  const selection = getSelection();
  if (!block || !selection?.focusNode) return false;
  const rest = document.createRange();
  rest.setStart(selection.focusNode, selection.focusOffset);
  rest.setEndAfter(block);
  const text = plainText(block);
  if (rest.toString() || !text.trim() || !text.endsWith('\n')) return false;
  // The breaks that made the empty line go, and a line after the block takes the caret
  const last = () => {
    let node = block.lastChild;
    while (node?.lastChild) node = node.lastChild;
    return node;
  };
  const blank = (node: ChildNode | null) => !!node && !node.textContent?.replace(/\u200b/g, '').trim();
  for (let node = last(); node && blank(node); node = last()) node.remove();
  const line = document.createElement('div');
  line.append(document.createElement('br'));
  block.after(line);
  selection.collapse(line, 0);
  return true;
}

/** Set while the box redraws itself, so the input that causes is not taken as typing */
let redrawing = false;

const MARKS: Readonly<Record<string, string>> = {
  B: '**',
  STRONG: '**',
  I: '_',
  EM: '_',
  S: '~~',
  STRIKE: '~~',
  DEL: '~~',
};

/** A mark around words, outside the spaces at their ends, as Markdown needs it */
function wrap(mark: string, text: string): string {
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
  return core ? `${lead}${mark}${core}${mark}${trail}` : text;
}

/** What an element says, its line breaks kept and no marks: the inside of code */
function plainText(node: Node): string {
  if (node instanceof Text) return node.data.replace(/​/g, '');
  if (node.nodeName === 'BR') return '\n';
  const inner = [...node.childNodes].map(plainText).join('');
  return /^(DIV|P)$/.test(node.nodeName) && node.previousSibling ? `\n${inner}` : inner;
}

/** What is in the box, as Markdown */
function toMarkdown(root: Node): string {
  let out = '';
  /** What comes next goes on a new line (1), or after a blank one (2) */
  const gap = (lines: number) => {
    const have = /\n*$/.exec(out)?.[0].length ?? 0;
    if (out && have < lines) out += '\n'.repeat(lines - have);
  };
  const block = (lines: number, write: () => void) => {
    gap(lines);
    write();
    gap(lines);
  };
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      out += node.data.replace(/​/g, '').replace(/ /g, ' ');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    const mark = MARKS[tag];
    const href = node.getAttribute('href');
    if (tag === 'BR') out += '\n';
    else if (mark) out += wrap(mark, toMarkdown(node));
    else if (tag === 'CODE') out += wrap('`', plainText(node));
    else if (tag === 'A' && href) {
      const label = toMarkdown(node);
      out += !label || label === href || label === shortLink(href) ? href : `[${label}](${href})`;
    } else if (tag === 'PRE')
      block(2, () => (out += `\`\`\`\n${plainText(node).replace(/\n$/, '')}\n\`\`\``));
    else if (tag === 'BLOCKQUOTE') block(2, () => (out += toMarkdown(node).replace(/^/gm, '> ')));
    else if (tag === 'UL' || tag === 'OL')
      block(2, () => {
        const items = [...node.children].map(
          (li, i) => `${tag === 'OL' ? `${i + 1}.` : '-'} ${toMarkdown(li)}`,
        );
        out += items.join('\n');
      });
    else if (tag === 'TABLE')
      block(2, () => {
        const rows = [...node.querySelectorAll('tr')].map(
          (tr) => `| ${[...tr.cells].map((cell) => toMarkdown(cell).replace(/\|/g, '\\|')).join(' | ')} |`,
        );
        const columns = node.querySelector('tr')?.cells.length ?? 1;
        rows.splice(1, 0, `|${' --- |'.repeat(columns)}`);
        out += rows.join('\n');
      });
    else if (tag === 'HR') block(2, () => (out += '---'));
    else if (tag === 'P' || /^H\d$/.test(tag)) block(2, () => node.childNodes.forEach(visit));
    else if (tag === 'DIV' || tag === 'LI') block(1, () => node.childNodes.forEach(visit));
    else node.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return out.replace(/^\n+|\s+$/g, '');
}

/** Puts Markdown in the box, drawn */
function fill(box: HTMLElement, markdown: string) {
  const drawn = document.createElement('div');
  render(html`${markdownOf(markdown)}`, drawn);
  box.innerHTML = drawn.innerHTML;
}

/**
 * The box to write in: formatting shows as it will be sent, `value` and
 * `onChange` are Markdown. Enter sends its form, Shift+Enter starts a new line
 * (or item, in a list). "@" suggests the space's people above it as you type;
 * arrows move through them, Enter or Tab picks one. Anything else a box takes
 * (aria-label, say) is passed on.
 */
export function MentionInput({
  value,
  onChange,
  placeholder,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
} & Omit<JSX.HTMLAttributes<HTMLDivElement>, 'value' | 'onChange' | 'placeholder'>) {
  const others = usePeople().filter((one) => one.did !== minca.me.did);
  const [typed, setTyped] = useState('');
  const [choice, setChoice] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // The Markdown the box last gave, so a value that is only that again leaves the box (and its caret) as it is
  const gave = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || value === gave.current) return;
    gave.current = value;
    fill(el, value);
    // Set from outside while being written in (an emoji added, say), the caret goes to the end
    if (document.activeElement === el) getSelection()?.collapse(el, el.childNodes.length);
  }, [value]);

  /** The word being typed, when the caret is at the end of one */
  const track = () => {
    const selection = getSelection();
    const node = selection?.anchorNode;
    setTyped(node instanceof Text ? node.data.slice(0, selection?.anchorOffset ?? 0) : '');
  };
  const changed = () => {
    const el = box.current;
    if (!el) return;
    const markdown = toMarkdown(el);
    // Emptied, the box drops the line break a browser leaves, so its placeholder shows
    if (!markdown && !el.querySelector('li, pre, blockquote')) el.replaceChildren();
    gave.current = markdown;
    onChange(markdown);
    track();
    setChoice(0);
  };

  const mention = /(?:^|\s)@([^\s@]*)$/.exec(typed);
  const query = mention ? (mention[1] ?? '').toLowerCase() : null;
  const suggestions =
    query === null ? [] : others.filter((one) => one.name.toLowerCase().includes(query)).slice(0, 6);
  const pick = (someone: Someone) => {
    const selection = getSelection();
    const node = selection?.anchorNode;
    if (!(node instanceof Text) || !selection) return;
    const at = selection.anchorOffset;
    selection.setBaseAndExtent(node, at - (query?.length ?? 0) - 1, node, at);
    exec('insertText', `@${someone.name} `);
  };

  const keyDown = (event: KeyboardEvent) => {
    if (suggestions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setChoice((choice + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const someone = suggestions[choice] ?? suggestions[0];
        if (someone) pick(someone);
        return;
      }
      if (event.key === 'Escape') return setTyped('');
    }
    const format = (event.metaKey || event.ctrlKey) && FORMATS.find((f) => f.key === event.code);
    if (format && !!format.shift === event.shiftKey && !!format.alt === event.altKey) {
      event.preventDefault();
      format.apply();
      return;
    }
    // Enter mid-word in an input method is the input method's
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!event.shiftKey) box.current?.closest('form')?.requestSubmit();
    else if (leaveBlock()) changed();
    else exec(around('li') ? 'insertParagraph' : 'insertLineBreak');
  };

  const paste = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    // Files are the form's to take
    if (!data || data.files.length) return;
    event.preventDefault();
    const text = data.getData('text/plain');
    const selected = getSelection()?.toString();
    // A link pasted over words links them
    if (selected && /^https?:\/\/\S+$/.test(text.trim())) exec('createLink', text.trim());
    else exec('insertText', text);
  };

  return html`<div class="mention-input">
    ${
      suggestions.length > 0 &&
      html`<ul class="suggestions above" role="listbox">
        ${suggestions.map(
          (one, i) =>
            html`<li
              key=${one.did}
              role="option"
              aria-selected=${i === choice}
              onMouseDown=${(event: Event) => (event.preventDefault(), pick(one))}
            >
              <span class="row"><${Avatar} did=${one.did} size=${18} round /> ${one.name}</span>
            </li>`,
        )}
      </ul>`
    }
    <div
      ...${rest}
      ref=${box}
      class="editor markdown"
      contenteditable="true"
      role="textbox"
      aria-multiline="true"
      data-placeholder=${placeholder}
      onInput=${(event: InputEvent) => {
        // Our own redraw comes back through here; an input method's word isn't done until it is
        if (redrawing || event.isComposing) return;
        changed();
        // Undo takes a redraw back, and stays taken back
        if (event.inputType.startsWith('history')) return;
        // Once whatever made this input is done: a browser refuses a command (the redraw's) inside another (a paste's)
        queueMicrotask(() => {
          if (!box.current) return;
          redrawing = true;
          try {
            redraw(box.current);
          } finally {
            redrawing = false;
          }
          changed();
        });
      }}
      onKeyDown=${keyDown}
      onKeyUp=${track}
      onClick=${track}
      onPaste=${paste}
    ></div>
  </div>`;
}

/**
 * A button that opens the formats, each with its keys; picking one formats
 * what is selected in the box beside it. A press keeps the box's selection.
 */
export function FormatMenu() {
  const { open, setOpen, box } = useOpen();
  const keep = (event: Event) => event.preventDefault();
  return html`<div class="anchor" ref=${box}>
    <button
      type="button"
      data-intent="ghost"
      data-icon
      aria-label="Formatting"
      title="Formatting"
      aria-expanded=${open}
      onMouseDown=${keep}
      onClick=${() => setOpen(!open)}
    >
      <${Icon} name="format" />
    </button>
    ${
      open &&
      html`<menu role="menu" class="formats">
        ${FORMATS.map(
          (format) =>
            html`<li key=${format.label}>
              <button
                type="button"
                role="menuitem"
                onMouseDown=${keep}
                onClick=${() => {
                  setOpen(false);
                  format.apply();
                }}
              >
                ${format.label} <kbd>${MOD}${format.keys}</kbd>
              </button>
            </li>`,
        )}
      </menu>`
    }
  </div>`;
}
