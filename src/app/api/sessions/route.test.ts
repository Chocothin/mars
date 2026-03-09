import { afterEach, describe, expect, test } from 'bun:test';

import { GET, POST, resetSessionsForTesting } from './route';

afterEach(() => {
  resetSessionsForTesting();
});

describe('/api/sessions', () => {
  test('GET returns an empty array when there are no saved sessions', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test('POST creates a session and GET returns it', async () => {
    const postResponse = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          duration: 1500,
        }),
      }),
    );

    expect(postResponse.status).toBe(201);

    const createdSession = await postResponse.json();

    expect(createdSession.duration).toBe(1500);
    expect(typeof createdSession.completedAt).toBe('string');

    const getResponse = await GET();
    const sessions = await getResponse.json();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      duration: 1500,
      completedAt: createdSession.completedAt,
    });
  });

  test('POST rejects a non-positive duration', async () => {
    const response = await POST(
      new Request('http://localhost/api/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          duration: 0,
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'duration must be a positive number',
    });
  });
});
