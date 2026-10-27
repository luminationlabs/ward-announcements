/**
 * "Save as PDF" builds a pdfmake document from the preview's markup — the same inline-styled HTML
 * `richPreviewHtml()` renders for the modal and the standalone page — so the PDF can only ever say
 * what the copy says. `public/preview-pdf.js` runs verbatim in a `vm` against a stub DOM parsed
 * from that markup; pdfmake itself is stubbed so the test sees the document definition.
 *
 * Node only, and deliberately in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/preview-pdf.js', import.meta.url), 'utf8');

/**
 * The smallest DOM the converter needs, parsed from the well-formed, double-quoted markup the
 * renderer emits (markdown-it + the preview's inline-style rewrite). Not a general HTML parser.
 */
function parse(html) {
  const VOID = new Set(['BR', 'IMG', 'HR']);
  const root = { nodeType: 1, nodeName: 'DIV', attrs: {}, childNodes: [] };
  const stack = [root];
  const re = /<\/?([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const parent = stack[stack.length - 1];
    if (m[3] !== undefined) {
      parent.childNodes.push({ nodeType: 3, nodeValue: decode(m[3]) });
      continue;
    }
    const name = m[1].toUpperCase();
    if (m[0].startsWith('</')) {
      assert.equal(parent.nodeName, name, `mismatched </${name}>`);
      stack.pop();
      continue;
    }
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '');
    const el = {
      nodeType: 1,
      nodeName: name,
      attrs,
      childNodes: [],
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
    parent.childNodes.push(el);
    if (!VOID.has(name)) stack.push(el);
  }
  assert.equal(stack.length, 1, 'unclosed elements');
  return root;
}
function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function load({ fontBytes = null } = {}) {
  const created = [];
  const registered = { vfs: {}, fonts: {} };
  const fetched = [];
  const window = {
    pdfMake: {
      createPdf(doc) {
        created.push(doc);
        return { download: async () => undefined };
      },
      addVirtualFileSystem(vfs) { Object.assign(registered.vfs, vfs); },
      addFonts(fonts) { Object.assign(registered.fonts, fonts); },
    },
  };
  const context = {
    window,
    document: { createElement: () => { throw new Error('no DOM in the test'); }, head: {} },
    // The only fetch the converter makes outside an image is the emoji font.
    fetch: async (url) => {
      fetched.push(url);
      if (!fontBytes) return { ok: false, status: 404 };
      return { ok: true, arrayBuffer: async () => fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength) };
    },
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    Uint8Array,
    RegExp,
    Promise,
    Object,
    Array,
    String,
    Number,
    Math,
    Date,
    Error,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'preview-pdf.js' });
  return { api: window.PreviewPdf, created, registered, fetched };
}

/** Every text run in a pdfmake content item, joined — what the PDF would say. */
function textOf(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (Array.isArray(item)) return item.map(textOf).join('');
  if (item.text !== undefined) return textOf(item.text);
  if (item.stack) return item.stack.map(textOf).join('\n');
  if (item.ul) return item.ul.map(textOf).join('\n');
  if (item.ol) return item.ol.map(textOf).join('\n');
  if (item.table) return item.table.body.map((r) => r.map(textOf).join(' | ')).join('\n');
  return '';
}

