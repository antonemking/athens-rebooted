import { describe, expect, it } from 'vitest';

import { dailyNoteTitle, dailyNoteUid, timeZoneMismatchWarning } from '../src/dates.js';

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
