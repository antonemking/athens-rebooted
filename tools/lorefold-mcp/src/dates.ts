/**
 * Daily-note naming (LF-12).
 *
 * The server names daily pages with the tick formatter `LLLL dd, yyyy`
 * (`src/cljc/athens/dates.cljc`): full month name, **zero-padded** day, comma,
 * four-digit year — "August 09, 2026", never "August 9, 2026". The page's uid
 * is `MM-dd-yyyy`, also zero-padded.
 *
 * ## Why this is a data problem and not a display problem
 *
 * Nothing in the graph enforces one daily page per day. A title is just a
 * string, so "August 9, 2026" is a perfectly valid *different* page from
 * "August 09, 2026". Get the padding wrong and you do not get an error — you
 * get a second daily note that no calendar view will ever show, holding half
 * the day's writing. The same is true of the timezone: the server resolves the
 * current day from its own container clock, so a bridge running in a different
 * zone silently writes to yesterday's or tomorrow's page for part of every day.
 *
 * ## The consequence for how this module is used
 *
 * **Writes never name the daily page.** They go through the path root
 * `{pageQuery: "@today"}` and let the server pick the day, which makes the
 * server's clock authoritative and removes the failure mode entirely.
 *
 * This module exists to *report* which page that will be, so an agent can say
 * "appended to August 10, 2026" and so the tool layer can compare its own
 * answer with the title the server returned and complain loudly when the two
 * disagree. That comparison is the only reliable detector of a `TZ` mismatch
 * between `ops/.env` and `LOREFOLD_TZ`.
 */

import { assertValidTimeZone } from './config.js';

const MONTH_DAY_YEAR: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: '2-digit',
};

const NUMERIC: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

interface DateParts {
  year: string;
  month: string;
  day: string;
}

function partsIn(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): DateParts {
  assertValidTimeZone(timeZone);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Cannot name a daily note from an invalid Date.');
  }

  // formatToParts rather than format(): the assembled string is then ours, and
  // does not depend on how a given ICU build punctuates en-US.
  const parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

/**
 * The daily-note title for `date` as seen from `timeZone` — "August 09, 2026".
 *
 * `timeZone` must match the `TZ` of the Lorefold container.
 */
export function dailyNoteTitle(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone, MONTH_DAY_YEAR);
  return `${month} ${day}, ${year}`;
}

/**
 * The daily-note uid for `date` — `MM-dd-yyyy`, e.g. "08-09-2026".
 *
 * Daily pages get a deterministic uid derived from the date rather than a
 * random one, which is why a page can be addressed either way.
 */
export function dailyNoteUid(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone, NUMERIC);
  return `${month}-${day}-${year}`;
}

/* ------------------------------------------------------------------ *
 * ISO dates (LF-38).
 *
 * `:decision/date` is a `YYYY-MM-DD` string, and a decision is filed on the
 * daily note *of that date*, which is often not today — decisions get written
 * down after they are made. So the bridge needs to go from an ISO date to a
 * daily-note title, which `@today` cannot do.
 *
 * A calendar date has no timezone. These helpers therefore treat an ISO date as
 * UTC midnight and format it in UTC, which makes the mapping total and
 * reversible. `LOREFOLD_TZ` is used only to decide what "today" is, never to
 * shift a date the caller stated explicitly.
 * ------------------------------------------------------------------ */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real `YYYY-MM-DD` calendar date. Rejects "2026-02-30". */
export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** UTC midnight for an ISO date, or `null` if it is not one. */
export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value.trim());
  if (match === null) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check: Date.UTC happily rolls 2026-02-30 over into March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** `YYYY-MM-DD` for `date` as seen from `timeZone`. */
export function isoDateIn(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone, NUMERIC);
  return `${year}-${month}-${day}`;
}

/**
 * The daily-note title for an ISO date — "2026-08-09" to "August 09, 2026".
 *
 * Safe to write to by title: the server's `:page/new` resolver derives a page's
 * uid from a date-shaped title (`resolver/atomic.cljc:151`), so a page created
 * this way gets the canonical daily uid `08-09-2026` and is the same page the
 * calendar view shows — provided the title format is exactly right, which is
 * why this goes through `dailyNoteTitle` rather than assembling a string.
 */
export function dailyNoteTitleForIso(iso: string): string {
  const date = parseIsoDate(iso);
  if (date === null) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${JSON.stringify(iso)}`);
  }
  return dailyNoteTitle(date, 'UTC');
}

/** Every ISO date from `from` to `to`, inclusive. Empty if `to` precedes `from`. */
export function isoDateRange(from: string, to: string): string[] {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (start === null || end === null) {
    throw new RangeError(`Not a YYYY-MM-DD range: ${JSON.stringify(from)}..${JSON.stringify(to)}`);
  }

  const dates: string[] = [];
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    dates.push(isoDateIn(new Date(d), 'UTC'));
  }
  return dates;
}

/** The ISO date `days` before `iso`. */
export function isoDaysBefore(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  if (date === null) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${JSON.stringify(iso)}`);
  }
  return isoDateIn(new Date(date.getTime() - days * 86_400_000), 'UTC');
}

/**
 * Compares a title the server returned against the one this bridge expected.
 *
 * Returns `null` when they agree or when there is nothing to compare, and a
 * ready-to-surface warning when they do not — which means `LOREFOLD_TZ` and the
 * server's `TZ` disagree, and daily notes are landing on a different day than
 * the agent is being told.
 */
export function timeZoneMismatchWarning(
  serverTitle: string | null,
  expectedTitle: string,
  timeZone: string,
): string | null {
  if (serverTitle === null || serverTitle === expectedTitle) return null;
  return (
    `TIMEZONE MISMATCH: the write landed on "${serverTitle}", but this bridge ` +
    `computed today as "${expectedTitle}" in ${timeZone}. The server resolves ` +
    `"@today" from its own container clock, so it is right and this bridge is ` +
    `wrong. Set LOREFOLD_TZ to the TZ configured for the Lorefold container in ` +
    `ops/.env. Until then, treat any date this bridge reports as unreliable.`
  );
}
