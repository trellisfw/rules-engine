/**
 * @internal
 */

import sinon from 'sinon';

import { OADAClient } from '@oada/client';
import type { SocketResponse } from '@oada/client/dist/websocket';

const emptyResp: SocketResponse = {
  requestId: 'testid',
  status: 200,
  statusText: 'OK',
  headers: { 'content-location': '' },
  data: {},
};

/**
 * Creates a stubbed OADAClient for use in tests
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
