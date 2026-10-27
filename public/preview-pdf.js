/**
 * "Save as PDF" for the announcements preview (the dashboard modal and /admin/announcements/preview).
 *
 * Walks the preview's DOM — markdown-it's sanitized output with the inline styles `richPreviewHtml()`
 * put on it — and builds a pdfmake document definition from it: real, selectable text laid out by
 * pdfmake rather than a screenshot of the page. pdfmake itself (~1.9 MB with its Roboto fonts, in
 * public/vendor/pdfmake/) is loaded the first time the button is pressed, never with the page.
 *
 * Only the markup the preview can contain is understood: headings, paragraphs (centered or with a
 * gap above), emphasis, links, inline code, lists, block quotes, rules, tables and images. Anything
 * else falls through as its text. Images are fetched from `/images/:key` and re-encoded through a
 * canvas because pdfmake takes only JPEG and PNG, and an upload may be WebP or GIF.
 *
 * Emoji get a second font. pdfmake's Roboto has none and pdfmake has no font fallback, so a 👋
 * would print as a box; each emoji sequence becomes its own run set in Noto Emoji (monochrome,
 * OFL, a WOFF subset in public/vendor/noto-emoji/, ~570 KB, fetched with pdfmake). If that font
 * cannot be had the emoji are stripped instead — a missing wave beats a row of boxes.
 *
 * Kept dependency-free and DOM-only (nodeName / childNodes / getAttribute / nodeValue), so the
 * converter runs verbatim in a `vm` against a stub tree — see test/preview-pdf.test.js.
 */
