#!/usr/bin/env node
/**
 * Build script for Node.js Single Executable Application (SEA)
 *
 * Steps:
 *   1. Bundle ESM app into a single CJS file via esbuild
 *   2. Generate SEA blob from the bundle
 *   3. Copy Node binary and inject the blob
 *
 * Requires: Node.js 21.7+, esbuild, postject
 *
 * Usage:
 *   node scripts/build-sea.mjs
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const distDir = join(ROOT, 'dist');

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

console.log('📦 Building Node.js SEA bundle...');
console.log('   Node version:', process.version);

try {
  // ── Step 1: Bundle ESM → single CJS file via esbuild ──────────────────
  console.log('\n1. Bundling with esbuild...');
  const bundlePath = join(distDir, 'sea-bundle.cjs');

  execFileSync('npx', [
    'esbuild',
    join(ROOT, 'bin', 'ai-dashboard.js'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    `--outfile=${bundlePath}`,
    '--external:better-sqlite3',
    '--external:fsevents',
  ], { stdio: 'inherit', cwd: ROOT });

  // ── Step 2: Generate SEA blob ──────────────────────────────────────────
  console.log('\n2. Generating SEA blob...');
  const seaConfig = {
    main: bundlePath,
    output: join(distDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };

  const seaConfigPath = join(distDir, 'sea-config.json');
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    stdio: 'inherit', cwd: ROOT
  });

  // ── Step 3: Create executable ──────────────────────────────────────────
  const platform = process.platform;
  const arch = process.arch;
  const outName = platform === 'win32' ? 'ai-dashboard-win.exe'
    : platform === 'darwin' ? `ai-dashboard-macos-${arch}`
    : `ai-dashboard-linux-${arch}`;
  const outPath = join(distDir, outName);

  console.log(`\n3. Creating executable for ${platform}/${arch}...`);
  copyFileSync(process.execPath, outPath);

  // Remove existing signature (macOS)
  if (platform === 'darwin') {
    try {
      execFileSync('codesign', ['--remove-signature', outPath], { stdio: 'pipe' });
    } catch { /* codesign may not be available */ }
  }

  // ── Step 4: Inject the SEA blob ────────────────────────────────────────
  console.log('\n4. Injecting application blob...');
  const blobPath = join(distDir, 'sea-prep.blob');
  execFileSync('npx', [
    'postject', outPath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ], { stdio: 'inherit', cwd: ROOT });

  // Re-sign (macOS)
  if (platform === 'darwin') {
    try {
      execFileSync('codesign', ['--sign', '-', outPath], { stdio: 'pipe' });
    } catch { /* codesign may not be available */ }
  }

  console.log(`\n✅ Built: dist/${outName}`);
} catch (err) {
  console.error('\n❌ SEA build failed:', err.message);
  console.error('Requirements: Node.js 21.7+, esbuild, postject');
  process.exit(1);
}
