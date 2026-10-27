# Icon artwork

Every PNG the app ships — home-screen icons, the iOS launch images, the favicon, the link-preview card — is drawn by `scripts/generate-icons.mjs` from a **mask**: an 8-bit greyscale coverage map of a building, cropped to the artwork's bounding box, 0 = field, 255 = building. Storing coverage rather than a two-colour render is what lets the icons be recoloured freely: they ship as white on hymn-book green (`#ffffff` on `#24513f`), not the app's own navy `--brand` — a white building on a blue tile is too close to the Church's own Tools app.

## The default: a generic meetinghouse

**`chapel-mask.png`** — a meetinghouse with a steeple, for any ward. Drawn from a few polygons by `node scripts/chapel-mask.mjs` (no dependencies; 4×4 supersampled). To change it, edit the shapes in that script, then:

```bash
node scripts/chapel-mask.mjs   # rewrites art/chapel-mask.png
npm run icons                  # then look at public/icons/
```

and commit the regenerated mask.

## Using your own building

Make a mask of the same kind — a greyscale PNG (8-bit, non-interlaced), white building on black, cropped tight to the artwork — put it in this folder, and select it with a git-ignored `icon.local.json` beside this file:

```json
{ "mask": "my-building.png" }
```

`npm run icons` (and every build and deploy script except `npm run host:deploy`, which always uses the generic `chapel-mask.png`: a host serves many wards) then draws your building instead. A Docker build never sees `icon.local.json`; name the mask with a build argument instead: `docker build --build-arg ICON_MASK=my-building.png .` The generator measures the mask itself — how tall it is, how wide, what fits Android's round crop — so any shape works; a very wide building may want more room, which `ICON_FIT` in `generate-icons.mjs` sets per mask.

The generator never reads an SVG: rasterizing one would put a native dependency in `npm run build`, which also runs on the Cloudflare deploy path. Render your artwork to a mask once, by whatever tool you like, and commit or keep that PNG.
