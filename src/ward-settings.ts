/**
 * The ward's own settings: what it is called, the footer and link members see, and its timezone.
 *
 * They are edited on the dashboard (Settings → Ward Settings) and kept in one `settings` row as JSON,
 * because as env vars alone renaming the app would take a redeploy — and a ward hosted on a shared
 * deployment has no env vars of its own at all. The env vars supply the starting values: until an
 * admin first saves the card, the env decides, and after that the saved values win.
 *
 * Applied by writing onto the current ward's `config`, the same way `identity.ts` fills in what the
 * env left unset, so every reader of `config.appName` and friends picks it up unchanged. A save in
 * one isolate reaches the others within `REFRESH_MS`, through `refreshWardSettings()` on each request.
 */
import { config, type AppConfig } from './config.js';
import { getSetting, setSetting } from './db.js';
import { logger } from './log.js';
import { scheduleRezoned } from './schedule-core.js';
import { tenantLocal } from './tenant.js';

const SETTING = 'ward_settings';

/** How stale another isolate's copy may get after a save. One settings read per isolate per period. */
const REFRESH_MS = 60_000;

export interface WardSettings {
  appName: string;
  appShortName: string;
  appDescription: string;
  appFooter: string;
  linkText: string;
  linkUrl: string;
  timezone: string;
}

/** The `config` fields this module owns — also the JSON row's keys. */
const FIELDS = [
  'appName',
  'appShortName',
  'appDescription',
  'appFooter',
  'linkText',
  'linkUrl',
  'timezone',
] as const satisfies readonly (keyof WardSettings & keyof AppConfig)[];

/** Fields that may not be saved empty; an empty stored value never overrides the env's. */
const REQUIRED: readonly string[] = ['appName', 'appShortName', 'appDescription', 'timezone'];

/** Upper bounds, enforced on save and mirrored as `maxlength` on the form. */
export const WARD_LIMITS = {
  appName: 60,
  appShortName: 20,
  appDescription: 200,
  appFooter: 300,
  linkText: 80,
  linkUrl: 500,
} as const;

/**
 * When this isolate last read the row, and how many saves it has made. The count is what stops a
 * read that started before a save from landing after it: a refresh that awaits the database while
 * the admin's save completes would otherwise put the old values back for a minute.
 */
const freshness = tenantLocal(() => ({ at: 0, saves: 0 }));

/** The ward's settings as they stand: the env's values, overlaid with whatever was saved. */
export function currentWardSettings(): WardSettings {
  return Object.fromEntries(FIELDS.map((key) => [key, config[key]])) as unknown as WardSettings;
}

/**
 * Overlay the saved settings onto `config`. Fields never saved keep their env value.
 *
 * Throws only at boot (`throwOnError`): there a failed read is a failed boot, and the entry retries.
 * Every later refresh is **stale-on-error** — a database blip must not fail every page, asset and
 * health check in the isolate — and is timestamped before it reads, so a slow or failing read is not
 * re-issued by every request that arrives meanwhile.
 */
export async function loadWardSettings({ throwOnError = true } = {}): Promise<void> {
  const state = freshness();
  const savesBefore = state.saves;
  state.at = Date.now();
  let raw: string | null;
  try {
    raw = await getSetting(SETTING);
  } catch (err) {
    if (throwOnError) throw err;
    logger.warn({ err }, 'could not re-read the ward settings; keeping the current ones');
    return;
  }
  if (state.saves !== savesBefore) return; // a save in this isolate landed meanwhile and is newer
  if (!raw) return;
  let saved: Partial<WardSettings>;
  try {
    saved = JSON.parse(raw) as Partial<WardSettings>;
  } catch {
    return; // a hand-edited row; the env values stand rather than the app failing to boot
  }
  apply(saved);
}

/** `loadWardSettings`, at most once per `REFRESH_MS` — cheap enough for every request. */
export async function refreshWardSettings(): Promise<void> {
  if (Date.now() - freshness().at < REFRESH_MS) return;
  await loadWardSettings({ throwOnError: false });
}

/** Validate, store and apply new settings. Throws an `Error` whose message is fit to show the admin. */
export async function saveWardSettings(input: Record<string, unknown>): Promise<WardSettings> {
  const text = (key: keyof typeof WARD_LIMITS, label: string, required: boolean): string => {
    const value = typeof input[key] === 'string' ? (input[key] as string).trim() : '';
    if (required && !value) throw new Error(`${label} is required.`);
    if (value.length > WARD_LIMITS[key]) {
      throw new Error(`${label} must be at most ${WARD_LIMITS[key]} characters.`);
    }
    return value;
  };
  const next: WardSettings = {
    appName: text('appName', 'The app name', true),
    appShortName: text('appShortName', 'The home-screen name', true),
    appDescription: text('appDescription', 'The description', true),
    appFooter: text('appFooter', 'The footer note', false),
    linkText: text('linkText', 'The link text', false),
    linkUrl: text('linkUrl', 'The link address', false),
    timezone: typeof input.timezone === 'string' ? input.timezone.trim().slice(0, 64) : '',
  };
  if (!!next.linkText !== !!next.linkUrl) {
    throw new Error('Fill in both the link text and its address, or leave both empty.');
  }
  // The address is rendered into an href on the public page; only plain web links, never
  // `javascript:` or a data URL.
  if (next.linkUrl && !isWebUrl(next.linkUrl)) {
    throw new Error('The link address must start with https:// (or http://).');
  }
  if (!isTimeZone(next.timezone)) {
    throw new Error(`"${next.timezone}" is not a timezone this server knows. Try one like America/Denver.`);
  }
  // Stored as the runtime spells it (`america/denver` → `America/Denver`), so the dashboard shows
  // the proper name and a re-save of the same zone is not mistaken for a change.
  next.timezone = canonicalTimeZone(next.timezone);

  // Compared with what is *stored*, not this isolate's copy, which may be a minute behind a save
  // made in another.
  const before = JSON.parse((await getSetting(SETTING)) ?? 'null') as Partial<WardSettings> | null;
  const timezoneChanged = next.timezone !== (before?.timezone ?? config.timezone);
  const state = freshness();
  state.saves++;
  await setSetting(SETTING, JSON.stringify(next));
  apply(next);
  state.at = Date.now();
  // The weekly slot is a local day and time, so a new zone keeps it at the same local time — which
  // is a different instant — and the runtime has to hear about it (Node rebuilds its croner job).
  // Deliberately *not* a "schedule moved" (no `schedule_set_at` bump): that would suppress the
  // catch-up for a slot that has just passed in the new zone, so a ward fixing its timezone on a
  // Sunday morning before the send would lose that week. Without it the worst case is a send that
  // goes out late, never twice: a week's send is keyed by its local date and time
  // (`YYYY-MM-DDTHH:MM`), which the timezone does not change, and one already made covers it.
  if (timezoneChanged) await scheduleRezoned();
  return next;
}

function apply(saved: Partial<WardSettings>): void {
  const target = config as unknown as Record<string, unknown>;
  for (const key of FIELDS) {
    const value = saved[key];
    if (typeof value === 'string' && (value || !REQUIRED.includes(key))) {
      // Skip a stored timezone the runtime does not know rather than break every schedule check.
      if (key === 'timezone' && !isTimeZone(value)) continue;
      target[key] = value;
    }
  }
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function canonicalTimeZone(value: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
}

export function isTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
