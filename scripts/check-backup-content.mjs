// Runs every announcement, page and program in a dashboard backup through the visual editor's
// Markdown round trip, and reports any that would not survive it unchanged. Read-only: it reads the
// file you give it and prints a report; nothing is sent anywhere.
//
//   npm run build                                   # the check uses dist/markdown.js
//   node scripts/check-backup-content.mjs ward-announcements-backup-2026-10-26.json
//
// For each item it reports one of:
//   ok          — opens in the visual editor and saves back byte for byte
//   same look   — opens and renders identically, but would be saved with different Markdown
//   different   — opens, but would render differently after a save (worth a look)
//   markdown    — the editor cannot hold it (a table, an inline image), so it opens in Markdown mode
//
// The same bridge test/editor-roundtrip.test.js uses, so the two cannot disagree.
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from '../editor/extensions.js';
import { createMarkdownParser, createMarkdownSerializer } from '../editor/markdown.js';
import { editorMarkdownIt, renderMarkdown, renderProgramMarkdown } from '../dist/markdown.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/check-backup-content.mjs <backup.json>');
  process.exit(2);
}
const backup = JSON.parse(readFileSync(file, 'utf8'));
const tables = backup.tables ?? backup;

function bridge(kind) {
  const schema = getSchema(editorExtensions(kind));
  const parser = createMarkdownParser(schema, editorMarkdownIt(kind));
  const serializer = createMarkdownSerializer(kind);
  const render = kind === 'program' ? renderProgramMarkdown : renderMarkdown;
  return { parser, serializer, render };
}
const bridges = { announcement: bridge('announcement'), program: bridge('program') };

const items = [
  ...(tables.announcements ?? []).map((r) => ['announcement', r.title, r.body]),
  ...(tables.pages ?? []).map((r) => ['page', r.title, r.body]),
  ...(tables.programs ?? []).map((r) => ['program', r.program_date, r.body_md]),
];

const counts = {};
for (const [kind, name, md] of items) {
  const b = bridges[kind === 'program' ? 'program' : 'announcement'];
  let verdict;
  let detail = '';
  try {
    const out = b.serializer.serialize(b.parser.parse(md ?? ''));
    if (out === md) verdict = 'ok';
    else if (b.render(out) === b.render(md ?? '')) verdict = 'same look';
    else verdict = 'different';
  } catch (err) {
    verdict = 'markdown';
    detail = ` (${err.message})`;
  }
  counts[verdict] = (counts[verdict] ?? 0) + 1;
  if (verdict !== 'ok') console.log(`${verdict.padEnd(10)} ${kind.padEnd(12)} ${name}${detail}`);
}
console.log(`\n${items.length} items: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
