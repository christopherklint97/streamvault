// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { frontendAliases } from '../../build/frontend-aliases';
import viteConfig from '../../vite.config';
import vitestConfig from '../../vitest.config';

function replacementFor(id: string): string {
  if (!Array.isArray(frontendAliases)) throw new Error('Expected explicit frontend alias entries');
  const alias = frontendAliases.find(({ find }) => typeof find === 'string' ? find === id : find.test(id));
  return alias ? id.replace(alias.find, alias.replacement) : id;
}

describe('shared production and test renderer aliases', () => {
  it.each(['production', 'tizen', 'tizen5'])('uses the same alias table for %s builds and Vitest', (mode) => {
    const config = viteConfig({ mode, command: 'build' });
    expect(config.resolve?.alias).toBe(frontendAliases);
    expect(vitestConfig.resolve?.alias).toBe(frontendAliases);
  });

  it.each([
    ['react', 'preact/compat'],
    ['react-dom', 'preact/compat'],
    ['react-dom/client', 'preact/compat/client'],
    ['react-dom/server', 'preact/compat/server'],
    ['react-dom/test-utils', 'preact/test-utils'],
    ['react/jsx-runtime', 'preact/jsx-runtime'],
    ['react/jsx-dev-runtime', 'preact/jsx-dev-runtime'],
  ])('maps %s explicitly to %s', (id, replacement) => {
    expect(replacementFor(id)).toBe(replacement);
  });

  it.each(['react-extra', 'react-dom-extra', 'react/jsx-runtime-extra', 'react-dom/client-extra'])('does not rewrite the unrelated module %s', (id) => {
    expect(replacementFor(id)).toBe(id);
  });
});
