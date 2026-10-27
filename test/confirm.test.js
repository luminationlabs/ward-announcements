/**
 * "Are you sure?" on the dashboard's dangerous buttons.
 *
 * The forms carry `data-confirm="…"` and one listener in the admin layout asks the question; the
 * Content Security Policy (src/csp.ts) refuses the inline `onsubmit="return confirm('…')"` they used
 * to have. That old form was also a hole, found while making the change: the question was a
 * JavaScript string inside an HTML attribute, escaped for HTML only, so a person's name with an
 * apostrophe broke the button — and a crafted one ran as script for the admin who opened that
 * person's page. An editor can set their own name.
 *
 * The listener is the layout's real inline script, run in a `vm` with a stub document, as
 * gate-unlock.test.js does for the gate page. Node only. Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { loadConfig } from '../dist/config.js';
import { personPage } from '../dist/views.js';

loadConfig({ APP_NAME: 'Test Ward', APP_SHORT_NAME: 'Test', APP_DESCRIPTION: 'Test', ADMIN_PASSWORD: 'a long test passphrase' });

const NAME = "Sister O'Brien'); alert('pwned"; // an apostrophe, and the shape of an attack

function page() {
  return personPage({
    person: { id: 7, name: NAME, role: 'editor', session_version: 1, webauthn_id: 'x', created_at: '2026-01-01 00:00:00' },
    passkeys: [],
    invite: null,
    isSelf: false,
  });
}

/**
 * The layout's listener, wired to a stub document; returns a way to submit a form through it. The
 * form's submit buttons are stubs too, so the double-tap guard (buttons disabled once a submit is
 * on its way, back on again on `pageshow`) is observable. `setTimeout` runs its callback at once:
 * the deferral exists for the browser's sake (listeners later in the dispatch), not for timing.
 */
function listener(answer) {
  const html = page();
  const asked = [];
  const buttons = [{ disabled: false }, { disabled: false }];
  for (const b of buttons) {
    b.attrs = {};
    b.setAttribute = (name, value) => (b.attrs[name] = value);
    b.removeAttribute = (name) => delete b.attrs[name];
  }
  let onSubmit;
  let onPageShow;
  const context = {
    document: {
      addEventListener: (type, fn) => type === 'submit' && (onSubmit = fn),
      querySelectorAll: (selector) => (selector === 'button[data-submitting]' ? buttons.filter((b) => 'data-submitting' in b.attrs) : []),
    },
    window: {
      location: { href: 'https://ward.example/admin/people/7' },
      confirm: (q) => (asked.push(q), answer),
      addEventListener: (type, fn) => type === 'pageshow' && (onPageShow = fn),
    },
    history: { replaceState() {} },
    setTimeout: (fn) => fn(),
    URL,
  };
  vm.createContext(context);
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].find((m) => m[1].includes('data-confirm'))?.[1];
  assert.ok(script, 'the layout carries the confirm listener');
  vm.runInContext(script, context);
  return {
    asked,
    buttons,
    submit(attrs, { takenOver = false } = {}) {
      let prevented = takenOver;
      onSubmit({
        target: { getAttribute: (name) => attrs[name] ?? null, querySelectorAll: () => buttons },
        preventDefault: () => (prevented = true),
        get defaultPrevented() { return prevented; },
      });
      return prevented;
    },
    pageshow: () => onPageShow({ persisted: true }),
  };
}

/** The data-confirm values on the page, as a browser would decode them. */
function questions() {
  return [...page().matchAll(/data-confirm="([^"]*)"/g)].map((m) =>
    m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  );
}

test('no inline handler is left on the page', () => {
  assert.doesNotMatch(page(), /<[^>]+\son[a-z]+\s*=/i);
});

test('the question names the person exactly, as text', () => {
  assert.ok(questions().includes(`Sign ${NAME} out on every device?`), questions().join('\n'));
});

test('cancelling stops the submit; agreeing lets it through', () => {
  const [question] = questions();
  const no = listener(false);
  assert.equal(no.submit({ 'data-confirm': question }), true, 'prevented');
  assert.deepEqual(no.asked, [question]);
  const yes = listener(true);
  assert.equal(yes.submit({ 'data-confirm': question }), false, 'not prevented');
});

test('a form with no question submits without asking', () => {
  const l = listener(false);
  assert.equal(l.submit({}), false);
  assert.deepEqual(l.asked, []);
});

test('a submit on its way disables the form\'s buttons; a cancelled one leaves them alone', () => {
  const [question] = questions();
  const yes = listener(true);
  yes.submit({ 'data-confirm': question });
  assert.ok(yes.buttons.every((b) => b.disabled), 'no second tap posts the form again');
  const plain = listener(true);
  plain.submit({});
  assert.ok(plain.buttons.every((b) => b.disabled), 'with or without a question');
  const no = listener(false);
  no.submit({ 'data-confirm': question });
  assert.ok(no.buttons.every((b) => !b.disabled), 'cancelled: the person is still on the form');
});

test('a submit another script took over (preventDefault) leaves the buttons usable', () => {
  const l = listener(true);
  l.submit({}, { takenOver: true });
  assert.ok(l.buttons.every((b) => !b.disabled));
});

test('coming back to the page (bfcache) switches the buttons on again', () => {
  const l = listener(true);
  l.submit({});
  assert.ok(l.buttons.every((b) => b.disabled));
  l.pageshow();
  assert.ok(l.buttons.every((b) => !b.disabled && !('data-submitting' in b.attrs)));
});
