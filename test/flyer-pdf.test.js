/**
 * The printable "get the app" flyer (`public/flyer-pdf.js`): the pdfmake document it builds for
 * each layout, what it fills in for a ward, the display-domain helper, and the file names. The
 * script runs verbatim in a `vm`, as in the browser; each layout is then handed to the real pdfmake
 * (the devDependency the browser copy is vendored from), so an SVG svg-to-pdfkit cannot draw fails
 * here rather than on a clerk's laptop.
 *
 * Node only, and deliberately in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../public/flyer-pdf.js', import.meta.url), 'utf8');
const FONTS = new URL('../node_modules/pdfmake/build/fonts/Roboto/', import.meta.url).pathname;

function load(extra = {}) {
  const window = { ...extra.window };
  const context = { window, console, ...extra.globals };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'flyer-pdf.js' });
  return window.FlyerPdf;
}

function matrix(link) {
  const m = QRCode.create(link, { errorCorrectionLevel: 'Q' }).modules;
  const rows = [];
  for (let r = 0; r < m.size; r++) {
    let row = '';
    for (let c = 0; c < m.size; c++) row += m.get(r, c) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

/** A value built in the `vm`, rebuilt in this realm so deepEqual compares contents, not prototypes. */
const plain = (x) => JSON.parse(JSON.stringify(x));

const LINK = 'https://example2nd.example.org/#code=abcd-efgh-jkmn-pqrs';
const WARD = { wardName: 'Example 2nd Ward', shortName: 'Example 2nd', link: LINK, qr: matrix(LINK) };

/** Every string drawn as text in an SVG, entities decoded. */
function textsOf(svg) {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) =>
    m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
  );
}

/** Rebuild the module matrix from the QR path's row runs (`M<x> <y>h<n>v1.02h-<n>z`). */
function qrFromSvg(svg, n) {
  const d = /<path d="(M[^"]*)" fill="#1c2b40"\/><\/g>/.exec(svg)?.[1];
  assert.ok(d, 'a QR path');
  const rows = Array.from({ length: n }, () => Array(n).fill('0'));
  for (const [, x, y, len] of d.matchAll(/M(\d+) (\d+)h(\d+)v1\.02h-\d+z/g)) {
    for (let i = 0; i < Number(len); i++) rows[Number(y)][Number(x) + i] = '1';
  }
  return rows.map((r) => r.join(''));
}

/** The pages' SVG nodes, without the font primer (see the test of it). */
const pages = (doc) => doc.content.filter((node) => node.svg);

async function render(doc) {
  const pdfmake = require('pdfmake');
  // The family the flyer's SVG names, as `registerFonts()` sets it up in the browser — here from
  // the files on disk, which Node's pdfkit can open by path.
  const family = { normal: FONTS + 'Roboto-Regular.ttf', bold: FONTS + 'Roboto-Medium.ttf', italics: FONTS + 'Roboto-Regular.ttf', bolditalics: FONTS + 'Roboto-Medium.ttf' };
  pdfmake.addFonts({ Roboto: family, FlyerRoboto: family });
  // Only the fonts above; nothing in the flyer may reach for a file or a URL.
  pdfmake.setLocalAccessPolicy((path) => path.startsWith(FONTS));
  pdfmake.setUrlAccessPolicy(() => false);
  return Buffer.from(await pdfmake.createPdf(structuredClone(doc)).getBuffer()).toString('latin1');
}

