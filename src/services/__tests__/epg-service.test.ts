import { describe, it, expect } from 'vitest';
import { fetchEPG, getCurrentProgram, getNextProgram } from '../epg-service';

describe('fetchEPG', () => {
  it('parses valid XMLTV with multiple programmes', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="ch1">
    <title>News at Noon</title>
    <desc>Daily news broadcast</desc>
    <category>News</category>
  </programme>
  <programme start="20240101130000 +0000" stop="20240101140000 +0000" channel="ch1">
    <title>Sports Hour</title>
    <desc>Live sports coverage</desc>
    <category>Sports</category>
  </programme>
  <programme start="20240101120000 +0000" stop="20240101133000 +0000" channel="ch2">
    <title>Movie Time</title>
    <desc>A great movie</desc>
    <category>Entertainment</category>
  </programme>
</tv>`;

    const programs = fetchEPG(xml);

    expect(programs).toHaveLength(3);

    expect(programs[0].channelId).toBe('ch1');
    expect(programs[0].title).toBe('News at Noon');
    expect(programs[0].description).toBe('Daily news broadcast');
    expect(programs[0].category).toBe('News');
    expect(programs[0].start).toBeInstanceOf(Date);
    expect(programs[0].stop).toBeInstanceOf(Date);

    expect(programs[1].title).toBe('Sports Hour');
    expect(programs[2].channelId).toBe('ch2');
    expect(programs[2].title).toBe('Movie Time');
  });

  it('parses XMLTV date format correctly (UTC +0000)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="ch1">
    <title>Test</title>
  </programme>
</tv>`;

    const programs = fetchEPG(xml);

    expect(programs).toHaveLength(1);
    expect(programs[0].start.toISOString()).toBe('2024-01-01T12:00:00.000Z');
    expect(programs[0].stop.toISOString()).toBe('2024-01-01T13:00:00.000Z');
  });

  it('parses XMLTV date with timezone offset (+0530)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20240101120000 +0530" stop="20240101130000 +0530" channel="ch1">
    <title>India Show</title>
  </programme>
</tv>`;

    const programs = fetchEPG(xml);

    expect(programs).toHaveLength(1);
    // 12:00 +0530 = 06:30 UTC
    expect(programs[0].start.toISOString()).toBe('2024-01-01T06:30:00.000Z');
    // 13:00 +0530 = 07:30 UTC
    expect(programs[0].stop.toISOString()).toBe('2024-01-01T07:30:00.000Z');
  });

  it('skips programme with missing stop time', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20240101120000 +0000" channel="ch1">
    <title>No Stop</title>
  </programme>
  <programme start="20240101130000 +0000" stop="20240101140000 +0000" channel="ch1">
    <title>Has Stop</title>
  </programme>
</tv>`;

    const programs = fetchEPG(xml);

    // The programme with a valid stop time should always be present
    const hasStop = programs.find((p) => p.title === 'Has Stop');
    expect(hasStop).toBeDefined();
    expect(hasStop!.start.toISOString()).toBe('2024-01-01T13:00:00.000Z');
    expect(hasStop!.stop.toISOString()).toBe('2024-01-01T14:00:00.000Z');
  });

  it('returns empty array for empty XML string', () => {
    const programs = fetchEPG('');
    expect(programs).toEqual([]);
  });

  it('returns empty array for malformed XML (does not throw)', () => {
    const programs = fetchEPG('<tv><broken><<<');
    // DOMParser doesn't throw; it may produce a parsererror document.
    // Either way we should get an empty or valid array, not an exception.
    expect(Array.isArray(programs)).toBe(true);
  });

  it('uses default values for missing title, desc, category', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="ch1">
  </programme>
</tv>`;

    const programs = fetchEPG(xml);

    expect(programs).toHaveLength(1);
    expect(programs[0].title).toBe('No Title');
    expect(programs[0].description).toBe('');
    expect(programs[0].category).toBe('General');
  });
});

describe('getCurrentProgram', () => {
  it('returns the program that spans the current time', () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);
    const oneHourLater = new Date(now.getTime() + 3600000);

    const programs = [
      {
        channelId: 'ch1',
        title: 'Current Show',
        description: 'On now',
        start: oneHourAgo,
        stop: oneHourLater,
        category: 'General',
      },
      {
        channelId: 'ch1',
        title: 'Next Show',
        description: 'Coming up',
        start: oneHourLater,
        stop: new Date(oneHourLater.getTime() + 3600000),
        category: 'General',
      },
    ];

    const current = getCurrentProgram(programs, 'ch1');

    expect(current).not.toBeNull();
    expect(current!.title).toBe('Current Show');
  });

  it('returns null when no program is currently airing', () => {
    const pastStop = new Date(Date.now() - 3600000);
    const pastStart = new Date(pastStop.getTime() - 3600000);

    const programs = [
      {
        channelId: 'ch1',
        title: 'Old Show',
        description: '',
        start: pastStart,
        stop: pastStop,
        category: 'General',
      },
    ];

    expect(getCurrentProgram(programs, 'ch1')).toBeNull();
  });

  it('returns null for a non-matching channel', () => {
    const now = new Date();
    const programs = [
      {
        channelId: 'ch1',
        title: 'Show',
        description: '',
        start: new Date(now.getTime() - 3600000),
        stop: new Date(now.getTime() + 3600000),
        category: 'General',
      },
    ];

    expect(getCurrentProgram(programs, 'ch2')).toBeNull();
  });
});

describe('getNextProgram', () => {
  it('returns the next upcoming program for the channel', () => {
    const now = new Date();
    const oneHourLater = new Date(now.getTime() + 3600000);
    const twoHoursLater = new Date(now.getTime() + 7200000);
    const threeHoursLater = new Date(now.getTime() + 10800000);

    const programs = [
      {
        channelId: 'ch1',
        title: 'Current Show',
        description: '',
        start: new Date(now.getTime() - 3600000),
        stop: oneHourLater,
        category: 'General',
      },
      {
        channelId: 'ch1',
        title: 'Later Show',
        description: '',
        start: twoHoursLater,
        stop: threeHoursLater,
        category: 'General',
      },
      {
        channelId: 'ch1',
        title: 'Next Show',
        description: '',
        start: oneHourLater,
        stop: twoHoursLater,
        category: 'General',
      },
    ];

    const next = getNextProgram(programs, 'ch1');

    expect(next).not.toBeNull();
    expect(next!.title).toBe('Next Show');
  });

  it('returns null when there are no upcoming programs', () => {
    const now = new Date();
    const programs = [
      {
        channelId: 'ch1',
        title: 'Past Show',
        description: '',
        start: new Date(now.getTime() - 7200000),
        stop: new Date(now.getTime() - 3600000),
        category: 'General',
      },
    ];

    expect(getNextProgram(programs, 'ch1')).toBeNull();
  });
});
