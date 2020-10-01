import Bluebird from 'bluebird';
import { join } from 'path';
import debug from 'debug';
import findRoot from 'find-root';
import _glob, { IOptions as GlobOptions } from 'glob';
import * as TJS from 'typescript-json-schema';
import type { JSONSchema8 as Schema } from 'jsonschema8';
import pointer from 'json-pointer';

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

type AllowSymbols<T> = {
  [K in keyof T]: T[K] | symbol;
};
export type InputSchema = AllowSymbols<Schema>;
/**
 * Used for creating Schemata with inputs.
 */
export function SchemaInput(name: string) {
  return Symbol(name);
}
/**
 * Processes a schema with `SchemaInput`s into form for Rules Engine.
 *
 * @see SchemaInput
 * @todo better name?
 */
function processSchema(
  inschema: InputSchema
): { paths: { path: string[]; iskey: boolean }[]; schema: Schema } {
  const paths: { path: string[]; iskey: boolean }[] = [];

  const keys = Object.getOwnPropertyNames(inschema);
  const inputKeys = Object.getOwnPropertySymbols(inschema);

  const schema: { [key: string]: any } = {};
  for (const key of inputKeys) {
    paths.push({ path: [key.toString()], iskey: true });
  }
  for (const key of [...keys, ...inputKeys]) {
    const val = (inschema as any)[key];
    if (typeof val === 'object') {
      const { schema: sschema, paths: ppaths } = processSchema(val);

      for (const { path, iskey } of ppaths) {
        paths.push({ path: [key.toString(), ...path], iskey });
      }
      schema[key.toString()] = sschema;
    } else {
      if (typeof val === 'symbol') {
        paths.push({ path: [key.toString()], iskey: false });
      }
      schema[key.toString()] = val.toString();
    }
  }

  return { schema, paths };
}
/**
 * Render a Schema with input to the format for Rules engine
 *
 * @see SchemaInput
 * @internal
 */
export function renderSchema(inschema: InputSchema) {
  const { paths, schema } = processSchema(inschema);

  const pointers: Record<string, boolean> = {};
  for (const { path, iskey } of paths) {
    pointers[pointer.compile(path)] = iskey;
  }

  return { pointers, schema };
}
