/**
 * The dashboard's "Download Backup (ZIP)": the whole ward — every table, and every image — as one
 * file, for disaster recovery.
 *
 * Assembled here, in the admin's browser, and not on the server: a free-plan Worker has about 10 ms
 * of CPU per request, and a CRC over tens of megabytes of images would exceed it many times over.
 * The server's part is what it already serves: `/admin/backup.json` (the data, exactly as the JSON
 * download) and `/images/:key` (each image, from R2, the D1 `file_chunks` table or the disk —
 * whichever the deployment uses). The zip itself is `public/zip.js`, loaded on first use.
 *
 * What is in the file:
 *   backup.json      the JSON backup, byte for byte what "Data only (JSON)" downloads
 *   images/<key>     every image an `attachments` row names, under its own storage key
 *   manifest.json    what this is: format version, schema version, when, from where, the image
 *                    count and bytes, and any image that could not be fetched (and why)
 *
 * An image that fails to download does not stop the backup: it is listed in the manifest's
 * `missing`, and the page says so. Images are fetched one at a time and held in memory until the
 * zip is written; they were downscaled on upload (1600px JPEG), so a ward's few hundred images come
 * to tens of megabytes, which a browser holds without trouble. Restored by the many-ward host's
 * Import Backup, or by `scripts/db-restore.mjs` on a single-ward deployment.
 *
 * The many-ward host's operator page makes the same file for any of its wards (Export), with the
 * same code: `download()` takes the URLs to fetch — there the operator's `/wards/<id>/export` and
 * `/wards/<id>/images/<key>`, which read the ward's own store — so Export and Import Backup take
 * one format, and a ward whose admins cannot sign in can still be copied.
 *
 * `buildBackup()` is DOM-free and takes its `fetch` and zip writer as arguments, so
 * test/backup-zip.test.js runs it verbatim in a `vm`; only `download()` and `wire()` touch the page.
 */
(function (root) {
  'use strict';

  var FORMAT = 'ward-announcements-backup';
  var VERSION = 1;

  function settingOf(backup, key) {
    var rows = (backup.tables && backup.tables.settings) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].key === key) return rows[i].value;
    return null;
  }

  /**
   * Fetch the backup and its images and lay out the zip's entries. Resolves to
   * `{ entries, manifest, filename }`; `onProgress({ done, total, bytes })` is told as each image lands.
   * `dataUrl` and `imageUrl(key)` say where from (the dashboard's own routes by default), and `name`
   * starts the file's name (`<name>-backup-<date>.zip`).
   */
  function buildBackup(options) {
    var fetchFn = options.fetch;
    var now = options.now || new Date();
    var onProgress = options.onProgress || function () {};
    var dataUrl = options.dataUrl || '/admin/backup.json';
    var imageUrl = options.imageUrl || function (key) { return '/images/' + encodeURIComponent(key); };
    var name = options.name || 'ward-announcements';
    return fetchFn(dataUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        // A session that has ended answers with its sign-in page: a redirect, which fetch follows to a 200.
        if (res.redirected) throw new Error('The backup could not be downloaded: you have been signed out. Sign in again.');
        if (!res.ok) throw new Error('The backup could not be downloaded (' + res.status + '). Are you still signed in?');
        return res.text();
      })
      .then(function (json) {
        var backup = JSON.parse(json);
        var rows = (backup.tables && backup.tables.attachments) || [];
        var wanted = rows.filter(function (r) { return r && typeof r.key === 'string'; });
        var expected = wanted.reduce(function (sum, r) { return sum + (Number(r.size) || 0); }, 0);
        var images = [];
        var missing = [];
        var bytes = 0;
        var i = 0;
        onProgress({ done: 0, total: wanted.length, bytes: 0, expected: expected });
        function next() {
          if (i >= wanted.length) return Promise.resolve();
          var row = wanted[i++];
          return fetchFn(imageUrl(row.key), { credentials: 'same-origin' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.arrayBuffer();
            })
            .then(
              function (buffer) {
                var data = new Uint8Array(buffer);
                images.push({ name: 'images/' + row.key, data: data, date: now });
                bytes += data.length;
              },
              function (err) {
                missing.push({ key: row.key, error: (err && err.message) || String(err) });
              },
            )
            .then(function () {
              onProgress({ done: i, total: wanted.length, bytes: bytes, expected: expected });
              return next();
            });
        }
        return next().then(function () {
          var version = Number(settingOf(backup, 'schema_version'));
          var manifest = {
            format: FORMAT,
            version: VERSION,
            created_at: now.toISOString(),
            app: backup.app || null,
            hostname: options.hostname || null,
            schema_version: isNaN(version) ? null : version,
            images: { count: images.length, bytes: bytes, expected: wanted.length },
            missing: missing,
          };
          var entries = [{ name: 'backup.json', data: json, date: now }]
            .concat(images)
            .concat([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 2), date: now }]);
          return {
            entries: entries,
            manifest: manifest,
            filename: name + '-backup-' + now.toISOString().slice(0, 10) + '.zip',
          };
        });
      });
  }

  var loading = null;
  function ensureZip() {
    if (root.WardZip) return Promise.resolve(root.WardZip);
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/zip.js';
        s.onload = function () { resolve(root.WardZip); };
        s.onerror = function () { loading = null; reject(new Error('Could not load the zip writer.')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  function mb(n) {
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  /**
   * Build the zip, save it, and tell `say(text, isError)` how it is going: the progress line while
   * images download, then what was saved and which images could not be. `options` goes to
   * `buildBackup()` (fetch, hostname, URLs, name). Resolves when done; a failure is said, not thrown.
   */
  function download(options, say) {
    say('Downloading the data…');
    return ensureZip()
      .then(function (Zip) {
        var opts = { fetch: root.fetch.bind(root) };
        for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) opts[k] = options[k];
        opts.onProgress = function (p) {
          if (p.total) say('Adding images… ' + p.done + ' of ' + p.total + ' (' + mb(p.bytes) + ' of about ' + mb(p.expected) + ')');
        };
        return buildBackup(opts).then(function (built) {
          say('Writing the ZIP…');
          var blob = new Blob(Zip.createZipParts(built.entries), { type: 'application/zip' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = built.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
          var m = built.manifest;
          var done = 'Saved ' + built.filename + ' (' + mb(blob.size) + ', ' + m.images.count + ' image' + (m.images.count === 1 ? '' : 's') + ').';
          if (m.missing.length) {
            say(done + ' ' + m.missing.length + ' image' + (m.missing.length === 1 ? '' : 's') + ' could not be downloaded and ' +
              (m.missing.length === 1 ? 'is' : 'are') + ' not in it: ' + m.missing.map(function (x) { return x.key + ' (' + x.error + ')'; }).join(', ') +
              '. The file lists them in manifest.json.', true);
          } else say(done);
        });
      })
      .catch(function (err) { say((err && err.message) || String(err), true); });
  }

  /** The Backup card's button: `[data-backup-zip]`, reporting in `[data-backup-status]`. */
  function wire() {
    var button = document.querySelector('[data-backup-zip]');
    var status = document.querySelector('[data-backup-status]');
    if (!button || !status) return;
    var say = function (text, isError) {
      status.hidden = false;
      status.textContent = text;
      status.classList.toggle('err', !!isError);
    };
    button.addEventListener('click', function () {
      button.disabled = true;
      download({ hostname: location.hostname }, say).then(function () { button.disabled = false; });
    });
  }

  root.BackupZip = { buildBackup: buildBackup, download: download };
  if (typeof document !== 'undefined' && document.querySelector) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }
})(typeof window !== 'undefined' ? window : globalThis);
