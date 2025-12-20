import * as fs from 'node:fs';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import { parser } from 'stream-json';
import Assembler from 'stream-json/Assembler';

/**
 * Parses a JSON file using a streaming parser to avoid loading the entire
 * payload into memory as a single string.
 */
export async function parseJsonFile<T>(filePath: string): Promise<T> {
  const readStream = fs.createReadStream(filePath);
  const pipeline = readStream.pipe(parser());
  const assembler = new Assembler();

  pipeline.on('data', (chunk: unknown) => assembler.consume(chunk));
  await finished(pipeline);

  return assembler.current as T;
}

/**
 * Resolves a path safely relative to the filesystem root to guard against
 * accidental directory traversal when working with temp files.
 */
export function resolveFile(filePath: string): string {
  return path.resolve(filePath);
}
