import crypto from 'node:crypto';

import { TUYA_REGIONS } from '../settings.js';
import type { TuyaRegion } from '../settings.js';
import type {
  TuyaDeviceInfoResponse,
  TuyaDeviceStatusResponse,
  TuyaSpecResponse,
  TuyaStatusItem,
} from './types.js';

export interface CloudClientConfig {
  region: TuyaRegion;
  accessKey: string;
  secretKey: string;
  requestTimeoutMs: number;
}

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

export class CloudClient {
  private readonly config: CloudClientConfig;
  private readonly baseUrl: string;
  private token: TokenInfo | null = null;
  private lastRequestMs = 0;
  private readonly minIntervalMs = 200;

  constructor(config: CloudClientConfig) {
    this.config = config;
    this.baseUrl = TUYA_REGIONS[config.region];
  }

  async getDeviceStatus(deviceId: string): Promise<TuyaStatusItem[]> {
    const data = await this.request<TuyaDeviceStatusResponse>(
      'GET',
      `/v1.0/devices/${deviceId}/status`,
    );
    return data.result;
  }

  async getDeviceSpecification(deviceId: string): Promise<TuyaSpecResponse> {
    return this.request<TuyaSpecResponse>('GET', `/v1.0/devices/${deviceId}/specifications`);
  }

  async getDeviceInfo(deviceId: string): Promise<TuyaDeviceInfoResponse> {
    return this.request<TuyaDeviceInfoResponse>('GET', `/v1.0/devices/${deviceId}`);
  }

  async postCommand(deviceId: string, code: string, value: boolean | number | string): Promise<void> {
    await this.request('POST', `/v1.0/devices/${deviceId}/commands`, {
      commands: [{ code, value }],
    });
  }

  private async request<T extends { success: boolean; code?: number }>(
    method: string,
    path: string,
    body?: unknown,
    retryOnToken = true,
  ): Promise<T> {
    await this.pace();
    const token = await this.ensureToken();
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const sign = this.sign(token, t, nonce, method, path, bodyStr);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'client_id': this.config.accessKey,
          'access_token': token,
          'sign': sign,
          't': t,
          'sign_method': 'HMAC-SHA256',
          'nonce': nonce,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? bodyStr : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      throw new Error(`Tuya rate limit exceeded (429) on ${path}`);
    }

    const data = await res.json() as T;

    if (!data.success && (data.code === 1010 || data.code === 1011) && retryOnToken) {
      this.token = null;
      return this.request<T>(method, path, body, false);
    }

    return data;
  }

  private async ensureToken(): Promise<string> {
    if (this.token !== null && Date.now() < this.token.expiresAt) {
      return this.token.accessToken;
    }
    await this.pace();
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const sign = this.signToken(t, nonce);

    const res = await fetch(`${this.baseUrl}/v1.0/token?grant_type=1`, {
      headers: {
        'client_id': this.config.accessKey,
        'sign': sign,
        't': t,
        'sign_method': 'HMAC-SHA256',
        'nonce': nonce,
      },
    });

    const data = await res.json() as {
      success: boolean;
      result: { access_token: string; expire_time: number };
    };
    if (!data.success) {
      throw new Error('Tuya auth failed');
    }

    this.token = {
      accessToken: data.result.access_token,
      expiresAt: Date.now() + (data.result.expire_time - 60) * 1000,
    };
    return this.token.accessToken;
  }

  private sign(
    token: string,
    t: string,
    nonce: string,
    method: string,
    path: string,
    body: string,
  ): string {
    const contentHash = crypto.createHash('sha256').update(body).digest('hex');
    const stringToSign = [method, contentHash, '', path].join('\n');
    const str = this.config.accessKey + token + t + nonce + stringToSign;
    return crypto.createHmac('sha256', this.config.secretKey).update(str).digest('hex').toUpperCase();
  }

  private signToken(t: string, nonce: string): string {
    const emptyHash = crypto.createHash('sha256').update('').digest('hex');
    const stringToSign = ['GET', emptyHash, '', '/v1.0/token?grant_type=1'].join('\n');
    const str = this.config.accessKey + t + nonce + stringToSign;
    return crypto.createHmac('sha256', this.config.secretKey).update(str).digest('hex').toUpperCase();
  }

  private async pace(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestMs;
    if (elapsed < this.minIntervalMs) {
      await new Promise<void>((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestMs = Date.now();
  }
}
