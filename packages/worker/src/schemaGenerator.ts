/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Stuff for automagically generating JSON Schema from TS Class
 *
 * @internal
 * @packageDocumentation
 */

import Bluebird from 'bluebird';
import { join } from 'node:path';
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
  const { compilerOptions }: { compilerOptions: TJS.CompilerOptions } =
    await import(join(root, 'tsconfig'));

  // Find TS files for program
  const files = await glob(join(compilerOptions.rootDir ?? '', '**', '*.ts'), {
    cwd: root,
  });
  const program = TJS.getProgramFromFiles(files, compilerOptions, root);

  return TJS.buildGenerator(program, compilerSettings);
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
 * Description of a path into a JSON Schema where an input should be applied.
 */
export interface InputPath {
  path: string[];
  name: string;
  iskey: boolean;
}
/**
 * Processes a schema with `SchemaInput`s into form for Rules Engine.
 *
 * @see SchemaInput
 * @todo better name?
 */
function processSchema(inSchema: InputSchema): {
  paths: InputPath[];
  schema: Record<string, unknown> | any[];
} {
  const paths: InputPath[] = [];

  const keys = Object.getOwnPropertyNames(inSchema);
  const inputKeys = Object.getOwnPropertySymbols(inSchema);

  const schema: Record<string, any> = {};
  for (const key of inputKeys) {
    paths.push({ path: [key.toString()], name: key.description!, iskey: true });
  }

  for (const key of [...keys, ...inputKeys]) {
    const value = (inSchema as any)[key];
    if (typeof value === 'object') {
      const { schema: sSchema, paths: pPaths } = processSchema(value);

      for (const { path, name, iskey } of pPaths) {
        paths.push({ path: [key.toString(), ...path], name, iskey });
      }

      schema[key.toString()] = sSchema;
    } else {
      if (typeof value === 'symbol') {
        paths.push({
          path: [key.toString()],
          name: value.description!,
          iskey: false,
        });
      }

      schema[key.toString()] = value.toString();
    }
  }

  if (Array.isArray(inSchema)) {
    return { schema: Array.from(schema as ArrayLike<any>), paths };
  }

  return { schema, paths };
}

/**
 * Render a Schema with input to the format for Rules engine
 *
 * @see SchemaInput
 * @internal
 */
export function renderSchema(inSchema: InputSchema) {
  const { paths, schema } = processSchema(inSchema);

  const pointers: Record<string, Omit<InputPath, 'path'>> = {};
  for (const { path, name, iskey } of paths) {
    pointers[pointer.compile(path)] = { name, iskey };
  }

  return { pointers, schema };
}
