// Bundles the extension into dist/, which is the folder to load in chrome://extensions.
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  target: 'chrome116',
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: false,
};

const modules = {
  ...common,
  format: 'esm',
  entryPoints: {
    background: path.join(src, 'background/service-worker.js'),
    offscreen: path.join(src, 'offscreen/engine.js'),
    popup: path.join(src, 'popup/popup.js'),
    options: path.join(src, 'options/options.js'),
    recording: path.join(src, 'recording/recording.js'),
    'capture-worklet': path.join(src, 'worklets/capture.js'),
  },
  outdir: dist,
};

// Content scripts cannot be ES modules.
const scripts = {
  ...common,
  format: 'iife',
  entryPoints: {
    'page-hook': path.join(src, 'content/page-hook.js'),
    bridge: path.join(src, 'content/bridge.js'),
  },
  outdir: dist,
};

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await cp(path.join(src, 'manifest.json'), path.join(dist, 'manifest.json'));
  await cp(path.join(src, 'offscreen/offscreen.html'), path.join(dist, 'offscreen.html'));
  for (const page of ['popup', 'options', 'recording']) {
    await cp(path.join(src, `${page}/${page}.html`), path.join(dist, `${page}.html`));
    await cp(path.join(src, `${page}/${page}.css`), path.join(dist, `${page}.css`));
  }
  await cp(path.join(src, 'icons'), path.join(dist, 'icons'), { recursive: true });
  await cp(path.join(src, '_locales'), path.join(dist, '_locales'), { recursive: true });
}

await rm(dist, { recursive: true, force: true });
await copyStatic();
if (watch) {
  const contexts = await Promise.all([context(modules), context(scripts)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching src/ (static files are copied once; rerun for HTML/CSS changes).');
} else {
  await Promise.all([build(modules), build(scripts)]);
  console.log(`Built ${path.relative(root, dist)}/`);
}