// Exactly the shape richPreviewHtml() emits: a font-styled wrapper, an <h3> per announcement, the
// body with class→style rewrites, a leader row flattened to "left … right", and an image paragraph.
const PREVIEW = `<div style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#111">
<h3 style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;font-size:17px;font-weight:600;margin:1.1em 0 0.3em;color:#1f3a5f">Ward Temple Day &amp; Potluck</h3>
<h2 style="text-align:center">Centered heading</h2>
<p style="text-align:center;margin-top:1.8em;margin-bottom:0.6em">Centered line</p>
<p style="margin:0 0 0.6em">A <strong>bold</strong> word, an <em>italic</em> one and a <a href="https://example.com/x">link</a>.<br>
Second line after a break.</p>
<p style="margin:0 0 0.6em">Speaker … Jane Doe</p>
<ul>
<li>tight <strong>one</strong></li>
<li>two</li>
</ul>
<p style="margin:0.4em 0 0.6em"><a href="https://example.com/images/k1"><img src="https://example.com/images/k1" alt="" style="max-height:220px"></a><a href="https://example.com/images/k2"><img src="https://example.com/images/k2" alt="" style="max-height:220px"></a></p>
<h3 style="font-size:17px;color:#1f3a5f">Second announcement</h3>
<p style="margin:0 0 0.6em">Body two.</p>
</div>`;

