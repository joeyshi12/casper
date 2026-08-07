// Builds the single-package layout that gets published:
//
//   dist/casper.js   the server, with @casper/shared inlined
//   dist/web/        the built web app, served from beside the bundle
//
// The workspaces stay private, so @casper/shared can't be resolved from the
// registry - inlining it is what makes one publishable package possible. Real
// runtime dependencies stay external and declared, which matters most for pino:
// it loads transports in worker threads and breaks if bundled.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');

// The published package's own dependencies are exactly what must stay external.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

fs.rmSync(outDir, { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: [path.join(root, 'server/src/cli/index.ts')],
  outfile: path.join(outDir, 'server.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external,
  define: { __CASPER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
  metafile: true,
});

// The bin entry is the launcher, not the bundle: it checks the Node version before
// the bundle's node:sqlite import would fail at link time with nothing to explain it.
fs.copyFileSync(path.join(root, 'scripts/launcher.js'), path.join(outDir, 'casper.js'));
fs.chmodSync(path.join(outDir, 'casper.js'), 0o755);

const webSrc = path.join(root, 'web/dist');
if (!fs.existsSync(webSrc)) {
  throw new Error('web/dist is missing - run the web build before bundling');
}
fs.cpSync(webSrc, path.join(outDir, 'web'), { recursive: true });

// Fail loudly rather than publishing a bundle that still needs the workspace.
const imports = Object.values(result.metafile.outputs)[0].imports.map((i) => i.path);
const leaked = imports.filter((i) => i.startsWith('@casper/'));
if (leaked.length > 0) {
  throw new Error(`workspace packages left as imports: ${leaked.join(', ')}`);
}

const bundleSize = fs.statSync(path.join(outDir, 'server.js')).size;
console.log(`bundled dist/server.js (${(bundleSize / 1024).toFixed(0)} KB), launcher at dist/casper.js`);
console.log(`external: ${external.join(', ')}`);
