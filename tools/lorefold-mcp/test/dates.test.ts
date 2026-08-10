import { describe, expect, it } from 'vitest';

import {
  dailyNoteTitle,
  dailyNoteTitleForIso,
  dailyNoteUid,
  isIsoDate,
  isoDateIn,
  isoDateRange,
  isoDaysBefore,
  timeZoneMismatchWarning,
} from '../src/dates.js';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';
const UTC = 'UTC';

describe('dailyNoteTitle', () => {
  it('zero-pads a single-digit day — the trap that silently duplicates daily pages', () => {
    expect(dailyNoteTitle(new Date('2026-08-09T16:00:00Z'), NY)).toBe('August 09, 2026');
  });

  it('zero-pads single-digit months in the title month name position too', () => {
    expect(dailyNoteTitle(new Date('2026-01-05T16:00:00Z'), NY)).toBe('January 05, 2026');
  });

  it('uses the full month name and a four-digit year', () => {
    expect(dailyNoteTitle(new Date('2026-08-10T16:00:00Z'), NY)).toBe('August 10, 2026');
    expect(dailyNoteTitle(new Date('2026-09-30T16:00:00Z'), NY)).toBe('September 30, 2026');
  });

  describe('month and year boundaries', () => {
    it('stays in August for 23:00 local on the 31st, though UTC has rolled over', () => {
      // 2026-09-01T03:00Z is 2026-08-31 23:00 EDT.
      expect(dailyNoteTitle(new Date('2026-09-01T03:00:00Z'), NY)).toBe('August 31, 2026');
      expect(dailyNoteTitle(new Date('2026-09-01T03:00:00Z'), UTC)).toBe('September 01, 2026');
    });

    it('crosses the year boundary correctly', () => {
      expect(dailyNoteTitle(new Date('2027-01-01T03:00:00Z'), NY)).toBe('December 31, 2026');
      expect(dailyNoteTitle(new Date('2027-01-01T03:00:00Z'), UTC)).toBe('January 01, 2027');
    });

    it('handles a leap day', () => {
      expect(dailyNoteTitle(new Date('2028-02-29T17:00:00Z'), NY)).toBe('February 29, 2028');
    });
  });

  describe('explicit non-local timezones', () => {
    // These must not depend on the machine running the suite, which is exactly
    // the failure mode the tests exist to catch.
    const instant = new Date('2026-08-09T23:30:00Z');

    it('is the 9th in UTC', () => {
      expect(dailyNoteTitle(instant, UTC)).toBe('August 09, 2026');
    });

    it('is still the 9th in New York, which is behind UTC', () => {
      expect(dailyNoteTitle(instant, NY)).toBe('August 09, 2026');
    });

    it('is already the 10th in Tokyo, which is ahead of UTC', () => {
      expect(dailyNoteTitle(instant, TOKYO)).toBe('August 10, 2026');
    });

    it('honours a half-hour offset zone', () => {
      // Kolkata is UTC+5:30, so 23:30Z is 05:00 on the following day.
      expect(dailyNoteTitle(instant, 'Asia/Kolkata')).toBe('August 10, 2026');
    });
  });

  it('rejects an invalid timezone rather than falling back to the host zone', () => {
    expect(() => dailyNoteTitle(new Date(), 'Mars/Olympus_Mons')).toThrow(/not a valid IANA/);
  });

  it('rejects an invalid date', () => {
    expect(() => dailyNoteTitle(new Date('nonsense'), NY)).toThrow(/invalid Date/);
  });
});

describe('dailyNoteUid', () => {
  it('is MM-dd-yyyy with both parts zero-padded', () => {
    expect(dailyNoteUid(new Date('2026-08-09T16:00:00Z'), NY)).toBe('08-09-2026');
    expect(dailyNoteUid(new Date('2026-01-05T16:00:00Z'), NY)).toBe('01-05-2026');
    expect(dailyNoteUid(new Date('2026-12-31T16:00:00Z'), NY)).toBe('12-31-2026');
  });

  it('agrees with the title about which day it is', () => {
    const instant = new Date('2026-09-01T03:00:00Z');
    expect(dailyNoteUid(instant, NY)).toBe('08-31-2026');
    expect(dailyNoteTitle(instant, NY)).toBe('August 31, 2026');
  });
});

