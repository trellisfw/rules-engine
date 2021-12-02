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

import { JSONSchema8 as Schema } from 'jsonschema8';
import test from 'ava';

import { SchemaInput, renderSchema, schemaGenerator } from './schemaGenerator';

test('it should compile TS class to JSON Schema', async (t) => {
  /**
   * @description test test
   */
  abstract class TestClass {
    /**
     * @description foo bar
     */
    a = 'ss';
    /**
     * @type integer
     * @default 0
     */
    b?: number;
    c?: { a: 1; b: 'b' };
  }

  const schemaGen = await schemaGenerator(__filename);

  const testSchema = schemaGen?.getSchemaForSymbol(TestClass.name);

  t.deepEqual(testSchema, {
    $schema: 'http://json-schema.org/draft-07/schema#',
    description: 'test test',
    type: 'object',
    required: ['a'],
    properties: {
      a: { description: 'foo bar', type: 'string', default: 'ss' },
      b: { type: 'integer', default: 0 },
      c: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: { type: 'number', enum: [1] },
          b: { type: 'string', enum: ['b'] },
        },
      },
    },
  });
});

test('it should render schema with inputs', (t) => {
  const inschema: Schema = {
    // @ts-expect-error
    type: SchemaInput('type'),
    properties: {
      a: {
        enum: [
          // @ts-expect-error
          SchemaInput('a'),
        ],
      },
      [SchemaInput('prop')]: { type: 'integer' },
    },
  };

  const { schema, pointers } = renderSchema(inschema);

  t.deepEqual(schema, {
    type: 'Symbol(type)',
    properties: {
      'a': { enum: ['Symbol(a)'] },
      'Symbol(prop)': { type: 'integer' },
    },
  });
  t.deepEqual(pointers, {
    '/type': { name: 'type', iskey: false },
    '/properties/a/enum/0': { name: 'a', iskey: false },
    '/properties/Symbol(prop)': { name: 'prop', iskey: true },
  });
});
