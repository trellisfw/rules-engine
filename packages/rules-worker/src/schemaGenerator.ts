import Bluebird from 'bluebird';
import { join } from 'path';
import debug from 'debug';
import findRoot from 'find-root';
import _glob, { IOptions as GlobOptions } from 'glob';
import * as TJS from 'typescript-json-schema';

const trace = debug('rules-worker:trace');

/**
 * Promisified glob
 */
const glob = Bluebird.promisify<string[], string, GlobOptions>(_glob);

/**
 * Generates JSON schemata from TypeScript classes.
 * @internal
 */
export async function schemaGenerator(caller: string) {
  /**
   * Settings for the TypeScript to JSONSchema compiler
   */
  const compilerSettings: TJS.PartialArgs = {
    // Make required properties required in the schema
    required: true,
    ignoreErrors: true,
  };

  const root = findRoot(caller);
  trace(`Caller root: ${root}`);

  // Load TS compiler options for caller
  const {
    compilerOptions,
  }: { compilerOptions: TJS.CompilerOptions } = await import(
    join(root, 'tsconfig')
  );

  // Find TS files for program
  const files = await glob(join(compilerOptions.rootDir ?? '', '**', '*.ts'), {
    cwd: root,
  });
  const program = TJS.getProgramFromFiles(files, compilerOptions, root);

  const generator = TJS.buildGenerator(program, compilerSettings);

  return generator;
}
