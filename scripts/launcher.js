#!/usr/bin/env node
// Copied to dist/casper.js and used as the bin entry.
//
// This stays out of the bundle deliberately. The bundle imports node:sqlite at the
// top level, and a missing builtin fails while the module graph is being linked -
// before any code in it runs - so a version check inside it could never report
// anything. Nothing is imported here, so this file always loads and can explain
// itself.
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 24) {
  process.stderr.write(
    `casper: Node 24 or newer is required (found ${process.version}).\n` +
      '  Casper stores its data with the built-in node:sqlite module, which older\n' +
      '  versions do not provide.\n',
  );
  process.exit(1);
}

const here = new URL('./server.js', import.meta.url);
import(here.href).catch((err) => {
  process.stderr.write(`casper: failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
