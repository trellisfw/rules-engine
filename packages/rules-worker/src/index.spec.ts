import test from 'ava';

import { createStub } from './conn-stub';
import { RulesWorker, Action } from './';

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

  await it.initialized;

  const { callback, ...data } = action;
  t.is(
    conn.put.calledWithMatch(
      // @ts-ignore
      { path: `${it.path}/actions/${action.name}`, data }
    ),
    true
  );
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
      // @ts-ignore
      { path: '/bookmarks/rules/actions' }
    ),
    true
  );
});

test.todo('it should add work from rules engine');
