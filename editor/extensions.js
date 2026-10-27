// The visual editor's document model: Tiptap's StarterKit, trimmed to what Markdown can hold, plus
// the things this app's Markdown has that CommonMark does not — centered lines and headings, program
// rows (`Speaker ... Jane Doe`, with an optional note line), list tightness and markers, and which
// blocks sat on consecutive lines.
//
// No DOM is touched at definition time, so the same list builds the schema in Node for the
// round-trip tests (`test/editor-roundtrip.test.js`) and runs the editor in the browser
// (`editor/index.js`). How each node becomes Markdown and back is in `editor/markdown.js`.

import { Extension, InputRule, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import { TextSelection } from '@tiptap/pm/state';

// ---------------------------------------------------------------------------
// Program rows
// ---------------------------------------------------------------------------

/**
 * A program row: label, value, and an optional note under the value — what `Opening Hymn ... #19`
 * and the `... "Hymn title"` line under it render as. Cells rather than one text with a separator
 * in it, so the editor draws the dots and nobody has to type the syntax. The markup is the public
 * page's own (`p.leader` and its spans), so the row looks in the editor as it will to members.
 */
const LeaderRow = Node.create({
  name: 'leaderRow',
  group: 'block',
  content: 'leaderLeft leaderRight leaderNote?',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: 'p.leader' }],
  renderHTML: ({ HTMLAttributes }) => ['p', mergeAttributes(HTMLAttributes, { class: 'leader' }), 0],

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => rowEnter(editor),
      'Shift-Enter': ({ editor }) => rowNote(editor),
      Tab: ({ editor }) => rowTab(editor),
      Backspace: ({ editor }) => rowBackspace(editor),
    };
  },

  addInputRules() {
    return [
      // `Opening Hymn ... ` (or `…`, which an iPhone makes of three dots) turns the line into a row,
      // the label on the left and the cursor in the value. The space before the dots is optional —
      // `Opening Hymn... ` is how most people type it — because the Markdown written back always
      // spaces them. Backspace straight afterwards undoes it (see `rowBackspace`), for prose.
      new InputRule({ find: /\s?(?:\.{3,}|…)\s$/, handler: ({ state, range }) => toRow(state, range) }),
      // `... ` at the start of the line under a row starts that row's note.
      new InputRule({ find: /^(?:\.{3,}|…)\s$/, handler: ({ state, range }) => toNote(state, range) }),
    ];
  },
});

/**
 * One cell. Text only — no line breaks — because a row is one line of the source. The label's cell
 * also carries the dots, as a non-editable sibling inside a `display: contents` wrapper, so both
 * land in the row's flex layout exactly as the public markup's three spans do.
 */
const cell = (name, className, withDots = false) =>
  Node.create({
    name,
    content: 'text*',
    marks: '_',
    defining: true,
    parseHTML: () => [{ tag: `span.${className}` }],
    renderHTML: ({ HTMLAttributes }) =>
      withDots
        ? [
            'span',
            { style: 'display: contents' },
            ['span', mergeAttributes(HTMLAttributes, { class: className }), 0],
            ['span', { class: 'leader-dots', contenteditable: 'false', 'aria-hidden': 'true' }],
          ]
        : ['span', mergeAttributes(HTMLAttributes, { class: className }), 0],
  });

/** Where the cursor is, if it is in a row: the row, its position, and which cell. */
function rowAt(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'leaderRow') {
      return { row: $from.node(d), pos: $from.before(d), cell: $from.index(d), $from };
    }
  }
  return null;
}

/** Position of the start of cell `i`'s text inside the row at `pos`. */
function cellStart(row, pos, i) {
  let at = pos + 1;
  for (let c = 0; c < i; c++) at += row.child(c).nodeSize;
  return at + 1;
}

const isEmptyRow = (row) => row.childCount === 2 && row.child(0).content.size === 0 && row.child(1).content.size === 0;

