import { JSONSchema8 as Schema } from 'jsonschema8'
import Bluebird from 'bluebird'
import Ajv from 'ajv'
import debug from 'debug'

import { ListWatch, Options as WatchOptions } from '@oada/list-lib'

const error = debug('rules-worker:error')
const ajv = new Ajv()

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
        rules: rulesTree.bookmarks.rules
      }
    }
  }
}

/**
 * Type for the inputs to the constructor
 *
 * @typeParam Service Don't worry about it, just let TS infer it
 */
export type Options<Service extends string> = {
  /**
   * The name of the OADA service to assiate with
   *
   * Should be a constant string
   */
  name: Service
  /**
   * An oada/client type connection
   */
  conn: WatchOptions<never>['conn']

  /**
   * Array of actions this service implements
   */
  actions?: ActionImplementor<Service>[]
  /**
   * Array of conditions this service implements
   */
  conditions?: Condition[]
}

// TODO: Add these to oada/types
/**
 * Possible parameters for an action/condition
 * @todo how to handle parameters?
 */
type Params = never & object
type Action = {
  /**
   * Name of the action
   */
  name: string
  /**
   * Name of the service implementing the action
   */
  service: string
  /**
   * Content-type this action works with?
   */
  type: string | string[]
  /**
   * Human description of the action
   * @todo How to handle parameters?
   */
  description: string
  /**
   * Parameters the action takes
   * @todo how to handle parameters?
   */
  params?: Params
}
/**
 * @todo Implement conditions
 */
type Condition = never & {
  /**
   * Name of the condition
   */
  name: string
  /**
   * Name of the service implementing the action
   */
  service: string
  /**
   * Content-type this condition works with?
   */
  type: string | string[]
  /**
   * Human description of the condition
   * @todo How to handle parameters?
   */
  description: string
  /**
   * Parameters the condition takes
   * @todo how to handle parameters?
   */
  params?: Params
}
// TODO: Work should link back to rule?
type Work = {
  /**
   * Content-type this work is on?
   */
  type: string
  service: string
  /**
   * The name of the action to perform
   */
  action: Action['name']
  /**
   * Parameters to send to action
   * @todo how to handle parametea,rs?
   */
  options: object
  /**
   * The OADA path to a list to work on
   */
  path: string
  /**
   * A JSON Schema to limit items to work on
   */
  schema: Schema
}

type Literal<T> = T extends string & infer R ? R : never
/**
 * Representation of an action we implement
 */
type ActionImplementor<Service extends string> = Action & {
  /**
   * Only implement our own actions
   */
  service: Literal<Service>
  /**
   * A callback for code to implement this action
   * @todo Better types parameters?
   */
  callback: (item: any, params: object) => Promise<void>
}

const GLOBAL_ROOT = '/bookmarks/rules'
const ACTIONS_PATH = 'actions'
const WORK_PATH = 'compiled'

/**
 * Class for exposing and implemention a worker for the "rules engine"
 */
export class RulesWorker<Service extends string> {
  public readonly path
  public readonly name
  public readonly actions: Map<
    Action['name'],
    ActionImplementor<Service>['callback']
  > = new Map()
  private conn
  private workWatch: ListWatch<Work>
  private work: Map<string, ListWatch> = new Map()

  constructor ({
    name,
    conn,
    actions = [],
    conditions = []
  }: Options<Service>) {
    this.name = name
    this.path = `/bookmarks/services/${name}/rules`
    this.conn = conn

    if (actions.length === 0 && conditions.length === 0) {
      throw new Error('This service registered neither actions nor conditions')
    }

    // Setup watch for receving work
    this.workWatch = new ListWatch({
      name,
      path: `${this.path}/${WORK_PATH}`,
      tree: serviceRulesTree,
      conn,
      // Reload all our work at startup
      resume: false,
      onItem: this.addWork.bind(this)
      // TODO: Handle deleting work
    })

    this.initialize(actions).catch(error)
  }

  /**
   * Do async part of initialization
   */
  private async initialize (actions: ActionImplementor<Service>[]) {
    const { conn } = this

    // Register our actions
    // TODO: Figure out if actions are already listed?
    for (const { name, callback, ...rest } of actions) {
      const action: Action = { name, ...rest }

      // TODO: Must be a bug in client if I need this?
      // Either that or I still don't understand trees
      // Probably both
      try {
        await conn.put({
          path: `${this.path}/${ACTIONS_PATH}`,
          tree: serviceRulesTree,
          data: {}
        })
      } catch {}

      // Register action in OADA
      const { headers } = await conn.put({
        path: `${this.path}/${ACTIONS_PATH}/${name}`,
        tree: serviceRulesTree,
        data: action as any
      })
      // Link action in global actions list?
      await conn.put({
        path: `${GLOBAL_ROOT}/${ACTIONS_PATH}`,
        tree: rulesTree,
        data: {
          [`${this.name}-${name}`]: {
            // TODO: Should this link be versioned?
            _id: headers['content-location'].substring(1)
          }
        }
      })

      // Keep the callback for later
      this.actions.set(name, callback)
    }
  }

  /**
   * Registers a "conditional watch" for a new piece of work
   */
  private async addWork ({ path, schema, action, options }: Work, id: string) {
    const { actions, name, conn } = this

    if (this.work.has(id)) {
      // TODO: Handle modifying exisitng work
    }

    // Compile schema
    const validator = ajv.compile(schema)

    // Register watch for this work
    const watch = new ListWatch({
      // Make sure each work has unique name?
      name: `${name}-work-${id}`,
      path,
      conn,
      // Only work on each item once
      resume: true,
      assertItem: item => {
        if (!validator(item)) {
          // TODO: Maybe throw something else
          throw validator.errors
        }
      },
      // TODO: Handle changes to items?
      onAddItem: item => {
        const cb = actions.get(action)
        if (!cb) {
          throw new Error(`Unsupported action ${action}`)
        }
        return cb(item, options)
      }
    })

    this.work.set(id, watch)
  }

  /**
   * Stop all of our watches
   */
  public async stop () {
    await this.workWatch.stop()
    await Bluebird.map(this.work, ([_, work]) => work.stop())
  }
}
