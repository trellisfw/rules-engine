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
 * @internal
 */
declare module 'json-pointer' {
  function set(
    object: object,
    pointer: string | readonly string[],
    value: any
  ): void;
  function get(object: object, pointer: string | readonly string[]): unknown;
}

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
  actions: readonly Readonly<ActionInstance>[];
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
    const services = [
      ...new Set(
        [...rule.actions, ...rule.conditions]
          .map((x) => x.service)
          .filter((x) => !!x) as string[]
      ),
    ];

    // Create "configured" rule resource
    const configured: Configured = {
      services,
      enabled: true,
      type: rule.type,
      path: rule.path,
      actions: rule.actions.reduce(
        (out, { _id, _rev, name, service, options }) => ({
          ...out,
          [`${service}-${name}`]: {
            // Link to action resource
            action: {
              _id,
              _rev,
            },
            options,
          },
        }),
        {}
      ),
      conditions: [...rule.conditions].reduce(
        (out, { _id, _rev, name, service, options }) => ({
          ...out,
          [`${service}-${name}`]: {
            // Link to condition resource
            condition: {
              _id,
              _rev,
            },
            options,
          },
        }),
        {}
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
            _id: headers['content-location'].substring(1),
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
            _id: headers['content-location'].substring(1),
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
  checkTypes: boolean = false
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
    } catch (err) {
      throw new Error('Types of conditions/actions do not align');
    }
  }

  // TODO: Implement multiple actions
  if (actions.length > 1) {
    throw new Error('Rules with multiple actions not yet implemented');
  }

  // "Compile condtions"
  const schema: Schema = { allOf: [] };
  for (const condition of conditions) {
    if (!condition.schema) {
      throw new Error('Non-schema conditions not yet implemented');
    }

    let sschema = condition.schema as object;
    // Map inputs onto schema
    if (condition.options && condition.pointers) {
      sschema = cloneDeep(condition.schema) as object;

      Object.entries(condition.pointers).forEach(([p, { name, iskey }]) => {
        const pp = pointer.parse(p);
        const val = condition.options![name]! as string;

        if (iskey) {
          const oldval = pp.pop()!;
          // Copy child under new key
          pointer.set(sschema, [...pp, val], pointer.get(sschema, pp));
          // Unset old key
          pointer.set(sschema, [...pp, oldval], undefined);
        } else {
          pointer.set(sschema, pp, val);
        }
      });
    }

    schema.allOf!.push(sschema as Schema);
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
        _rev: '',
      },
    },
  ];
}
