"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import { sessionStore, type SessionUser } from "@/lib/session";

export interface Org {
  id: string;
  name: string;
  type: string;
  role: string;
}

interface AuthState {
  user: SessionUser | null;
  orgs: Org[];
  orgId: string | null;
  ready: boolean;
  login(email: string): Promise<{ devToken?: string }>;
  consume(token: string): Promise<void>;
  selectOrg(id: string): void;
  logout(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const loadMe = useCallback(async () => {
    if (!sessionStore.load()) {
      setReady(true);
      return;
    }
    try {
      const me = await apiGet<{ user: SessionUser; organizations: Org[] }>("/auth/me");
      setUser(me.user);
      sessionStore.setUser(me.user);
      setOrgs(me.organizations);
      const saved = sessionStore.org();
      const active = me.organizations.some((o) => o.id === saved) ? saved : me.organizations[0]?.id ?? null;
      if (active) sessionStore.setOrg(active);
      setOrgId(active);
    } catch {
      sessionStore.clear();
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const login = useCallback(async (email: string) => {
    const res = await apiPost<{ sent: boolean; devToken?: string }>("/auth/magic/start", { email });
    return { devToken: res.devToken };
  }, []);

  const consume = useCallback(
    async (token: string) => {
      const res = await apiGet<{ accessToken: string; refreshToken: string; user: SessionUser }>(
        `/auth/magic/consume?token=${encodeURIComponent(token)}`,
      );
      sessionStore.save({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      await loadMe();
      router.push("/");
    },
    [loadMe, router],
  );

  const selectOrg = useCallback((id: string) => {
    sessionStore.setOrg(id);
    setOrgId(id);
  }, []);

  const logout = useCallback(async () => {
    const s = sessionStore.load();
    if (s) {
      try {
        await apiPost("/auth/logout", { refreshToken: s.refreshToken });
      } catch {
        // best effort
      }
    }
    sessionStore.clear();
    setUser(null);
    setOrgs([]);
    setOrgId(null);
    router.push("/login");
  }, [router]);

  return (
    <Ctx.Provider value={{ user, orgs, orgId, ready, login, consume, selectOrg, logout }}>{children}</Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside provider");
  return v;
}
