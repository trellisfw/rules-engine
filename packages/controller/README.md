# @trellisfw/rules-controller

Library for configuring and controlling rules within
the Trellis Rules Engine.

## Basic Usage Example

```typescript
import type { Action, Condition } from '@oada/types';
import { connect } from '@oada/client';

import { RulesEngine } from '@trellisfw/rules-controller';

// Initialize the lib with a connection to OADA
const conn = await connect();
const engine = new RulesEngine({ conn });

/**
 * @todo Add functionality for fetching actions/conditions to rules-controller
 */
// Fetch an action
const { data: action } = await conn.get({
  path: '/bookmarks/services/foo/rules/actions/actionBar',
});
// Fetch a condition
const { data: conditon } = await conn.get({
  path: '/bookmarks/services/foo/rules/conditions/conditionBaz',
});

// Register a rule that runs `action` when `condition`
engine.register({
  type: 'application/vnd.foo.bar+json',
  path: '/bookmarks/foo',
  conditions: new Set([conditon as Condition]),
  actions: [action as Action],
});
```

## Full Docs

The latest full documentation of this library is available at
https://trellisfw.github.io/rules-engine/modules/controller

Alternatively, you can run the following at the root of the monorepo
to generate the docs:

```
yarn docs
```
