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

/**
 * @internal
 */

import sinon from 'sinon';

import { OADAClient } from '@oada/client';

const emptyResp = {
  requestId: 'testid',
  status: 200,
  statusText: 'OK',
  headers: { 'content-location': '' },
  data: {},
};

/**
 * Creates a stubbed OADAClient for use in tests
 *
 * @internal
 */
export function createStub() {
  const conn = sinon.createStubInstance(OADAClient);

  conn.get.resolves(emptyResp);
  conn.head.resolves(emptyResp);
  conn.put.resolves(emptyResp);
  conn.post.resolves(emptyResp);
  conn.delete.resolves(emptyResp);
  conn.watch.resolves('watchid');
  conn.unwatch.resolves(emptyResp);

  return conn;
}