describe('the half-letter flyer', () => {
  const flyer = load();
  const doc = flyer.build(WARD, 'half');

  test('is two half-letter pages, iPhone then Android, each one SVG filling its page', () => {
    assert.deepEqual(plain(doc.pageSize), { width: 396, height: 612 });
    assert.deepEqual(plain(doc.pageMargins), [0, 0, 0, 0]);
    assert.equal(pages(doc).length, 2);
    assert.equal(pages(doc)[1].pageBreak, 'before');
    for (const node of pages(doc)) {
      assert.equal(node.width, 396);
      assert.equal(node.height, 612);
      assert.match(node.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="396" height="612" viewBox="0 0 139\.7 215\.9">/);
    }
    assert.ok(textsOf(pages(doc)[0].svg).includes('iPhone & iPad'));
    assert.ok(textsOf(pages(doc)[1].svg).includes('Android'));
  });

  test("carries the ward's name, home-screen name and domain, and no fixed placeholder", () => {
    for (const node of pages(doc)) {
      const texts = textsOf(node.svg);
      assert.ok(texts.includes('EXAMPLE 2ND WARD'), 'the ward in capitals on the masthead');
      assert.ok(texts.includes('example.org'), 'the display domain in the address-bar pictures');
      assert.doesNotMatch(node.svg, /oneward\.org/i, 'no fixed domain');
    }
    assert.ok(textsOf(pages(doc)[0].svg).includes('Example 2nd'), 'step 5 names the home-screen icon');
    const page1 = textsOf(pages(doc)[0].svg).join(' ');
    for (const words of ['Scan this code', "Open Safari's menu", 'Tap Share, then View More', 'Tap Add to Home Screen', 'Open the new icon and turn on notifications', 'iOS 27 (newest):']) {
      assert.ok(page1.includes(words), words);
    }
    const page2 = textsOf(pages(doc)[1].svg).join(' ');
    for (const words of ['Tap Enable Notifications, then Allow', 'Optional: add it to your home screen', 'If your phone warns that the app may be unsafe:', 'Install anyway']) {
      assert.ok(page2.includes(words), words);
    }
  });

  test('draws the QR code module for module, on both sides', () => {
    for (const node of pages(doc)) assert.deepEqual(qrFromSvg(node.svg, WARD.qr.length), WARD.qr);
  });

  test('escapes what a ward can type', () => {
    const odd = flyer.build({ ...WARD, wardName: 'Smith & <Jones> "Ward"', shortName: 'S&J' }, 'half');
    assert.ok(textsOf(pages(odd)[0].svg).includes('SMITH & <JONES> "WARD"'));
    assert.ok(textsOf(pages(odd)[0].svg).includes('S&J'));
    assert.doesNotMatch(pages(odd)[0].svg, /<JONES>|&(?!amp;|lt;|gt;|quot;)/);
  });

  test('a long name or domain is shrunk to its space rather than run past it', () => {
    const long = flyer.build(
      { ...WARD, wardName: 'Saint George Little Valley Twenty-Second Ward (Spanish)', link: 'https://ward-app.someone-long.workers.dev/#code=x' },
      'half',
    );
    const svg = pages(long)[0].svg;
    const name = /<text x="14\.4" y="33\.6" [^>]*font-size="([0-9.]+)"[^>]*letter-spacing="([0-9.]+)"[^>]*>([^<]*)</.exec(svg);
    assert.ok(name, 'the ward name line');
    const width = flyer.measure(name[3], Number(name[1]), true, Number(name[2]));
    assert.ok(width <= 125.7 - flyer.measure('iPhone & iPad', 5.2, true) - 6 - 14.4 + 0.01, `fits beside the platform tag (${width} mm)`);
    const bar = /<text x="96" y="72" font-size="([0-9.]+)"[^>]*>someone-long\.workers\.dev</.exec(svg);
    assert.ok(bar && Number(bar[1]) < 19, 'the address-bar domain is set smaller');
    assert.ok(flyer.measure('someone-long.workers.dev', Number(bar[1]), false) <= 112);
  });

  // Found in Chrome, invisible on Node: pdfmake's browser build cannot open a font for an SVG's
  // text until one of its own text nodes has set something in that weight — every <text> throws,
  // or the bold comes out regular.
  test('opens with an invisible dot in each weight, off the flow, so the SVG text finds its fonts', () => {
    const primer = doc.content[0];
    assert.ok(primer.absolutePosition, 'it takes no room');
    assert.equal(primer.color, '#ffffff');
    assert.equal(primer.font, 'FlyerRoboto', 'in the family the SVG text names');
    assert.ok(pages(doc).every((n) => !/font-family="(?!FlyerRoboto")/.test(n.svg)), 'and every <text> names it');
    assert.deepEqual(plain(primer.text.map((r) => [r.text, !!r.bold])), [['.', false], ['.', true]]);
  });

  test('pdfmake renders it as two 5½ × 8½ in pages', async () => {
    const pdf = await render(doc);
    assert.match(pdf, /\/Count 2\b/);
    assert.equal(pdf.match(/\/MediaBox \[0 0 396 612\]/g)?.length, 2);
  });
});

