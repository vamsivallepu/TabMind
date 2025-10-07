import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const distDir = 'dist';

// Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

// Bundle background.js
await esbuild.build({
  entryPoints: ['src/background.js'],
  bundle: true,
  outfile: 'dist/background.js',
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  sourcemap: false,
});

// Bundle popup.js
await esbuild.build({
  entryPoints: ['src/popup.js'],
  bundle: true,
  outfile: 'dist/popup.js',
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  sourcemap: false,
});

// Copy static files
copyFileSync('manifest.json', join(distDir, 'manifest.json'));
copyFileSync('popup.html', join(distDir, 'popup.html'));

console.log('✅ Build complete! Extension files are in the dist/ directory.');

