import { sessionStore } from "./session";

export interface ApiError {
  status: number;
  message: string;
}

const base = () => process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:3001";

async function refresh(): Promise<boolean> {
  const s = sessionStore.load();
  if (!s) return false;
  const res = await fetch(`${base()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: s.refreshToken }),
  });
  if (!res.ok) {
    sessionStore.clear();
    return false;
  }
  const pair = (await res.json()) as { accessToken: string; refreshToken: string };
  sessionStore.save(pair);
  return true;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const call = async (): Promise<Response> => {
    const s = sessionStore.load();
    const org = sessionStore.org();
    return fetch(`${base()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
        ...(org ? { "x-org-id": org } : {}),
        ...(init?.headers ?? {}),
      },
    });
  };
  let res = await call();
  if (res.status === 401 && sessionStore.load()) {
    if (await refresh()) res = await call();
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const err: ApiError = { status: res.status, message: data.error?.message ?? "request failed" };
    throw err;
  }
  return (await res.json()) as T;
}

export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const apiPatch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });

export const apiDelete = <T>(path: string) => api<T>(path, { method: "DELETE" });

export const apiGet = <T>(path: string) => api<T>(path);
