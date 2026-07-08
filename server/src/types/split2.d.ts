declare module 'split2' {
  import { Transform } from 'node:stream';
  function split2(matcher?: string | RegExp, mapper?: (line: string) => unknown): Transform;
  export = split2;
}
