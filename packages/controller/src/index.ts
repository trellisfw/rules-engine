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

import type { JSONSchema8 as Schema } from 'jsonschema8';
import { is } from 'type-is';
import cloneDeep from 'clone-deep';
import pointer from 'json-pointer';
import KSUID from 'ksuid';

import type Action from '@oada/types/trellis/rules/action';
/**
 * @todo Implement conditions besides schemas
 */
import type Condition from '@oada/types/trellis/rules/condition';
import type Work from '@oada/types/trellis/rules/compiled';
import type Configured from '@oada/types/trellis/rules/configured';

import type { OADAClient } from '@oada/client';

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
const rulesTree = <const>{
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
const serviceRulesTree = <const>{
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
 * Values to assign to parameters
 */
interface Options {
  options?: Work['options'];
}
interface ActionInstance extends Action, Options {}
interface ConditionInstance extends Condition, Options {}

/**
 * A rule to be "compiled"
 */
export interface RuleInputs {
  type: Configured['type'];
  path: Configured['path'];
  on?: Configured['on'];
  // Represented as list in OADA?
  conditions: Set<Readonly<ConditionInstance>>;
  // Represented as list in OADA?
  actions: ReadonlyArray<Readonly<ActionInstance>>;
}

export interface EngineOptions {
  conn: OADAClient;
}
/**
 * Not sure this class is a good idea yet
 */
export class RulesEngine {
  #conn;

  constructor({ conn }: EngineOptions) {
    this.#conn = conn;
  }

  /**
   * Compile a rule and register its work with the appropriate workers
   *
   * @param rule Description of rule to compile and run
   */
  public async register(rule: RuleInputs) {
    const conn = this.#conn;

    // Compile rule
    const work = compile(rule);

    // Find all services involved
    const services = Array.from(
      new Set(
        [...rule.actions, ...rule.conditions]
          .map((x) => x.service)
          .filter((x) => Boolean(x)) as string[]
      )
    );

    // Create "configured" rule resource
    const configured: Configured = {
      services,
      enabled: true,
      type: rule.type,
      path: rule.path,
      actions: Object.fromEntries(
        rule.actions.map(({ _id, _rev, name, service, options }) => [
          `${service}-${name}`,
          {
            // Link to action resource
            action: {
              _id: _id as string,
              _rev: _rev as number,
            },
            options,
          },
        ])
      ),
      conditions: Object.fromEntries(
        Array.from(rule.conditions, ({ _id, _rev, name, service, options }) => [
          `${service}-${name}`,
          {
            // Link to condition resource
            condition: {
              _id: _id as string,
              _rev: _rev as number,
            },
            options,
          },
        ])
      ),
    };

    // Register rule in OADA
    // TODO: Link rule to actions and conditions instead of embedding them?
    const uuid = (await KSUID.random()).string;
    const { headers } = await conn.put({
      path: `/bookmarks/rules/configured/${uuid}`,
      tree: rulesTree,
      data: configured as any,
    });
    // List rule under the services?
    for (const service of services) {
      // TODO: Fix POSTing a link with client?
      await conn.put({
        path: `/bookmarks/services/${service}/rules/configured`,
        tree: serviceRulesTree,
        data: {
          [uuid.toString()]: {
            _id: headers['content-location'].slice(1),
            _rev: 0,
          },
        },
      });
    }

    // Register the work in OADA
    for (const piece of work) {
      await conn.post({
        path: `/bookmarks/services/${piece.service}/rules/compiled`,
        tree: serviceRulesTree,
        data: {
          ...piece,
          // Add a link to the rule this work is for
          rule: {
            _id: headers['content-location'].slice(1),
            _rev: 0,
          },
        } as any,
      });
    }
  }

  /**
   * Remove a rule from OADA along with its associated work
   *
   * @todo Implement this
   */
  public async unregister() {
    throw new Error('Not yet implemented');
  }
}

/**
 * "Compile" a rule to a set of runnable pieces of work
 *
 * @param rule the rule to be compiled
 * @param checkTypes Ensure that the types of the rule make sense
 * @returns An array of work that implement the rule
 */
export function compile(
  {
    path,
    type,
    /**
     * @default 'new'
     */
    on = 'new',
    conditions,
    actions,
  }: RuleInputs,
  /**
   * @default false
   */
  checkTypes = false
): Work[] {
  if (checkTypes) {
    // Check that types make sense
    try {
      for (const condition of conditions) {
        if (!is(type, ([] as string[]).concat(condition.type))) {
          throw new Error();
        }
      }

      for (const action of actions) {
        if (!is(type, ([] as string[]).concat(action.type))) {
          throw new Error();
        }
      }
    } catch {
      throw new Error('Types of conditions/actions do not align');
    }
  }

  // TODO: Implement multiple actions
  if (actions.length > 1) {
    throw new Error('Rules with multiple actions not yet implemented');
  }

  // "Compile conditions"
  const schema: Schema = { allOf: [] };
  for (const condition of conditions) {
    if (!condition.schema) {
      throw new Error('Non-schema conditions not yet implemented');
    }

    let sSchema = condition.schema as Record<string, unknown>;
    // Map inputs onto schema
    if (condition.options && condition.pointers) {
      sSchema = cloneDeep(condition.schema) as Record<string, unknown>;

      for (const [p, { name, iskey }] of Object.entries(condition.pointers)) {
        const pp = pointer.parse(p);
        const value = condition.options[name]! as string;

        if (iskey) {
          const oldval = pp.pop()!;
          // Copy child under new key
          pointer.set(sSchema, [...pp, value], pointer.get(sSchema, pp));
          // Unset old key
          pointer.set(sSchema, [...pp, oldval], undefined);
        } else {
          pointer.set(sSchema, pp, value);
        }
      }
    }

    schema.allOf!.push(sSchema as Schema);
  }

  // Handle no conditions?
  if (schema.allOf?.length === 0) {
    delete schema.allOf;
  }

  const [{ name, service, options }] = actions;
  return [
    {
      type,
      service,
      action: name,
      options,
      path,
      on,
      schema: schema as Work['schema'],
      // TODO: better way to handle this...
      rule: {
        // Empty link for now?
        _id: '',
        _rev: 0,
      },
    },
  ];
}
