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
