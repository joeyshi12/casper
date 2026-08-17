// Builds what the server package publishes:
//
//   server/dist/casper.js   launcher: checks the Node version, then loads the bundle
//   server/dist/server.js   the server, with @casper/shared inlined
//   server/dist/mcp\.js      the generative-UI MCP server kiro spawns over stdio
//   server/dist/web/        the built web app, served from beside the bundle
//   server/dist/agents/     the agent prompt, written into ~/.kiro on first run
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
const outDir = path.join(root, 'server', 'dist');

// The published package's own dependencies are exactly what must stay external.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
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

// Its own entry, because kiro spawns it as a separate stdio process.
await esbuild.build({
  entryPoints: [path.join(root, 'server/src/mcp/index.ts')],
  outfile: path.join(outDir, 'mcp.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external,
  define: { __CASPER_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
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

// files: ["dist/"] can't reach ../assets, so the prompt has to live inside the bundle.
// The rest of the agent file is an object literal in agentFile.ts, compiled in.
const promptSrc = path.join(root, 'assets/agents/prompt.txt');
if (!fs.existsSync(promptSrc)) throw new Error(`missing ${promptSrc}`);
fs.mkdirSync(path.join(outDir, 'agents'), { recursive: true });
fs.copyFileSync(promptSrc, path.join(outDir, 'agents/prompt.txt'));

// npm picks up README and LICENSE from the package directory only, and both live at
// the repo root - without copying them in, the npm page has no readme and the tarball
// ships no licence. Generated, so they're gitignored inside server/.
const pkgDir = path.join(root, 'server');
for (const file of ['README.md', 'LICENSE']) {
  const from = path.join(root, file);
  if (!fs.existsSync(from)) throw new Error(`missing ${from}`);
  fs.copyFileSync(from, path.join(pkgDir, file));
}

// Fail loudly rather than publishing a bundle that still needs the workspace.
const imports = Object.values(result.metafile.outputs)[0].imports.map((i) => i.path);
const leaked = imports.filter((i) => i.startsWith('@casper/'));
if (leaked.length > 0) {
  throw new Error(`workspace packages left as imports: ${leaked.join(', ')}`);
}

const bundleSize = fs.statSync(path.join(outDir, 'server.js')).size;
console.log(`bundled server/dist/server.js (${(bundleSize / 1024).toFixed(0)} KB), launcher at server/dist/casper.js`);
console.log(`bundled server/dist/mcp.js (${(fs.statSync(path.join(outDir, 'mcp.js')).size / 1024).toFixed(0)} KB)`);
console.log(`external: ${external.join(', ')}`);
