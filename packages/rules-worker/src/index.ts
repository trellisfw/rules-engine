import Bluebird from 'bluebird';
import Ajv from 'ajv';
import debug from 'debug';
import { JSONSchema8 as Schema } from 'jsonschema8';
import * as TJS from 'typescript-json-schema';
import getCallerFile from 'get-caller-file';
import findRoot from 'find-root';
import { join } from 'path';
import _glob, { IOptions as GlobOptions } from 'glob';

import Rule, { assert as assertRule } from '@oada/types/oada/rules/configured';
import type Action from '@oada/types/oada/rules/action';
import type Condition from '@oada/types/oada/rules/condition';
import type Work from '@oada/types/oada/rules/compiled';

import { ListWatch, Options as WatchOptions } from '@oada/list-lib';

const info = debug('rules-worker:info');
const trace = debug('rules-worker:trace');
const error = debug('rules-worker:error');
const ajv = new Ajv();

/**
 * Promisified glob
 */
const glob = Bluebird.promisify<string[], string, GlobOptions>(_glob);

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
const serviceRulesTree = {
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
 * Type for the inputs to the constructor
 *
 * @typeParam Service Don't worry about it, just let TS infer it
 */
export type Options<
  Service extends string,
  Actions extends readonly ActionImplementor<Service, unknown>[]
> = {
  /**
   * The name of the OADA service to assiate with
   *
   * Should be a constant string
   */
  name: Service;
  /**
   * An oada/client type connection
   */
  conn: WatchOptions<unknown>['conn'];

  /**
   * Array of actions this service implements
   */
  actions?: Actions;
  /**
   * Array of conditions this service implements
   *
   * @todo Implement worker provided conditions
   */
  conditions?: Condition[];
};

/**
 * Do magic with type inference stuff.
 */
type Literal<T> = T extends string & infer R ? R : never;

/**
 * Representation of an action we implement
 */
export interface ActionImplementor<Service extends string, Params = never>
  extends Action {
  /**
   * Only implement our own actions
   */
  service: Service;
  /**
   * Limit types of our parameters
   *
   * MUST be a TypeScript `class` (i.e., not an `interface` or `type`)
   * and MUST be named (i.e., not an anonymous class)
   *
   * @experimental It is more stable and performant to provide `params`
   * @see params
   */
  class?: Params extends never ? never : { new (): Params };
  /**
   * A callback for code to implement this action
   * @todo Better types parameters?
   */
  callback: (item: any, options: Params) => Promise<void>;
}

/**
 * Lets TypeScript do more inference magic on Actions
 *
 * @todo Figure out how to infer better without this function
 */
export function Action<S extends string, T = unknown>(
  action: ActionImplementor<S, T>
) {
  return action;
}

const GLOBAL_ROOT = '/bookmarks/rules';
const ACTIONS_PATH = 'actions';
const WORK_PATH = 'compiled';

/**
 * Class for exposing and implemention a worker for the "rules engine"
 *
 * @typeParam Service Don't worry about it, just let TS infer it
 */
export class RulesWorker<
  Service extends string,
  Actions extends readonly ActionImplementor<Service, any>[]
> {
  public readonly path;
  public readonly name;
  public readonly actions: Map<
    Action['name'],
    Actions[0]['callback']
  > = new Map();

  #conn;
  #workWatch: ListWatch<Work>;
  #work: Map<string, WorkRunner<Service, {}>> = new Map();

  constructor({ name, conn, actions, conditions }: Options<Service, Actions>) {
    this.name = name;
    this.path = `/bookmarks/services/${name}/rules`;
    this.#conn = conn;

    const caller = getCallerFile();

    if (!actions?.length && !conditions?.length) {
      throw new Error('This service registered neither actions nor conditions');
    }

    // Setup watch for receving work
    this.#workWatch = new ListWatch({
      name,
      path: `${this.path}/${WORK_PATH}`,
      tree: serviceRulesTree,
      conn,
      // Reload all our work at startup
      resume: false,
      // TODO: Handle deleting work
      onItem: this.addWork.bind(this),
    });

    this.initialize(actions!, caller).catch(error);
  }

  /**
   * Do async part of initialization
   */
  private async initialize(actions: Actions, caller: string) {
    const conn = this.#conn;

    trace(`Initializing with caller`, caller);
    const root = findRoot(caller);
    trace(`Caller root: ${root}`);

    // Load TS compiler options for caller
    const {
      compilerOptions,
    }: { compilerOptions: TJS.CompilerOptions } = await import(
      join(root, 'tsconfig')
    );
    // Find TS files for program
    const files = await glob(
      join(compilerOptions.rootDir ?? '', '**', '*.ts'),
      {
        cwd: root,
      }
    );

    /**
     * Settings for the TypeScript to JSONSchema compiler
     */
    const compilerSettings: TJS.PartialArgs = {
      // Make required properties required in the schema
      required: true,
      ignoreErrors: true,
    };
    const program = TJS.getProgramFromFiles(files, compilerOptions, root);
    trace(`TS options: %O`, program.getCompilerOptions());

    // Register our actions
    // TODO: Figure out if actions are already listed?
    for (const { name, class: _class, callback, ...rest } of actions) {
      const action: Action = { name, ...rest };

      // TODO: Hacky magic
      // This is for when params is a class constructor
      if (_class) {
        const type = _class.name;

        info(`Generating action ${name} parameter schema ${type}`);
        const schema = TJS.generateSchema(program, type, compilerSettings);
        if (!schema) {
          throw new Error(
            `Failed to generate parameter schema for action ${name}, class ${type}`
          );
        }
        trace(`Generated action ${name} parameter schema ${type}: %O`, schema);

        // @ts-ignore
        action.params = schema as Schema;
      }

      // TODO: Must be an unimplemented feature in client if I need this?
      // Either that or I still don't understand trees
      // Probably both
      try {
        await conn.put({
          path: `${this.path}/${ACTIONS_PATH}`,
          tree: serviceRulesTree,
          data: {},
        });
      } catch {}

      // Register action in OADA
      const { headers } = await conn.put({
        path: `${this.path}/${ACTIONS_PATH}/${name}`,
        tree: serviceRulesTree,
        data: action as any,
      });
      // Link action in global actions list?
      await conn.put({
        path: `${GLOBAL_ROOT}/${ACTIONS_PATH}`,
        tree: rulesTree,
        data: {
          [`${this.name}-${name}`]: {
            // TODO: Should this link be versioned?
            _id: headers['content-location'].substring(1),
          },
        },
      });

      // Keep the callback for later
      this.actions.set(name, callback);
    }
  }

  /**
   * Registers a "conditional watch" for a new piece of work
   */
  private async addWork(work: Work, id: string) {
    const { actions, name } = this;
    const conn = this.#conn;

    if (this.#work.has(id)) {
      // TODO: Handle modifying exisitng work
    }

    info(`Adding new work ${id}`);
    try {
      // TODO: Should WorkRunner do this too?
      const action = actions.get(work.action);
      if (!action) {
        throw new Error(`Unsupported action: ${work.action}`);
      }

      const workRunner = new WorkRunner(
        conn,
        `${name}-${action}`,
        work,
        action
      );

      await workRunner.init();
      this.#work.set(id, workRunner);
    } catch (err: unknown) {
      error(`Error adding work ${id}: %O`, err);
      throw err;
    }
  }

  /**
   * Stop all of our watches
   */
  public async stop() {
    await this.#workWatch.stop();
    await Bluebird.map(this.#work, ([_, work]) => work.stop());
  }
}

