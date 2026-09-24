// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildAiringKey } from './epg-identity.js';
import { parseEPG } from './parsers.js';
import { decodeBase64Maybe, mapXtreamEpgEntry } from './xtream.js';

describe('EPG enrichment', () => {
  it('keeps a direct SportsCenter title instead of treating it as base64', () => {
    expect(decodeBase64Maybe('SportsCenter')).toBe('SportsCenter');
    expect(decodeBase64Maybe(Buffer.from('SportsCenter').toString('base64'))).toBe('SportsCenter');
  });

  it('preserves separate Xtream event and EPG ids with raw metadata', () => {
    const raw = {
      id: 'event-42', epg_id: 'espn.us', title: 'SportsCenter', description: '',
      start: '2026-09-20T23:00:00Z', end: '2026-09-21T00:00:00Z', channel_id: 'provider-espn',
      subtitle: 'Late Edition', is_live: 1,
    };
    const program = mapXtreamEpgEntry(raw, 'live_71936');
    expect(program).toMatchObject({
      channel_id: 'live_71936', source: 'xtream', source_channel_id: 'provider-espn',
      provider_event_id: 'event-42', provider_epg_id: 'espn.us', title: 'SportsCenter',
      subtitle: 'Late Edition', is_live: 1, is_new: null, is_repeat: null,
      content_key: null,
    });
    expect(JSON.parse(program!.raw_metadata)).toMatchObject({ id: 'event-42', epg_id: 'espn.us' });
    expect(program!.airing_key).toBe(buildAiringKey('xtream', 'live_71936', 'event-42', program!.start_time, program!.stop_time));
  });

  it('uses provider Unix timestamps instead of timezone-less Xtream wall-clock strings', () => {
    const raw = {
      id: '354746', epg_id: '46', title: 'SportsCenter', description: '', channel_id: 'espn.us',
      start: '2026-09-24 21:00:00', end: '2026-09-24 21:30:00',
      start_timestamp: 1790283600, stop_timestamp: 1790285400,
    };
    const program = mapXtreamEpgEntry(raw, 'live_71936');
    expect(program?.start_time).toBe(Date.parse('2026-09-24T21:00:00Z'));
    expect(program?.stop_time).toBe(Date.parse('2026-09-24T21:30:00Z'));
  });

  it('extracts XMLTV subtitle, episode numbers, tri-state flags, original air date, and raw metadata', () => {
    const xml = `<tv><programme channel="espn" start="20260920230000 +0000" stop="20260921000000 +0000">
      <title>SportsCenter</title><sub-title>Late Edition</sub-title><desc>Highlights</desc>
      <category>Sports</category><category>News</category>
      <episode-num system="xmltv_ns">0.19.</episode-num><episode-num system="onscreen">S01E20</episode-num>
      <previously-shown start="20260919"/><live/></programme></tv>`;
    const [program] = parseEPG(xml, { now: Date.parse('2026-09-20T00:00:00Z'), horizonMs: 7 * 86400_000 });
    expect(program).toMatchObject({
      source: 'xmltv', source_channel_id: 'espn', title: 'SportsCenter', subtitle: 'Late Edition',
      is_repeat: 1, is_new: null, is_live: 1, original_air_date: '20260919', content_key: expect.any(String),
    });
    expect(JSON.parse(program.episode_numbers_json)).toEqual([
      { system: 'xmltv_ns', value: '0.19.' }, { system: 'onscreen', value: 'S01E20' },
    ]);
    expect(JSON.parse(program.categories_json)).toEqual(['Sports', 'News']);
    expect(program.raw_metadata).toContain('<programme');
  });

  it('never uses an XMLTV series id as episode content identity', () => {
    const xml = `<tv>
      <programme channel="espn" start="20260920230000 +0000" stop="20260921000000 +0000">
        <title>SportsCenter</title><series-id>sportscenter</series-id><new/>
      </programme>
      <programme channel="espn" start="20260921000000 +0000" stop="20260921010000 +0000">
        <title>SportsCenter</title><series-id>sportscenter</series-id>
        <episode-num system="xmltv_ns">0.19.</episode-num>
      </programme>
    </tv>`;
    const programs = parseEPG(xml, { now: Date.parse('2026-09-20T00:00:00Z'), horizonMs: 7 * 86400_000 });

    expect(programs[0]).toMatchObject({ content_key: null, is_new: null, is_repeat: null });
    expect(programs[1].content_key).toEqual(expect.any(String));
  });

  it('uses stable provider ids for moved airings and time for distinct id-less blocks', () => {
    const stable = buildAiringKey('xtream', 'live_1', 'evt', 1000, 2000);
    expect(buildAiringKey('xtream', 'live_1', 'evt', 3000, 4000)).toBe(stable);
    expect(buildAiringKey('xmltv', 'espn', null, 1000, 2000))
      .not.toBe(buildAiringKey('xmltv', 'espn', null, 2000, 3000));
  });
});
