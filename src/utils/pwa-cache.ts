/** API responses that are safe for the PWA runtime cache. */
export const CACHEABLE_API_PATTERN = /\/api\/(?!(?:status|config|programs|stream|live|proxy|remux|transcode|subtitles|recordings|recording-rules|recording-status|ios-hls|ios-hls-authorize|ios-hls-assets)(?:\/|\?|$))/i;