describe('timeZoneMismatchWarning', () => {
  it('says nothing when the server agrees', () => {
    expect(timeZoneMismatchWarning('August 10, 2026', 'August 10, 2026', NY)).toBeNull();
  });

  it('says nothing when there is no server title to compare', () => {
    expect(timeZoneMismatchWarning(null, 'August 10, 2026', NY)).toBeNull();
  });

  it('names both dates and points at the fix when they disagree', () => {
    const warning = timeZoneMismatchWarning('August 11, 2026', 'August 10, 2026', NY);
    expect(warning).toContain('August 11, 2026');
    expect(warning).toContain('August 10, 2026');
    expect(warning).toContain('LOREFOLD_TZ');
    expect(warning).toContain('ops/.env');
  });
});

/* ------------------------------------------------------------------ *
 * ISO dates (LF-38). A decision is filed on the daily note of the day it was
 * MADE, so the bridge has to go from YYYY-MM-DD to a page title — something
 * `@today` cannot do.
 * ------------------------------------------------------------------ */

describe('isIsoDate', () => {
  it('accepts a real calendar date', () => {
    expect(isIsoDate('2026-08-09')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects the wrong shape', () => {
    expect(isIsoDate('2026-8-9')).toBe(false);
    expect(isIsoDate('09-08-2026')).toBe(false);
    expect(isIsoDate('August 09, 2026')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('rejects a date that does not exist, which Date.UTC would silently roll over', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2025-02-29')).toBe(false);
  });
});

describe('dailyNoteTitleForIso', () => {
  it('produces the zero-padded title the server uses', () => {
    expect(dailyNoteTitleForIso('2026-08-09')).toBe('August 09, 2026');
    expect(dailyNoteTitleForIso('2026-12-31')).toBe('December 31, 2026');
  });

  it('does not shift the date with the host or configured timezone', () => {
    // A calendar date has no timezone; treating it as one is how you file a
    // decision on the wrong day.
    expect(dailyNoteTitleForIso('2026-01-01')).toBe('January 01, 2026');
  });

  it('throws rather than inventing a title for a non-date', () => {
    expect(() => dailyNoteTitleForIso('yesterday')).toThrow(RangeError);
  });
});

describe('isoDateIn', () => {
  it('reads the calendar date in the given zone', () => {
    // 2026-08-11T02:00Z is still the 10th in New York and already the 11th in Tokyo.
    const instant = new Date('2026-08-11T02:00:00Z');
    expect(isoDateIn(instant, NY)).toBe('2026-08-10');
    expect(isoDateIn(instant, TOKYO)).toBe('2026-08-11');
    expect(isoDateIn(instant, UTC)).toBe('2026-08-11');
  });
});

describe('isoDateRange', () => {
  it('is inclusive at both ends', () => {
    expect(isoDateRange('2026-08-08', '2026-08-10')).toEqual([
      '2026-08-08',
      '2026-08-09',
      '2026-08-10',
    ]);
  });

  it('handles a single day and crossing a month or year boundary', () => {
    expect(isoDateRange('2026-08-10', '2026-08-10')).toEqual(['2026-08-10']);
    expect(isoDateRange('2026-07-31', '2026-08-01')).toEqual(['2026-07-31', '2026-08-01']);
    expect(isoDateRange('2025-12-31', '2026-01-01')).toEqual(['2025-12-31', '2026-01-01']);
  });

  it('is empty when the range is inverted, rather than looping forever', () => {
    expect(isoDateRange('2026-08-10', '2026-08-01')).toEqual([]);
  });
});

describe('isoDaysBefore', () => {
  it('walks back across a month boundary', () => {
    expect(isoDaysBefore('2026-08-10', 13)).toBe('2026-07-28');
    expect(isoDaysBefore('2026-03-01', 1)).toBe('2026-02-28');
  });
});
