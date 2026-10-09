// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

describe('frontend compiler and runtime dependency split', () => {
  it('uses stable TypeScript 7 for the standard tsc build command', () => {
    const version = execFileSync(fileURLToPath(new URL('node_modules/.bin/tsc', root)), ['--version'], { encoding: 'utf8' });
    expect(version.trim()).toBe('Version 7.0.2');
    expect(manifest.devDependencies['@typescript/native']).toBe('npm:typescript@7.0.2');
  });

  it('keeps the TypeScript 6 JavaScript API available to ESLint without a tsc bin collision', () => {
    expect(manifest.devDependencies.typescript).toBe('npm:@typescript/typescript6@6.0.2');
    expect(require('typescript').version).toBe('6.0.3');
    const compatPackage = require('typescript/package.json');
    expect(Object.keys(compatPackage.bin)).toEqual(['tsc6']);
    const parserRequire = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
    expect(parserRequire.resolve('typescript')).toBe(require.resolve('typescript'));
  });

  it('ships Preact 10 and retains React only as development peer/type support', () => {
    expect(manifest.dependencies.preact).toBe('10.29.8');
    expect(manifest.dependencies).not.toHaveProperty('react');
    expect(manifest.dependencies).not.toHaveProperty('react-dom');
    expect(manifest.devDependencies.react).toBe('19.3.0');
    expect(manifest.devDependencies['react-dom']).toBe('19.3.0');
  });
});