describe('the preview-to-PDF converter', () => {
  test('carries the preview into pdfmake text runs with its formatting', async () => {
    const { api } = load();
    const loaded = [];
    const doc = await api.build(parse(PREVIEW), {
      title: 'Ward Announcements',
      now: new Date(2026, 8, 27),
      loadImage: async (src) => {
        loaded.push(src);
        return src.endsWith('k2') ? null : 'data:image/jpeg;base64,AAAA';
      },
    });
    assert.equal(doc.pageSize, 'LETTER');
    assert.equal(doc.defaultStyle.font, 'Roboto');
    const c = doc.content;
    assert.equal(textOf(c[0]), 'Ward Announcements', 'the app name heads the page');
    assert.match(textOf(c[1]), /September 27, 2026/u, 'then the date');

    const h3 = c[2];
    assert.equal(textOf(h3), 'Ward Temple Day & Potluck', 'entities are decoded, not printed');
    assert.equal(h3.bold, true);
    assert.equal(h3.fontSize, 14);

    const centeredHeading = c[3];
    assert.equal(textOf(centeredHeading), 'Centered heading');
    assert.equal(centeredHeading.alignment, 'center');
    const centeredLine = c[4];
    assert.equal(centeredLine.alignment, 'center');
    assert.ok(centeredLine.margin[1] > 12, 'the gap class became a top margin');

    const para = c[5];
    assert.equal(textOf(para), 'A bold word, an italic one and a link.\nSecond line after a break.');
    const runs = para.text;
    assert.equal(runs.find((r) => r.text === 'bold').bold, true);
    assert.equal(runs.find((r) => r.text === 'italic').italics, true);
    const link = runs.find((r) => r.text === 'link');
    assert.equal(link.link, 'https://example.com/x');
    assert.equal(link.decoration, 'underline');
    assert.ok(!runs.some((r) => r.text.includes('<')), 'no markup leaks into the text');

    assert.equal(textOf(c[6]), 'Speaker … Jane Doe', 'a flattened leader row reads as one line');

    const list = c[7];
    assert.ok(list.ul, 'a list is a pdfmake ul');
    assert.equal(list.ul.length, 2);
    assert.equal(textOf(list.ul[0]), 'tight one', 'a tight item is one text block, bold word and all');
    assert.equal(list.ul[0].text.find((r) => r.text === 'one').bold, true);

    // Both images were asked for; the one that failed to load is dropped rather than failing the
    // export (pdfmake throws on a missing image), and no <img> src is left in the document.
    assert.deepEqual(loaded, ['https://example.com/images/k1', 'https://example.com/images/k2']);
    const images = c.filter((item) => item.image);
    assert.equal(images.length, 1);
    assert.equal(images[0].image, 'data:image/jpeg;base64,AAAA');
    assert.ok(Array.isArray(images[0].fit));

    assert.equal(textOf(c[c.length - 2]), 'Second announcement');
    assert.equal(textOf(c[c.length - 1]), 'Body two.');
    assert.equal(doc.footer(1, 1), null, 'no page number on a one-page handout');
    assert.match(textOf(doc.footer(2, 3)), /2 of 3/u);
  });

  const EMOJI_HTML = '<div><h3>Welcome 👋</h3><p>Potluck <strong>🍲🥧</strong> on Friday 👨‍👩‍👧‍👦 — bring a dish ✅ 🇺🇸.</p><p>© 2026 Ward™ ‼ 1️⃣</p></div>';

  test('emoji become their own runs in the emoji font, one per cluster', async () => {
    // Roboto has no emoji glyphs and pdfmake cannot fall back to a font that does, so each emoji
    // cluster is set in Noto Emoji — and a ZWJ family or a skin-toned hand must stay *one* run, or
    // the font's ligature shaping never sees the whole sequence.
    const { api } = load();
    const doc = await api.build(parse(EMOJI_HTML), { now: new Date(2026, 0, 4), emojiFont: 'NotoEmoji' });
    assert.equal(textOf(doc.content[1]), 'Welcome 👋');
    assert.equal(doc.content[1].text[1].font, 'NotoEmoji');
    const runs = doc.content[2].text;
    const emoji = runs.filter((r) => r.font === 'NotoEmoji').map((r) => r.text);
    assert.deepEqual([...emoji], ['🍲🥧', '👨‍👩‍👧‍👦', '✅', '🇺🇸']);
    assert.equal(runs.find((r) => r.text === '🍲🥧').bold, true, 'the emoji run keeps its formatting');
    assert.ok(runs.every((r) => r.font === 'NotoEmoji' || !/\p{Extended_Pictographic}/u.test(r.text)), 'no emoji in a Roboto run');
    // Unicode calls © ® ‼ ™ pictographic too, but Roboto has them, and an announcement may well.
    // A keycap's selector and combining mark are in neither font and go; the digit stays.
    assert.equal(textOf(doc.content[3]), '© 2026 Ward™ ‼ 1');
    assert.ok(doc.content[3].text.every((r) => !r.font), 'those stay in the default font');
  });

  test('without the emoji font, emoji are dropped rather than printed as boxes', async () => {
    const { api } = load();
    const doc = await api.build(parse(EMOJI_HTML), { now: new Date(2026, 0, 4) });
    assert.equal(textOf(doc.content[1]), 'Welcome');
    assert.equal(textOf(doc.content[2]), 'Potluck on Friday — bring a dish .');
    assert.equal(textOf(doc.content[3]), '© 2026 Ward™ ‼ 1');
  });

  test('download registers the emoji font with pdfmake and reports its progress', async () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 2, 3]); // "wOFF" + a little
    const { api, created, registered, fetched } = load({ fontBytes: bytes });
    const seen = [];
    const name = await api.download(parse('<div><p>Hi 👋</p></div>'), {
      title: 'Ward',
      now: new Date(2026, 8, 27),
      loadImage: async () => null,
      onStatus: (t) => seen.push(t),
    });
    assert.equal(name, 'ward-2026-09-27.pdf');
    assert.deepEqual(fetched, ['/vendor/noto-emoji/NotoEmoji-Regular.woff']);
    assert.equal(registered.vfs['NotoEmoji.woff'], Buffer.from(bytes).toString('base64'));
    assert.equal(registered.fonts.NotoEmoji.normal, 'NotoEmoji.woff');
    assert.equal(created[0].content[created[0].content.length - 1].text[1].font, 'NotoEmoji', 'the run was set in it');
    assert.equal(seen.length, 2, 'a "getting the tools" message, then a "building" one');
    assert.match(seen[1], /Building/u);

    // A second download does not fetch the font again.
    await api.download(parse('<div><p>x</p></div>'), { title: 'Ward', loadImage: async () => null });
    assert.equal(fetched.length, 1);
  });

  test('download survives the emoji font being unavailable', async () => {
    const { api, created, fetched } = load(); // fetch answers 404
    await api.download(parse('<div><p>Hi 👋</p></div>'), { title: 'Ward', loadImage: async () => null });
    assert.equal(fetched.length, 1);
    assert.equal(textOf(created[0].content[created[0].content.length - 1]), 'Hi', 'the emoji was dropped instead');
  });

  test('a code block keeps its line breaks and indent', async () => {
    const { api } = load();
    const doc = await api.build(parse('<div><pre><code>line one\n  line two\n</code></pre></div>'), {
      now: new Date(2026, 0, 4),
    });
    assert.equal(doc.content[1].text, 'line one\n  line two');
    assert.equal(doc.content[1].preserveLeadingSpaces, true);
  });

  test('a small image is not blown up to the page width', async () => {
    const { api } = load();
    const doc = await api.build(parse('<div><p><img src="/images/k1"></p><p><img src="/images/k2"></p></div>'), {
      now: new Date(2026, 0, 4),
      loadImage: async (src) => ({ data: 'data:image/jpeg;base64,AAAA', width: src.endsWith('k1') ? 200 : 1600, height: src.endsWith('k1') ? 100 : 1200 }),
    });
    const [small, big] = doc.content.filter((i) => i.image);
    assert.deepEqual([...small.fit], [150, 75], '200×100 px is 150×75 pt, well inside the page');
    assert.equal(big.fit[0], 504, 'a big flyer is capped at the content width');
    assert.equal(big.fit[1], 260);
  });

  // "Include a link to the app" appends one marked paragraph to the preview. In the PDF it closes
  // the document under a rule, with a QR of the same address beside it.
  test('an image is embedded at the size the page prints it, not the size it was uploaded', () => {
    const { api } = load();
    const size = (w, h) => { const s = api.embedSize(w, h); return [s.width, s.height].join('x'); };
    // The box is 504 x 260pt and the target 4px per point: a portrait flyer is bound by the height.
    assert.equal(size(1200, 1600), '780x1040', 'a portrait upload shrinks to the 260pt it is given');
    assert.equal(size(1600, 1200), '1387x1040', 'a landscape one too');
    assert.equal(size(1600, 400), '1600x400', 'a banner already has fewer than the page width could use');
    assert.equal(size(300, 200), '300x200', 'a small image is never enlarged');
    assert.equal(size(4000, 1), '2016x1', 'and never rounds away to nothing');
  });

  test('the app link closes the document, under a rule and beside a QR of the same address', async () => {
    const { api } = load();
    const url = 'https://ward.example.org/#i=abc-DEF_123';
    const invite =
      `<p data-app-link style="margin:1.6em 0 0">` +
      `<a href="${url}" style="font-weight:600">Get these announcements on your phone each week</a>. ` +
      `<span style="color:#666">This link works through October 20.</span></p>`;
    const doc = await api.build(parse(PREVIEW + invite), {
      title: 'Ward Announcements',
      now: new Date(2026, 8, 27),
      loadImage: async () => null,
    });
    const c = doc.content;
    assert.equal(textOf(c[0]), 'Ward Announcements', 'the heading is as it was');
    assert.equal(textOf(c[2]), 'Ward Temple Day & Potluck');
    const foot = c[c.length - 1];
    assert.equal(foot.unbreakable, true, 'the rule, the line and the QR stay on one page');
    assert.equal(foot.stack[0].canvas[0].type, 'line', 'a rule sets it apart from the announcements');
    const [text, qr] = foot.stack[1].columns;
    assert.equal(textOf(text), 'Get these announcements on your phone each week. This link works through October 20.');
    const linked = text.text.filter((r) => r.link);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].text, 'Get these announcements on your phone each week');
    assert.equal(linked[0].link, url, 'fragment intact');
    assert.equal(qr.qr, url, 'the QR is the same address');
    assert.ok(!c.slice(0, -1).some((item) => /on your phone/u.test(textOf(item))), 'and it is said once');
  });

  test('a heading is never left at the foot of a page without its text', async () => {
    const { api } = load();
    const doc = await api.build(parse(PREVIEW), { title: 'Example Ward', loadImage: async () => null });
    const headings = doc.content.filter((c) => c.headlineLevel);
    assert.equal(headings.map((h) => h.headlineLevel).join(), '3,2,3', 'every heading is marked for the rule');

    // pdfmake asks about each node with the nodes laid out around it, the page's footer among them.
    const footer = doc.footer(1, 2);
    assert.ok(doc.styles[footer.style], 'the footer is styled by the name the rule knows it by');
    const ask = (node, following, next) =>
      doc.pageBreakBefore(node, { getFollowingNodesOnPage: () => following, getNodesOnNextPage: () => next });
    const h3 = { headlineLevel: 3 };
    const h2 = { headlineLevel: 2 };
    const para = { text: 'body' };
    assert.equal(ask(h3, [footer], [para, footer]), true, 'alone above the footer, its text overleaf');
    assert.equal(ask(h2, [h3, footer], [para, footer]), true, 'a run of headings moves together');
    assert.equal(ask(h3, [para, footer], [para, footer]), false, 'its text starts on the same page');
    assert.equal(ask(h3, [footer], []), false, 'a heading that closes the document stays put');
    assert.equal(ask(para, [footer], [para, footer]), false, 'only headings move');
  });

  test('an empty preview still makes a document', async () => {
    const { api } = load();
    const doc = await api.build(
      parse('<div style="font-size:16px"><p><em>No current announcements.</em></p></div>'),
      { now: new Date(2026, 0, 4) },
    );
    assert.equal(textOf(doc.content[doc.content.length - 1]), 'No current announcements.');
    assert.equal(doc.content[doc.content.length - 1].text[0].italics, true);
  });

  test('download names the file after the title and the day', async () => {
    const { api, created } = load();
    const name = await api.download(parse('<div><p>x</p></div>'), {
      title: 'Ward Announcements',
      now: new Date(2026, 8, 27),
      loadImage: async () => null,
    });
    assert.equal(name, 'ward-announcements-2026-09-27.pdf');
    assert.equal(created.length, 1);
    assert.equal(textOf(created[0].content[created[0].content.length - 1]), 'x');
  });

  test('the date is the Sunday the handout is for, not the day it was exported', async () => {
    const { api, created } = load();
    const dated = async (now) => {
      const doc = await api.build(parse(PREVIEW), { title: 'Ward', now, loadImage: async () => null });
      return textOf(doc.content[1]);
    };
    assert.match(await dated(new Date(2026, 8, 24, 21)), /Sunday, September 27, 2026/u, 'a Thursday export');
    assert.match(await dated(new Date(2026, 8, 27, 23, 59)), /Sunday, September 27, 2026/u, 'on the Sunday itself');
    assert.match(await dated(new Date(2026, 8, 28)), /Sunday, October 4, 2026/u, 'Monday belongs to the next one');
    assert.match(await dated(new Date(2026, 11, 30)), /Sunday, January 3, 2027/u, 'across a year end');

    const name = await api.download(parse(PREVIEW), { title: 'Ward', now: new Date(2026, 8, 24), loadImage: async () => null });
    assert.equal(name, 'ward-2026-09-27.pdf', 'the file is named for the same day');
    assert.match(created[created.length - 1].info.title, /September 27, 2026/u);
  });

  test('parseStyle reads only what the preview writes', () => {
    const { api } = load();
    // Objects born in the vm have their own Object prototype; compare structure, not identity.
    const parseStyle = (v) => JSON.parse(JSON.stringify(api.parseStyle(v)));
    assert.deepEqual(parseStyle('text-align:center;margin-top:1.8em;margin-bottom:0.6em'), {
      align: 'center',
      marginTop: 1.8 * 11,
    });
    assert.deepEqual(parseStyle('font-size:17px;color:#1f3a5f'), {});
    assert.deepEqual(parseStyle(null), {});
  });
});
