import debug from 'debug';
import Ajv from 'ajv';

import Rule, { assert as assertRule } from '@oada/types/oada/rules/configured';
import type Work from '@oada/types/oada/rules/compiled';

import { ListWatch } from '@oada/list-lib';

import { Options, ActionImplementor } from './';

const info = debug('rules-worker:info');

const ajv = new Ajv();

/**
 * Do magic with type inference stuff.
 */
type Literal<T> = T extends string & infer R ? R : never;

/**
 * Class for running a particular piece of compiled work
 * Track the corresponding rule and only actually does work if rule enabled.
 *
 * @todo I don't love this class...
 * @internal
 */
export class WorkRunner<S extends string, P extends {}> {
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
