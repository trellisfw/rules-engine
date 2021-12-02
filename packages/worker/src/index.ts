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

import { join } from 'node:path';

import Bluebird from 'bluebird';
import debug from 'debug';
import getCallerFile from 'get-caller-file';

// Import type { UiSchema } from '@rjsf/core';

import type Action from '@oada/types/trellis/rules/action';
import type Condition from '@oada/types/trellis/rules/condition';
import type Work from '@oada/types/trellis/rules/compiled';

import { ListWatch, Options as WatchOptions } from '@oada/list-lib';

import { fillTree, rulesTree, serviceRulesTree } from './trees';
import { renderSchema, schemaGenerator } from './schemaGenerator';
import { WorkRunner } from './WorkRunner';
import type { JSONSchema8 as Schema } from 'jsonschema8';
import { JsonSchemaGenerator } from 'typescript-json-schema';

/**
 * @todo Figure out how to fix rjsf type?
 */
type UiSchema = any;

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
  Actions extends ReadonlyArray<ActionImplementor<Service, unknown>>,
  Conditions extends ReadonlyArray<ConditionImplementor<Service, unknown>>
> = {
  /**
   * The name of the OADA service to associate with
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
export interface ActionImplementor<Service extends string, Parameters_ = never>
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
  class?: Parameters_ extends never ? never : new () => Parameters_;
  // Make TS smarter about uischema?
  uischema?: { [K in keyof Parameters_]?: UiSchema };
  /**
   * A callback for code to implement this action
   * @todo Better types parameters?
   */
  callback: (item: any, options: Parameters_) => Promise<void>;
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
// @ts-expect-error
export interface ConditionImplementor<
  Service extends string,
  Parameters_ = never
> extends Condition {
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
  class?: Parameters_ extends never ? never : new () => Parameters_;
  // Make TS smarter about uischema?
  uischema?: { [K in keyof Parameters_]?: UiSchema };
  /**
   * A JSON Schema to implement this condition.
   *
   * Can also be a function which returns a schema using inputs.
   * @see params
   */
  schema?: Schema | ((parameters: Parameters_) => Schema);
  /**
   * A callback for code to implement this action
   * @todo Better types parameters?
   */
  callback?: (item: any, options: Parameters_) => Promise<void>;
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
  Actions extends ReadonlyArray<ActionImplementor<Service, any>>,
  Conditions extends ReadonlyArray<ConditionImplementor<Service, any>>
> {
  public readonly path;
  public readonly name;
  public readonly actions: Map<Action['name'], Actions[0]['callback']> =
    new Map();

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
  #work: Map<string, WorkRunner<Service, Record<string, unknown>>> = new Map();

  /**
   * File which called the constructor
   */
  #caller;
  #schemaGen?: Promise<JsonSchemaGenerator | null>;
  private get schemaGen() {
    if (!this.#schemaGen) {
      this.#schemaGen = schemaGenerator(this.#caller);
    }

    return this.#schemaGen;
  }

  constructor({
    name,
    conn,
    actions,
    conditions,
  }: Options<Service, Actions, Conditions>) {
    this.name = name;
    this.path = `/bookmarks/services/${name}/rules`;
    this.#conn = conn;

    this.#caller = getCallerFile();

    if (!actions?.length && !conditions?.length) {
      throw new Error('This service registered neither actions nor conditions');
    }

    /*
    // Setup watch for receiving work
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
      await this.initialize(actions, conditions).catch(error);
    });
  }

  /**
   * Do async part of initialization
   */
  private async initialize(
    actions: Actions | undefined,
    conditions: Conditions | undefined
  ) {
    const conn = this.#conn;

    trace(`Initializing with caller`, this.#caller);

    // Ensure service rules tree
    await fillTree(conn, serviceRulesTree, this.path);
    // Ensure global rules tree
    await fillTree(conn, rulesTree, GLOBAL_ROOT);

    // Process actions of this service
    for (const { name, class: pClass, callback, ...rest } of actions || []) {
      const action: Action = { name, ...rest };

      // FIXME: Hacky magic
      if (pClass) {
        action.params = (await this.schemaGen)?.getSchemaForSymbol(
          pClass.name
        ) as any;
      }

      // Register action in OADA
      const { headers } = await conn.put({
        path: join(this.path, ACTIONS_PATH, name),
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
            _id: headers['content-location'].slice(1),
          },
        },
      });

      // Keep the callback for later
      this.actions.set(name, callback);
    }

    // Process conditions of this service
    for (const {
      name,
      schema: inSchema,
      class: pClass,
      callback,
      ...rest
    } of conditions || []) {
      const condition: Condition = { name, ...rest };

      if (typeof inSchema === 'function') {
        const inputs = new Proxy(
          {},
          { get: (_, property) => Symbol(property.toString()) }
        );
        condition.schema = inSchema(inputs) as Condition['schema'];
      } else {
        condition.schema = inSchema as Condition['schema'];
      }

      if (condition.schema) {
        const { pointers, schema } = renderSchema(condition.schema as any);
        condition.schema = schema as Condition['schema'];
        condition.pointers = pointers;
      }

      // TODO: Hacky magic
      if (pClass) {
        condition.params = (await this.schemaGen)?.getSchemaForSymbol(
          pClass.name
        ) as any;
      }

      // Register action in OADA
      const { headers } = await conn.put({
        path: join(this.path, CONDITIONS_PATH, name),
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
            _id: headers['content-location'].slice(1),
          },
        },
      });

      if (callback) {
        // Keep the callback for later
        this.conditions.set(name, callback);
      }
    }

    // Setup watch for receiving work
    this.#workWatch = new ListWatch({
      name: this.name,
      path: join(this.path, WORK_PATH),
      tree: serviceRulesTree,
      conn,
      // Reload all our work at startup
      resume: false,
      // TODO: Handle deleting work
      onItem: this.addWork.bind(this),
    });
  }

  /**
   * Registers a "conditional watch" for a new piece of work
   */
  private async addWork(work: Work, id: string) {
    const { actions, name } = this;
    const conn = this.#conn;

    if (this.#work.has(id)) {
      // TODO: Handle modifying existing work
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
        // Make name unique
        `${name}-work-${id}`,
        work,
        action
      );

      await workRunner.init();
      this.#work.set(id, workRunner);
    } catch (error_: unknown) {
      error(`Error adding work ${id}: %O`, error_);
      throw error_;
    }
  }

  /**
   * Stop all of our watches
   */
  public async stop() {
    await (this.#workWatch && this.#workWatch.stop());
    await Bluebird.map(this.#work, async ([_, work]) => work.stop());
  }
}
