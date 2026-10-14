export type ManagerTokens = { accessToken: string; refreshToken: string };
export type ManagerOrg = { id: string; name: string; type: string; role: string };
export type ManagerReading = {
  id: string;
  bacPromille: string | number;
  measuredAt: string;
  deviceSerial: string;
};
export type ManagerDevice = {
  serialNumber: string;
  model?: string;
  firmwareVersion?: string;
  hardwareRevision?: string;
  softwareRevision?: string;
  batteryLevel?: number;
};

export interface SecureValueStore {
  getSecureValue(key: string): Promise<string | null>;
  setSecureValue(key: string, value: string): Promise<boolean>;
  clearSecureValue(key: string): Promise<boolean>;
}

export class ManagerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly organizationId: string,
    private readonly storage: SecureValueStore,
  ) {}

  static normalizeBaseUrl(value: string): string {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Enter a valid Manager server URL.');
    }
    return parsed.toString().replace(/\/$/, '');
  }

  async startLogin(email: string): Promise<{ sent: boolean; devToken?: string }> {
    return this.publicRequest('/auth/magic/start', { email });
  }

  async consumeMagicToken(token: string): Promise<{ tokens?: ManagerTokens; mfaTicket?: string; user?: { email: string } }> {
    const result = await this.publicRequest<{
      accessToken?: string;
      refreshToken?: string;
      pair?: ManagerTokens;
      mfaRequired?: true;
      mfaTicket?: string;
      user?: { email: string };
    }>(`/auth/magic/consume?token=${encodeURIComponent(token)}`);
    if (result.mfaRequired && result.mfaTicket) return { mfaTicket: result.mfaTicket };
    const tokens = result.pair ?? (result.accessToken && result.refreshToken
      ? { accessToken: result.accessToken, refreshToken: result.refreshToken }
      : undefined);
    if (!tokens) throw new Error('The sign-in link did not return a valid session.');
    await this.saveTokens(tokens);
    return { tokens, user: result.user };
  }

  async completeMfa(ticket: string, code: string): Promise<void> {
    const result = await this.publicRequest<ManagerTokens & { user: { email: string } }>('/auth/mfa/challenge', { ticket, code });
    await this.saveTokens(result);
  }

  async me(): Promise<{ user: { id: string; email: string; displayName: string }; organizations: ManagerOrg[] }> {
    return this.request('/auth/me');
  }

  async uploadReadings(readings: { localId: string; bacPercent: number; measuredAt: string; deviceSerial?: string; latitude?: number; longitude?: number; accuracy?: number }[]) {
    return this.request<{ syncedLocalIds: string[]; created: number; duplicates: number }>('/readings/local-sync', { readings });
  }

  async claimDevice(device: ManagerDevice) {
    return this.request<ManagerDevice>('/devices/claim', device);
  }

  async listReadings(offset: number) {
    const query = new URLSearchParams({ limit: '1000', offset: String(offset) });
    return this.request<{ readings: ManagerReading[] }>(`/readings?${query}`);
  }

  async logout(): Promise<void> {
    const tokens = await this.tokens();
    if (tokens) {
      try {
        await this.publicRequest('/auth/logout', { refreshToken: tokens.refreshToken });
      } catch {
        // Local sign-out must work when the home-lab server is offline.
      }
      await this.storage.clearSecureValue('manager.tokens');
    }
  }

  private async publicRequest<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async request<T>(path: string, body?: unknown, retry = true): Promise<T> {
    const tokens = await this.tokens();
    if (!tokens) throw new Error('Sign in to Manager first.');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
        'x-org-id': this.organizationId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && retry) {
      try {
        const refreshed = await this.publicRequest<ManagerTokens>('/auth/refresh', { refreshToken: tokens.refreshToken });
        await this.saveTokens(refreshed);
      } catch (error) {
        if (error instanceof ManagerHttpError && [400, 401, 403].includes(error.status)) {
          await this.storage.clearSecureValue('manager.tokens');
        }
        throw error;
      }
      return this.request<T>(path, body, false);
    }
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const result = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string | string[] };
    if (!response.ok) {
      const message = result.error?.message ?? (Array.isArray(result.message) ? result.message.join(', ') : result.message);
      throw new ManagerHttpError(response.status, message ?? `Manager server returned ${response.status}.`);
    }
    return result as T;
  }

  private async tokens(): Promise<ManagerTokens | null> {
    const value = await this.storage.getSecureValue('manager.tokens');
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as ManagerTokens;
      return parsed.accessToken && parsed.refreshToken ? parsed : null;
    } catch {
      return null;
    }
  }

  private async saveTokens(tokens: ManagerTokens): Promise<void> {
    await this.storage.setSecureValue('manager.tokens', JSON.stringify(tokens));
  }
}

export class ManagerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
