// The small pure parts of passkey sign-in, in process. The flow itself is test/passkeys.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceLabel } from '../dist/passkeys.js';

test('a passkey is labelled with the kind of device it was made on', () => {
  const cases = {
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1': 'iPhone',
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148': 'iPad',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36': 'Android phone',
    'Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36 Chrome/140.0 Safari/537.36': 'Android tablet',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15': 'Mac',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36': 'Windows PC',
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36': 'Chromebook',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36': 'Linux computer',
  };
  for (const [ua, label] of Object.entries(cases)) assert.equal(deviceLabel(ua), label, ua);
  assert.equal(deviceLabel(undefined), 'Device');
});
