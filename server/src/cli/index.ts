import { buildProgram } from './program.js';

// Commander has no notion of "unknown command" once a default command exists - it
// reports the stray word as an excess argument to that command, which reads as
// nonsense. So the defaults are filled in here instead, leaving commander to route
// only explicit commands and to complain accurately about the rest.
function withDefaults(argv: string[]): string[] {
  const args = argv.slice(2);
  if (args.length === 0) return [...argv, 'start'];
  if (args.length === 1 && args[0] === 'service') return [...argv, 'status'];
  return argv;
}

await buildProgram().parseAsync(withDefaults(process.argv));