describe('the two-per-sheet flyer', () => {
  const flyer = load();
  const doc = flyer.build(WARD, 'two-up');

  test('is two portrait letter sheets, two copies of one side each, a quarter-turn round', () => {
    assert.deepEqual(plain(doc.pageSize), { width: 612, height: 792 });
    assert.equal(pages(doc).length, 2);
    const [front, back] = pages(doc).map((n) => n.svg);
    for (const svg of [front, back]) {
      assert.match(svg, /^<svg [^>]*width="612" height="792" viewBox="0 0 215\.9 279\.4">/);
      // Each copy's top at the sheet's right edge, one
      // above the other, and the cut marked across the middle at both edges.
      assert.equal(svg.match(/<g transform="translate\(215\.9 0\) rotate\(90\)">/g)?.length, 1);
      assert.equal(svg.match(/<g transform="translate\(215\.9 139\.7\) rotate\(90\)">/g)?.length, 1);
      assert.ok(svg.includes('<rect x="0" y="139.6" width="4" height="0.2" fill="#000000"/>'));
      assert.ok(svg.includes('<rect x="211.9" y="139.6" width="4" height="0.2" fill="#000000"/>'));
      assert.equal(textsOf(svg).filter((t) => t === 'EXAMPLE 2ND WARD').length, 2);
      assert.doesNotMatch(svg, /oneward\.org/i);
    }
    assert.equal(textsOf(front).filter((t) => t === 'iPhone & iPad').length, 2, 'the front is the iPhone side');
    assert.equal(textsOf(back).filter((t) => t === 'Android').length, 2, 'the back is the Android side');
    assert.deepEqual(qrFromSvg(front, WARD.qr.length), WARD.qr);
  });

  test('pdfmake renders it as two letter pages', async () => {
    const pdf = await render(doc);
    assert.match(pdf, /\/Count 2\b/);
    assert.equal(pdf.match(/\/MediaBox \[0 0 612 792\]/g)?.length, 2);
  });
});

describe('names', () => {
  const flyer = load();

  test('the file is named for the home-screen name', () => {
    assert.equal(flyer.fileName('Example 2nd', 'half'), 'example-2nd-flyer.pdf');
    assert.equal(flyer.fileName('Example 2nd', 'two-up'), 'example-2nd-flyer-2-per-sheet.pdf');
    assert.equal(flyer.fileName('  Élan!! ', 'half'), 'elan-flyer.pdf');
    assert.equal(flyer.fileName('', 'half'), 'ward-flyer.pdf');
  });

  test('the display domain is what Safari shows: the registrable domain', () => {
    const cases = {
      'yourward.oneward.org': 'oneward.org',
      'announcements.example.org': 'example.org',
      'example.org': 'example.org',
      'a.b.c.example.org': 'example.org',
      'ward-app.name.workers.dev': 'name.workers.dev',
      'name.workers.dev': 'name.workers.dev',
      'ward.pages.dev': 'ward.pages.dev',
      'ward.example.co.uk': 'example.co.uk',
      'news.ward.com.au': 'ward.com.au',
      'Ward.Example.ORG.': 'example.org',
      localhost: 'localhost',
      '127.0.0.1': '127.0.0.1',
      '[::1]': '[::1]',
      '': '',
    };
    for (const [host, shown] of Object.entries(cases)) assert.equal(flyer.displayDomain(host), shown, host);
  });

  test('the host is read off the share link without its port or fragment', () => {
    assert.equal(flyer.hostOf('https://example2nd.oneward.org/#code=a-b'), 'example2nd.oneward.org');
    assert.equal(flyer.hostOf('http://localhost:3000/#code=a'), 'localhost');
    assert.equal(flyer.hostOf('https://user@ward.example.org:8443/x'), 'ward.example.org');
    assert.equal(flyer.hostOf('not a link'), '');
  });
});

