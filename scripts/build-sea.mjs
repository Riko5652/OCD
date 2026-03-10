#!/usr/bin/env node
/**
 * Build script for Node.js Single Executable Application (SEA)
 * Requires Node.js 21.7+ for stable SEA support
 *
 * Usage:
 *   node scripts/build-sea.mjs
 *
 * Output:
 *   dist/ai-dashboard-linux
 *   dist/ai-dashboard-macos
 *   dist/ai-dashboard-win.exe
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Ensure dist directory exists
const distDir = join(ROOT, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

// SEA configuration
const seaConfig = {
  main: join(ROOT, 'bin', 'ai-dashboard.js'),
  output: join(ROOT, 'dist', 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};

console.log('📦 Building Node.js SEA bundle...');
console.log('   Node version:', process.version);

const seaConfigPath = join(ROOT, 'dist', 'sea-config.json');
writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));

try {
  // Generate the SEA blob — use execFileSync (no shell) to avoid injection
  console.log('\n1. Generating SEA blob...');
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    stdio: 'inherit', cwd: ROOT
  });

  // Platform detection
  const platform = process.platform;
  const arch = process.arch;
  const outName = platform === 'win32' ? 'ai-dashboard-win.exe'
    : platform === 'darwin' ? `ai-dashboard-macos-${arch}`
    : `ai-dashboard-linux-${arch}`;
  const outPath = join(distDir, outName);

  // Copy Node binary using Node.js API (cross-platform, no shell)
  console.log(`\n2. Creating executable for ${platform}/${arch}...`);
  copyFileSync(process.execPath, outPath);

  // Remove existing signature (macOS)
  if (platform === 'darwin') {
    try {
      execFileSync('codesign', ['--remove-signature', outPath], { stdio: 'pipe' });
    } catch { /* codesign may not be available */ }
  }

  // Inject the SEA blob — use execFileSync with args array (no shell)
  console.log('\n3. Injecting application blob...');
  const blobPath = join(ROOT, 'dist', 'sea-prep.blob');
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
  console.log('\nInstall postject if not available: npm install -g postject');
} catch (err) {
  console.error('\n❌ SEA build failed:', err.message);
  console.error('Requirements: Node.js 21.7+, npm install -g postject');
  process.exit(1);
}
