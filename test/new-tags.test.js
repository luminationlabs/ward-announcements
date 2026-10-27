/**
 * The "New" tag on announcements this phone has not shown before.
 *
 * The rule is a pure function in `public/app.js`, `newAnnouncementTags(baseline, currentIds)`. It is
 * lifted out of the real source by name and run in a `vm` (as `silent-update.test.js` does with its
 * helpers) — `app.js` cannot be evaluated whole here. The storage readers around it are lifted too,
 * and run against a localStorage that works, one that is empty, and one that throws.
 *
 * Node only, in process. Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP_SOURCE = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** Pull one top-level `function name(...) {...}` out of app.js by scanning braces. */
function liftFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js does not define ${name}()`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

const SEEN_KEY = /const SEEN_KEY = '([^']+)';/u.exec(APP_SOURCE)?.[1];

function load(localStorage) {
  const context = vm.createContext({ localStorage, JSON, Set, Array, String });
  vm.runInContext(
    [
      `const SEEN_KEY = ${JSON.stringify(SEEN_KEY)};`,
      liftFunction(APP_SOURCE, 'newAnnouncementTags'),
      liftFunction(APP_SOURCE, 'readSeenAnnouncements'),
      liftFunction(APP_SOURCE, 'writeSeenAnnouncements'),
    ].join('\n'),
    context,
  );
  return context;
}

/** A Map-backed localStorage. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}

/** Storage that refuses everything, as Safari's private mode once did and a blocked site does. */
const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

// vm results are from another realm, so compare through JSON rather than deepEqual on prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('which announcements are new', () => {
  const { newAnnouncementTags } = load(memoryStorage());

  test('a phone with no record tags nothing, and remembers what is there', () => {
    assert.deepEqual(plain(newAnnouncementTags(null, [3, 2, 1])), { fresh: [], seen: ['3', '2', '1'] });
  });

  test('an id the phone has not seen is new; the ones it has are not', () => {
    assert.deepEqual(plain(newAnnouncementTags(['1', '2'], [3, 2, 1])), {
      fresh: ['3'],
      seen: ['3', '2', '1'],
    });
  });

  test('ids that are no longer live are pruned from what is remembered', () => {
    const { seen } = newAnnouncementTags(['1', '2', '9', '10'], [2, 4]);
    assert.deepEqual(plain(seen), ['2', '4']);
  });

  test('an empty record (everything expired last week) makes every live one new', () => {
    assert.deepEqual(plain(newAnnouncementTags([], [5, 6]).fresh), ['5', '6']);
  });

  test('a re-render in the same visit keeps the tags: the baseline, not the last write, decides', () => {
    // app.js holds the visit's baseline and re-renders on resume and refresh. Each render writes
    // `seen`, but measuring the next one against that write would take the tag off while the
    // member is still looking at it.
    const baseline = ['1', '2'];
    const first = newAnnouncementTags(baseline, [3, 2, 1]);
    const again = newAnnouncementTags(baseline, [3, 2, 1]);
    assert.deepEqual(plain(again.fresh), plain(first.fresh));
    assert.deepEqual(plain(again.fresh), ['3']);
    // One posted while the page stayed open is new too.
    assert.deepEqual(plain(newAnnouncementTags(baseline, [4, 3, 2, 1]).fresh), ['4', '3']);
  });

  test('ids compare as strings, whatever the JSON gave', () => {
    assert.deepEqual(plain(newAnnouncementTags([1, '2'], ['1', 2, 3]).fresh), ['3']);
  });
});

describe('the record in storage', () => {
  test('round-trips, and a phone that never wrote one reads as no record', () => {
    const storage = memoryStorage();
    const app = load(storage);
    assert.equal(app.readSeenAnnouncements(), null);
    app.writeSeenAnnouncements(['4', '5']);
    assert.deepEqual(plain(app.readSeenAnnouncements()), ['4', '5']);
    assert.equal(storage.map.get(SEEN_KEY), '["4","5"]');
  });

  test('a corrupt value is treated as no record rather than thrown', () => {
    for (const bad of ['{not json', '{"a":1}', '"x"', 'null']) {
      const app = load(memoryStorage({ [SEEN_KEY]: bad }));
      assert.equal(app.readSeenAnnouncements(), null, bad);
    }
  });

  test('storage that throws on every call breaks nothing', () => {
    const app = load(throwingStorage);
    assert.equal(app.readSeenAnnouncements(), null);
    assert.doesNotThrow(() => app.writeSeenAnnouncements(['1']));
  });
});
