// The visual editor's Markdown bridge (editor/markdown.js), in both directions.
//
// 1. **Markdown → editor → Markdown** must not change what members see: the original and the
//    re-serialized text render to identical HTML through the real renderers. Programs in the usual
//    hand-written shape must also come back byte-for-byte, since that shape (rows on
//    consecutive lines, two-blank-line gaps) is what a clerk reads in Markdown view.
// 2. **Editor → Markdown → editor** must give back the document the editor showed: text typed into a
//    paragraph that merely looks like a row, a centered line or a list stays text.
//
// The schema is built headless (Tiptap's getSchema), so this runs in Node with no DOM. The browser
// half — toolbar, keys, input rules, paste — is checked by hand in a browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from '../editor/extensions.js';
import { createMarkdownParser, createMarkdownSerializer } from '../editor/markdown.js';
import { editorMarkdownIt, renderMarkdown, renderProgramMarkdown } from '../dist/markdown.js';
import { EXAMPLE_PROGRAM } from '../dist/programs.js';

function bridge(kind) {
  const schema = getSchema(editorExtensions(kind));
  const parser = createMarkdownParser(schema, editorMarkdownIt(kind));
  const serializer = createMarkdownSerializer(kind);
  const render = kind === 'program' ? renderProgramMarkdown : renderMarkdown;
  const roundTrip = (md) => serializer.serialize(parser.parse(md));
  return { schema, parser, serializer, render, roundTrip };
}
const program = bridge('program');
const announcement = bridge('announcement');

/** A program in the usual hand-written shape. Names are invented. */
const USUAL_SHAPE = `Presiding ... Bishop Ramirez
Conducting ... Brother Okafor
Organist ... Sister Lindqvist
Chorister ... Brother Haddad


## -> Welcome and Announcements <-


Opening Hymn ... #19
... "We Thank Thee, O God, for a Prophet"
Invocation ... Sister Moreau


## -> Ward and Stake Business <-


Sacrament Hymn ... #169
... "As Now We Take the Sacrament"


## -> Administration of the Sacrament <-


Speaker ... Brother Tanaka
... Farewell
Speaker ... Sister Novak


Closing Hymn ... #2
... "The Spirit of God"
Benediction ... Brother Silva


---


### Meeting Info
12:00-1:00 PM: Sacrament Meeting
1:05-1:30 PM: Sunday School, Primary

### Sunday School Classroom Assignments
Adult Sunday School ... Relief Society Room
Course 17 ... Room 118`;

const PROGRAMS = {
  'the usual shape': USUAL_SHAPE,
  'the New program page’s example': EXAMPLE_PROGRAM,
  'formatting inside rows': `Presiding ... **Bishop** *Ramirez*
Conducting | [Brother Okafor](https://example.org)
Speaker ... Jane ... Doe
-> **Fast and Testimony Meeting** <-
### -> Meeting Info <-
1. A list straight under a heading
2. Second`,
  'a list, a quote and rows after them': `- one
- two

Speaker ... After a list

> A quote

Benediction ... Sister Novak`,
};

const ANNOUNCEMENTS = {
  'a little of everything': `## -> Ward Christmas Party <-

Join us **Friday, Dec 12** at 6:00 PM in the *cultural hall*.
Bring a side dish to share!


### What to bring
- A side dish
- A wrapped gift (under $10)

1. Arrive early
2. Help set up

Questions? See https://example.org/party or [the sign-up](https://example.org/signup "Sign up").

> Remember: the content policy applies.

---

Wait ... there's more! Use 5 * 3, some_snake_case and #hashtag. A | B is prose here.`,
  'loose list': `- one

- two`,
  'gaps of every size': 'One\n\n\nTwo\n\n\n\nThree\n\n\n\n\nFour\n\n\n\n\n\nFive',
  'blocks that interrupt a paragraph': 'Line one\nLine two\n-> centered <-\n- a list',
  'nested lists, code and adjacent lists': `1. First
   - nested a
   - nested b
2. Second

3) a separate list

\`inline\` and ~~struck~~ and ***both***

\`\`\`
code block
  indented
\`\`\`

Escapes: \\*not em\\* and <b>not html</b> & 🎉👨‍👩‍👧
# Heading 1
###### Heading 6`,
  'an ordered list that starts at three': '3. three\n4. four',
};

describe('Markdown → editor → Markdown', () => {
  for (const [kind, corpus, b] of [
    ['program', PROGRAMS, program],
    ['announcement', ANNOUNCEMENTS, announcement],
  ]) {
    for (const [name, md] of Object.entries(corpus)) {
      test(`${kind}: ${name} renders identically, and is stable`, () => {
        const out = b.roundTrip(md);
        assert.equal(b.render(out), b.render(md));
        assert.equal(b.roundTrip(out), out, 'a second pass changes nothing');
      });
    }
  }

  test('a program in the usual shape comes back byte-for-byte', () => {
    assert.equal(program.roundTrip(USUAL_SHAPE), USUAL_SHAPE);
  });

  test('the example program opens in the visual editor and comes back byte-for-byte', () => {
    // "Start from an example" must not open in Markdown mode, or change before anyone edits it.
    assert.doesNotThrow(() => program.parser.parse(EXAMPLE_PROGRAM));
    assert.equal(program.roundTrip(EXAMPLE_PROGRAM), EXAMPLE_PROGRAM);
    // As members would see it: every row a dot-leader row (13 of them).
    const html = renderProgramMarkdown(EXAMPLE_PROGRAM);
    assert.equal((html.match(/class="leader[ "]/g) ?? []).length, 13); // 4 of them with a hymn title
  });

  test('blank lines past the renderer’s cap of three steps come back capped', () => {
    assert.equal(announcement.roundTrip('A\n\n\n\n\n\nB'), 'A\n\n\n\n\nB');
  });

  test('what the editor cannot hold is refused, so it stays in Markdown', () => {
    assert.throws(() => announcement.parser.parse('| a | b |\n| - | - |\n| 1 | 2 |'), /table/);
    assert.throws(() => announcement.parser.parse('![flyer](https://example.org/x.png)'), /image/);
    // The schema's list item opens with a paragraph: a row there would be pushed out of its list.
    assert.throws(() => program.parser.parse('- Course 17 ... Room 118'), /program row/);
    assert.doesNotThrow(() => program.parser.parse('- Course 17\n\n  Room ... 118'));
  });
});

