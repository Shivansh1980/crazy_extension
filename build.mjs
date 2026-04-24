import { mkdir, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

import manifest from './src/manifest.json' with { type: 'json' };

const isWatchMode = process.argv.includes('--watch');
const projectRoot = process.cwd();
const distDirectory = path.join(projectRoot, 'dist');

async function ensureStaticAssets() {
  await mkdir(distDirectory, { recursive: true });
  await cp(path.join(projectRoot, 'src', 'manifest.json'), path.join(distDirectory, 'manifest.json'));
  await cp(path.join(projectRoot, 'src', 'options', 'index.html'), path.join(distDirectory, 'options.html'));
  await cp(path.join(projectRoot, 'src', 'offscreen', 'index.html'), path.join(distDirectory, 'offscreen.html'));
  await cp(path.join(projectRoot, 'src', 'screen-share', 'index.html'), path.join(distDirectory, 'screen-share.html'));
}

async function runBuild() {
  await rm(distDirectory, { recursive: true, force: true });
  await ensureStaticAssets();

  const commonOptions = {
    entryPoints: {
      background: path.join(projectRoot, 'src', 'background', 'main.ts'),
      options: path.join(projectRoot, 'src', 'options', 'index.ts'),
      offscreen: path.join(projectRoot, 'src', 'offscreen', 'index.ts'),
      'screen-share': path.join(projectRoot, 'src', 'screen-share', 'index.ts')
    },
    bundle: true,
    format: 'esm',
    target: 'chrome128',
    sourcemap: true,
    outdir: distDirectory,
    define: {
      __EXTENSION_NAME__: JSON.stringify(manifest.name),
      __EXTENSION_VERSION__: JSON.stringify(manifest.version)
    },
    logLevel: 'info'
  };

  if (isWatchMode) {
    const context = await esbuild.context(commonOptions);
    await context.watch();
    console.log('Watching extension sources for changes...');
    return;
  }

  await esbuild.build(commonOptions);
}

runBuild().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
