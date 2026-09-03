import type { TokenStore } from "./tokens.js";

export interface ApiError {
  status: number;
  code: number;
  message: string;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly orgId: string,
    private readonly tokens: TokenStore,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bundle = await this.tokens.load();
    if (!bundle) throw new Error("not authenticated");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bundle.accessToken}`,
        "x-org-id": this.orgId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (!refreshed) {
        const err: ApiError = { status: 401, code: 401, message: "session expired" };
        throw err;
      }
      return this.request<T>(method, path, body);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
      const err: ApiError = {
        status: res.status,
        code: data.error?.code ?? res.status,
        message: data.error?.message ?? "request failed",
      };
      throw err;
    }
    return (await res.json()) as T;
  }

  private async refresh(): Promise<boolean> {
    const bundle = await this.tokens.load();
    if (!bundle) return false;
    const res = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: bundle.refreshToken }),
    });
    if (!res.ok) {
      await this.tokens.clear();
      return false;
    }
    const pair = (await res.json()) as { accessToken: string; refreshToken: string };
    await this.tokens.save(pair);
    return true;
  }

  createSession(input: { deviceId: string; subjectUserId: string; clientSessionId: string }) {
    return this.request<{ session: { id: string }; lease: { id: string } }>("POST", "/sessions", input);
  }

  completeSession(
    id: string,
    input: { bacPromille: number; measuredAt: string; rawPayload?: Record<string, unknown> },
  ) {
    return this.request<{ reading: { id: string }; duplicate: boolean }>("POST", `/sessions/${id}/complete`, input);
  }

  listReadings(query: string) {
    return this.request<{ readings: unknown[] }>("GET", `/readings${query}`);
  }
}
