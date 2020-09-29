# OADA/rules-worker

Library for exposing "actions" to the OADA Rules Engine.
For detailed constructor options, see the `Options` type in src/index.ts

## Basic Usage Example

```typescript
import { RulesWorker, Action } from '@oada/rules-worker';

new RulesWorker({
  name: 'test',
  conn /* @oada/client instance */,
  actions: [
    Action({
      name: 'foo',
      service: 'test',
      type: '*/*',
      description: 'do awesome action',
      async callback(item) {
        /* Do actual stuff here with item */
      },
    }),
  ],
});
```

## Actions with Input Options

Actions can have inputs beyond just the item the rule is operating on.
The library facilitates advertising these to the Rules Engine.

Below are two example of the two ways to specify action inputs.
Both examples are equivalent in regards to the rules engine.

### Automagical TypeScript way

This way is the most featureful approach if using TypeScript.
It will not work in JavaScript though.

```typescript
import { RulesWorker, Action } from '@oada/rules-worker';

// Create TypeScript class for typing action inputs
class Options {
  /**
   * This will not be exposed to the rules engine.
   * @description This will become the description of a in the rules engine
   * @default 1
   */
  a?: number; // an optional input

  /**
   *
   */
  b!: string; // a required input
}

new RulesWorker({
  name: 'test',
  conn /* @oada/client instance */,
  actions: [
    Action({
      name: 'foo',
      service: 'test',
      type: '*/*',
      class: Options /* Give the class to the action */,
      // Include inputs in action description
      description: 'do awesome action with a={{a}} and b={{b}}',
      // callback for actually implementing the action
      async callback(item, options) {
        // TypeScript will know options is of type Options
        options; // $ExpectType Options
        /* Do actual stuff here with item and options */
      },
    }),
  ],
});
```

### Supplying You Own Input Schema

This approach will work with both TypeScript and JavaScript.
The downside is that even in TypeScript you do not get a type for `options`.
The upside is that JSON Schema is what the Rules Engine actually uses,
and this approach gives finer control over the advertised input schema.

```typescript
import { JSONSchema8 as Schema } from 'jsonschema8';

import { RulesWorker, Action } from '@oada/rules-worker';

// JSON Schema for typing action inputs
const options: Schema = {
  required: ['b'], // Require b (but not a)
  properties: {
    // This will not be exposed to the rules engine.
    a: {
      description: 'This will become the description of a in the rules engine'
      default: 1,
      type: 'number'
    },
    b: {
      type: 'string'
    }
  }
}

new RulesWorker({
  name: 'test',
  conn, /* @oada/client instance */
  actions: [
    Action({
      name: 'foo',
      service: 'test',
      type: '*/*',
      params: options, /* Give the schema to the action */
      // Include inputs in action description
      description: 'do awesome action with a={{a}} and b={{b}}',
      // callback for actually implementing the action
      async callback(item, options) {
        // TypeScript will not know the type of options
        /* Do actual stuff here with item and options */
      },
    }),
  ],
});
```
