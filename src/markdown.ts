import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateBlock,
  type StateCore,
  type Token,
} from 'markdown-it';
import { HYMNS_1985, HYMNS_FOR_HOME_AND_CHURCH } from './hymns.js';

/**
 * Markdown renderers for admin-authored content. Configured to be safe to inject as HTML:
 *  - `html: false` escapes any raw HTML in the source (no tag passthrough).
 *  - markdown-it's default `validateLink` rejects javascript:/vbscript:/data: URLs.
 *  - `linkify` turns bare URLs into links; `breaks` keeps single newlines as line breaks.
 * Only the trusted admin authors this content, but these settings keep it XSS-safe regardless.
 *
 * There are two instances rather than one, because sacrament meeting programs understand one extra
 * bit of syntax that announcements must not (see `dotLeaderRule`): a program is a list of
 * assignments, and announcements are prose that may legitimately contain a pipe. Centered lines
 * (see `centerRule`) are shared by both — `-> text <-` has no innocent reading in prose.
 */

// ---------------------------------------------------------------------------
// Dot leaders
// ---------------------------------------------------------------------------
//
// A program line reads as two columns joined by a run of dots:
//
//     Opening Hymn ... #19
//     ... "We Thank Thee, O God, for a Prophet"
//     Presiding | Bishop Smith
//
// …and should render as one row with the label left-justified, the name right-justified, and the
// gap between them filled — the way it looks on the printed program. The second line there is the
// row's *note* (see `NOTE_RE`), set under the value on a line of its own.
//
// This is a **block rule**, not a pass over rendered HTML, and that is the whole security argument.
// A regex over `md.render()`'s output would be running against a string in which the admin's text
// and our own markup are already indistinguishable; a substitution there could reopen a tag that
// markdown-it escaped. Working on the source instead means both halves of the line go back through
// markdown-it's own inline parser and out through its own escaping, so a name containing `<script>`
// is escaped by exactly the code that escapes it everywhere else. Nothing here ever concatenates
// user text into markup.

/**
 * Label, separator, value — split at the first separator, or null. The separator is three-or-more
 * dots or a single pipe, and it must be surrounded by spaces — without that, `Ratio 3|4` and an
 * ellipsis mid-sentence would both become rows. The sides come back untrimmed; the caller rejects
 * an empty one, which is what keeps a bare `...` from being a row.
 *
 * One pass along the line, not the regex it replaced (`^(.+?)[ \t]+(?:\.{3,}|\|)[ \t]+(.+)$`),
 * which found the same split but backtracked in quadratic time on a long run of spaces — and every
 * member page load renders every body.
 */
function splitLeader(line: string): { left: string; right: string } | null {
  const space = (i: number) => line[i] === ' ' || line[i] === '\t';
  // `p` is where a separator would start: at least one character of label, then a space, before it.
  for (let p = 2; p < line.length; p++) {
    if (!space(p - 1)) continue;
    let end = p;
    if (line[p] === '|') end = p + 1;
    else while (line[end] === '.') end++;
    if (end === p || (line[p] === '.' && end - p < 3)) continue;
    // A space after it, and something after that space.
    if (space(end) && end + 1 < line.length) return { left: line.slice(0, p), right: line.slice(end) };
  }
  return null;
}

/**
 * A row's note: the line directly under a row that opens with the dots and nothing to their left,
 * `... "Did You Think to Pray"`. It renders as a third span on a line of its own under the value,
 * right-aligned and quiet — a hymn's title under its number, the way a printed program sets it.
 * The leading dots are what make it explicit: a plain line under a row stays a paragraph, so no
 * program written before this rule existed changes shape. Anywhere but directly under a row the
 * same line is ordinary text (the row rule is the only thing that looks for it).
 */
const NOTE_RE = /^\.{3,}[ \t]+(.+)$/;

/** Push `<span class="…">inline content</span>` as three tokens, so the content is parsed normally. */
function pushSide(state: StateBlock, name: string, content: string, line: number): void {
  state.push(`${name}_open`, 'span', 1);
  const inline = state.push('inline', '', 0);
  inline.content = content;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push(`${name}_close`, 'span', -1);
}

function dotLeaderRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  // Four spaces of indent is an indented code block, which must survive verbatim.
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;

  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const line = state.src.slice(start, state.eMarks[startLine]!);

  // A leading pipe is a table row. The built-in `table` rule sits ahead of this one in the ruler and
  // has already declined (no delimiter row underneath), but a header row that lost its table is
  // still not a leader line — and quietly turning one into a two-column row would be a baffling way
  // to find out your table was malformed.
  if (line.startsWith('|')) return false;

  const split = splitLeader(line);
  if (!split) return false;
  const left = split.left.trim();
  const right = split.right.trim();
  if (!left || !right) return false;

  // Silent mode asks "could this line start a block?", which is how the paragraph rule discovers
  // its own terminators. Answering yes is what lets a leader line interrupt a paragraph, so a
  // program can put prose and rows next to each other without a blank line between them.
  if (silent) return true;

  // One optional note line, taken only when it sits directly under the row (a blank line ends the
  // row like any other block) and is not indented as code.
  let note: string | undefined;
  const noteLine = startLine + 1;
  if (noteLine < endLine && state.sCount[noteLine]! - state.blkIndent < 4) {
    const next = state.src.slice(
      state.bMarks[noteLine]! + state.tShift[noteLine]!,
      state.eMarks[noteLine]!,
    );
    const text = NOTE_RE.exec(next)?.[1]?.trim();
    if (text) note = text;
  }

  state.line = note === undefined ? startLine + 1 : startLine + 2;

  const open = state.push('leader_open', 'p', 1);
  open.map = [startLine, state.line];
  open.attrSet('class', 'leader');

  pushSide(state, 'leader_left', left, startLine);
  state.push('leader_dots', 'span', 0);
  pushSide(state, 'leader_right', right, startLine);
  if (note !== undefined) pushSide(state, 'leader_note', note, noteLine);

  state.push('leader_close', 'p', -1);
  return true;
}

/**
 * Teach an instance the dot-leader syntax.
 *
 * Registered `before('paragraph')`, which puts it after `table`, `code` and `fence` in the ruler —
 * so a real table, an indented code block and a fenced block all win the line before this rule sees
 * it. The `alt` list is what makes it a paragraph terminator (see `silent` above).
 *
 * Every token it emits has its own renderer rule, so the markup is written here in full rather than
 * assembled from token attributes. The `<span class="leader-dots">` is empty and `aria-hidden`: the
 * dots are drawn by CSS, and a screen reader should hear "Opening Hymn, #19", not the leader.
 */
function dotLeaderPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before('paragraph', 'dot_leader', dotLeaderRule, {
    alt: ['paragraph', 'blockquote', 'list'],
  });
  // The class rides on the token so a later core rule (see `blankLineGapRule`) can add to it.
  md.renderer.rules.leader_open = (tokens, idx, _o, _e, self) => `<p${self.renderAttrs(tokens[idx]!)}>`;
  md.renderer.rules.leader_close = () => '</p>\n';
  md.renderer.rules.leader_left_open = () => '<span class="leader-left">';
  md.renderer.rules.leader_left_close = () => '</span>';
  md.renderer.rules.leader_dots = () => '<span class="leader-dots" aria-hidden="true"></span>';
  md.renderer.rules.leader_right_open = () => '<span class="leader-right">';
  md.renderer.rules.leader_right_close = () => '</span>';
  md.renderer.rules.leader_note_open = () => '<span class="leader-note">';
  md.renderer.rules.leader_note_close = () => '</span>';
}

// ---------------------------------------------------------------------------
// Centered lines
// ---------------------------------------------------------------------------
//
// A line wrapped in arrow markers is centered:
//
//     -> **Sacrament Meeting** <-
//
// Same construction as the dot-leader rule above, and for the same reason: a **block rule** whose
// content goes back through markdown-it's own inline parser, never a substitution over rendered
// HTML. Inline Markdown inside keeps working and `<img onerror=…>` stays escaped, because neither
// is handled here at all — both are markdown-it's own job, on the source.
//
// Unlike dot leaders this is enabled on **both** renderers. `Presiding | Bishop Smith` is prose an
// announcement might legitimately write; `-> text <-` is not.

/**
 * The text between the arrows when the whole line is arrow-wrapped, or null. Stray spaces and tabs
 * at either end are tolerated, and the *last* `<-` on the line closes it. Content must be
 * non-empty: a bare `-> <-` is nothing to center, so it stays an ordinary paragraph.
 *
 * Plain string checks, not a regex. The regex this replaced (`^[ \t]*->[ \t]*(.*?)[ \t]*<-[ \t]*$`)
 * had three adjacent runs that could all match a space, and backtracked in cubic time on a line
 * that opened with `->` and never closed: `->` plus 3,000 spaces took five seconds to render, and
 * every member page load renders every body — one saved line could stall a ward.
 */