describe('editor → Markdown → editor', () => {
  const p = (schema, text, attrs = {}) => schema.nodes.paragraph.create(attrs, text ? schema.text(text) : null);
  const strip = (json) => JSON.parse(JSON.stringify(json, (k, v) => (k === 'joinUp' ? undefined : v)));
  const sameDoc = (b, doc) => assert.deepEqual(strip(b.parser.parse(b.serializer.serialize(doc)).toJSON()), strip(doc.toJSON()));

  test('prose that looks like a program row stays prose', () => {
    const { schema } = program;
    sameDoc(program, schema.nodes.doc.create(null, [p(schema, 'Presiding | Bishop Ramirez')]));
    // A run of dots is written as the ellipsis the typographer would have made of it: still prose,
    // and what members see is `…`, not the `.…` that escaping only the first dot rendered.
    const doc = schema.nodes.doc.create(null, [p(schema, 'Speaker ... Jane Doe'), p(schema, '... not a note')]);
    const md = program.serializer.serialize(doc);
    assert.equal(md, 'Speaker … Jane Doe\n\n… not a note');
    assert.doesNotMatch(program.render(md), /leader|\.…/);
    sameDoc(program, program.parser.parse(md));
  });

  test('a break in a centered line or a heading keeps it one centered line or one heading', () => {
    // Shift+Enter is on everywhere; a bare newline would end the line and show members the arrows.
    const { schema } = program;
    const br = () => schema.nodes.hardBreak.create();
    const centered = schema.nodes.paragraph.create({ textAlign: 'center' }, [br(), schema.text('Ward'), br(), br(), schema.text('Conference'), br()]);
    assert.equal(program.serializer.serialize(schema.nodes.doc.create(null, [centered])), '-> Ward <-\n-> Conference <-');
    const heading = (attrs) => schema.nodes.heading.create(attrs, [schema.text('Ward'), br(), schema.text('Conference')]);
    assert.equal(program.serializer.serialize(schema.nodes.doc.create(null, [heading({ level: 2 })])), '## Ward Conference');
    const md = program.serializer.serialize(schema.nodes.doc.create(null, [heading({ level: 3, textAlign: 'center' })]));
    assert.equal(md, '### -> Ward Conference <-');
    assert.equal(program.render(md).trim(), '<h3 class="centered">Ward Conference</h3>');
  });

  test('prose that looks like a centered line, a heading or a list stays prose', () => {
    for (const b of [program, announcement]) {
      const { schema } = b;
      sameDoc(b, schema.nodes.doc.create(null, [
        p(schema, '-> not centered <-'),
        p(schema, '## not a heading'),
        p(schema, '- not a list'),
        p(schema, '1. not a list either'),
      ]));
    }
  });

  test('line breaks, including one typed twice, stay inside their paragraph', () => {
    const { schema } = announcement;
    const br = () => schema.nodes.hardBreak.create();
    sameDoc(announcement, schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text('one'), br(), schema.text('- two'), br(), br(), schema.text('-> three <-')]),
    ]));
  });

  test('rows made in the editor stack on consecutive lines, notes included', () => {
    const { schema } = program;
    const { leaderRow, leaderLeft, leaderRight, leaderNote } = schema.nodes;
    const row = (l, r, n) =>
      leaderRow.create(null, [leaderLeft.create(null, schema.text(l)), leaderRight.create(null, schema.text(r)), ...(n ? [leaderNote.create(null, schema.text(n))] : [])]);
    const doc = schema.nodes.doc.create(null, [row('Opening Hymn', '#19', '"We Thank Thee"'), row('Invocation', 'Sister Moreau'), p(schema, ''), row('Speaker', 'Brother Tanaka')]);
    assert.equal(program.serializer.serialize(doc), 'Opening Hymn ... #19\n... "We Thank Thee"\nInvocation ... Sister Moreau\n\n\nSpeaker ... Brother Tanaka');
    sameDoc(program, doc);
  });

  test('half a row is written as the text it has, not as a broken row', () => {
    const { schema } = program;
    const { leaderRow, leaderLeft, leaderRight } = schema.nodes;
    const doc = schema.nodes.doc.create(null, [leaderRow.create(null, [leaderLeft.create(null, schema.text('Speaker')), leaderRight.create()])]);
    assert.equal(program.serializer.serialize(doc), 'Speaker');
  });
});
