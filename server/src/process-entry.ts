/** Keep source-mode development and emitted production subprocesses separate. */
export function processEntrypoint(name: string, parentUrl: string): { url: URL; execArgv: string[] } {
  const sourceMode = new URL(parentUrl).pathname.endsWith('.ts');
  return {
    url: new URL(`./${name}.${sourceMode ? 'ts' : 'js'}`, parentUrl),
    execArgv: sourceMode ? ['--import', 'tsx'] : [],
  };
}