function centeredText(line: string): string | null {
  // Index scans, not `/[ \t]+$/`: that one is quadratic too, retrying the run from every space.
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start++;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end - start < 4 || !line.startsWith('->', start) || !line.endsWith('<-', end)) return null;
  return line.slice(start + 2, end - 2).trim() || null;
}

function centerRule(
  state: StateBlock,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  // Four spaces of indent is an indented code block, which must survive verbatim.
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;

  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const line = state.src.slice(start, state.eMarks[startLine]!);

  const content = centeredText(line);
  if (!content) return false;

  // See `dotLeaderRule`: answering the paragraph rule's "could this line start a block?" is what
  // lets a centered line interrupt a paragraph without a blank line above it.
  if (silent) return true;

  state.line = startLine + 1;

  const open = state.push('center_open', 'p', 1);
  open.map = [startLine, state.line];
  open.attrSet('class', 'centered');

  const inline = state.push('inline', '', 0);
  inline.content = content;
  inline.map = [startLine, state.line];
  inline.children = [];

  state.push('center_close', 'p', -1);
  return true;
}

/**
 * Teach an instance the centered-line syntax.
 *
 * Registered `before('paragraph')`, like the leader rule — and installed *first*, because
 * `before('paragraph')` inserts immediately ahead of `paragraph`, so whichever plugin runs last
 * ends up nearest it. That ordering is the precedence decision: on the program renderer the ruler
 * reads center_line, dot_leader, paragraph, so **center wins a line that matches both shapes**.
 * `-> Speaker ... Jane Doe <-` is pathological either way; centering the whole line (leaving
 * `Speaker ... Jane Doe` as ordinary inline text inside it) is the reading in which the outermost
 * markers decide, which is how Markdown resolves nesting everywhere else. A leader row whose
 * *value* merely ends in `<-` is unaffected — the arrows are not outermost there, so this rule
 * declines and the leader rule gets the line.
 */
function centerPlugin(md: MarkdownItInstance): void {
  md.block.ruler.before('paragraph', 'center_line', centerRule, {
    alt: ['paragraph', 'blockquote', 'list'],
  });
  md.renderer.rules.center_open = (tokens, idx, _o, _e, self) => `<p${self.renderAttrs(tokens[idx]!)}>`;
  md.renderer.rules.center_close = () => '</p>\n';
}

// ---------------------------------------------------------------------------
// Centered headings
// ---------------------------------------------------------------------------
//
// A heading behaves like a heading anywhere else in Markdown — left-aligned — and is centered by
// wrapping its text in the same arrows a centered paragraph uses:
//
//     ## -> Ward and Stake Business <-
//
// One rule to remember, not two. The heading block rule has already claimed the line by the time
// this runs, so it is a **core rule**, slotted after `block` and before `inline`: it inspects the
// inline token that follows each `heading_open`, and when the whole text is arrow-wrapped it strips
// the arrows from `content` and classes the heading. The stripped text then goes through the inline
// parser exactly as any heading's would — same escaping, same emphasis — so nothing here touches
// markup or the admin's text beyond removing the two markers.

function centeredHeadingRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i]!.type !== 'heading_open') continue;
    const inline = tokens[i + 1]!;
    if (inline.type !== 'inline') continue;
    const content = centeredText(inline.content);
    if (!content) continue;
    inline.content = content;
    tokens[i]!.attrJoin('class', 'centered');
  }
}

/** Teach an instance the centered-heading syntax. Installed with the centered-line rule. */
function centeredHeadingPlugin(md: MarkdownItInstance): void {
  md.core.ruler.after('block', 'centered_heading', centeredHeadingRule);
}

// ---------------------------------------------------------------------------
// Blank-line gaps
// ---------------------------------------------------------------------------
//
// An extra blank line means extra space. One blank line between blocks is ordinary Markdown and
// changes nothing; two or more open a gap above the next block:
//
//     Benediction ... Sister Lee
//
//
//     ### Meeting Info
//
// It is how anyone would try to add space in a text box, so there is nothing to learn, and the
// source still reads as a program rather than as markup. Each blank line beyond the first adds a
// step — two blank lines is one step, three is two, four is three — and it stops there: a stray run
// of blank lines must not push a section off a phone screen, and three steps is as much as one can
// use. The step is a class (`gap-1`..`gap-3`) and the space itself is CSS.
//
// A core rule, because blank lines never become tokens: markdown-it's block parser skips them, but
// every top-level block token carries `map`, the source lines it spanned, so the blank run is the
// difference between one block's end line and the next block's start. Only top-level blocks are
// considered; blank lines inside a list or a blockquote are left to Markdown's own handling. The
// rule adds a class and nothing else, and touches no text.