function moveTo(editor, tr, pos) {
  tr.setSelection(TextSelection.create(tr.doc, pos));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

function emptyRow(schema) {
  const { leaderRow, leaderLeft, leaderRight } = schema.nodes;
  return leaderRow.create(null, [leaderLeft.create(), leaderRight.create()]);
}

/** Enter: label → value → a new row below; on an empty row, leave rows for an ordinary line. */
function rowEnter(editor) {
  const at = rowAt(editor.state);
  if (!at) return false;
  const { state } = editor;
  const tr = state.tr;
  if (isEmptyRow(at.row)) {
    tr.replaceWith(at.pos, at.pos + at.row.nodeSize, state.schema.nodes.paragraph.create());
    return moveTo(editor, tr, at.pos + 1);
  }
  if (at.cell === 0) return moveTo(editor, tr, cellStart(at.row, at.pos, 1));
  const after = at.pos + at.row.nodeSize;
  tr.insert(after, emptyRow(state.schema));
  return moveTo(editor, tr, after + 2);
}

/** Shift+Enter: into the row's note, adding one if it has none. */
function rowNote(editor) {
  const at = rowAt(editor.state);
  if (!at) return false;
  const tr = editor.state.tr;
  if (at.row.childCount < 3) {
    const end = at.pos + at.row.nodeSize - 1;
    tr.insert(end, editor.schema.nodes.leaderNote.create());
    return moveTo(editor, tr, end + 1);
  }
  return moveTo(editor, tr, cellStart(at.row, at.pos, 2));
}

/** Tab: label → value (and no further, so Tab still leaves the editor from the value). */
function rowTab(editor) {
  const at = rowAt(editor.state);
  if (!at || at.cell !== 0) return false;
  return moveTo(editor, editor.state.tr, cellStart(at.row, at.pos, 1));
}

/**
 * Backspace at the start of a cell: back into the previous cell (dropping an empty note), or, on
 * an empty row, turn it back into an ordinary line. Never the default join, which would try to
 * merge cells into the block above and leave a malformed row.
 */
function rowBackspace(editor) {
  const at = rowAt(editor.state);
  const { selection } = editor.state;
  if (!at || !selection.empty || at.$from.parentOffset !== 0) return false;
  // Straight after the `Label ... ` rule fired, Backspace puts the typed text back, as it does for
  // every other input rule — `Thanks... ` in a sentence was not meant to become a row.
  if (editor.commands.undoInputRule()) {
    // The undo maps the cursor past the restored line; put it back at that line's end.
    const line = editor.state.doc.nodeAt(at.pos);
    if (line) editor.commands.setTextSelection(at.pos + 1 + line.content.size);
    return true;
  }
  const tr = editor.state.tr;
  if (at.cell === 0) {
    if (!isEmptyRow(at.row)) return true;
    tr.replaceWith(at.pos, at.pos + at.row.nodeSize, editor.schema.nodes.paragraph.create());
    return moveTo(editor, tr, at.pos + 1);
  }
  const prevEnd = cellStart(at.row, at.pos, at.cell) - 2;
  if (at.cell === 2 && at.row.child(2).content.size === 0) {
    tr.delete(prevEnd + 1, prevEnd + 1 + at.row.child(2).nodeSize);
  }
  return moveTo(editor, tr, prevEnd);
}

/** The `Label ... ` input rule: the paragraph becomes a row, what followed the cursor its value. */
function toRow(state, range) {
  const $from = state.doc.resolve(range.from);
  const para = $from.parent;
  if (para.type.name !== 'paragraph' || para.attrs.textAlign === 'center' || $from.depth !== 1) return null;
  const start = $from.start();
  if (range.from - start <= 0) return null;
  const { leaderRow, leaderLeft, leaderRight } = state.schema.nodes;
  const label = para.content.cut(0, range.from - start);
  const value = para.content.cut(range.to - start);
  if (!label.textBetween(0, label.size).trim()) return null;
  const left = leaderLeft.create(null, label);
  const row = leaderRow.create({ joinUp: para.attrs.joinUp }, [left, leaderRight.create(null, value)]);
  const before = $from.before();
  const tr = state.tr.replaceWith(before, $from.after(), row);
  tr.setSelection(TextSelection.create(tr.doc, before + 1 + left.nodeSize + 1));
}

/** The `... ` input rule on the line under a row with no note: that line becomes the note. */
function toNote(state, range) {
  const $from = state.doc.resolve(range.from);
  const para = $from.parent;
  if (para.type.name !== 'paragraph' || $from.depth !== 1) return null;
  const index = $from.index(0);
  const prev = index > 0 ? state.doc.child(index - 1) : null;
  if (!prev || prev.type.name !== 'leaderRow' || prev.childCount > 2) return null;
  const rest = para.content.cut(range.to - $from.start());
  const note = state.schema.nodes.leaderNote.create(null, rest);
  const rowEnd = $from.before() - 1;
  const tr = state.tr.delete($from.before(), $from.after()).insert(rowEnd, note);
  tr.setSelection(TextSelection.create(tr.doc, rowEnd + 1));
}

// ---------------------------------------------------------------------------
// Attributes the Markdown needs back
// ---------------------------------------------------------------------------

/** Loose lists (a blank line between items) render each item as a paragraph; tight ones do not. */
const ListShape = Extension.create({
  name: 'listShape',
  addGlobalAttributes: () => [
    {
      types: ['bulletList', 'orderedList'],
      attributes: {
        tight: { default: true, rendered: false },
        // `-`, `*`, `+`, or `.` / `)`: what the source used, so two adjacent lists stay two.
        marker: { default: null, rendered: false },
      },
    },
  ],
});

/**
 * Whether a block sat on the line directly under the one before it in the source (`editor/markdown.js`
 * writes it back the same way when that is safe). Null means "never recorded": a block made in the
 * editor, which gets the ordinary blank line — except between two program rows, which stack.
 */
const BlockJoin = Extension.create({
  name: 'blockJoin',
  addGlobalAttributes: () => [
    {
      types: ['paragraph', 'heading', 'leaderRow', 'bulletList', 'orderedList'],
      attributes: { joinUp: { default: null, rendered: false } },
    },
  ],
});

// ---------------------------------------------------------------------------

const PLACEHOLDERS = {
  leaderLeft: 'Label',
  leaderRight: 'Name or number',
  leaderNote: 'Note',
};

/**
 * The editor's extensions. `kind` decides whether program rows exist: an announcement or a page
 * has no such syntax, so a line that merely contains ` ... ` stays prose there. `placeholder` is
 * the empty-document prompt (browser only; the schema does not depend on it).
 */
export function editorExtensions(kind, { placeholder = '' } = {}) {
  const extensions = [
    StarterKit.configure({
      // Markdown has no underline, and a mark that cannot be saved should not be offered.
      underline: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center'] }),
    ListShape,
    BlockJoin,
    Placeholder.configure({
      includeChildren: true,
      showOnlyCurrent: false,
      // Every empty paragraph carries the document prompt and CSS shows it only on a lone one
      // (`.wysiwyg-content > p:only-child`). Asking `editor.isEmpty` here instead is stale: the
      // decorations are rebuilt while a transaction applies, against the state before it, so the
      // blank lines a paste creates were labelled as though the document were still empty.
      placeholder: ({ node }) => PLACEHOLDERS[node.type.name] ?? (node.type.name === 'paragraph' ? placeholder : ''),
    }),
  ];
  if (kind === 'program') {
    extensions.push(
      LeaderRow,
      cell('leaderLeft', 'leader-left', true),
      cell('leaderRight', 'leader-right'),
      cell('leaderNote', 'leader-note'),
    );
  }
  return extensions;
}

export { emptyRow, rowAt };
