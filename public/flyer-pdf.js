/**
 * The printable "get the app" flyer on the Member Access card: a half-letter handout with the
 * iPhone steps on one side and the Android steps on the other, carrying the ward's own name,
 * home-screen name and member QR code. Built in the browser with pdfmake, like "Save as PDF" — and
 * from the same on-demand copy of it (`PreviewPdf.ensurePdfMake` in public/preview-pdf.js).
 *
 * Two layouts. **Half-letter**: two 5½ × 8½ in pages, for a printer that takes half sheets or a
 * PDF to pass on. **Two per sheet**: US Letter, two copies of a side per sheet with cut marks —
 * page 1 the iPhone side, page 2 the Android side — printed double-sided and cut across the middle.
 * Each copy is turned a quarter-turn on the portrait sheet, so both halves print the same way up
 * after the cut.
 *
 * Every page is one SVG drawn by pdfmake's `svg` node (svg-to-pdfkit), not pdfmake's flowing text:
 * the flyer is a fixed design whose every line has its place, and an SVG group is the only thing in
 * pdfmake that can be rotated for the two-per-sheet layout. The copy is still real, selectable text
 * in Roboto (the font pdfmake ships), wrapped here against Roboto's advance widths (`ADVANCE`) —
 * the one thing an SVG cannot do for itself. The QR code is drawn here too, from the module matrix
 * `/admin/flyer.json` sends: pdfmake's own `qr` node rounds its modules to whole points.
 *
 * The step pictures are the install illustrations in public/img/install/ (plus the app's own
 * Weekly Notifications card and Chrome's menu, drawn the same way), adapted and cropped for print;
 * the address-bar pictures show the ward's own domain
 * (`displayDomain`).
 *
 * DOM-free apart from the button wiring at the bottom, so `build()` runs verbatim in a `vm` — see
 * test/flyer-pdf.test.js.
 */
