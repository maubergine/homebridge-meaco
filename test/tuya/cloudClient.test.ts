import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { CloudClient } from '../../src/tuya/cloudClient.js';

const ACCESS_KEY = 'testAccessKey123';
const SECRET_KEY = 'testSecretKey456';
const DEVICE_ID = 'device001';

function makeResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

const tokenReply = {
  success: true,
  result: { access_token: 'tok1', expire_time: 7200, refresh_token: 'ref1', uid: 'uid1' },
  t: Date.now(),
};

describe('CloudClient', () => {
  let client: CloudClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    client = new CloudClient({
      region: 'EU',
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      requestTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches and caches an access token', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(tokenReply))
      .mockResolvedValueOnce(makeResponse({
        success: true,
        result: [{ code: 'switch', value: true }],
        t: Date.now(),
      }));

    const status = await client.getDeviceStatus(DEVICE_ID);
    expect(status).toHaveLength(1);
    expect(status[0]?.code).toBe('switch');
    // Token fetch + status fetch = 2 calls total
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should reuse cached token (no extra token fetch)
    mockFetch.mockResolvedValueOnce(makeResponse({
      success: true,
      result: [{ code: 'switch', value: false }],
      t: Date.now(),
    }));
    await client.getDeviceStatus(DEVICE_ID);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('re-authenticates on 1010 (token expired) and retries', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(tokenReply))
      .mockResolvedValueOnce(makeResponse({
        success: false,
        code: 1010,
        msg: 'token invalid',
        t: Date.now(),
      }))
      .mockResolvedValueOnce(makeResponse({
        success: true,
        result: { access_token: 'fresh', expire_time: 7200, refresh_token: 'r2', uid: 'u' },
        t: Date.now(),
      }))
      .mockResolvedValueOnce(makeResponse({
        success: true,
        result: [{ code: 'switch', value: false }],
        t: Date.now(),
      }));

    const status = await client.getDeviceStatus(DEVICE_ID);
    expect(status[0]?.value).toBe(false);
    // 4 calls: initial token, failed status, re-auth token, retried status
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('throws on 429 rate limit', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(tokenReply))
      .mockResolvedValueOnce(makeResponse({ success: false, code: 28841105, msg: 'rate limited' }, 429));

    await expect(client.getDeviceStatus(DEVICE_ID)).rejects.toThrow(/rate limit/i);
  });

  it('sends a command via POST', async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(tokenReply))
      .mockResolvedValueOnce(makeResponse({ success: true, result: true, t: Date.now() }));

    await expect(client.postCommand(DEVICE_ID, 'switch', true)).resolves.not.toThrow();

    const postCall = mockFetch.mock.calls[1];
    expect(postCall?.[1]?.method).toBe('POST');
    expect(postCall?.[0]).toContain(`/v1.0/devices/${DEVICE_ID}/commands`);
  });
});
