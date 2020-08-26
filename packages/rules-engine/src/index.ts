import { JSONSchema8 as Schema } from 'jsonschema8'
import { is } from 'type-is'

import Action from '@oada/types/oada/rules/action'
/**
 * @todo Implement conditions besides schemas
 */
import Condition from '@oada/types/oada/rules/condition'
import Work from '@oada/types/oada/rules/compiled'

import type { OADAClient } from '@oada/client'

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
const rulesTree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    _rev: 0,
    rules: {
      _type: 'application/vnd.oada.rules.1+json',
      _rev: 0,
      actions: {
        _type: 'application/vnd.oada.rules.actions.1+json',
        _rev: 0,
        '*': {
          _type: 'application/vnd.oada.rules.action.1+json',
          _rev: 0
        }
      },
      conditions: {
        _type: 'application/vnd.oada.rules.conditions.1+json',
        _rev: 0,
        '*': {
          _type: 'application/vnd.oada.rules.condition.1+json',
          _rev: 0
        }
      },
      configured: {
        _type: 'application/vnd.oada.rules.configured.1+json',
        _rev: 0,
        '*': {
          _type: 'application/vnd.oada.rule.configured.1+json',
          _rev: 0
        }
      },
      compiled: {
        _type: 'application/vnd.oada.rules.compiled.1+json',
        _rev: 0,
        '*': {
          _type: 'application/vnd.oada.rule.compiled.1+json',
          _rev: 0
        }
      }
    }
  }
}
const serviceRulesTree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    _rev: 0,
    services: {
      _type: 'application/vnd.oada.services.1+json',
      _rev: 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        rules: rulesTree.bookmarks
      }
    }
  }
}

/**
 * Values to assign to parameters
 */
type Options = {
  options: Work['options']
}
type ActionInstance = Action & Options
type ConditionInstance = Condition & Options
/**
 * A rule to be "compiled"
 */
type RuleInputs = {
  type: string
  path: string
  // Represented as list in OADA?
  conditions: Set<ConditionInstance>
  // Represented as list in OADA?
  actions: ActionInstance[]
}

type EngineOptions = {
  conn: OADAClient
}
// Not sure this class is a good idea yet
export class RulesEngine {
  private conn

  constructor ({ conn }: EngineOptions) {
    this.conn = conn
  }

  /**
   * Compile a rule and register its work with the appropriate workers
   *
   * @param rule Description of rule to compile and run
   */
  public async register (rule: RuleInputs) {
    const { conn } = this

    // Compile rule
    const work = compile(rule)

    // Register rule in OADA
    // TODO: Link rule to actions and conditions instead of embedding them?
    const { headers } = await conn.post({
      path: '/bookmarks/rules/configured',
        tree: rulesTree,
      data: {
        enabled: true,
        ...rule
      } as any
    })

    // Register the work in OADA
    for (const piece of work) {
      await conn.post({
        path: `/bookmarks/services/${piece.service}/rules/compiled`,
        tree: serviceRulesTree,
        data: {
          // Add a link to the rule this work is for?
          rule: {
            _id: headers['content-location'].substring(1),
            _rev: 0
          },
          ...piece
        } as any
      })
    }
  }

  /**
   * Remove a rule from OADA along with its associated work
   *
   * @todo Implement this
   */
  public async unregister() {
    throw new Error('Not yet implemented')
  }
}

/**
 * "Compile" a rule to a set of runnable pieces of work
 *
 * @param rule then rule to be compiled
 * @param checkTypes Ensure that the types of the rule make sense
 * @returns An array of work that implement the rule
 */
export function compile (
  { path, type, conditions, actions }: RuleInputs,
  checkTypes: boolean = false
): Work[] {
  if (checkTypes) {
    // Check that types make sense
    try {
      for (const condition of conditions) {

        if (!is(type, ([] as string[]).concat(condition.type))) {
          throw new Error()
        }
      }
      for (const action of actions) {
        if (!is(type, ([] as string[]).concat(action.type))) {
          throw new Error()
        }
      }
    } catch (err) {
      throw new Error('Types of conditions/actions do not align')
    }
  }

  // TODO: Implement multiple actions
  if (actions.length > 1) {
    throw new Error('Rules with multiple actions not yet implemented')
  }

  // "Compile condtions"
  const schema: Schema = { allOf: [] }
  for (const condition of conditions) {
    if (!condition.schema) {
      throw new Error('Non-schema conditions not yet implemented')
    }

    schema.allOf!.push(condition.schema as Schema)
  }

  const { name, service, options } = actions[0]
  return [
    {
      type,
      service,
      action: name,
      options,
      path,
      schema
    } as Work
  ]
}
