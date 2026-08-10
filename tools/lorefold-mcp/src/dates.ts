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