(function () {
  'use strict';

  var NAVY = '#1c2b40';
  var GOLD = '#c9ad74';
  var RED = '#c8102e';
  var MUTED = '#5a6672';
  var PANEL = '#eef2f6';
  // The SVG text's font family: Roboto (the font pdfmake ships) under a name of its own — see
  // `registerFonts()` for why the plain 'Roboto' cannot be used.
  var FONT = 'FlyerRoboto';
  var FONT_FILES = { normal: 'Roboto-Regular', bold: 'Roboto-Medium' }; // = each file's PostScript name
  // Half-letter and letter, in millimetres (the SVG's user unit) and points (pdfmake's).
  var HALF = { w: 139.7, h: 215.9, wPt: 396, hPt: 612 };
  var LETTER = { w: 215.9, h: 279.4, wPt: 612, hPt: 792 };

  // Roboto's advance widths in thousandths of an em — Regular, then Medium (pdfmake's "bold") —
  // for U+0020–U+007E followed by U+00A0–U+00FF. Read from the TTFs pdfmake ships with fontkit;
  // test/flyer-pdf.test.js re-reads them, so a pdfmake upgrade that changes the font fails there.
  /* eslint-disable max-len */
  var ADVANCE = {
    regular: [248, 258, 320, 616, 562, 732, 622, 175, 342, 348, 431, 567, 197, 276, 264, 413, 562, 562, 562, 562, 562, 562, 562, 562, 562, 562, 242, 211, 508, 549, 523, 473, 898, 652, 623, 651, 656, 568, 553, 681, 713, 272, 552, 627, 539, 873, 713, 688, 631, 688, 616, 594, 597, 648, 637, 887, 627, 601, 599, 265, 411, 265, 418, 451, 309, 544, 562, 523, 564, 530, 348, 562, 551, 243, 239, 507, 243, 877, 552, 570, 562, 568, 339, 516, 327, 551, 484, 751, 496, 473, 496, 338, 244, 338, 680,
      248, 244, 547, 582, 713, 525, 240, 613, 418, 786, 447, 469, 554, 276, 786, 458, 374, 535, 367, 367, 313, 567, 489, 261, 248, 367, 455, 469, 732, 776, 778, 474, 652, 652, 652, 652, 652, 652, 935, 651, 568, 568, 568, 568, 272, 272, 272, 272, 671, 713, 688, 688, 688, 688, 688, 534, 688, 648, 648, 648, 648, 601, 591, 595, 544, 544, 544, 544, 544, 544, 845, 523, 530, 530, 530, 530, 248, 248, 248, 248, 586, 552, 570, 570, 570, 570, 570, 571, 567, 551, 551, 551, 551, 473, 576, 473],
    bold: [249, 265, 319, 603, 568, 736, 641, 167, 346, 350, 443, 555, 224, 340, 278, 390, 568, 568, 568, 568, 568, 568, 568, 568, 568, 568, 264, 240, 509, 563, 520, 486, 897, 663, 631, 653, 653, 565, 551, 681, 709, 283, 556, 632, 540, 875, 709, 689, 638, 689, 629, 605, 609, 654, 646, 880, 631, 611, 603, 271, 417, 271, 429, 448, 320, 539, 562, 522, 563, 536, 353, 567, 556, 255, 251, 521, 255, 871, 557, 567, 562, 566, 354, 515, 333, 556, 496, 742, 503, 490, 503, 333, 249, 333, 663,
      249, 265, 563, 588, 702, 531, 246, 622, 446, 786, 445, 486, 552, 340, 786, 481, 382, 536, 370, 370, 322, 594, 489, 283, 259, 370, 457, 486, 724, 767, 795, 487, 663, 663, 663, 663, 663, 663, 937, 653, 565, 565, 565, 565, 283, 283, 283, 283, 667, 709, 689, 689, 689, 689, 689, 532, 688, 654, 654, 654, 654, 611, 601, 615, 539, 539, 539, 539, 539, 539, 845, 522, 536, 536, 536, 536, 261, 261, 261, 261, 580, 557, 567, 567, 567, 567, 567, 571, 565, 556, 556, 556, 556, 490, 571, 490],
  };
  /* eslint-enable max-len */

  function advance(ch, bold) {
    var table = bold ? ADVANCE.bold : ADVANCE.regular;
    var c = ch.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return table[c - 0x20];
    if (c >= 0xa0 && c <= 0xff) return table[95 + c - 0xa0];
    if (/[‘’]/.test(ch)) return table[7] + 20; // curly quotes, about an apostrophe
    // An accented letter outside Latin-1 measures as its base letter; anything else as a wide one,
    // so a guess errs towards wrapping early rather than running past the margin.
    var base = ch.normalize ? ch.normalize('NFD').charAt(0) : ch;
    if (base !== ch) return advance(base, bold);
    return 640;
  }

  /** Width in the units of `size`, as svg-to-pdfkit will set it (no kerning, so never short). */
  function measure(str, size, bold, spacing) {
    var w = 0;
    var chars = Array.from(String(str));
    for (var i = 0; i < chars.length; i++) w += advance(chars[i], bold);
    return (w / 1000) * size + (spacing || 0) * chars.length;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** A font size no larger than `size` at which `str` fits in `width`. */
  function fitSize(str, size, width, bold, spacing) {
    var w = measure(str, size, bold, spacing);
    return w <= width ? size : Math.floor(size * (width / w) * 100) / 100;
  }

  // ---------------------------------------------------------------------------------------------
  // Text

  /**
   * Break runs of text (`[[text, bold], …]`) into lines no wider than `width` at `size`, at spaces
   * only. Returns lines of runs, adjacent words of the same weight merged so a line is a few spans.
   */
  function wrap(runs, size, width) {
    var words = []; // { text, bold, space } — `space`: a space precedes it
    var pendingSpace = false;
    runs.forEach(function (run) {
      var parts = String(run[0]).split(/( +)/);
      parts.forEach(function (part) {
        if (!part) return;
        if (/^ +$/.test(part)) { pendingSpace = true; return; }
        var last = words[words.length - 1];
        if (last && !pendingSpace) last.pieces.push({ text: part, bold: !!run[1] }); // "Share" + "."
        else words.push({ pieces: [{ text: part, bold: !!run[1] }], space: pendingSpace && words.length > 0 });
        pendingSpace = false;
      });
    });
    var wordWidth = function (w) {
      return w.pieces.reduce(function (sum, p) { return sum + measure(p.text, size, p.bold); }, 0);
    };
    var lines = [];
    var line = [];
    var used = 0;
    words.forEach(function (w) {
      var space = line.length ? measure(' ', size, false) : 0;
      var need = wordWidth(w);
      if (line.length && used + space + need > width) {
        lines.push(line);
        line = [];
        used = 0;
        space = 0;
      }
      line.push(w);
      used += space + need;
    });
    if (line.length) lines.push(line);
    return lines.map(function (ws) {
      var out = [];
      ws.forEach(function (w, i) {
        w.pieces.forEach(function (p, j) {
          var text = (i > 0 && j === 0 ? ' ' : '') + p.text;
          var last = out[out.length - 1];
          if (last && last.bold === p.bold) last.text += text;
          else out.push({ text: text, bold: p.bold });
        });
      });
      return out;
    });
  }

  /**
   * One line of text. `content` is a string, or runs (`[{ text, bold }]`) from `wrap()`, which are
   * set as one `<text>` each at a measured x: svg-to-pdfkit misplaces a `<tspan>` that follows
   * text, and drops a run's leading space. `o`: fill, bold, anchor, spacing, and `heavy` — an
   * outline of that width in the fill colour. The design wants a heavy face, and
   * the heaviest Roboto pdfmake has is Medium, so a hairline of outline brings the title and the
   * headings back up to a poster weight (and keeps them strong on a copier).
   */
  function text(x, y, size, content, o) {
    o = o || {};
    if (typeof content !== 'string') {
      var at = x;
      return content
        .map(function (run) {
          var lead = /^ */.exec(run.text)[0];
          var start = at + measure(lead, size, run.bold);
          at += measure(run.text, size, run.bold);
          return text(round(start), y, size, run.text.slice(lead.length), Object.assign({}, o, { bold: run.bold }));
        })
        .join('');
    }
    return (
      '<text x="' + x + '" y="' + y + '" font-family="' + FONT + '" font-size="' + size + '"' +
      ' fill="' + (o.fill || NAVY) + '"' +
      (o.bold ? ' font-weight="bold"' : '') +
      (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') +
      (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '') +
      (o.heavy ? ' stroke="' + (o.fill || NAVY) + '" stroke-width="' + o.heavy + '" stroke-linejoin="round"' : '') +
      '>' + esc(content) + '</text>'
    );
  }

  /** A wrapped paragraph whose first baseline is `y`. */
  function para(x, y, size, width, runs, o) {
    o = o || {};
    var leading = size * (o.lineHeight || 1.4);
    return wrap(runs, size, width)
      .map(function (line, i) { return text(x, Math.round((y + i * leading) * 100) / 100, size, line, o); })
      .join('');
  }

  // ---------------------------------------------------------------------------------------------
  // The pieces every page shares

  var DEFS =
    '<defs>' +
    '<marker id="arrow-red" markerWidth="3.2" markerHeight="3.6" refX="2" refY="1.8" orient="auto">' +
    '<path d="M0 0 L3 1.8 L0 3.6 Z" fill="' + RED + '"/></marker>' +
    '<clipPath id="clip-share-top"><rect x="0" y="0" width="320" height="64"/></clipPath>' +
    '<clipPath id="clip-add-home"><rect x="0" y="108" width="320" height="102"/></clipPath>' +
    '</defs>';

  /** The navy masthead: title, the ward's name in gold capitals, and which phones the side is for. */
  function masthead(wardName, platform) {
    var platformSize = 5.2;
    var platformLeft = 125.7 - measure(platform, platformSize, true);
    // The ward's name gets what the platform tag leaves. A long one first loses some letter-spacing,
    // then shrinks; a typical name ("EXAMPLE 2ND WARD") is nowhere near either.
    var name = String(wardName || '').toUpperCase();
    var room = platformLeft - 6 - 14.4;
    var size = 3.4;
    var spacing = 1.2;
    if (measure(name, size, true, spacing) > room) {
      spacing = 0.6;
      size = fitSize(name, size, room, true, spacing);
      spacing = Math.round(spacing * (size / 3.4) * 100) / 100;
    }
    return (
      '<rect x="8" y="8" width="123.7" height="30" fill="' + NAVY + '"/>' +
      '<rect x="8" y="38" width="123.7" height="0.6" fill="' + GOLD + '"/>' +
      text(14, 17.6, 7, 'Ward Announcements &', { bold: true, heavy: 0.14, fill: '#ffffff' }) +
      text(14, 25.6, 7, 'Sacrament Meeting Program', { bold: true, heavy: 0.14, fill: '#ffffff' }) +
      text(14.4, 33.6, size, name, { bold: true, fill: GOLD, spacing: spacing }) +
      text(125.7, 33.8, platformSize, platform, { bold: true, heavy: 0.1, fill: '#ffffff', anchor: 'end' })
    );
  }

  /** A numbered step: the navy disc (an outline for an optional step), heading, and body copy. */
  function step(n, cy, heading, copy, copyWidth, opts) {
    opts = opts || {};
    var badge = opts.optional
      ? '<circle cx="18.3" cy="' + cy + '" r="4.3" fill="none" stroke="' + NAVY + '" stroke-width="0.6"/>'
      : '<circle cx="18.3" cy="' + cy + '" r="4.3" fill="' + NAVY + '"/>';
    return (
      badge +
      text(18.3, round(cy + 1.6), 4.6, String(n), { bold: true, heavy: 0.08, fill: opts.optional ? NAVY : '#ffffff', anchor: 'middle' }) +
      text(26, round(cy + 1.5), 4.4, heading, { bold: true, heavy: 0.08 }) +
      para(26, round(cy + (opts.copyGap || 8)), 3.5, copyWidth, copy)
    );
  }

  function round(n) { return Math.round(n * 100) / 100; }

  /**
   * The QR code, from the rows of the module matrix ('1' dark), in a `box`-mm square that includes
   * a two-module quiet zone — 31 mm, large enough to scan from arm's length. One path of row runs; each run overlaps the row
   * below by a hair so no PDF viewer draws seams between them.
   */
  function qrCode(rows, x, y, box) {
    var n = rows.length;
    if (!n) return '';
    var m = box / (n + 4);
    var d = '';
    rows.forEach(function (row, r) {
      var re = /1+/g;
      var run;
      while ((run = re.exec(row))) d += 'M' + run.index + ' ' + r + 'h' + run[0].length + 'v1.02h-' + run[0].length + 'z';
    });
    return (
      '<rect x="' + x + '" y="' + y + '" width="' + box + '" height="' + box + '" fill="#ffffff"/>' +
      '<g transform="translate(' + round(x + 2 * m) + ' ' + round(y + 2 * m) + ') scale(' + m.toFixed(5) + ')">' +
      '<path d="' + d + '" fill="' + NAVY + '"/></g>'
    );
  }

  /** The domain in an address-bar picture, shrunk to fit its pill when it is long. */
  function domainText(domain, x, y, room) {
    var size = fitSize(domain, 19, room, false);
    return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="#3c3c43" font-family="' + FONT + '">' + esc(domain) + '</text>';
  }

  function arrow(x1, y1, x2, y2) {
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + RED + '" stroke-width="5" marker-end="url(#arrow-red)"/>';
  }

  function label(x, y, size, str, extra) {
    return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="#1c1c1e" font-family="' + FONT + '"' + (extra ? ' ' + extra : '') + '>' + esc(str) + '</text>';
  }

  // ---------------------------------------------------------------------------------------------
  // Pictures (drawn at the install illustrations' own 320-wide scale, placed with a transform)

  /** Safari's bottom bar: back, the address pill, and either the iOS 27 page menu or iOS 26's ••• . */
  function safariBar(domain, ios27) {
    var reload =
      '<g transform="translate(213,55) scale(0.82)" fill="none" stroke="#8e8e93" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1 -2.12 -9.36 L23 10"/></g>';
    var lines = ios27
      ? '<g stroke="#1c1c1e" stroke-width="2.6" stroke-linecap="round"><line x1="70" y1="60" x2="82" y2="60"/><line x1="70" y1="66" x2="82" y2="66"/><line x1="70" y1="72" x2="78" y2="72"/></g>'
      : '<g stroke="#8e8e93" stroke-width="2" stroke-linecap="round"><line x1="70" y1="60" x2="82" y2="60"/><line x1="70" y1="66" x2="82" y2="66"/><line x1="70" y1="72" x2="78" y2="72"/></g>';
    var right = ios27
      ? '<g stroke="#1c1c1e" stroke-width="2.2" stroke-linejoin="round"><rect x="269" y="57" width="14" height="14" rx="4" fill="#ededf0"/><rect x="275" y="63" width="14" height="14" rx="4" fill="#ededf0"/></g>'
      : '<circle cx="268" cy="66" r="3.2" fill="#3a3a3c"/><circle cx="278" cy="66" r="3.2" fill="#3a3a3c"/><circle cx="288" cy="66" r="3.2" fill="#3a3a3c"/>';
    return (
      '<rect x="8" y="46" width="40" height="40" rx="20" fill="#ededf0"/>' +
      '<path d="M31 58 L23 66 L31 74" stroke="#1c1c1e" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<rect x="54" y="46" width="194" height="40" rx="20" fill="#ededf0"/>' +
      lines +
      domainText(domain, 96, 72, 112) +
      reload +
      '<rect x="256" y="46" width="44" height="40" rx="20" fill="#ededf0"/>' +
      right +
      (ios27 ? arrow(143, 8, 84, 50) : arrow(315, 12, 288, 52))
    );
  }

  /** The top of iOS's page menu — the Share row — cropped (ios-26-share-2.svg). */
  function shareRow() {
    return (
      '<g clip-path="url(#clip-share-top)">' +
      '<rect x="96" y="8" width="216" height="284" rx="16" fill="#fbfbfd" stroke="#e6e6ea" stroke-width="1.5"/>' +
      '<path d="M124 46 V34 M120 38 L124 33.5 L128 38" stroke="#1c1c1e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<path d="M119 43 V49 H129 V43" stroke="#1c1c1e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      label(150, 46, 17, 'Share') +
      arrow(290, 8, 214, 40) +
      '</g>'
    );
  }

  /** The share sheet's row of actions ending in View More (ios-26-share-3.svg). */
  function viewMoreRow() {
    var c = function (cx) { return '<circle cx="' + cx + '" cy="36" r="20" fill="#eef0f3"/>'; };
    var l = function (x, y, s) { return label(x, y, 12, s, 'text-anchor="middle"'); };
    return (
      c(44) +
      '<rect x="38" y="29" width="10" height="12" rx="2" fill="none" stroke="#1c1c1e" stroke-width="1.6"/>' +
      '<rect x="42" y="33" width="10" height="12" rx="2" fill="#eef0f3" stroke="#1c1c1e" stroke-width="1.6"/>' +
      l(44, 74, 'Copy') +
      c(120) +
      '<path d="M115 28 V45 L120 41 L125 45 V28 Z" fill="none" stroke="#1c1c1e" stroke-width="1.6" stroke-linejoin="round"/>' +
      l(120, 74, 'Add to') + l(120, 88, 'Bookmarks') +
      c(196) +
      '<circle cx="191" cy="37" r="4" fill="none" stroke="#1c1c1e" stroke-width="1.6"/><circle cx="201" cy="37" r="4" fill="none" stroke="#1c1c1e" stroke-width="1.6"/>' +
      '<line x1="195" y1="37" x2="197" y2="37" stroke="#1c1c1e" stroke-width="1.6"/>' +
      l(196, 74, 'Add to') + l(196, 88, 'Reading List') +
      c(272) +
      '<path d="M266 33 L272 39 L278 33" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      l(272, 74, 'View More') +
      arrow(316, 0, 285, 20)
    );
  }

  /** Find on Page / Add to Home Screen, cropped from the bottom of the list (ios-26-share-4.svg). */
  function addToHomeRow() {
    return (
      '<g clip-path="url(#clip-add-home)">' +
      '<rect x="6" y="6" width="308" height="198" rx="18" fill="#fff" stroke="#e6e6ea" stroke-width="2"/>' +
      '<line x1="50" y1="153" x2="314" y2="153" stroke="#ececec" stroke-width="1.5"/>' +
      '<rect x="18" y="118" width="15" height="20" rx="2" fill="none" stroke="#1c1c1e" stroke-width="2"/>' +
      '<line x1="22" y1="124" x2="29" y2="124" stroke="#1c1c1e" stroke-width="1.6" stroke-linecap="round"/>' +
      '<line x1="22" y1="128" x2="29" y2="128" stroke="#1c1c1e" stroke-width="1.6" stroke-linecap="round"/>' +
      '<circle cx="31" cy="134" r="5.5" fill="#fff" stroke="#1c1c1e" stroke-width="2"/>' +
      '<line x1="35.5" y1="138.5" x2="39" y2="142" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round"/>' +
      label(58, 134, 18, 'Find on Page') +
      '<rect x="17" y="167" width="22" height="22" rx="5" fill="none" stroke="#1c1c1e" stroke-width="2"/>' +
      '<line x1="28" y1="172" x2="28" y2="184" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round"/>' +
      '<line x1="22" y1="178" x2="34" y2="178" stroke="#1c1c1e" stroke-width="2" stroke-linecap="round"/>' +
      label(58, 184, 18, 'Add to Home Screen') +
      arrow(290, 114, 248, 168) +
      '</g>'
    );
  }

  /** The app's own Weekly Notifications card, as a member sees it before subscribing. */
  function notificationsCard() {
    return (
      '<rect x="4" y="4" width="312" height="132" rx="14" fill="#ffffff" stroke="#d9dee5" stroke-width="2"/>' +
      label(22, 40, 19, 'Weekly Notifications', 'font-weight="bold"') +
      '<text x="22" y="64" font-size="14" fill="#6b7280" font-family="' + FONT + '">One notification each Sunday.</text>' +
      '<rect x="22" y="82" width="176" height="38" rx="9" fill="' + NAVY + '"/>' +
      '<text x="110" y="107" font-size="17" font-weight="bold" fill="#ffffff" text-anchor="middle" font-family="' + FONT + '">Enable Notifications</text>' +
      arrow(300, 30, 226, 92)
    );
  }

  /** Chrome on Android: the address bar, its ⋮ and the menu with Add to Home screen. */
  function chromeMenu(domain) {
    var item = function (y, s) { return label(138, y, 16, s); };
    return (
      '<rect x="4" y="4" width="312" height="44" rx="22" fill="#ededf0"/>' +
      domainText(domain, 24, 33, 250) +
      '<circle cx="292" cy="19" r="3.2" fill="#3a3a3c"/><circle cx="292" cy="26" r="3.2" fill="#3a3a3c"/><circle cx="292" cy="33" r="3.2" fill="#3a3a3c"/>' +
      '<rect x="120" y="60" width="196" height="120" rx="12" fill="#ffffff" stroke="#d9dee5" stroke-width="2"/>' +
      item(88, 'New tab') + item(116, 'Bookmarks') + item(144, 'Add to Home screen') + item(170, 'Settings') +
      arrow(60, 176, 126, 146) +
      arrow(250, -6, 286, 8)
    );
  }

  function picture(x, y, scale, body) {
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' + body + '</g>';
  }

  // ---------------------------------------------------------------------------------------------
  // The two sides, each drawn on a 139.7 × 215.9 mm page

  function iphoneSide(d) {
    return (
      masthead(d.wardName, 'iPhone & iPad') +
      para(14, 46, 3.5, 117, [['Follow these steps to get the program and announcements on your iPhone or iPad, plus a Sunday morning notification when they change.']]) +
      text(14, 57.2, 3.1, 'Have an Android device? The steps are on the other side.', { fill: MUTED }) +

      step(1, 66, 'Scan this code', [["Open your phone's Camera and point it at the square. Tap the yellow link that pops up. The page opens in Safari."]], 62) +
      qrCode(d.qr, 97.7, 61.5, 31) +

      step(2, 97.5, "Open Safari's menu", [['Tap whichever of these buttons your iPhone shows:']], 104) +
      picture(14, 106.1, 0.1719, safariBar(d.domain, true)) +
      para(14, 125.6, 3.1, 55, [['iOS 27 (newest):', true], [' tap the lines at the left of the address bar.']], { lineHeight: 1.35 }) +
      picture(76.7, 106.1, 0.1719, safariBar(d.domain, false)) +
      para(76.7, 125.6, 3.1, 55, [['iOS 26:', true], [' tap the three dots at the bottom right.']], { lineHeight: 1.35 }) +

      step(3, 139.6, 'Tap Share, then View More', [['Tap '], ['Share', true], ['. On the sheet that slides up, tap '], ['View More', true], ['.']], 58) +
      picture(88.7, 135.1, 0.1344, shareRow()) +
      picture(88.7, 146.1, 0.1344, viewMoreRow()) +

      step(4, 165.1, 'Tap Add to Home Screen', [['Tap it in the list, then tap '], ['Add', true], [' in the top corner. A new icon appears on your home screen.']], 58) +
      picture(88.7, 147.1, 0.1344, addToHomeRow()) +

      step(5, 191.6, 'Open the new icon and turn on notifications', [['Tap the '], [d.shortName, true], [' icon on your home screen. Tap '], ['Enable Notifications', true], [', then '], ['Allow', true], [". That's it."]], 104)
    );
  }

  function androidSide(d) {
    return (
      masthead(d.wardName, 'Android') +
      '<rect x="8" y="182.5" width="123.7" height="19.5" rx="1.5" fill="' + PANEL + '"/>' +
      para(14, 47, 3.5, 117, [['Follow these steps to get the program and announcements on your Android device, plus a Sunday morning notification when they change.']]) +
      text(14, 57.2, 3.1, 'Have an iPhone or iPad? The steps are on the other side.', { fill: MUTED }) +

      step(1, 69, 'Scan this code', [["Open your phone's Camera and point it at the square. Tap the link that pops up. The page opens in your browser."]], 62) +
      qrCode(d.qr, 97.7, 64.5, 31) +

      step(2, 107, 'Tap Enable Notifications, then Allow', [['Near the top of the page is a box called '], ['Weekly Notifications', true], ['. Tap its blue '], ['Enable Notifications', true], [' button, then tap '], ['Allow', true], [" when your phone asks. That's it."]], 58) +
      picture(88.7, 110.5, 0.1344, notificationsCard()) +

      step(3, 148, 'Optional: add it to your home screen', [['Handy for finding it again. Tap the three dots at the top right of your browser, choose '], ['Add to Home screen', true], [' (it may say '], ['Install app', true], ['), then '], ['Install', true], ['.']], 58, { optional: true }) +
      picture(88.7, 149.5, 0.1344, chromeMenu(d.domain)) +

      para(13, 189, 3.1, 114, [['If your phone warns that the app may be unsafe:', true], [' try updating Chrome from the Play Store, then add the app again. If the warning still appears, tap '], ['More details', true], [', then '], ['Install anyway', true], ['.']])
    );
  }

  function svgDoc(wPt, hPt, wMm, hMm, body) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + wPt + '" height="' + hPt + '" viewBox="0 0 ' + wMm + ' ' + hMm + '">' +
      DEFS + '<rect x="0" y="0" width="' + wMm + '" height="' + hMm + '" fill="#ffffff"/>' + body + '</svg>'
    );
  }

  /**
   * One letter sheet holding two copies of a side, each turned a quarter-turn clockwise (its top at
   * the sheet's right edge), one above the other, with the cut marked at both edges.
   */
  function twoUp(side) {
    var copy = function (dy) { return '<g transform="translate(' + HALF.h + ' ' + dy + ') rotate(90)">' + side + '</g>'; };
    var mid = LETTER.h / 2;
    return svgDoc(
      LETTER.wPt, LETTER.hPt, LETTER.w, LETTER.h,
      copy(0) + copy(HALF.w) +
      '<rect x="0" y="' + round(mid - 0.1) + '" width="4" height="0.2" fill="#000000"/>' +
      '<rect x="' + round(LETTER.w - 4) + '" y="' + round(mid - 0.1) + '" width="4" height="0.2" fill="#000000"/>'
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Names

  // Registries under which anyone can have a name, so the name a browser shows is one label deeper.
  // A short hand-kept list rather than the Public Suffix List (~250 KB): it covers the hosts a ward
  // deploys to (workers.dev, pages.dev) and the commonest two-level country suffixes. A host under a
  // suffix not listed here shows one label too few — `ward.example.co.xx` as `co.xx` — which is
  // only a picture on a flyer, and wrong in a way a reader still recognises.
  var MULTI_LABEL_SUFFIXES = [
    'workers.dev', 'pages.dev', 'github.io', 'netlify.app', 'vercel.app', 'onrender.com', 'fly.dev',
    'herokuapp.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'blogspot.com',
    'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'net.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
    'co.nz', 'org.nz', 'net.nz', 'school.nz', 'govt.nz',
    'co.za', 'org.za', 'com.br', 'net.br', 'org.br', 'com.mx', 'org.mx', 'com.ar', 'com.pe', 'com.co',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'co.kr', 'or.kr', 'com.tw', 'org.tw', 'com.hk', 'org.hk',
    'com.sg', 'org.sg', 'com.ph', 'org.ph', 'com.my', 'co.in', 'org.in', 'co.id', 'or.id', 'co.th',
  ];

  /**
   * What Safari's address bar shows for a host: its registrable domain ("eTLD+1") —
   * `yourward.oneward.org` → `oneward.org`, `ward-app.name.workers.dev` → `name.workers.dev`.
   * An approximation (see MULTI_LABEL_SUFFIXES). An address, `localhost` or a bare name is shown
   * as it is.
   */
  function displayDomain(host) {
    host = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!host || host.indexOf('.') < 0 || host.indexOf(':') >= 0 || /^[0-9.]+$/.test(host)) return host;
    var labels = host.split('.');
    var keep = 2;
    MULTI_LABEL_SUFFIXES.forEach(function (suffix) {
      if (host === suffix || host.slice(-(suffix.length + 1)) === '.' + suffix) {
        keep = Math.max(keep, suffix.split('.').length + 1);
      }
    });
    return labels.slice(-keep).join('.');
  }

  /** The host of an absolute link, without a port or credentials. */
  function hostOf(link) {
    var m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(String(link || ''));
    return m ? m[1] : '';
  }

  function slug(name) {
    var plain = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // é → e
    return plain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ward';
  }

  /** `<home-screen-name>-flyer.pdf`, or `…-flyer-2-per-sheet.pdf` for the two-per-sheet layout. */
  function fileName(shortName, layout) {
    return slug(shortName) + '-flyer' + (layout === 'two-up' ? '-2-per-sheet' : '') + '.pdf';
  }

  // ---------------------------------------------------------------------------------------------
  // The document

  /**
   * The pdfmake document. `data` is `/admin/flyer.json`: `wardName`, `shortName`, `link` and `qr`
   * (the module matrix as strings of 0 and 1). `layout` is 'half' (default) or 'two-up'.
   */
  function build(data, layout) {
    var d = {
      wardName: data.wardName || '',
      shortName: data.shortName || data.wardName || '',
      qr: data.qr || [],
      domain: displayDomain(hostOf(data.link)),
    };
    var sides = [iphoneSide(d), androidSide(d)];
    var twoPerSheet = layout === 'two-up';
    var page = twoPerSheet ? LETTER : HALF;
    var content = sides.map(function (side, i) {
      var svg = twoPerSheet ? twoUp(side) : svgDoc(HALF.wPt, HALF.hPt, HALF.w, HALF.h, side);
      var node = { svg: svg, width: page.wPt, height: page.hPt };
      if (i > 0) node.pageBreak = 'before';
      return node;
    });
    // The SVG text finds its fonts only once pdfmake has opened them for text of its own (see
    // `registerFonts()`), so the document starts with a dot in each weight: white, 1 pt, in the
    // corner of the sheet, out of the flow. Not a space — pdfmake trims that before it needs a font.
    content.unshift({ text: [{ text: '.' }, { text: '.', bold: true }], font: FONT, fontSize: 1, color: '#ffffff', absolutePosition: { x: 0, y: 0 } });
    return {
      pageSize: { width: page.wPt, height: page.hPt },
      pageMargins: [0, 0, 0, 0],
      info: { title: (d.wardName ? d.wardName + ' — ' : '') + 'get the app' },
      defaultStyle: { font: FONT },
      content: content,
    };
  }

  /**
   * Fetch the ward's details, build, and hand the browser the file. Resolves with the file name.
   * `opts.onStatus(text)` is told what is taking the time (pdfmake is a few MB the first time).
   */
  /**
   * Make Roboto reachable from an SVG's text in pdfmake's browser build.
   *
   * svg-to-pdfkit asks for a font by the file name in pdfmake's font table (`Roboto-Medium.ttf`)
   * and pdfkit opens that name through its *own* browser file system, which holds none of
   * pdfmake's fonts. The open fails quietly and the text is set in whatever font pdfmake used last
   * — or, when it has used none, throws "Cannot read properties of null (reading 'encode')". Node
   * reads the file from disk, so only a browser shows it.
   *
   * pdfkit does find a font it has already opened, by the font's PostScript name. So the family
   * the SVG names, FlyerRoboto, lists its files under exactly those names (`Roboto-Medium`), copied
   * in pdfmake's virtual file system from the `.ttf` entries vfs_fonts.js installed; `build()`
   * then has pdfmake open both weights before any SVG is drawn.
   */
  function registerFonts(pdfMake) {
    var vfs = pdfMake.virtualfs;
    Object.keys(FONT_FILES).forEach(function (weight) {
      var name = FONT_FILES[weight];
      if (!vfs.existsSync(name)) vfs.writeFileSync(name, vfs.readFileSync(name + '.ttf'));
    });
    var family = {};
    family[FONT] = { normal: FONT_FILES.normal, bold: FONT_FILES.bold, italics: FONT_FILES.normal, bolditalics: FONT_FILES.bold };
    pdfMake.addFonts(family);
    return pdfMake;
  }

  function download(layout, opts) {
    opts = opts || {};
    var status = opts.onStatus || function () {};
    var loader = window.PreviewPdf && window.PreviewPdf.ensurePdfMake;
    if (!loader) return Promise.reject(new Error('the PDF tools are still loading'));
    var fresh = !(window.pdfMake && window.pdfMake.createPdf);
    status(fresh ? 'Downloading the PDF tools (a few MB, first time only)…' : 'Preparing the flyer…');
    var details = fetch('/admin/flyer.json', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok || r.redirected) throw new Error('flyer details ' + r.status); return r.json(); });
    return Promise.all([details, loader()]).then(function (got) {
      status('Building the flyer…');
      var name = fileName(got[0].shortName, layout);
      var pdfMake = registerFonts(got[1]);
      return Promise.resolve(pdfMake.createPdf(build(got[0], layout)).download(name)).then(function () { return name; });
    });
  }

  window.FlyerPdf = {
    build: build,
    download: download,
    displayDomain: displayDomain,
    hostOf: hostOf,
    fileName: fileName,
    registerFonts: registerFonts,
    FONT: FONT,
    wrap: wrap,
    measure: measure,
  };

  // The Member Access card's buttons (`flyerButtons()` in src/views.ts).
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-flyer-pdf]');
      if (!btn) return;
      var bar = btn.closest('[data-flyer]');
      var statusEl = bar && bar.querySelector('[data-flyer-status]');
      var spinner = bar && bar.querySelector('[data-flyer-spinner]');
      var say = function (msg, sticky) {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.hidden = false;
        if (spinner) spinner.hidden = !sticky;
        clearTimeout(statusEl._t);
        if (!sticky) statusEl._t = setTimeout(function () { statusEl.hidden = true; }, 4000);
      };
      var buttons = bar ? bar.querySelectorAll('[data-flyer-pdf]') : [btn];
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
      download(btn.getAttribute('data-flyer-pdf'), { onStatus: function (msg) { say(msg, true); } })
        .then(function (name) { say('Saved ' + name + '.'); })
        .catch(function () { say('Could not make the flyer — reload the page and try again.'); })
        .then(function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
    });
  }
})();
