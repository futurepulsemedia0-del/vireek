import { describe, expect, it } from 'vitest';
import { denyUnlessCanManageCrm, type PermissionRpc } from './crmPermission';

const rpc = (result: { data: unknown; error: unknown } | Error): PermissionRpc => ({
  rpc: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

describe('denyUnlessCanManageCrm', () => {
  it('allows only an explicit boolean true', async () => {
    expect(await denyUnlessCanManageCrm('jwt', rpc({ data: true, error: null }))).toBeNull();
  });
  it('denies false, null, truthy non-booleans', async () => {
    for (const data of [false, null, undefined, 'true', 1]) {
      expect((await denyUnlessCanManageCrm('jwt', rpc({ data, error: null })))?.status).toBe(403);
    }
  });
  it('fails closed on RPC error or exception', async () => {
    expect((await denyUnlessCanManageCrm('jwt', rpc({ data: true, error: { message: 'boom' } })))?.status).toBe(500);
    expect((await denyUnlessCanManageCrm('jwt', rpc(new Error('network'))))?.status).toBe(500);
  });
});
