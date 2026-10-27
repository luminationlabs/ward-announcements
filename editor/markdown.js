// Markdown in and out of the visual editor.
//
// **In** is this app's own markdown-it instance (`editorMarkdownIt()` in src/markdown.ts), driven
// through prosemirror-markdown's token-to-node parser. So a centered line, a program row, its note
// and a blank-line gap reach the editor already recognised by the code that renders them for
// members, not by a second parser that might disagree.
//
// **Out** is prosemirror-markdown's serializer with node writers for this schema. The contract is
// that what members see does not change: render(serialize(parse(md))) === render(md), which
// `test/editor-roundtrip.test.js` checks over real programs and announcements. Byte-for-byte equality
// is a nicety on top (`*a*` and `_a_` are the same thing), and is kept where it is cheap: the
// single-newline joins between rows and headings are recorded per block, so a program comes back
// looking the way it was written.
//
// Two representation choices carry the app's own syntax:
// - **A gap is empty paragraphs.** Two blank lines in the source (one step of extra space) is one
//   empty paragraph above the block, three is two, four is three — pressing Enter twice is how
//   anyone adds space in a text box. Runs of empties are written back as the blank lines they were,
//   capped where the renderer caps them.
// - **A line break is a newline.** The renderer runs with `breaks: true`, so a single newline inside
//   a paragraph is a <br>; it is written back as a bare newline, not CommonMark's `\` or two spaces.
//
// Anything the editor cannot hold (a table, an inline image, raw HTML, a list item that opens with a
// program row) makes `parse` throw, and the caller keeps that document in plain Markdown rather than
// risk rewriting it.

import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';

/** The renderer stops adding space at three steps (`MAX_GAP` in src/markdown.ts). */
const MAX_GAP = 3;

/** `gap-N` on a token's class, as the renderer's blank-line rule wrote it. */
function gapOf(token) {
  const m = /(?:^|\s)gap-(\d)(?:\s|$)/.exec(token.attrGet('class') || '');
  return m ? Number(m[1]) : 0;
}
const hasClass = (token, name) => (token.attrGet('class') || '').split(/\s+/).includes(name);

/**
 * Wrap the markdown-it instance so the token stream carries what the serializer needs to put the
 * source back: an empty paragraph per gap step ahead of each top-level block, and a `data-join` mark
 * on a block that sat on the very next line after the previous one.
 */
function tokenizerFor(md) {
  return {
    parse(text, env) {
      const tokens = md.parse(text, env);
      const out = [];
      let prevEnd;
      for (const [i, token] of tokens.entries()) {
        // A list item must open with a paragraph in the editor's schema, so ProseMirror would "fix" a
        // row there by inserting an empty one — and the save would push the row out of its list.
        if (token.type === 'leader_open' && tokens[i - 1]?.type === 'list_item_open') {
          throw new Error('A list item that starts with a program row cannot be edited visually.');
        }
        const topOpen = token.level === 0 && token.map && token.nesting !== -1;
        if (topOpen) {
          const gap = gapOf(token);
          for (let i = 0; i < gap; i++) out.push(...emptyParagraph(token));
          if (gap === 0 && prevEnd !== undefined && token.map[0] === prevEnd) token.attrSet('data-join', '1');
          prevEnd = token.map[1];
        }
        out.push(token);
      }
      return out;
    },
  };
}

function emptyParagraph(like) {
  const Token = like.constructor;
  const open = new Token('paragraph_open', 'p', 1);
  const inline = new Token('inline', '', 0);
  inline.children = [];
  inline.content = '';
  const close = new Token('paragraph_close', 'p', -1);
  return [open, inline, close];
}

const joined = (token) => (token.attrGet('data-join') ? true : null);

/** Mirrors prosemirror-markdown's own helper: a list is tight when its items' paragraphs are hidden. */
function listIsTight(tokens, i) {
  while (++i < tokens.length) if (tokens[i].type !== 'list_item_open') return tokens[i].hidden;
  return false;
}

