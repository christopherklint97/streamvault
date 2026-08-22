/**
 * AVPlay accepts remote media only as an absolute URL. Browser fetches can use
 * same-origin relative paths, so convert the StreamVault proxy path at the
 * player boundary without changing ordinary API requests.
 */
export function toAbsolutePlayerUrl(path: string, apiBaseUrl: string, pageOrigin = window.location.origin): string {
  return new URL(path, apiBaseUrl || pageOrigin).toString();
}

/** Endpoint that remuxes provider VOD into an iOS-compatible fragmented MP4. */
export function vodRemuxPath(channelId: string): string {
  return `/api/remux/${encodeURIComponent(channelId)}`;
}
