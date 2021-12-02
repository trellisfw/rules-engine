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

import test from 'ava';
import sinon from 'sinon';

import { createStub } from './conn-stub';
import { Action, Condition, RulesWorker } from './';

test('it should constrcut', (t) => {
  new RulesWorker({
    name: 'test',
    conn: createStub(),
    actions: [
      Action({
        service: 'test',
        type: '*/*',
        name: 'test-action',
        description: 'do test action',
        async callback() {},
      }),
    ],
  });

  t.pass();
});

test('it should error when nothing to implent', (t) => {
  try {
    new RulesWorker({
      name: 'test',
      conn: createStub(),
      // Has neither actions nor conditions
      actions: [],
      conditions: [],
    });

    t.fail();
  } catch {
    t.pass();
  }
});

test('it should communicate action to rules engine under service', async (t) => {
  const conn = createStub();
  const action = Action({
    service: 'test',
    type: '*/*',
    name: 'test-action',
    description: 'do test action',
    async callback() {},
  });

  const it = new RulesWorker({
    name: 'test',
    conn,
    actions: [action],
  });

  const stub = conn.put.withArgs(
    sinon.match({ path: `${it.path}/actions/${action.name}` })
  );
  await it.initialized;

  const { data } = stub.getCall(0)?.firstArg;
  const { callback, ...rest } = action;

  t.deepEqual(data, rest);
});

test('it should communicate action to rules engine globally', async (t) => {
  const conn = createStub();
  const action = Action({
    service: 'test',
    type: '*/*',
    name: 'test-action',
    description: 'do test action',
    async callback() {},
  });

  const it = new RulesWorker({
    name: 'test',
    conn,
    actions: [action],
  });

  await it.initialized;

  t.is(
    conn.put.calledWithMatch(
      // @ts-expect-error
      { path: '/bookmarks/rules/actions' }
    ),
    true
  );
});

test('it should handle schema inputs', async (t) => {
  class Inputs {
    a?: string = 'foo';
    b!: number;
  }

  const conn = createStub();
  const condition = Condition({
    service: 'test',
    name: 'test',
    description: 'test',
    class: Inputs,
    type: '*/*',
    schema({ a, b }) {
      return {
        type: 'object',
        properties: { a: { const: a }, b: { type: 'number', minimum: b } },
      };
    },
  });

  const it = new RulesWorker({
    name: 'test',
    conn,
    conditions: [condition],
  });

  const stub = conn.put.withArgs(
    sinon.match({ path: `${it.path}/conditions/${condition.name}` })
  );
  await it.initialized;

  const { data } = stub.getCall(0)?.firstArg;
  const { schema, class: _, ...rest } = condition;

  t.deepEqual(data, {
    params: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['b'],
      properties: {
        a: {
          type: 'string',
          default: 'foo',
        },
        b: {
          type: 'number',
        },
      },
    },
    pointers: {
      '/properties/a/const': { name: 'a', iskey: false },
      '/properties/b/minimum': { name: 'b', iskey: false },
    },
    schema: {
      type: 'object',
      properties: {
        a: { const: 'Symbol(a)' },
        b: { type: 'number', minimum: 'Symbol(b)' },
      },
    },
    ...rest,
  });
});

test.todo('it should add work from rules engine');

// Had an error with work trying to run before processing actions/conditions
test.todo('it should handle pre-existing work from rules engine');