describe('text layout', () => {
  const flyer = load();

  test("the width table is Roboto's own", async () => {
    const fontkit = require('fontkit');
    for (const [file, bold] of [['Roboto-Regular.ttf', false], ['Roboto-Medium.ttf', true]]) {
      const font = fontkit.openSync(FONTS + file);
      for (const code of [...Array(95).keys()].map((i) => i + 0x20).concat([...Array(96).keys()].map((i) => i + 0xa0))) {
        const ch = String.fromCodePoint(code);
        const want = Math.round((font.glyphForCodePoint(code).advanceWidth * 1000) / font.unitsPerEm);
        assert.equal(flyer.measure(ch, 1000, bold), want, `${file} U+${code.toString(16)}`);
      }
    }
  });

  test('wrapped lines stay inside their width and keep every word, bold where asked', () => {
    const runs = [['Tap the '], ['Little Valley 22', true], [' icon on your home screen. Tap '], ['Enable Notifications', true], [', then '], ['Allow', true], [". That's it."]];
    const lines = flyer.wrap(runs, 3.5, 58);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      const width = line.reduce((w, r) => w + flyer.measure(r.text, 3.5, r.bold), 0);
      assert.ok(width <= 58, `line of ${width} mm`);
    }
    const joined = lines.map((l) => l.map((r) => r.text).join('')).join(' ');
    assert.equal(joined, runs.map((r) => r[0]).join(''));
    const bold = lines.flat().filter((r) => r.bold).map((r) => r.text.trim()).join('|');
    assert.match(bold, /Little( Valley 22|\|Valley 22)?/);
    assert.ok(bold.includes('Allow'));
  });
});

describe('fonts', () => {
  // The browser half of the font fix: the family is listed under the files' PostScript names,
  // which pdfkit can find once pdfmake has opened them, copied from the .ttf entries.
  test('registerFonts lists Roboto under its PostScript names, copied in the virtual file system', () => {
    const flyer = load();
    const storage = { 'Roboto-Regular.ttf': 'regular bytes', 'Roboto-Medium.ttf': 'medium bytes' };
    const added = [];
    const pdfMake = {
      virtualfs: {
        existsSync: (n) => n in storage,
        readFileSync: (n) => { if (!(n in storage)) throw new Error(`no ${n}`); return storage[n]; },
        writeFileSync: (n, data) => { storage[n] = data; },
      },
      addFonts: (fonts) => added.push(plain(fonts)),
    };
    assert.equal(flyer.registerFonts(pdfMake), pdfMake);
    assert.equal(storage['Roboto-Regular'], 'regular bytes');
    assert.equal(storage['Roboto-Medium'], 'medium bytes');
    assert.deepEqual(added, [{ FlyerRoboto: { normal: 'Roboto-Regular', bold: 'Roboto-Medium', italics: 'Roboto-Regular', bolditalics: 'Roboto-Medium' } }]);
    flyer.registerFonts(pdfMake); // a second press is harmless
    assert.equal(added.length, 2);
  });

  test("those names are the fonts' own PostScript names", () => {
    const fontkit = require('fontkit');
    assert.equal(fontkit.openSync(FONTS + 'Roboto-Regular.ttf').postscriptName, 'Roboto-Regular');
    assert.equal(fontkit.openSync(FONTS + 'Roboto-Medium.ttf').postscriptName, 'Roboto-Medium');
  });
});

describe('download', () => {
  test('fetches the details, loads pdfmake through the preview script, and names the file', async () => {
    const made = [];
    const fetched = [];
    const pdfMake = {
      createPdf: (doc) => ({ download: async (name) => made.push({ doc, name }) }),
      virtualfs: { existsSync: () => true },
      addFonts() {},
    };
    const flyer = load({
      window: { PreviewPdf: { ensurePdfMake: async () => pdfMake } },
      globals: {
        fetch: async (url) => {
          fetched.push(url);
          return { ok: true, redirected: false, json: async () => WARD };
        },
      },
    });
    const statuses = [];
    const name = await flyer.download('two-up', { onStatus: (s) => statuses.push(s) });
    assert.equal(name, 'example-2nd-flyer-2-per-sheet.pdf');
    assert.deepEqual(fetched, ['/admin/flyer.json']);
    assert.equal(made.length, 1);
    assert.equal(made[0].name, name);
    assert.deepEqual(plain(made[0].doc.pageSize), { width: 612, height: 792 });
    assert.ok(statuses.length >= 2, 'it says what is taking the time');
  });

  test('a signed-out dashboard (the fetch redirected to the login) fails rather than printing nothing', async () => {
    const flyer = load({
      window: { PreviewPdf: { ensurePdfMake: async () => ({ createPdf() { throw new Error('not reached'); } }) } },
      globals: { fetch: async () => ({ ok: true, redirected: true, json: async () => ({}) }) },
    });
    await assert.rejects(flyer.download('half'));
  });
});
