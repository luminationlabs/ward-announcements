// The browser half of passkey sign-in (src/passkeys.ts), bundled by scripts/vendor-bundles.mjs into
// public/vendor/passkey.js for the login and invite pages. SimpleWebAuthn's browser helpers turn the
// server's JSON options into navigator.credentials calls and the results back into JSON.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

window.WardPasskey = { supported: browserSupportsWebAuthn, startAuthentication, startRegistration };