/**
 * Class for running a particular piece of compiled work
 * Track the corresponding rule and only actually does work if rule enabled.
 *
 * @todo I don't love this class...
 */
class WorkRunner<S extends string, P extends {}> {
  private conn;
  /**
   * Compiled JSON Schema filter for this work
   */
  private validator;
  /**
   * ListWatch for path of potential work
   */
  private workWatch?: ListWatch;
  /**
   * Watch on corresponding rule so we can react to changes
   */
  private ruleWatch;
  private _enabled;
  public readonly name;
  /**
   * Original compiled rule thing from OADA
   */
  public readonly work;
  /**
   * Callback which implements the action involved in this work
   */
  private callback;

  constructor(
    conn: Options<S, []>['conn'],
    name: string,
    work: Work,
    callback: ActionImplementor<S, P>['callback']
  ) {
    const { rule, schema } = work;

    this.conn = conn;
    this.name = name;
    this.work = work;
    this.callback = callback;
    // Start disabled?
    this._enabled = false;

    // Pre-compile schema
    this.validator = ajv.compile(schema);

    // Start watching our rule
    this.ruleWatch = conn.watch({
      path: rule._id,
      watchCallback: this.handleEnabled,
    });
  }

  /**
   * Wait for watch on rule and start doing work if appropriate
   */
  public async init() {
    await this.ruleWatch;
    const { data: rule } = await this.conn.get({ path: this.work.rule._id });
    assertRule(rule);
    if (rule.enabled !== false) {
      await this.handleEnabled({ enabled: true });
    }
  }

  public get enabled() {
    return this._enabled;
  }

  /**
   * Check for rule enabled status being changed
   * @todo handle rule being deleted
   * @todo can I just watch the enabled section of the rule? IDK OADA man
   */
  private async handleEnabled({ enabled }: Partial<Rule>) {
    const {
      conn,
      name,
      work: { path, options },
      validator,
      callback,
    } = this;

    // See if enabled was included in this change to rule
    if (typeof enabled !== 'undefined') {
      // Check for "change" to same value
      if (enabled === this._enabled) {
        // Ignore change
        return;
      }

      info(`Work ${name} set to ${enabled ? 'enabled' : 'disabled'}`);
      this._enabled = enabled;
      if (enabled) {
        // Register watch for this work
        this.workWatch = new ListWatch({
          // Make sure each work has unique name?
          name,
          path,
          conn,
          // Only work on each item once
          resume: true,
          assertItem: (item) => {
            if (!validator(item)) {
              // TODO: Maybe throw something else
              throw validator.errors;
            }
          },
          // TODO: Handle changes to items?
          onAddItem: (item) => callback(item, options as Literal<P>),
        });
      } else {
        await this.workWatch!.stop();
        // Get rid of stopped watch
        this.workWatch = undefined;
      }
    }
  }

  /**
   * Stop all related watches
   */
  public async stop() {
    await this.workWatch?.stop();
    await this.conn.unwatch(await this.ruleWatch);
  }
}
