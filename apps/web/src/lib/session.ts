export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

const A_KEY = "bactrack.access";
const R_KEY = "bactrack.refresh";
const O_KEY = "bactrack.org";
const U_KEY = "bactrack.user";

export interface SessionUser {
  id: string;
  email: string;
}

export const sessionStore = {
  load(): SessionTokens | null {
    const a = localStorage.getItem(A_KEY);
    const r = localStorage.getItem(R_KEY);
    return a && r ? { accessToken: a, refreshToken: r } : null;
  },
  save(t: SessionTokens): void {
    localStorage.setItem(A_KEY, t.accessToken);
    localStorage.setItem(R_KEY, t.refreshToken);
  },
  clear(): void {
    localStorage.removeItem(A_KEY);
    localStorage.removeItem(R_KEY);
    localStorage.removeItem(O_KEY);
    localStorage.removeItem(U_KEY);
  },
  org(): string | null {
    return localStorage.getItem(O_KEY);
  },
  setOrg(id: string): void {
    localStorage.setItem(O_KEY, id);
  },
  user(): SessionUser | null {
    const raw = localStorage.getItem(U_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  },
  setUser(u: SessionUser): void {
    localStorage.setItem(U_KEY, JSON.stringify(u));
  },
};