(function () {
  'use strict';

  var VENDOR = ['/vendor/pdfmake/pdfmake.min.js', '/vendor/pdfmake/vfs_fonts.js'];
  var EMOJI_FONT_URL = '/vendor/noto-emoji/NotoEmoji-Regular.woff';
  var EMOJI_FONT = 'NotoEmoji';
  var NAVY = '#1f3a5f';
  var PAGE = { size: 'LETTER', margins: [54, 56, 54, 56] }; // points; 3/4" sides
  var CONTENT_WIDTH = 612 - PAGE.margins[0] - PAGE.margins[2];
  var IMAGE_BOX = [CONTENT_WIDTH, 260]; // points; the most room an image is given on the page
  var IMAGE_PX_PER_PT = 4; // 288 dpi at the printed size, so a flyer's small text survives zooming in
  var HEADING_SIZE = { H1: 18, H2: 16, H3: 14, H4: 12, H5: 11, H6: 11 };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  var loading = null;
  function ensurePdfMake() {
    if (window.pdfMake && window.pdfMake.createPdf) return Promise.resolve(window.pdfMake);
    if (!loading) {
      // vfs_fonts.js registers itself with pdfMake, so the order matters.
      loading = loadScript(VENDOR[0])
        .then(function () { return loadScript(VENDOR[1]); })
        .then(function () { return window.pdfMake; })
        .catch(function (err) { loading = null; throw err; });
    }
    return loading;
  }

  function base64Of(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  /**
   * Register the emoji font with pdfmake. Resolves true when it is available, false when the fetch
   * failed (the caller then strips emoji); never rejects. Fetched by hand rather than through
   * pdfmake's own URL resolver so a failure is survivable and reported.
   */
  var emojiFont = null;
  function ensureEmojiFont(pdfMake) {
    if (!emojiFont) {
      emojiFont = fetch(EMOJI_FONT_URL, { credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error('font ' + r.status); return r.arrayBuffer(); })
        .then(function (buf) {
          var vfs = {};
          vfs['NotoEmoji.woff'] = base64Of(new Uint8Array(buf));
          pdfMake.addVirtualFileSystem(vfs);
          var fonts = {};
          fonts[EMOJI_FONT] = { normal: 'NotoEmoji.woff', bold: 'NotoEmoji.woff', italics: 'NotoEmoji.woff', bolditalics: 'NotoEmoji.woff' };
          pdfMake.addFonts(fonts);
          return true;
        })
        .catch(function () { emojiFont = null; return false; });
    }
    return emojiFont;
  }

  /** The handful of inline properties the preview writes, from a `style=""` attribute. */
  function parseStyle(attr) {
    var out = {};
    String(attr || '').split(';').forEach(function (decl) {
      var i = decl.indexOf(':');
      if (i < 0) return;
      var name = decl.slice(0, i).trim().toLowerCase();
      var value = decl.slice(i + 1).trim();
      if (name === 'text-align') out.align = value;
      else if (name === 'margin-top') {
        var m = /^([0-9.]+)(em|px)?$/.exec(value);
        if (m) out.marginTop = Number(m[1]) * (m[2] === 'px' ? 0.75 : 11);
      }
    });
    return out;
  }

  function isElement(node) { return node.nodeType === 1; }
  function isText(node) { return node.nodeType === 3; }
  function children(node) { return Array.prototype.slice.call(node.childNodes || []); }
  function attr(node, name) { return node.getAttribute ? node.getAttribute(name) : null; }

  // An emoji sequence: a pictograph or a regional-indicator letter (flags), then any run of
  // joiners, variation selectors, skin tones, keycaps and further pictographs — one match per
  // *cluster of adjacent emoji*, so a ZWJ family or a "🍲🥧" pair stays one run and the font's
  // ligature shaping still sees the whole sequence. Excludes the four "pictographic" characters
  // Roboto does carry (© ® ‼ ™; checked against its cmap), which an announcement may well use.
  // `u` and property escapes are ES2018 — every browser that can install this app has them.
  var EMOJI_START = '(?:(?![\\u00A9\\u00AE\\u203C\\u2122])\\p{Extended_Pictographic}|[\\u{1F1E6}-\\u{1F1FF}])';
  var EMOJI_MORE = '(?:[\\uFE0F\\u200D\\u20E3]|[\\u{1F3FB}-\\u{1F3FF}]|\\p{Extended_Pictographic}|[\\u{1F1E6}-\\u{1F1FF}])*';
  var EMOJI = new RegExp(EMOJI_START + EMOJI_MORE, 'gu');
  // Joiners and selectors left on their own (a "©️", a keycap "1️⃣") — nothing in either font.
  var STRAY = /[\uFE0F\u200D\u20E3]/g;

  /**
   * Split a text node into runs: plain text in the default font, each emoji cluster in the emoji
   * font — or dropped, when `fmt.emojiFont` is null because the font could not be loaded.
   */
  function textRuns(text, fmt, out) {
    if (!fmt.emojiFont) return pushText(text.replace(EMOJI, ''), fmt, out); // strip, then collapse as one
    var last = 0;
    var m;
    EMOJI.lastIndex = 0;
    while ((m = EMOJI.exec(text))) {
      if (m.index > last) pushText(text.slice(last, m.index), fmt, out);
      if (fmt.emojiFont) {
        var r = run(m[0], fmt);
        r.font = fmt.emojiFont;
        out.push(r);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) pushText(text.slice(last), fmt, out);
  }
  function pushText(text, fmt, out) {
    text = text.replace(STRAY, '');
    if (!fmt.raw) text = text.replace(/\s+/g, ' '); // a <pre> keeps its newlines and indent
    if (text) out.push(run(text, fmt));
  }

  /**
   * Flatten a phrasing-content subtree to pdfmake text runs. Whitespace collapses the way HTML
   * renders it; the caller trims the paragraph's ends.
   */
  function inlines(node, fmt, out) {
    children(node).forEach(function (child) {
      if (isText(child)) {
        textRuns(String(child.nodeValue || ''), fmt, out);
        return;
      }
      if (!isElement(child)) return;
      var tag = child.nodeName.toUpperCase();
      if (tag === 'BR') { out.push(run('\n', fmt)); return; }
      if (tag === 'IMG') return; // inline images are lifted out by the block walker
      var next = Object.assign({}, fmt);
      if (tag === 'STRONG' || tag === 'B') next.bold = true;
      else if (tag === 'EM' || tag === 'I') next.italics = true;
      else if (tag === 'S' || tag === 'DEL') next.decoration = 'lineThrough';
      else if (tag === 'CODE') next.code = true;
      else if (tag === 'A') { next.link = attr(child, 'href') || undefined; }
      inlines(child, next, out);
    });
  }

  function run(text, fmt) {
    var r = { text: text };
    if (fmt.bold) r.bold = true;
    if (fmt.italics) r.italics = true;
    if (fmt.decoration) r.decoration = fmt.decoration;
    if (fmt.code) r.background = '#f0f2f5';
    if (fmt.link) { r.link = fmt.link; r.color = NAVY; r.decoration = 'underline'; }
    return r;
  }

  /**
   * Trim the whitespace off a run list's ends, and around every line break — HTML ignores the
   * newline the source keeps after a <br>, so the PDF must too. Runs that empty out are dropped.
   */
  function trimRuns(runs) {
    runs.forEach(function (r, i) {
      var prev = runs[i - 1];
      var next = runs[i + 1];
      if (!prev || /\n$/.test(prev.text)) r.text = r.text.replace(/^[^\S\n]+/, '');
      else if (/ $/.test(prev.text)) r.text = r.text.replace(/^ +/, ''); // HTML collapses across inline boundaries too
      if (!next || /^\n/.test(next.text)) r.text = r.text.replace(/[^\S\n]+$/, '');
    });
    runs = runs.filter(function (r) { return r.text !== ''; });
    while (runs.length && !runs[0].text.trim()) runs.shift();
    while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
    return runs;
  }

  function textBlock(node, base) {
    var runs = trimRuns(collect(node));
    if (!runs.length) return null;
    return Object.assign({ text: runs }, base);
  }
  /** The emoji font for the walk in progress — set by build(), whose DOM walk is synchronous. */
  var activeEmojiFont = null;
  function collect(node, raw) {
    var out = [];
    inlines(node, { raw: !!raw, emojiFont: activeEmojiFont }, out);
    return out;
  }

  /** Every <img> under a node, in document order — the preview wraps them in a paragraph. */
  function imagesUnder(node, out) {
    children(node).forEach(function (child) {
      if (!isElement(child)) return;
      if (child.nodeName.toUpperCase() === 'IMG') out.push(attr(child, 'src'));
      else imagesUnder(child, out);
    });
    return out;
  }

  var PHRASING = { STRONG:1, B:1, EM:1, I:1, S:1, DEL:1, CODE:1, A:1, BR:1, SPAN:1, IMG:1 };
  function isPhrasing(node) {
    return isText(node) || (isElement(node) && PHRASING[node.nodeName.toUpperCase()] === 1);
  }

  /**
   * Walk block-level content into pdfmake content items. A run of phrasing children — the text of
   * a tight list item, say, which markdown-it emits without a <p> — becomes one text block, so a
   * bold word never splits its sentence into three. `images` collects the srcs to fetch; their
   * placeholders are `{ image: <src> }` and get a data URL in `build()`.
   */
  function blocks(node, out, images) {
    var pending = [];
    function flush() {
      if (!pending.length) return;
      var holder = { nodeType: 1, nodeName: 'SPAN', childNodes: pending };
      pending = [];
      pushImages(holder);
      var t = textBlock(holder, { margin: [0, 0, 0, 6] });
      if (t) out.push(t);
    }
    function pushImages(holder) {
      imagesUnder(holder, []).forEach(function (src) {
        images.push(src);
        out.push({ image: src, fit: IMAGE_BOX.slice(), margin: [0, 2, 0, 8] });
      });
    }
    children(node).forEach(function (child) {
      if (isPhrasing(child)) { pending.push(child); return; }
      if (!isElement(child)) return;
      if (attr(child, 'data-app-link') !== null) return; // build() sets this as the closing block
      flush();
      var tag = child.nodeName.toUpperCase();
      var style = parseStyle(attr(child, 'style'));
      var base = { margin: [0, style.marginTop || 0, 0, 6] };
      if (style.align === 'center' || style.align === 'right') base.alignment = style.align;

      if (HEADING_SIZE[tag]) {
        var h = textBlock(child, base);
        if (!h) return;
        h.fontSize = HEADING_SIZE[tag];
        h.bold = true;
        h.color = NAVY;
        h.margin = [0, Math.max(style.marginTop || 0, tag === 'H3' ? 12 : 10), 0, 4];
        h.headlineLevel = Number(tag.charAt(1)); // marks it for keepHeadingWithBody()
        out.push(h);
      } else if (tag === 'P') {
        pushImages(child);
        var p = textBlock(child, base);
        if (p) out.push(p);
      } else if (tag === 'UL' || tag === 'OL') {
        var items = [];
        children(child).forEach(function (li) {
          if (!isElement(li) || li.nodeName.toUpperCase() !== 'LI') return;
          var item = [];
          blocks(li, item, images);
          if (item.length) items.push(item.length === 1 ? item[0] : item);
        });
        if (items.length) out.push(Object.assign({}, base, tag === 'UL' ? { ul: items } : { ol: items }));
      } else if (tag === 'BLOCKQUOTE') {
        var inner = [];
        blocks(child, inner, images);
        if (inner.length) out.push({ stack: inner, margin: [12, style.marginTop || 0, 0, 6], color: '#444', italics: true });
      } else if (tag === 'HR') {
        out.push({
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: '#bbb' }],
          margin: [0, 6, 0, 10],
        });
      } else if (tag === 'PRE') {
        var code = collect(child, true).map(function (r) { return r.text; }).join('').replace(/\n$/, '');
        if (code.trim()) out.push(Object.assign({}, base, { text: code, fontSize: 9.5, background: '#f0f2f5', preserveLeadingSpaces: true }));
      } else if (tag === 'TABLE') {
        var rows = [];
        var walkRows = function (n) {
          children(n).forEach(function (c) {
            if (!isElement(c)) return;
            var t = c.nodeName.toUpperCase();
            if (t === 'TR') {
              var cells = [];
              children(c).forEach(function (cell) {
                if (!isElement(cell)) return;
                var ct = cell.nodeName.toUpperCase();
                if (ct !== 'TD' && ct !== 'TH') return;
                var runs = trimRuns(collect(cell));
                cells.push({ text: runs.length ? runs : '', bold: ct === 'TH' });
              });
              if (cells.length) rows.push(cells);
            } else walkRows(c);
          });
        };
        walkRows(child);
        if (rows.length) {
          var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
          rows.forEach(function (r) { while (r.length < width) r.push(''); }); // pdfmake throws on a ragged row
          out.push({
            table: { body: rows, widths: rows[0].map(function () { return '*'; }) }, // every row was padded to rows[0]'s length or wider
            layout: 'lightHorizontalLines',
            margin: [0, style.marginTop || 0, 0, 8],
          });
        }
      } else if (tag === 'SCRIPT' || tag === 'STYLE') {
        return;
      } else {
        // <div>, <section>, an unknown wrapper: look inside.
        blocks(child, out, images);
      }
    });
    flush();
    return out;
  }

  /**
   * The pixel size to embed an image at: enough for IMAGE_PX_PER_PT at the size it is printed, and
   * never more than it has. An upload is up to 1600px on its long side, but a portrait flyer is
   * printed 260pt tall, so embedding it whole spends most of the file on pixels no page shows.
   */
  function embedSize(width, height) {
    var shown = Math.min(1, IMAGE_BOX[0] / (width * 0.75), IMAGE_BOX[1] / (height * 0.75)); // CSS px → pt
    var scale = Math.min(1, shown * 0.75 * IMAGE_PX_PER_PT);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /**
   * Fetch an image and re-encode it as a JPEG data URL no larger than the page can use, with its
   * own pixel size so the page never upscales a small one; or null when it cannot be had.
   */
  function loadImageAsDataUrl(src) {
    return fetch(src, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('image ' + r.status); return r.blob(); })
      .then(function (blob) { return createImageBitmap(blob); })
      .then(function (bitmap) {
        var width = bitmap.width;
        var height = bitmap.height;
        var size = embedSize(width, height);
        var canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // transparency has nothing to show through to on paper
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        if (bitmap.close) bitmap.close();
        return { data: canvas.toDataURL('image/jpeg', 0.88), width: width, height: height };
      })
      .catch(function () { return null; });
  }

  function slug(text) {
    return String(text || 'announcements').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'announcements';
  }

  function isoDate(d) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /**
   * The day the handout is for: today on a Sunday, otherwise the coming Sunday. The export is made
   * in the week before the meeting it is read at, so the day it was generated means nothing to the
   * reader. Local time, like the date it replaces.
   */
  function meetingDay(now) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((7 - now.getDay()) % 7));
  }

  /**
   * pdfmake's `pageBreakBefore` hook: a heading moves to the next page when nothing but other
   * headings follows it on its own, so a title is never left at the foot of a page with its text
   * overleaf. A run of headings (a section title over an announcement's) moves together, because
   * the first of them is asked first. A heading that closes the document stays where it is.
   */
  var FOOTER_STYLE = 'pageNumber';
  function keepHeadingWithBody(node, around) {
    if (!node.headlineLevel) return false;
    // pdfmake lists the page's footer among a node's followers; it is not the heading's text.
    var body = function (n) { return n.style !== FOOTER_STYLE; };
    if (!around.getNodesOnNextPage().some(body)) return false;
    return around.getFollowingNodesOnPage().filter(body).every(function (next) { return !!next.headlineLevel; });
  }

  /**
   * The "get the app" line the dashboard's checkbox adds to the preview (`appLinkHtml()`), as text
   * runs plus the address they link to. Null when the box is not ticked.
   */
  function appLink(root) {
    var node = children(root).filter(function (child) {
      return isElement(child) && attr(child, 'data-app-link') !== null;
    })[0];
    if (!node) return null;
    var runs = trimRuns(collect(node));
    var linked = runs.filter(function (r) { return r.link; })[0];
    return linked ? { runs: runs, href: linked.link } : null;
  }

  /**
   * The pdfmake document for a preview element. `opts.title` heads the page (the app's name);
   * `opts.emojiFont` names the registered emoji font (null strips emoji); `opts.now` and
   * `opts.loadImage` exist for the tests.
   */
  function build(root, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var loadImage = opts.loadImage || loadImageAsDataUrl;
    var images = [];
    activeEmojiFont = opts.emojiFont || null;
    var content = blocks(root, [], images);
    var invite = appLink(root);
    activeEmojiFont = null;
    var dateText = meetingDay(now).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    var head = [];
    if (opts.title) head.push({ text: opts.title, fontSize: 20, bold: true, color: NAVY, margin: [0, 0, 0, 2] });
    head.push({ text: dateText, fontSize: 10, color: '#666', margin: [0, 0, 0, 10] });
    // A link to the app closes the document, under a rule: the invitation on the left, a QR of the
    // link on the right — for the reader who opened this on a computer or printed it, where there
    // is nothing to tap. Unbreakable, so the rule and the QR never part company across a page.
    var foot = [];
    if (invite) {
      foot.push({
        unbreakable: true,
        margin: [0, 16, 0, 0],
        stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: '#bbb' }], margin: [0, 0, 0, 12] },
          {
            columns: [{ width: '*', text: invite.runs, fontSize: 10 }, { width: 'auto', qr: invite.href, fit: 96, eccLevel: 'M' }],
            columnGap: 14,
          },
        ],
      });
    }

    var unique = images.filter(function (s, i) { return s && images.indexOf(s) === i; });
    return Promise.all(unique.map(loadImage)).then(function (dataUrls) {
      var byUrl = {};
      unique.forEach(function (src, i) { byUrl[src] = dataUrls[i]; });
      // An image that failed to fetch leaves no gap: pdfmake throws on a missing image, so the
      // item is dropped rather than the whole export.
      var resolved = content.filter(function (item) {
        if (!item.image) return true;
        var loaded = byUrl[item.image];
        var data = typeof loaded === 'string' ? loaded : loaded && loaded.data;
        if (!data) return false;
        item.image = data;
        // `fit` scales up as readily as down; cap the box at the image's own size (CSS px → pt)
        // so a small logo stays small and only a big flyer is shrunk to the page.
        if (loaded.width && loaded.height) {
          item.fit = [Math.min(item.fit[0], loaded.width * 0.75), Math.min(item.fit[1], loaded.height * 0.75)];
        }
        return true;
      });
      return {
        pageSize: PAGE.size,
        pageMargins: PAGE.margins,
        info: { title: (opts.title ? opts.title + ' — ' : '') + dateText },
        defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.25, color: '#111' },
        footer: function (page, pages) {
          if (pages < 2) return null;
          return { text: page + ' of ' + pages, style: FOOTER_STYLE, margin: [0, 20, 0, 0] };
        },
        styles: { pageNumber: { alignment: 'center', fontSize: 9, color: '#888' } },
        pageBreakBefore: keepHeadingWithBody,
        content: head.concat(resolved, foot),
      };
    });
  }

  /**
   * Build and hand the browser the file. Resolves with the filename once pdfmake has it.
   * `opts.onStatus(text)` is told what is taking the time — the first press downloads ~2.5 MB of
   * pdfmake, fonts and emoji, which on chapel wifi is long enough to need saying.
   */
  function download(root, opts) {
    opts = opts || {};
    var status = opts.onStatus || function () {};
    var name = slug(opts.title) + '-' + isoDate(meetingDay(opts.now || new Date())) + '.pdf';
    var fresh = !(window.pdfMake && window.pdfMake.createPdf);
    status(fresh ? 'Downloading the PDF tools (a few MB, first time only)…' : 'Preparing the PDF…');
    return ensurePdfMake()
      .then(function (pdfMake) {
        return ensureEmojiFont(pdfMake).then(function (hasEmoji) {
          status('Building the PDF…');
          return build(root, Object.assign({ emojiFont: hasEmoji ? EMOJI_FONT : null }, opts)).then(function (doc) {
            // pdfmake 0.3's download() is async; 0.2's took a callback and returned nothing.
            return Promise.resolve(pdfMake.createPdf(doc).download(name));
          });
        });
      })
      .then(function () { return name; });
  }

  // `ensurePdfMake` is shared with the printable flyer (public/flyer-pdf.js), so the dashboard loads
  // pdfmake at most once whichever button is pressed first.
  window.PreviewPdf = { build: build, download: download, parseStyle: parseStyle, embedSize: embedSize, ensurePdfMake: ensurePdfMake };
})();
