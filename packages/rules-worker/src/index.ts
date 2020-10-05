import Bluebird from 'bluebird';
import debug from 'debug';
import getCallerFile from 'get-caller-file';

import type Action from '@oada/types/oada/rules/action';
import type Condition from '@oada/types/oada/rules/condition';
import type Work from '@oada/types/oada/rules/compiled';

import { ListWatch, Options as WatchOptions } from '@oada/list-lib';

import { fillTree, rulesTree, serviceRulesTree } from './trees';
import { renderSchema, schemaGenerator } from './schemaGenerator';
import { WorkRunner } from './WorkRunner';
import { JSONSchema8 as Schema } from 'jsonschema8';

const info = debug('rules-worker:info');
const trace = debug('rules-worker:trace');
const error = debug('rules-worker:error');

/**
 * Type for the inputs to the constructor
 *
 * @typeParam Service Don't worry about it, just let TS infer it
 */
export type Options<
  Service extends string,
  Actions extends readonly ActionImplementor<Service, unknown>[],
  Conditions extends readonly ConditionImplementor<Service, unknown>[]
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
  conditions?: Conditions;
};

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

/**
 * Representation of an action we implement
 */
// @ts-ignore
export interface ConditionImplementor<Service extends string, Params = never>
  extends Condition {
  /**
   * Only implement our own conditions
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
   * A JSON Schema to implement this condition.
   *
   * Can also be a function which returns a schema using inputs.
   * @see params
   */
  schema?: Schema | ((params: Params) => Schema);
  /**
   * A callback for code to implement this action
   * @todo Better types parameters?
   */
  callback?: (item: any, options: Params) => Promise<void>;
}

/**
 * Lets TypeScript do more inference magic on Actions
 *
 * @todo Figure out how to infer better without this function
 */
export function Condition<S extends string, T = unknown>(
  condition: ConditionImplementor<S, T>
) {
  return condition;
}

const GLOBAL_ROOT = '/bookmarks/rules';
const ACTIONS_PATH = 'actions';
const CONDITIONS_PATH = 'conditions';
const WORK_PATH = 'compiled';

/**
 * Class for exposing and implemention a worker for the "rules engine"
 *
 * @typeParam Service Don't worry about it, just let TS infer it
 */
export class RulesWorker<
  Service extends string,
  Actions extends readonly ActionImplementor<Service, any>[],
  Conditions extends readonly ConditionImplementor<Service, any>[]
> {
  public readonly path;
  public readonly name;
  public readonly actions: Map<
    Action['name'],
    Actions[0]['callback']
  > = new Map();
  public readonly conditions: Map<
    Condition['name'],
    Conditions[0]['callback']
  > = new Map();

  /**
   * Allow checking if async initialization is done.
   */
  public readonly initialized: Promise<void>;

  #conn;
  #workWatch?: ListWatch<Work>;
  #work: Map<string, WorkRunner<Service, {}>> = new Map();

  constructor({
    name,
    conn,
    actions,
    conditions,
  }: Options<Service, Actions, Conditions>) {
    this.name = name;
    this.path = `/bookmarks/services/${name}/rules`;
    this.#conn = conn;

    const caller = getCallerFile();

    if (!actions?.length && !conditions?.length) {
      throw new Error('This service registered neither actions nor conditions');
    }

    /*
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
     */

    this.initialized = Bluebird.try(async () => {
      await this.initialize(actions, conditions, caller).catch(error);
    });
  }

  /**
   * Do async part of initialization
   */
  private async initialize(
    actions: Actions | undefined,
    conditions: Conditions | undefined,
    caller: string
  ) {
    const conn = this.#conn;

    trace(`Initializing with caller`, caller);
    const schemaGen = await schemaGenerator(caller);

    // Ensure service rules tree
    await fillTree(conn, serviceRulesTree, this.path);
    // Ensure global rules tree
    await fillTree(conn, rulesTree, GLOBAL_ROOT);

    // Setup watch for receving work
    this.#workWatch = new ListWatch({
      name: this.name,
      path: `${this.path}/${WORK_PATH}`,
      tree: serviceRulesTree,
      conn,
      // Reload all our work at startup
      resume: false,
      // TODO: Handle deleting work
      onItem: this.addWork.bind(this),
    });

    for (const { name, class: clazz, callback, ...rest } of actions || []) {
      const action: Action = { name, ...rest };

      // TODO: Hacky magic
      if (clazz) {
        // @ts-ignore
        action.params = schemaGen?.getSchemaForSymbol(clazz.name);
      }

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
    for (const {
      name,
      schema: inschema,
      class: clazz,
      callback,
      ...rest
    } of conditions || []) {
      const condition: Condition = { name, ...rest };

      if (typeof inschema === 'function') {
        const inputs = new Proxy(
          {},
          { get: (_, prop) => Symbol(prop.toString()) }
        );
        condition.schema = inschema(inputs) as Condition['schema'];
      } else {
        condition.schema = inschema as Condition['schema'];
      }

      if (condition.schema) {
        const { pointers, schema } = renderSchema(condition.schema as any);
        condition.schema = schema as Condition['schema'];
        // @ts-ignore
        condition.pointers = pointers;
      }

      // TODO: Hacky magic
      if (clazz) {
        // @ts-ignore
        condition.params = schemaGen?.getSchemaForSymbol(clazz.name);
      }

      // Register action in OADA
      const { headers } = await conn.put({
        path: `${this.path}/${CONDITIONS_PATH}/${name}`,
        tree: serviceRulesTree,
        data: condition as any,
      });
      // Link action in global actions list?
      await conn.put({
        path: `${GLOBAL_ROOT}/${CONDITIONS_PATH}`,
        tree: rulesTree,
        data: {
          [`${this.name}-${name}`]: {
            // TODO: Should this link be versioned?
            _id: headers['content-location'].substring(1),
          },
        },
      });

      if (callback) {
        // Keep the callback for later
        this.conditions.set(name, callback);
      }
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
    await (this.#workWatch && this.#workWatch.stop());
    await Bluebird.map(this.#work, ([_, work]) => work.stop());
  }
}