const MAX_GAP = 3;

function blankLineGapRule(state: StateCore): void {
  let prevEnd: number | undefined;
  for (const token of state.tokens) {
    if (token.level !== 0 || !token.map || token.nesting === -1) continue;
    const [start, end] = token.map;
    if (prevEnd !== undefined && start - prevEnd >= 2) {
      token.attrJoin('class', `gap-${Math.min(start - prevEnd - 1, MAX_GAP)}`);
    }
    prevEnd = end;
  }
}

/** Teach an instance the blank-line gap. Installed after the centered-heading rule. */
function blankLineGapPlugin(md: MarkdownItInstance): void {
  md.core.ruler.after('centered_heading', 'blank_line_gap', blankLineGapRule);
}

// ---------------------------------------------------------------------------
// Hymn links
// ---------------------------------------------------------------------------
//
// A hymn row's number — and its note, usually the hymn's title — links to the hymn on the Church's
// site, which a phone with Gospel Library installed opens in the app (churchofjesuschrist.org/study
// is a universal link):
//
//     Sacrament Hymn ... #169            → /study/manual/hymns/as-now-we-take-the-sacrament
//     ... "As Now We Take the Sacrament"   (the same link)
//
// Conservative on purpose: the label must say "hymn" and the value must be nothing but a number
// (`#169`, `169`, `No. 169`). "Rest Hymn ... Ward Choir" or "Hymn ... 98–99" stays plain text.
//
// The address comes only from `src/hymns.ts`, a committed table generated from the Church's own
// index pages (`npm run hymns`), never from the admin's text and never guessed from a title. A
// number the table doesn't know — a hymn released since it was generated — links to its book's
// index page instead, which is still one tap from the hymn.
//
// A **core rule** run last, after inline parsing (and after linkify and smartquotes, so neither
// ever sees the wrapper tokens): it reads the row's raw label and value, and wraps the value's and
// note's already-parsed children in a link token pair. Nothing about the text changes, so the
// escaping argument for leader rows above holds unchanged; the only new markup is the `<a>`, whose
// attributes markdown-it's own `renderAttrs` escapes. A note that already holds a link is left
// alone — anchors can't nest.
//
// Members' renderer only. The visual editor's instance (`editorMarkdownIt`) leaves it out, so a hymn
// link never becomes a link mark in the editor and is never written back into the stored Markdown.

const HYMN_LABEL_RE = /hymn/i;
const HYMN_NUMBER_RE = /^(?:#[ \t]*|No\.?[ \t]*|Number[ \t]+)?(\d{1,4})$/i;

const BOOK_1985 = 'https://www.churchofjesuschrist.org/study/manual/hymns';
const BOOK_HOME_AND_CHURCH = 'https://www.churchofjesuschrist.org/study/music/hymns-for-home-and-church';

/**
 * The page for a program row's value, or undefined when the value isn't a bare hymn number.
 * 1–999 is the 1985 *Hymns* (1–341); 1000 and up is *Hymns—For Home and Church*.
 */
export function hymnHref(value: string): string | undefined {
  const digits = HYMN_NUMBER_RE.exec(value.trim())?.[1];
  if (!digits) return undefined;
  const n = Number(digits);
  if (n < 1) return undefined;
  const [book, table] = n < 1000 ? [BOOK_1985, HYMNS_1985] : [BOOK_HOME_AND_CHURCH, HYMNS_FOR_HOME_AND_CHURCH];
  const slug = table[n];
  return slug ? `${book}/${slug}?lang=eng` : `${book}?lang=eng`;
}

function hymnLinkRule(state: StateCore): void {
  const tokens = state.tokens;
  const wrap = (inline: Token, href: string): void => {
    const open = new state.Token('hymn_link_open', 'a', 1);
    open.attrSet('href', href);
    open.attrSet('class', 'hymn-link');
    const close = new state.Token('hymn_link_close', 'a', -1);
    inline.children = [open, ...(inline.children ?? []), close];
  };
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.type !== 'leader_open') continue;
    const sides: Record<string, Token> = {};
    for (i++; i < tokens.length && tokens[i]!.type !== 'leader_close'; i++) {
      if (tokens[i]!.type === 'inline') sides[tokens[i - 1]!.type] = tokens[i]!;
    }
    const label = sides.leader_left_open;
    const value = sides.leader_right_open;
    const note = sides.leader_note_open;
    if (!label || !value || !HYMN_LABEL_RE.test(label.content)) continue;
    const href = hymnHref(value.content);
    if (!href) continue;
    wrap(value, href);
    if (note && !note.children?.some((t) => t.type === 'link_open')) wrap(note, href);
  }
}

