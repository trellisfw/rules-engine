import Bluebird from 'bluebird'
import Ajv from 'ajv'
import debug from 'debug'

import Rule, { assert as assertRule } from '@oada/types/oada/rules/configured'
import Action from '@oada/types/oada/rules/action'
import Condition from '@oada/types/oada/rules/condition'
import Work from '@oada/types/oada/rules/compiled'

import { ListWatch, Options as WatchOptions } from '@oada/list-lib'

const info = debug('rules-worker:info')
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
  callback: (item: any, options: Action['options']) => Promise<void>
}

const GLOBAL_ROOT = '/bookmarks/rules'
const ACTIONS_PATH = 'actions'
const WORK_PATH = 'compiled'

/**
 * Class for exposing and implemention a worker for the "rules engine"
 *
 * @typeParam Service Don't worry about it, just let TS infer it
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
  private work: Map<string, WorkRunner<Service>> = new Map()

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
      // TODO: Handle deleting work
      onItem: this.addWork.bind(this)
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
  private async addWork (work: Work, id: string) {
    const { actions, name, conn } = this

    if (this.work.has(id)) {
      // TODO: Handle modifying exisitng work
    }

    info(`Adding new work ${id}`)
    try {
      // TODO: Should WorkRunner do this too?
      const action = actions.get(work.action)
      if (!action) {
        throw new Error(`Unsupported action: ${work.action}`)
      }

      const workRunner = new WorkRunner(conn, `${name}-${action}`, work, action)

      await workRunner.init()
      this.work.set(id, workRunner)
    } catch (err: unknown) {
      error(`Error adding work ${id}: %O`, err)
      throw err
    }
  }

  /**
   * Stop all of our watches
   */
  public async stop () {
    await this.workWatch.stop()
    await Bluebird.map(this.work, ([_, work]) => work.stop())
  }
}

/**
 * Class for running a particular piece of compiled work
 * Track the corresponding rule and only actually does work if rule enabled.
 *
 * @todo I don't love this class...
 */
class WorkRunner<S extends string> {
  private conn
  /**
   * Compiled JSON Schema filter for this work
   */
  private validator
  /**
   * ListWatch for path of potential work
   */
  private workWatch?: ListWatch
  /**
   * Watch on corresponding rule so we can react to changes
   */
  private ruleWatch
  private _enabled
  public readonly name
  /**
   * Original compiled rule thing from OADA
   */
  public readonly work
  /**
   * Callback which implement the action involved in this work
   */
  private callback

  constructor (
    conn: Options<S>['conn'],
    name: string,
    work: Work,
    callback: ActionImplementor<S>['callback']
  ) {
    const { rule, schema } = work

    this.conn = conn
    this.name = name
    this.work = work
    this.callback = callback
    // Start disabled?
    this._enabled = false

    // Pre-compile schema
    this.validator = ajv.compile(schema)

    // Start watching our rule
    this.ruleWatch = conn.watch({
      path: rule._id,
      watchCallback: this.handleEnabled
    })
  }

  /**
   * Wait for watch on rule and start doing work if appropriate
   */
  public async init() {
    await this.ruleWatch
    const { data: rule } = await this.conn.get({path: this.work.rule._id})
    assertRule(rule)
    if (rule.enabled !== false) {
      await this.handleEnabled({ enabled: true })
    }
  }

  public get enabled () {
    return this._enabled
  }

  /**
   * Check for rule enabled status being changed
   * @todo handle rule being deleted
   * @todo can I just watch the enabled section of the rule? IDK OADA man
   */
  private async handleEnabled ({ enabled }: Partial<Rule>) {
    const {
      conn,
      name,
      work: { path, options },
      validator,
      callback
    } = this

    // See if enabled was included in this change to rule
    if (typeof enabled !== 'undefined') {
      // Check for "change" to same value
      if (enabled === this._enabled) {
        // Ignore change
        return
      }

      info(`Work ${name} set to ${enabled ? 'enabled' : 'disabled'}`)
      this._enabled = enabled
      if (enabled) {
        // Register watch for this work
        this.workWatch = new ListWatch({
          // Make sure each work has unique name?
          name,
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
          onAddItem: item => callback(item, options)
        })
      } else {
        await this.workWatch!.stop()
        // Get rid of stopped watch
        this.workWatch = undefined
      }
    }
  }

  /**
   * Stop all related watches
   */
  public async stop () {
    await this.workWatch?.stop()
    await this.conn.unwatch(await this.ruleWatch)
  }
}
