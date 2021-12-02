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

import debug from 'debug';
import Ajv from 'ajv';

import Rule, {
  assert as assertRule,
} from '@oada/types/trellis/rules/configured';
import type Work from '@oada/types/trellis/rules/compiled';

import { ListWatch } from '@oada/list-lib';

import { ActionImplementor, Options } from './';

const info = debug('rules-worker:info');

const ajv = new Ajv();

function assertNever(value: never) {
  throw new Error(`Unsupported value ${value}`);
}

/**
 * Class for running a particular piece of compiled work
 * Track the corresponding rule and only actually does work if rule enabled.
 *
 * @todo I don't love this class...
 * @internal
 */
export class WorkRunner<S extends string, P extends Record<string, unknown>> {
  private readonly conn;
  /**
   * Compiled JSON Schema filter for this work
   */
  private readonly validator;
  /**
   * ListWatch for path of potential work
   */
  private workWatch?: ListWatch;
  /**
   * Watch on corresponding rule so we can react to changes
   */
  private readonly ruleWatch;
  private _enabled;
  public readonly name;
  /**
   * Original compiled rule thing from OADA
   */
  public readonly work;
  /**
   * Callback which implements the action involved in this work
   */
  private readonly callback;

  constructor(
    conn: Options<S, [], []>['conn'],
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
      work: { path, on, options },
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
        // Determine which items to handle
        let listEvent: 'onAddItem' | 'onItem';
        switch (on) {
          case 'new':
            // Listen for new list items
            listEvent = <const>'onAddItem';
            break;
          case 'change':
            // Listen for any change to list items
            listEvent = <const>'onItem';
            break;
          default:
            assertNever(on);
        }

        // Register watch for this work
        this.workWatch = new ListWatch({
          // Make sure each work has unique name?
          name,
          path,
          conn,
          // Only work on each item once
          resume: true,
          assertItem: (item: unknown) => {
            if (!validator(item)) {
              throw validator.errors;
            }
          },
          [listEvent!]: async (item: unknown) => callback(item, options as any),
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
