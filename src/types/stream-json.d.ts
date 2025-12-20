declare module 'stream-json' {
  import { Transform } from 'node:stream';
  export function parser(options?: unknown): Transform;
}

declare module 'stream-json/Assembler' {
  export default class Assembler {
    current: unknown;
    consume(chunk: unknown): void;
  }
}
