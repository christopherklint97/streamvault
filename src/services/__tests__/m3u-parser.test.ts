import { describe, it, expect } from 'vitest';
import { parseM3U } from '../m3u-parser';

describe('parseM3U', () => {
  it('parses a normal playlist with multiple channels', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="Channel One" tvg-logo="http://example.com/logo1.png" group-title="News" tvg-country="US",Channel 1
http://stream.example.com/ch1.m3u8
#EXTINF:-1 tvg-id="ch2" tvg-name="Channel Two" tvg-logo="http://example.com/logo2.png" group-title="Sports",Channel 2
http://stream.example.com/ch2.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(2);

    expect(channels[0].name).toBe('Channel One');
    expect(channels[0].url).toBe('http://stream.example.com/ch1.m3u8');
    expect(channels[0].group).toBe('News');
    expect(channels[0].logo).toBe('http://example.com/logo1.png');
    expect(channels[0].region).toBe('US');
    expect(channels[0].isFavorite).toBe(false);
    expect(channels[0].id).toBeTruthy();

    expect(channels[1].name).toBe('Channel Two');
    expect(channels[1].url).toBe('http://stream.example.com/ch2.m3u8');
    expect(channels[1].group).toBe('Sports');
    expect(channels[1].logo).toBe('http://example.com/logo2.png');
  });

  it('returns empty array for empty string', () => {
    expect(parseM3U('')).toEqual([]);
  });

  it('returns empty array for header only', () => {
    expect(parseM3U('#EXTM3U\n')).toEqual([]);
  });

  it('handles malformed EXTINF with no comma', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="Test Channel"
http://stream.example.com/test.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Test Channel');
    expect(channels[0].url).toBe('http://stream.example.com/test.m3u8');
  });

  it('handles malformed EXTINF with missing attributes', () => {
    const content = `#EXTM3U
#EXTINF:-1,Bare Channel
http://stream.example.com/bare.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Bare Channel');
    expect(channels[0].logo).toBe('');
    expect(channels[0].group).toBe('Uncategorized');
    expect(channels[0].region).toBe('');
  });

  it('handles UTF-8 BOM', () => {
    const content = `\uFEFF#EXTM3U
#EXTINF:-1 tvg-name="BOM Channel",BOM Channel
http://stream.example.com/bom.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('BOM Channel');
  });

  it('handles Windows line endings (\\r\\n)', () => {
    const content = '#EXTM3U\r\n#EXTINF:-1 tvg-name="Win Channel",Win Channel\r\nhttp://stream.example.com/win.m3u8\r\n';

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Win Channel');
    expect(channels[0].url).toBe('http://stream.example.com/win.m3u8');
  });

  it('deduplicates by URL, keeping the first occurrence', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="First",First
http://stream.example.com/dup.m3u8
#EXTINF:-1 tvg-name="Second",Second
http://stream.example.com/dup.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('First');
  });

  it('skips non-standard directives like #EXTVLCOPT', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="VLC Channel",VLC Channel
#EXTVLCOPT:http-user-agent=MyAgent
http://stream.example.com/vlc.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('VLC Channel');
    expect(channels[0].url).toBe('http://stream.example.com/vlc.m3u8');
  });

  it('uses empty string for missing tvg-logo', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="No Logo",No Logo
http://stream.example.com/nologo.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].logo).toBe('');
  });

  it('preserves URLs with query parameters', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="Query Channel",Query Channel
http://stream.example.com/ch.m3u8?token=abc123&quality=high`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].url).toBe('http://stream.example.com/ch.m3u8?token=abc123&quality=high');
  });

  it('uses tvg-name over display name when tvg-name is set', () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-name="Official Name",Display Name
http://stream.example.com/name.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Official Name');
  });

  it('falls back to display name when tvg-name is not set', () => {
    const content = `#EXTM3U
#EXTINF:-1 group-title="Group",Fallback Name
http://stream.example.com/fallback.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Fallback Name');
  });

  it('skips a URL line without preceding EXTINF', () => {
    const content = `#EXTM3U
http://stream.example.com/orphan.m3u8
#EXTINF:-1 tvg-name="Valid",Valid
http://stream.example.com/valid.m3u8`;

    const channels = parseM3U(content);

    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Valid');
  });
});
