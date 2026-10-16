/**
 * API responses that are safe for the PWA runtime cache: an allowlist of the
 * catalogue/metadata GET routes. Everything else (media delivery, archives,
 * player pages, health/status, config, DVR) must always hit the network.
 */
export const CACHEABLE_API_PATTERN = /\/api\/(?:browse|categories|channels|search|vod|series|epg)(?:\/|\?|$)/i;
