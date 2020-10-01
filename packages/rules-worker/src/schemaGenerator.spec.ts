import { Schema } from '@oada/types';
import test from 'ava';

import { schemaGenerator, SchemaInput, renderSchema } from './schemaGenerator';

test('it should compile TS class to JSON Schema', async (t) => {
  /**
   * @description test test
   */
  abstract class TestClass {
    /**
     * @description foo bar
     */
    a: string = 'ss';
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
    // @ts-ignore
    type: SchemaInput('type'),
    properties: {
      a: {},
      [SchemaInput('prop')]: { type: 'integer' },
    },
  };

  const { schema, pointers } = renderSchema(inschema);

  t.deepEqual(schema, {
    // @ts-ignore
    type: 'Symbol(type)',
    properties: {
      'a': {},
      'Symbol(prop)': { type: 'integer' },
    },
  });
  t.deepEqual(pointers, {
    '/type': false,
    '/properties/Symbol(prop)': true,
  });
});
