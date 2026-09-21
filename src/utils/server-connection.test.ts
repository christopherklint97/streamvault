import { describe, expect, it } from 'vitest';
import { resolveBuildServerUrl, usesSameOriginApi } from './server-connection';

describe('resolveBuildServerUrl', () => {
  it('leaves public builds unbound when no server is configured', () => {
    expect(resolveBuildServerUrl({})).toBe('');
  });

  it('uses an explicitly configured URL or developer LAN IP', () => {
    expect(resolveBuildServerUrl({ VITE_SERVER_URL: 'https://streamvault.example' }))
      .toBe('https://streamvault.example');
    expect(resolveBuildServerUrl({ VITE_SERVER_URL: '' })).toBe('');
    expect(resolveBuildServerUrl({ VITE_SERVER_IP: '192.168.1.20' }))
      .toBe('http://192.168.1.20:3002');
  });
});

describe('usesSameOriginApi', () => {
  it('uses relative API paths only for an HTTP(S) app with no configured server', () => {
    expect(usesSameOriginApi('', 'http:')).toBe(true);
    expect(usesSameOriginApi('', 'https:')).toBe(true);
    expect(usesSameOriginApi('', 'file:')).toBe(false);
    expect(usesSameOriginApi('', 'widget:')).toBe(false);
    expect(usesSameOriginApi('http://192.168.1.20:3002', 'http:')).toBe(false);
  });
});
