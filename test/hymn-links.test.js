/**
 * Hymn links in the sacrament meeting program (see "Hymn links" in src/markdown.ts): a hymn row's
 * number and note link to the hymn on churchofjesuschrist.org, from the committed table in
 * src/hymns.ts — and nothing else in a program does, and the editor never sees them.
 *
 * In process, against the compiled modules. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { editorExtensions } from '../editor/extensions.js';
import { createMarkdownParser, createMarkdownSerializer } from '../editor/markdown.js';
import { editorMarkdownIt, hymnHref, renderMarkdown, renderProgramMarkdown } from '../dist/markdown.js';
import { HYMNS_1985, HYMNS_FOR_HOME_AND_CHURCH } from '../dist/hymns.js';

const OLD = 'https://www.churchofjesuschrist.org/study/manual/hymns';
const NEW = 'https://www.churchofjesuschrist.org/study/music/hymns-for-home-and-church';

const span = (cls, html) => new RegExp(`<span class="${cls}">(.*?)</span>`).exec(html)?.[1];
const link = (href, text) =>
  `<a href="${href}" class="hymn-link" target="_blank" rel="noopener noreferrer">${text}</a>`;

describe('the hymn table', () => {
  test('both books are number → slug maps of the expected size', () => {
    for (const [table, min] of [
      [HYMNS_1985, 341],
      [HYMNS_FOR_HOME_AND_CHURCH, 75],
    ]) {
      const entries = Object.entries(table);
      assert.ok(entries.length >= min, `${entries.length} entries`);
      for (const [n, slug] of entries) {
        assert.match(n, /^\d+$/);
        assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `#${n}: ${slug}`);
      }
    }
    // The 1985 book is complete and closed: 1–341, nothing else.
    const old = Object.keys(HYMNS_1985).map(Number);
    assert.equal(Math.min(...old), 1);
    assert.equal(Math.max(...old), 341);
    assert.equal(old.length, 341);
    // The new book numbers from 1001, so the two can never collide.
    assert.ok(Object.keys(HYMNS_FOR_HOME_AND_CHURCH).every((n) => Number(n) >= 1001));
  });

  test('known hymns are where the Church puts them', () => {
    assert.equal(HYMNS_1985[2], 'the-spirit-of-god');
    assert.equal(HYMNS_1985[169], 'as-now-we-take-the-sacrament');
    assert.equal(HYMNS_1985[301], 'i-am-a-child-of-god');
    assert.equal(HYMNS_FOR_HOME_AND_CHURCH[1001], 'come-thou-fount-of-every-blessing');
  });
});

describe('hymnHref', () => {
  test('accepts a bare number in the usual spellings', () => {
    for (const v of ['#2', '2', '# 2', 'No. 2', 'no 2', 'No.2', 'Number 2', ' #2 ']) {
      assert.equal(hymnHref(v), `${OLD}/the-spirit-of-god?lang=eng`, v);
    }
    assert.equal(hymnHref('#1001'), `${NEW}/come-thou-fount-of-every-blessing?lang=eng`);
  });

  test('a number not in the table links to its book’s index', () => {
    assert.equal(hymnHref('#500'), `${OLD}?lang=eng`);
    assert.equal(hymnHref('#999'), `${OLD}?lang=eng`);
    assert.equal(hymnHref('#1000'), `${NEW}?lang=eng`);
    assert.equal(hymnHref('#9999'), `${NEW}?lang=eng`);
  });

  test('anything but a bare number is not a hymn', () => {
    for (const v of ['Ward Choir', '#0', '0', '98–99', '#19, 20', '19a', '#12345', 'Hymn 2', '', '#', 'No.']) {
      assert.equal(hymnHref(v), undefined, v);
    }
  });
});

describe('hymn rows in a program', () => {
  test('a 1985 hymn row links the number', () => {
    const html = renderProgramMarkdown('Opening Hymn ... #2');
    assert.equal(span('leader-left', html), 'Opening Hymn', 'the label is not linked');
    assert.equal(span('leader-right', html), link(`${OLD}/the-spirit-of-god?lang=eng`, '#2'));
  });

  test('a Hymns—For Home and Church row links the number', () => {
    const html = renderProgramMarkdown('Sacrament Hymn | No. 1001');
    assert.equal(
      span('leader-right', html),
      link(`${NEW}/come-thou-fount-of-every-blessing?lang=eng`, 'No. 1001'),
    );
  });

  test('the note links to the same hymn', () => {
    const html = renderProgramMarkdown('Sacrament Hymn ... #169\n... "As Now We Take the Sacrament"');
    const href = `${OLD}/as-now-we-take-the-sacrament?lang=eng`;
    assert.equal(span('leader-right', html), link(href, '#169'));
    assert.equal(span('leader-note', html), link(href, '“As Now We Take the Sacrament”'));
  });

  test('any label containing "hymn", in any case', () => {
    for (const label of ['Rest Hymn', 'Closing Hymn', 'Intermediate hymn', 'HYMN', 'Hymn of Praise']) {
      assert.match(renderProgramMarkdown(`${label} ... #301`), /class="hymn-link"/, label);
    }
  });

  test('a number not in the table links to the index', () => {
    const html = renderProgramMarkdown('Closing Hymn ... #1999\n... "A New Hymn"');
    assert.equal(span('leader-right', html), link(`${NEW}?lang=eng`, '#1999'));
    assert.equal(span('leader-note', html), link(`${NEW}?lang=eng`, '“A New Hymn”'));
    assert.equal(
      span('leader-right', renderProgramMarkdown('Opening Hymn ... #400')),
      link(`${OLD}?lang=eng`, '#400'),
    );
  });

  test('non-hymn rows and non-number values are untouched', () => {
    for (const src of [
      'Speaker ... #2',
      'Musical Number ... 2',
      'Rest Hymn ... Ward Choir',
      'Rest Hymn ... Primary Children\n... "I Am a Child of God"',
      'Opening Hymn ... #19, 20',
      'Opening Hymn ... 98–99',
      'Opening Hymn ... TBD',
      'Opening Hymn ... **#2**',
    ]) {
      assert.doesNotMatch(renderProgramMarkdown(src), /<a /, src);
    }
  });

  test('a hymn line outside a row is just text', () => {
    assert.doesNotMatch(renderProgramMarkdown('Opening Hymn #2'), /<a /);
    assert.doesNotMatch(renderProgramMarkdown('# Opening Hymn ... #2'), /<a /);
    // Announcements have no rows at all.
    assert.doesNotMatch(renderMarkdown('Opening Hymn ... #2'), /<a /);
  });

  test('the note keeps markdown-it’s escaping inside the link', () => {
    const html = renderProgramMarkdown(
      'Opening Hymn ... #2\n... <img src=x onerror=alert(1)> & "Q" *em* [x](javascript:alert(1))',
    );
    const note = span('leader-note', html);
    assert.ok(note.startsWith(`<a href="${OLD}/the-spirit-of-god?lang=eng" class="hymn-link"`), note);
    assert.match(note, /&lt;img src=x onerror=alert\(1\)&gt; &amp; “Q” <em>em<\/em>/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /href="javascript/);
  });

  test('a note that already holds a link is not wrapped in another', () => {
    const html = renderProgramMarkdown('Opening Hymn ... #2\n... see https://example.org/x');
    assert.match(span('leader-right', html), /class="hymn-link"/);
    const note = /<span class="leader-note">(.*)<\/span><\/p>/.exec(html)[1];
    assert.doesNotMatch(note, /hymn-link/);
    assert.equal(note.match(/<a /g).length, 1);
  });
});

describe('the editor never sees hymn links', () => {
  const src = 'Opening Hymn ... #2\n... "The Spirit of God"';

  test('its markdown-it instance emits no link tokens for a hymn row', () => {
    const tokens = editorMarkdownIt('program').parse(src, {});
    const children = tokens.filter((t) => t.type === 'inline').flatMap((t) => t.children);
    assert.ok(children.length > 0);
    assert.ok(children.every((t) => !/link/.test(t.type)), children.map((t) => t.type).join());
  });

  test('a hymn row round-trips through the editor unchanged, with no link mark', () => {
    const schema = getSchema(editorExtensions('program'));
    const doc = createMarkdownParser(schema, editorMarkdownIt('program')).parse(src);
    let marks = 0;
    doc.descendants((node) => {
      marks += node.marks.length;
    });
    assert.equal(marks, 0);
    assert.equal(createMarkdownSerializer('program').serialize(doc), src);
  });
});
