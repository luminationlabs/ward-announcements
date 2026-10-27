/**
 * The per-ward state seam (`src/tenant.ts`) — the groundwork for hosting several wards from one
 * deployment.
 *
 * Two halves:
 * - **Isolation.** Two wards run side by side in one process, each with its own config and its own
 *   database, and neither sees the other's. Then the switch to multi-ward mode: code outside any
 *   ward must throw rather than fall back to some ward's state.
 * - **A guard on the source.** A module-level `let` (or a module-level Map/Set) is state every ward
 *   in an isolate would share, so one added later would quietly undo the isolation above. This scans
 *   `src/` and fails on any that is not on the reviewed list below — the list says why each is safe.
 *
 * Node only (better-sqlite3, and `dist/`). Run with: npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tenant, currentTenant, requireTenantContext, runInTenant } from '../dist/tenant.js';
import { config, loadConfig } from '../dist/config.js';
import { createSqliteDriver } from '../dist/driver-sqlite.js';
import * as db from '../dist/db.js';

const env = (name) => ({
  ADMIN_PASSWORD: `password-for-${name}`,
  APP_NAME: name,
  APP_SHORT_NAME: name,
  APP_DESCRIPTION: `${name} announcements`,
});

describe('per-ward state', () => {
  let dataDir;
  const north = new Tenant('north');
  const south = new Tenant('south');

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tenant-test-'));
    for (const [ward, name] of [[north, 'North Ward'], [south, 'South Ward']]) {
      await runInTenant(ward, async () => {
        loadConfig(env(name));
        await db.initDb(createSqliteDriver(join(dataDir, `${ward.id}.db`)));
      });
    }
  });

  after(() => rmSync(dataDir, { recursive: true, force: true }));

  test('each ward reads its own config', async () => {
    await runInTenant(north, async () => assert.equal(config.appName, 'North Ward'));
    await runInTenant(south, async () => assert.equal(config.appName, 'South Ward'));
  });

  test('a config write stays in its ward', async () => {
    // identity.ts writes the learned origin through `config`, so writes must be per ward too.
    await runInTenant(north, async () => {
      config.publicOrigin = 'https://north.example.org';
    });
    await runInTenant(south, async () => assert.equal(config.publicOrigin, ''));
    await runInTenant(north, async () => assert.equal(config.publicOrigin, 'https://north.example.org'));
  });

  test('each ward has its own database', async () => {
    await runInTenant(north, () => db.setSetting('probe', 'north'));
    await runInTenant(south, () => db.setSetting('probe', 'south'));
    assert.equal(await runInTenant(north, () => db.getSetting('probe')), 'north');
    assert.equal(await runInTenant(south, () => db.getSetting('probe')), 'south');
  });

  test('the ward survives awaits and concurrent work', async () => {
    // Interleave the two wards' requests; AsyncLocalStorage must keep each on its own side.
    const reads = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const ward = i % 2 ? north : south;
        return runInTenant(ward, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return [ward.id, config.appName, await db.getSetting('probe')];
        });
      }),
    );
    for (const [id, appName, probe] of reads) {
      assert.equal(appName, id === 'north' ? 'North Ward' : 'South Ward');
      assert.equal(probe, id);
    }
  });

  test('the implicit single-ward tenant is separate from both', () => {
    // Outside any ward this process is still single-ward, and nothing was loaded for that tenant.
    assert.equal(currentTenant().id, 'default');
    assert.throws(() => config.appName, /No config loaded/);
  });

  test("a ward's log lines name it, and only its own", async () => {
    // Every ward logs through one logger; without its name a line is no use to the operator.
    const { logger } = await import('../dist/log.js');
    const lines = [];
    const real = console.log;
    console.log = (text) => lines.push(JSON.parse(text));
    try {
      const a = new Tenant('object-a');
      a.label = { ward: 'alpha', host: 'alpha.example.org' };
      const b = new Tenant('object-b');
      b.label = { ward: 'beta', host: 'beta.example.org' };
      await Promise.all([
        runInTenant(a, async () => { await new Promise((r) => setTimeout(r, 5)); logger.info({ n: 1 }, 'from a'); }),
        runInTenant(b, async () => logger.info('from b')),
      ]);
    } finally {
      console.log = real;
    }
    const byMsg = Object.fromEntries(lines.map((l) => [l.msg, l]));
    assert.equal(byMsg['from a'].ward, 'alpha');
    assert.equal(byMsg['from a'].host, 'alpha.example.org');
    assert.equal(byMsg['from a'].n, 1, 'the line keeps its own fields');
    assert.equal(byMsg['from b'].ward, 'beta');
  });

  test('multi-ward mode refuses to run outside a ward', async () => {
    requireTenantContext(); // irreversible — node:test gives each file its own process
    assert.throws(() => currentTenant(), /No ward context/);
    assert.throws(() => config.appName, /No ward context/);
    await assert.rejects(db.getSetting('probe'), /No ward context/);
    // Inside a ward, unchanged.
    await runInTenant(north, async () => assert.equal(config.appName, 'North Ward'));
  });
});

/**
 * Module-level mutable state that is reviewed and allowed, by file. Anything else fails the guard.
 * Keep the reason with the entry: the point of the list is that someone thought about it.
 */
const ALLOWED = {
  // The mode switch itself.
  'tenant.ts': ['fallback'],
  // The single-ward Workers entry. A multi-ward host holds these per ward instead.
  'worker.ts': ['core', 'booted', 'fileStore'],
  // Node's croner jobs: the Node entry is single-ward by design.
  'schedule.ts': ['job', 'purgeJob', 'retryJob', 'logger'],
  // A test hook swapping the shared logger; carries no ward data.
  'push.ts': ['log'],
  // A constant lookup table, computed once (image-meta.ts keeps its own copy: it imports nothing).
  'qr-png.ts': ['crcTable'],
  'image-meta.ts': ['crcTable'],
  // The many-ward host's hostname -> ward cache: host-level, holds hostnames and ids, no ward data.
  // …and the operator app, one per isolate so its login rate limit persists between requests.
  'host.ts': ['wardCache', 'operatorApp'],
};

test('no unreviewed module-level mutable state in src/', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const found = [];
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(new URL(file, srcDir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Column 0 only: indented declarations live inside a function or block.
      const mutable = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
      const collection = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b.*=\s*new\s+(?:Map|Set|WeakMap)\b/.exec(line);
      const name = (mutable ?? collection)?.[1];
      if (name && !(ALLOWED[file] ?? []).includes(name)) found.push(`src/${file}:${i + 1} ${name}`);
    });
  }
  assert.deepEqual(
    found,
    [],
    'Module-level state is shared by every ward in an isolate. Hold it with tenantLocal() ' +
      '(src/tenant.ts), or add it to ALLOWED in this test with the reason it is safe.',
  );
});
