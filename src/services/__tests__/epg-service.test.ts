import { describe, it, expect } from 'vitest';
import { getCurrentProgram, getNextProgram } from '../epg-service';

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
