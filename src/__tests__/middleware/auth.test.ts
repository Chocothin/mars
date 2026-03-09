import { describe, expect, test } from 'bun:test';

import { withTokenAuth } from '../../middleware/auth';

describe('withTokenAuth', () => {
  test('returns 401 when the authorization header is missing', async () => {
    const handler = withTokenAuth(
      async () => Response.json({ success: true }),
      { token: 'secret-token' },
    );

    const response = await handler(
      new Request('http://localhost/api/dashboard/summary'),
      new URL('http://localhost/api/dashboard/summary'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Unauthorized',
    });
  });

  test('calls the wrapped handler when the bearer token matches', async () => {
    const handler = withTokenAuth(
      async () => Response.json({ success: true, data: 'ok' }),
      { token: 'secret-token' },
    );

    const response = await handler(
      new Request('http://localhost/api/dashboard/summary', {
        headers: {
          Authorization: 'Bearer secret-token',
        },
      }),
      new URL('http://localhost/api/dashboard/summary'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: 'ok',
    });
  });
});