/**
 * Teach an instance hymn links. Needs the dot-leader rule. `target="_blank"` like every other link
 * in this app: in an installed iPhone app an off-site page opens over the app, or Gospel Library
 * opens, and either way the program is still there when the member comes back; in a browser tab it
 * keeps the program open in its own tab rather than navigating away from it mid-meeting.
 */
function hymnLinkPlugin(md: MarkdownItInstance): void {
  md.core.ruler.push('hymn_links', hymnLinkRule);
  md.renderer.rules.hymn_link_open = (tokens, idx, _o, _e, self) => {
    tokens[idx]!.attrSet('target', '_blank');
    tokens[idx]!.attrSet('rel', 'noopener noreferrer');
    return `<a${self.renderAttrs(tokens[idx]!)}>`;
  };
  md.renderer.rules.hymn_link_close = () => '</a>';
}

// ---------------------------------------------------------------------------
// Images from elsewhere
// ---------------------------------------------------------------------------
//
// `![](https://…)` would have every member's phone fetch that address on every page load — a
// tracking pixel an editor's account could plant, logging who opens the app and when. The visual
// editor cannot insert an inline image (images are attachments), so the only images a body should
// hold are the ward's own uploads. Anything else is drawn as a plain link to it instead: nothing is
// fetched until someone taps it, and a body written that way by an older ward loses nothing.
//
// On the members' renderers only. The editor parses with the same rules, and rewriting an image as
// a link there would save it back into the source as one.

/** An uploaded image's address: `/images/` and a storage key (src/filestore.ts). */
const OWN_IMAGE = /^\/images\/[0-9a-f]{32}\.(?:jpg|png|webp|gif)$/;

function ownImagesOnly(md: MarkdownItInstance): void {
  const drawImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const src = String(token.attrGet('src') ?? '');
    if (OWN_IMAGE.test(src)) return drawImage(tokens, idx, options, env, self);
    const label = md.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env) || src);
    // A `data:` image (which markdown-it allows) would be a link no browser opens: just its words.
    if (!/^https?:\/\//i.test(src)) return label;
    return `<a href="${md.utils.escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  };
}

// ---------------------------------------------------------------------------
// The renderers
// ---------------------------------------------------------------------------

function createRenderer(opts: {
  dotLeaders: boolean;
  hymnLinks?: boolean;
  typographer?: boolean;
  /** Draw only the ward's own uploaded images (see `ownImagesOnly`). Members' renderers only. */
  ownImages?: boolean;
}): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    typographer: opts.typographer ?? true,
  });

  // Make links open in a new tab safely.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx]!.attrSet('target', '_blank');
    tokens[idx]!.attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  if (opts.ownImages) ownImagesOnly(md);

  // Order matters: see `centerPlugin`. Centering goes in first so it sits ahead of the leader rule.
  centerPlugin(md);
  centeredHeadingPlugin(md);
  blankLineGapPlugin(md);
  if (opts.dotLeaders) dotLeaderPlugin(md);
  if (opts.dotLeaders && opts.hymnLinks) hymnLinkPlugin(md);
  return md;
}

const announcementRenderer = createRenderer({ dotLeaders: false, ownImages: true });
const programRenderer = createRenderer({ dotLeaders: true, hymnLinks: true, ownImages: true });

/** Announcement bodies. Plain Markdown plus centered lines — a pipe in prose stays a pipe. */
export function renderMarkdown(source: string): string {
  return announcementRenderer.render(source ?? '');
}

/** Sacrament meeting program bodies. Markdown plus centered lines and the dot-leader row syntax. */
export function renderProgramMarkdown(source: string): string {
  return programRenderer.render(source ?? '');
}

/**
 * The parser the admin's visual editor reads Markdown with (`editor/markdown.js`): the same
 * instance and rules the members' page renders with, so a centered line, a leader row or a gap is
 * recognised by exactly the code that draws it. Two differences, both render-time niceties that
 * must not be stored: typographer off, since it rewrites straight quotes and `...` in the *text*,
 * which would then be saved back into the source as curly quotes and ellipses; and no hymn links,
 * which the editor would otherwise read as link marks and write back as Markdown links.
 */
export function editorMarkdownIt(kind: 'announcement' | 'program'): MarkdownItInstance {
  return createRenderer({ dotLeaders: kind === 'program', typographer: false });
}
