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
 * OADA Tree stuff?
 *
 * @internal
 * @packageDocumentation
 */

import pointer from 'json-pointer';

import type { Options } from './';

/**
 * Rules Tree
 * @todo What should _types be?
 *
 * Groups the various bits involved in the rule "engine"
 * /rules
 *  | List of descriptions of the actions a service implements
 *  /actions
 *  | List of descriptions of conditions a service implements
 *  /conditions
 *  | List of registered rules
 *  / configured
 *  | List of "compiled" inputs to be run by a worker
 *  /compiled
 */
export const rulesTree = <const>{
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    _rev: 0,
    rules: {
      _type: 'application/vnd.oada.rules.1+json',
      _rev: 0,
      actions: {
        '_type': 'application/vnd.oada.rules.actions.1+json',
        '_rev': 0,
        '*': {
          _type: 'application/vnd.oada.rules.action.1+json',
          _rev: 0,
        },
      },
      conditions: {
        '_type': 'application/vnd.oada.rules.conditions.1+json',
        '_rev': 0,
        '*': {
          _type: 'application/vnd.oada.rules.condition.1+json',
          _rev: 0,
        },
      },
      configured: {
        '_type': 'application/vnd.oada.rules.configured.1+json',
        '_rev': 0,
        '*': {
          _type: 'application/vnd.oada.rule.configured.1+json',
          _rev: 0,
        },
      },
      compiled: {
        '_type': 'application/vnd.oada.rules.compiled.1+json',
        '_rev': 0,
        '*': {
          _type: 'application/vnd.oada.rule.compiled.1+json',
          _rev: 0,
        },
      },
    },
  },
};

export const serviceRulesTree = <const>{
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    _rev: 0,
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      '_rev': 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        rules: rulesTree.bookmarks.rules,
      },
    },
  },
};

/**
 * Fill out tree one level at a time
 *
 * Client gets mad if too make levels of deep PUT don't exist.
 * @todo Must be an unimplemented feature in client if I need this?
 */
export async function fillTree(
  conn: Options<any, any, any>['conn'],
  tree: Record<string, unknown>,
  path: string
) {
  const p = pointer.parse(path);
  let l;
  for (l = 1; l <= p.length; l++) {
    await conn.put({
      path: pointer.compile(p.slice(0, l)),
      tree,
      data: {},
    });
  }
}
