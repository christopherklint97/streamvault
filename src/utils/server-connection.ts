type ServerBuildEnvironment = Readonly<Record<string, string | undefined>>;

/** Resolve the API URL embedded in a frontend build without leaking build-host addresses. */
export function resolveBuildServerUrl(env: ServerBuildEnvironment): string {
  if (env.VITE_SERVER_URL !== undefined) return env.VITE_SERVER_URL;
  return env.VITE_SERVER_IP ? `http://${env.VITE_SERVER_IP}:3002` : '';
}

/** Relative API paths are valid for a hosted PWA, but not a local Tizen widget. */
export function usesSameOriginApi(defaultServerUrl: string, protocol: string): boolean {
  return defaultServerUrl.length === 0 && (protocol === 'http:' || protocol === 'https:');
}
