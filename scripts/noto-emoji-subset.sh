#!/bin/sh
# Rebuilds public/vendor/noto-emoji/NotoEmoji-Regular.woff — the monochrome emoji font the
# announcements PDF falls back to for characters Roboto lacks (see public/preview-pdf.js).
#
# Run by hand, not by the build: it needs Python's fonttools, which the build deliberately does not.
# The output is committed. Re-run only to pick up a newer Noto Emoji release.
#
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli && PATH=/tmp/ft/bin:$PATH sh scripts/noto-emoji-subset.sh
#
# What it does, and why:
#  - Google ships Noto Emoji as a variable font (Light→Bold, 1.9 MB). A static Regular instance is
#    all the PDF uses, and is 890 KB.
#  - The subset keeps *every* code point (a clerk can type any emoji) and the GSUB table (which
#    shapes ZWJ families, skin tones and flags into single glyphs), and drops hinting, the
#    variation tables and most name records — 860 KB, since the glyph outlines are the bulk.
#  - WOFF (zlib) halves that to ~566 KB, the same as a gzipped TTF, and pdfmake's bundled fontkit
#    embeds it fine. WOFF2 would be ~465 KB but loses the `loca` table pdfkit's subsetter reads,
#    so it cannot be used.
set -eu
cd "$(dirname "$0")/.."
work=$(mktemp -d)
src="https://github.com/google/fonts/raw/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf"
curl -sL -o "$work/NotoEmoji.ttf" "$src"
curl -sL -o public/vendor/noto-emoji/OFL.txt "https://github.com/google/fonts/raw/main/ofl/notoemoji/OFL.txt"
fonttools varLib.instancer "$work/NotoEmoji.ttf" wght=400 -o "$work/static.ttf"
pyftsubset "$work/static.ttf" \
  --unicodes='*' --layout-features='*' \
  --no-hinting --desubroutinize \
  --name-IDs='0,1,2,3,4,5,6' \
  --drop-tables+=DSIG,STAT,MVAR,HVAR,VVAR,fvar,gvar,avar \
  --flavor=woff \
  --output-file=public/vendor/noto-emoji/NotoEmoji-Regular.woff
ls -la public/vendor/noto-emoji/
rm -rf "$work"