export function createMarkdownParser(schema, md) {
  const handlers = {
    paragraph: { block: 'paragraph', getAttrs: (tok) => ({ joinUp: joined(tok) }) },
    center: { block: 'paragraph', getAttrs: (tok) => ({ textAlign: 'center', joinUp: joined(tok) }) },
    heading: {
      block: 'heading',
      getAttrs: (tok) => ({
        level: Number(tok.tag.slice(1)),
        textAlign: hasClass(tok, 'centered') ? 'center' : null,
        joinUp: joined(tok),
      }),
    },
    blockquote: { block: 'blockquote' },
    list_item: { block: 'listItem' },
    bullet_list: {
      block: 'bulletList',
      getAttrs: (tok, tokens, i) => ({ tight: listIsTight(tokens, i), joinUp: joined(tok), marker: tok.markup }),
    },
    ordered_list: {
      block: 'orderedList',
      getAttrs: (tok, tokens, i) => ({
        start: Number(tok.attrGet('start')) || 1,
        tight: listIsTight(tokens, i),
        joinUp: joined(tok),
        marker: tok.markup,
      }),
    },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: { block: 'codeBlock', getAttrs: (tok) => ({ language: tok.info || null }), noCloseToken: true },
    hr: { node: 'horizontalRule' },
    hardbreak: { node: 'hardBreak' },
    softbreak: { node: 'hardBreak' },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    link: {
      mark: 'link',
      getAttrs: (tok) => ({ href: tok.attrGet('href'), title: tok.attrGet('title') || null }),
    },
    code_inline: { mark: 'code', noCloseToken: true },
  };
  if (schema.nodes.leaderRow) {
    Object.assign(handlers, {
      leader: { block: 'leaderRow', getAttrs: (tok) => ({ joinUp: joined(tok) }) },
      leader_left: { block: 'leaderLeft' },
      leader_right: { block: 'leaderRight' },
      leader_note: { block: 'leaderNote' },
      leader_dots: { ignore: true, noCloseToken: true },
    });
  }
  const parser = new MarkdownParser(schema, tokenizerFor(md), handlers);
  return {
    /** Markdown to an editor document. Throws on anything the editor cannot represent. */
    parse: (text) => parser.parse(text ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Out
// ---------------------------------------------------------------------------

const isEmptyParagraph = (node) => node.type.name === 'paragraph' && node.content.size === 0;
const isCentered = (node) => node.attrs.textAlign === 'center';

/**
 * May `next` sit on the line directly under `prev`, with no blank line, and still parse as its own
 * block? Only where the renderer guarantees it: a row, a centered line and a heading each end at
 * their own line and each can interrupt a paragraph. Never next to a list, quote, code block or a
 * rule (`text` over `---` is a heading in Markdown).
 */
function canJoin(prev, next) {
  const lineLike = (n) => ['paragraph', 'heading', 'leaderRow'].includes(n.type.name);
  // A row, a heading and a centered line each end at their own line; a paragraph runs on.
  const prevSelfEnding = lineLike(prev) && (prev.type.name !== 'paragraph' || isCentered(prev));
  // A list may start directly under a line that has already ended (`### What to bring` then `- …`).
  if (['bulletList', 'orderedList'].includes(next.type.name)) return prevSelfEnding;
  if (!lineLike(prev) || !lineLike(next)) return false;
  const interrupts = next.type.name !== 'paragraph' || isCentered(next);
  return interrupts || prevSelfEnding;
}

/**
 * Wrap a top-level writer so the space *before* each block is decided in one place: empty paragraphs
 * above it become blank lines, a recorded join stays a single newline, and anything else gets the
 * ordinary one blank line. Empty paragraphs themselves write nothing.
 */
function topLevel(write) {
  return (state, node, parent, index) => {
    if (parent?.type.name === 'doc') {
      if (isEmptyParagraph(node)) return;
      let empties = 0;
      let i = index - 1;
      while (i >= 0 && isEmptyParagraph(parent.child(i))) {
        empties++;
        i--;
      }
      const prev = i >= 0 ? parent.child(i) : null;
      if (state.closed && prev) {
        const gap = Math.min(empties, MAX_GAP);
        const stacked = prev.type.name === 'leaderRow' && node.type.name === 'leaderRow';
        const join = gap === 0 && canJoin(prev, node) && (node.attrs.joinUp ?? stacked);
        state.flushClose(gap > 0 ? 2 + gap : join ? 1 : 2);
      }
    }
    write(state, node, parent, index);
  };
}

/** A link whose text is exactly its address, with nothing else marked inside it. */
function isBareUrl(mark, parent, index) {
  if (mark.attrs.title || !/^https?:\/\//i.test(mark.attrs.href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== mark.attrs.href || content.marks[content.marks.length - 1] !== mark) {
    return false;
  }
  return index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks);
}

/**
 * The marker a list is written with: its own from the source when it has one, else the first. Two
 * lists of one kind side by side are one list to Markdown unless their markers differ, so a list
 * directly after another of its type takes the next marker along when they would clash.
 */
function listMarker(node, parent, index, choices) {
  let marker = choices.includes(node.attrs.marker) ? node.attrs.marker : choices[0];
  const prev = parent && index > 0 ? parent.child(index - 1) : null;
  if (prev && prev.type === node.type) {
    const prevMarker = listMarker(prev, parent, index - 1, choices);
    if (prevMarker === marker) marker = choices[(choices.indexOf(marker) + 1) % choices.length];
  }
  return marker;
}

export function createMarkdownSerializer(kind) {
  const program = kind === 'program';

  /**
   * Text, escaped for CommonMark and then for this app's own syntax: in a program, a run of dots or
   * a pipe between spaces would start a row (or a note at the start of a line), so typed prose that
   * merely looks like one is defused. A pipe is escaped. A run of dots is written as `…`, which is
   * what members would have seen anyway (the typographer turns `...` into one), whereas `\...`
   * escapes only the first dot and renders as `.…`. A row's value and note are left alone, since
   * only the first separator on a line splits it.
   */
  function text(state, node, parent) {
    if (state.inAutolink) return state.text(node.text, false);
    const lineStart = state.lineStart;
    state.lineStart = false;
    let out = state.esc(node.text, lineStart);
    if (program && !['leaderRight', 'leaderNote'].includes(parent.type.name)) {
      out = out.replace(/(^|\s)(?:(\.{3,})|\|)(?=\s|$)/g, (_, space, dots) => `${space}${dots ? '…' : '\\|'}`);
    }
    state.write();
    state.out += out;
  }

  /** Inline content at the start of a line, so the first text is escaped as a line start. */
  function inline(state, node, atLineStart = true) {
    state.lineStart = atLineStart;
    state.renderInline(node, atLineStart);
  }

  const nodes = {
    paragraph: topLevel((state, node) => {
      if (isCentered(node) && node.content.size > 0) {
        state.write('-> ');
        inline(state, node, false);
        state.write(' <-');
      } else {
        inline(state, node);
      }
      state.closeBlock(node);
    }),
    heading: topLevel((state, node) => {
      state.write(`${'#'.repeat(node.attrs.level)} ${isCentered(node) ? '-> ' : ''}`);
      inline(state, node, false);
      if (isCentered(node)) state.write(' <-');
      state.closeBlock(node);
    }),
    leaderRow: topLevel((state, node) => {
      const [left, right, note] = [node.child(0), node.child(1), node.childCount > 2 ? node.child(2) : null];
      if (left.content.size === 0 || right.content.size === 0) {
        // Half a row is not a row: the renderer needs text on both sides of the dots.
        inline(state, left.content.size ? left : right);
      } else {
        inline(state, left);
        state.write(' ... ');
        inline(state, right, false);
        if (note && note.content.size > 0) {
          state.write('\n... ');
          inline(state, note, false);
        }
      }
      state.closeBlock(node);
    }),
    blockquote: topLevel((state, node) => state.wrapBlock('> ', null, node, () => state.renderContent(node))),
    bulletList: topLevel((state, node, parent, index) => {
      const bullet = listMarker(node, parent, index, ['-', '*', '+']);
      state.renderList(node, '  ', () => `${bullet} `);
    }),
    orderedList: topLevel((state, node, parent, index) => {
      const delim = listMarker(node, parent, index, ['.', ')']);
      const start = node.attrs.start || 1;
      const width = String(start + node.childCount - 1).length;
      const pad = ' '.repeat(width + 2);
      state.renderList(node, pad, (i) => {
        const n = String(start + i);
        return ' '.repeat(width - n.length) + n + delim + ' ';
      });
    }),
    listItem: (state, node) => state.renderContent(node),
    codeBlock: topLevel((state, node) => {
      state.write('```' + (node.attrs.language || '') + '\n');
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write('```');
      state.closeBlock(node);
    }),
    horizontalRule: topLevel((state, node) => {
      state.write('---');
      state.closeBlock(node);
    }),
    hardBreak: (state, node, parent, index) => {
      // A trailing break shows nothing, so it writes nothing (prosemirror-markdown does the same).
      let last = true;
      for (let i = index + 1; i < parent.childCount; i++) if (parent.child(i).type !== node.type) last = false;
      if (last) return;
      const previous = index > 0 ? parent.child(index - 1) : null;
      // A heading is one line, so a break in one (Shift+Enter) is a space: a newline would end the
      // heading and turn the rest into a paragraph.
      if (parent.type.name === 'heading') {
        if (previous && previous.type !== node.type) state.write(' ');
        return;
      }
      // A centered line is one line between `->` and `<-`, so a break closes it and opens the next;
      // a newline inside would leave both arrows showing. A leading or repeated break would make an
      // empty centered line, which is no line at all, so it writes nothing.
      if (isCentered(parent)) {
        if (!previous || previous.type === node.type) return;
        state.write(' <-\n');
        state.write('-> ');
        state.lineStart = false;
        return;
      }
      // A second break in a row would be a blank line, which ends the paragraph: spell it `\`.
      state.write(previous && previous.type === node.type ? '\\\n' : '\n');
      state.lineStart = true;
    },
    text,
  };

  const marks = {
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    code: defaultMarkdownSerializer.marks.code,
    link: {
      // A bare URL stays bare: the renderer's linkify turns it back into the same link, and
      // `<https://…>` is CommonMark noise to whoever reads the source.
      open(state, mark, parent, index) {
        state.inAutolink = isBareUrl(mark, parent, index);
        return state.inAutolink ? '' : '[';
      },
      close(state, mark) {
        const wasBare = state.inAutolink;
        state.inAutolink = undefined;
        if (wasBare) return '';
        const href = mark.attrs.href.replace(/[()"]/g, '\\$&');
        return `](${href}${mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : ''})`;
      },
      mixable: true,
    },
  };

  const serializer = new MarkdownSerializer(nodes, marks, { hardBreakNodeName: 'hardBreak' });
  return {
    /** An editor document back to Markdown. */
    serialize: (doc) => serializer.serialize(doc).replace(/\n+$/, ''),
  };
}
