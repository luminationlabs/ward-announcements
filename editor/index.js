// The admin's visual editor, mounted over a form's Markdown textarea.
//
// Bundled by `scripts/vendor-bundles.mjs` into public/vendor/editor.js and loaded only on the three
// editor pages. The textarea stays the form field: the editor writes Markdown back into it as the
// document changes, so the server, the database and the members' renderer see exactly what they
// always did. A document the editor cannot hold — a table, an inline image — opens in Markdown
// instead, and anyone can switch to Markdown and back at any time.

import { Editor, getMarkRange } from '@tiptap/core';
import { protectDraft } from './drafts.js';
import { editorExtensions, emptyRow, rowAt } from './extensions.js';
import { createMarkdownParser, createMarkdownSerializer } from './markdown.js';
import { editorMarkdownIt } from '../src/markdown.ts';

/**
 * Pasted plain text that is probably Markdown — a program written elsewhere, a list,
 * a heading — is read as Markdown, so it arrives formatted rather than full of `##` and `...`.
 * Anything else (a sentence, a Word document's rich text) takes the browser's ordinary paste.
 */
const MARKDOWNISH = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|->|>\s|-{3,}\s*$)|\*\*|\]\(|\s(?:\.{3,}|…|\|)\s/m;

const MODE_KEY = 'ward-editor-mode';

const WORD_CHAR = /[\p{L}\p{N}\p{M}'’_-]/u;

/**
 * The word the cursor is strictly inside (word characters on both sides), as a document range, or
 * null at a word's edge or between words. Each inline leaf (a line break) reads as one newline, so
 * string offsets stay document offsets.
 */
function wordAround($pos) {
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const text = parent.textBetween(0, parent.content.size, '\n', '\n');
  let start = $pos.parentOffset;
  let end = start;
  if (!WORD_CHAR.test(text[start - 1] ?? '') || !WORD_CHAR.test(text[end] ?? '')) return null;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;
  return { from: $pos.start() + start, to: $pos.start() + end };
}

function button(label, title, onClick, extra = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
  b.addEventListener('click', onClick);
  Object.assign(b.dataset, extra);
  return b;
}

/** A curved arrow back to the left: undo, or mirrored, redo. */
const UNDO = '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>';
const icon = (paths, mirrored = false) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true"${mirrored ? ' style="transform: scaleX(-1)"' : ''}>${paths}</svg>`;


export function mountEditor(textarea, { kind = 'announcement', placeholder = '' } = {}) {
  const parseKind = kind === 'program' ? 'program' : 'announcement';
  let parser; // needs the editor's schema, so it is made just after the editor
  let drafts = null; // unsaved-work keeping; set up once the editor is in place (below)
  const serializer = createMarkdownSerializer(parseKind);

  const wrap = document.createElement('div');
  wrap.className = 'wysiwyg';
  const toolbar = document.createElement('div');
  toolbar.className = 'wysiwyg-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  const mount = document.createElement('div');
  const notice = document.createElement('p');
  notice.className = 'muted small wysiwyg-notice';
  notice.hidden = true;
  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.append(toolbar, mount, textarea, notice);
  textarea.classList.add('wysiwyg-source');

  const editor = new Editor({
    element: mount,
    extensions: editorExtensions(parseKind, { placeholder }),
    editorProps: {
      attributes: { class: 'editor-preview wysiwyg-content', spellcheck: 'true' },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || !MARKDOWNISH.test(text) || rowAt(view.state)) return false;
        try {
          editor.commands.insertContent(parser.parse(text).toJSON().content);
          return true;
        } catch {
          return false; // something the editor cannot hold: paste it as text instead
        }
      },
    },
  });
  parser = createMarkdownParser(editor.schema, editorMarkdownIt(parseKind));

  // What was loaded, exactly. Saving a document nobody touched must not rewrite it, however
  // render-identical the rewrite would be, so the textarea keeps these bytes until a real edit.
  let original = textarea.value;
  let originalSerialized = '';

  function load(markdown) {
    const doc = parser.parse(markdown);
    editor.commands.setContent(doc.toJSON(), { emitUpdate: false });
    original = markdown;
    originalSerialized = serializer.serialize(editor.state.doc);
  }

  editor.on('update', () => {
    const out = serializer.serialize(editor.state.doc);
    textarea.value = out === originalSerialized ? original : out;
    drafts?.changed();
  });

  // --- Mode -----------------------------------------------------------------

  let mode = 'visual';
  const modeButton = button('Markdown', 'Switch to Markdown', () => setMode(mode === 'visual' ? 'markdown' : 'visual', true));
  modeButton.classList.add('mode');

  function setMode(next, remember) {
    if (next === 'visual') {
      try {
        load(textarea.value);
      } catch {
        notice.textContent =
          'This uses something the visual editor cannot show (a table or a picture written into ' +
          'the text), so it stays in Markdown.';
        notice.hidden = false;
        next = 'markdown';
      }
    }
    if (next === 'visual') notice.hidden = true;
    mode = next;
    wrap.dataset.mode = mode;
    mount.hidden = mode !== 'visual';
    textarea.hidden = mode === 'visual';
    modeButton.textContent = mode === 'visual' ? 'Markdown' : 'Visual';
    modeButton.title = modeButton.ariaLabel = mode === 'visual' ? 'Switch to Markdown' : 'Switch to the visual editor';
    for (const b of toolbar.querySelectorAll('button:not(.mode)')) b.disabled = mode !== 'visual';
    // Only a switch someone made moves the focus: on page load it would scroll past the fields above.
    if (remember) {
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* private mode: the choice just isn't remembered */
      }
      if (mode === 'visual') editor.commands.focus();
      else textarea.focus();
    }
  }

  // --- Toolbar --------------------------------------------------------------

  // The editor's selection as it was when a toolbar button was first touched. On iOS the tap can
  // disturb a bare cursor before the button's click runs, so the click uses this snapshot when the
  // document has not changed in between.
  let pressed = null;
  toolbar.addEventListener(
    'pointerdown',
    () => {
      pressed = { selection: editor.state.selection, doc: editor.state.doc };
    },
    true,
  );
  const pressedSelection = () => {
    const snapshot = pressed;
    pressed = null;
    return snapshot && snapshot.doc === editor.state.doc ? snapshot.selection : editor.state.selection;
  };

  const run = (fn) => () => {
    fn(editor.chain().focus()).run();
  };

  /**
   * Bold, italic — as Word and Google Docs do them. With a selection, the usual toggle. With just a
   * cursor: inside text that already has the mark, the whole run loses it; inside a plain word,
   * the whole word gets it; at a word's edge or between words, it switches what is typed next.
   * (A bare toggle everywhere only ever changed what was typed next, so a tap on a word looked like
   * a button that did nothing.) The cursor stays where it was.
   */
  const markButton = (name) => () => {
    const sel = pressedSelection();
    const chain = editor.chain().focus();
    if (!sel.empty) return chain.setTextSelection({ from: sel.from, to: sel.to }).toggleMark(name).run();
    const range = getMarkRange(sel.$from, editor.schema.marks[name]);
    if (range) return chain.setTextSelection(range).unsetMark(name).setTextSelection(sel.from).run();
    const word = wordAround(sel.$from);
    if (word) return chain.setTextSelection(word).setMark(name).setTextSelection(sel.from).run();
    return chain.setTextSelection(sel.from).toggleMark(name).run();
  };

  function setLink() {
    const previous = editor.getAttributes('link').href || '';
    const url = window.prompt('Link address (leave empty to remove the link)', previous || 'https://');
    if (url === null) return;
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url.trim() || url.trim() === 'https://') return chain.unsetLink().run();
    if (editor.state.selection.empty && !previous) {
      return chain.insertContent({ type: 'text', text: url.trim(), marks: [{ type: 'link', attrs: { href: url.trim() } }] }).run();
    }
    chain.setLink({ href: url.trim() }).run();
  }

  /**
   * Buttons come in groups, and a group wraps as one: on a narrow screen the toolbar breaks between
   * groups, never inside one, so undo is not left on one line with redo on the next.
   */
  const group = (...members) => {
    const g = document.createElement('span');
    g.className = 'group';
    g.append(...members);
    return g;
  };

  const groups = [
    // Plain buttons rather than a style <select>: iOS's picker takes the focus (and with it the
    // selection) away from the editor, and "Text ▾" did not say what it was for.
    group(
      button('Heading', 'Heading (tap again for plain text)', run((c) => c.toggleHeading({ level: 2 })), { active: 'h2', blockOnly: '1' }),
      button('Subheading', 'Subheading (tap again for plain text)', run((c) => c.toggleHeading({ level: 3 })), { active: 'h3', blockOnly: '1' }),
    ),
    group(
      button('<b>B</b>', 'Bold', markButton('bold'), { active: 'bold' }),
      button('<i>I</i>', 'Italic', markButton('italic'), { active: 'italic' }),
      button('Link', 'Link', setLink, { active: 'link' }),
    ),
    group(
      button('Center', 'Center the line', () => {
        const centered = editor.isActive({ textAlign: 'center' });
        editor.chain().focus()[centered ? 'unsetTextAlign' : 'setTextAlign']('center').run();
      }, { active: 'center' }),
      button('• List', 'Bulleted list', run((c) => c.toggleBulletList()), { active: 'bulletList' }),
      button('1. List', 'Numbered list', run((c) => c.toggleOrderedList()), { active: 'orderedList' }),
      button('Line', 'Divider line', run((c) => c.setHorizontalRule())),
    ),
  ];
  if (parseKind === 'program') {
    groups.push(
      group(
        button('+ Row', 'Add a program row (label … name)', addRow),
        button('+ Note', 'Add a note under this row (a hymn title)', () => {
          editor.commands.focus();
          editor.commands.keyboardShortcut('Shift-Enter');
        }, { needsRow: '1' }),
      ),
    );
  }
  groups.push(
    group(button(icon(UNDO), 'Undo', run((c) => c.undo())), button(icon(UNDO, true), 'Redo', run((c) => c.redo()))),
    modeButton,
  );
  toolbar.append(...groups);

  /** A new row below the current block, or in place of the empty line the cursor is on. */
  function addRow() {
    const { state } = editor;
    const { $from } = state.selection;
    const top = $from.depth > 0 ? $from.before(1) : 0;
    const topNode = $from.depth > 0 ? $from.node(1) : null;
    const tr = state.tr;
    let at;
    if (topNode && topNode.type.name === 'paragraph' && topNode.content.size === 0) {
      tr.replaceWith(top, top + topNode.nodeSize, emptyRow(state.schema));
      at = top;
    } else {
      at = topNode ? top + topNode.nodeSize : state.doc.content.size;
      tr.insert(at, emptyRow(state.schema));
    }
    editor.view.dispatch(tr);
    editor.chain().focus().setTextSelection(at + 2).run();
  }

  function refresh() {
    for (const b of toolbar.querySelectorAll('[data-active]')) {
      const name = b.dataset.active;
      const active =
        name === 'center'
          ? editor.isActive({ textAlign: 'center' })
          : /^h\d$/.test(name)
            ? editor.isActive('heading', { level: Number(name[1]) })
            : editor.isActive(name);
      b.classList.toggle('is-active', active);
    }
    const inRow = !!rowAt(editor.state);
    for (const b of toolbar.querySelectorAll('[data-needs-row]')) b.disabled = mode !== 'visual' || !inRow;
    // A row is a row: it cannot also be a heading.
    for (const b of toolbar.querySelectorAll('[data-block-only]')) b.disabled = mode !== 'visual' || inRow;
  }
  editor.on('transaction', refresh);

  // --- Start ----------------------------------------------------------------

  let preferred = 'visual';
  try {
    preferred = localStorage.getItem(MODE_KEY) === 'markdown' ? 'markdown' : 'visual';
  } catch {
    /* no storage: start visual */
  }
  setMode(preferred, false);
  refresh();

  // Keep the pinned toolbar where it can be seen while the on-screen keyboard is up. iOS then keeps
  // the full-height layout viewport and scrolls a smaller visible window around inside it; `sticky`
  // pins to the top of the *layout* viewport, which is above the screen, so the toolbar stopped
  // just out of sight. `visualViewport.offsetTop` is how far down the visible window is, and the
  // stylesheet adds it to the toolbar's `top`. Always 0 on a desktop (short of pinch-zoom).
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const follow = () => {
      const top = Math.max(0, Math.round(vv.offsetTop));
      wrap.style.setProperty('--vv-top', `${top}px`);
    };
    vv.addEventListener('scroll', follow);
    vv.addEventListener('resize', follow);
    follow();
  }

  // Set up last: it snapshots the form as the server rendered it, which needs the editor in place.
  drafts = textarea.form
    ? protectDraft(textarea.form, wrap, (body) => {
        textarea.value = body;
        if (mode === 'visual') {
          try {
            load(body);
          } catch {
            setMode('markdown', false);
          }
        }
      })
    : null;
  return editor;
}

window.WardEditor = { mount: mountEditor };
