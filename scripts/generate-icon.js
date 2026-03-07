#!/usr/bin/env node
// Generates a simple SVG icon for StreamVault and converts to a placeholder PNG reference.
// For actual Tizen deployment, replace public/icon.png with a real 512x512 PNG.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0a0a1a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="64" fill="url(#bg)"/>
  <text x="256" y="280" font-family="Arial,sans-serif" font-size="180" font-weight="bold"
    fill="#00a8ff" text-anchor="middle" dominant-baseline="middle">SV</text>
</svg>`;

writeFileSync(resolve(dir, '../public/icon.svg'), svg);
console.log('Generated public/icon.svg');
console.log('Note: For Tizen packaging, convert to PNG: convert public/icon.svg public/icon.png');
