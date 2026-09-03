"use client";

// BAC-only markers on OpenStreetMap tiles (no key needed).
// Tile usage policy: https://operations.osmfoundation.org/policies/tiles/
// Dawarich overlay: each member links their OWN Dawarich account+key
// (per-user model — the API key lives in the user's Dawarich account
// settings; family sharing is real-time-only, never historical).
import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useAuth } from "../auth-context";

interface Reading {
  id: string;
  bacPromille: string;
  measuredAt: string;
}

interface TimelineDay {
  date: string;
  summary?: unknown;
  entries?: unknown[];
  readings?: { id: string; bacPromille: string; measuredAt: string; origin: string }[];
}

function last7(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function MapPage() {
  const { orgs, orgId } = useAuth();
  const [readings, setReadings] = useState<Reading[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [team, setTeam] = useState<{ userId: string; displayName: string; days: TimelineDay[] }[]>([]);
  const [msg, setMsg] = useState("");

  const myRole = orgs.find((o) => o.id === orgId)?.role ?? "";
  const canSeeTeam = myRole === "owner" || myRole === "admin";

  const refreshStatus = useCallback(async () => {
    try {
      const s = await apiGet<{ connected: boolean; baseUrl: string | null }>("/dawarich/status");
      setConnected(s.connected);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    apiGet<{ readings: Reading[] }>("/readings?limit=1000")
      .then((r) => setReadings(r.readings))
      .catch(() => undefined);
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    let map: { remove(): void } | null = null;
    void import("leaflet").then((L) => {
      const el = document.getElementById("bac-map");
      if (!el) return;
      const m = L.map(el).setView([39.9, 32.8], 6);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(m);
      map = m;
    });
    return () => map?.remove();
  }, []);

  const loadTimeline = useCallback(async () => {
    const { from, to } = last7();
    try {
      const t = await apiGet<{ days: TimelineDay[] }>(
        `/dawarich/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      setDays(t.days);
      setMsg("");
      if (canSeeTeam) {
        const tt = await apiGet<{ users: { userId: string; displayName: string; days: TimelineDay[] }[] }>(
          `/dawarich/team-timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        );
        setTeam(tt.users);
      }
    } catch {
      setMsg("Timeline unavailable — connect your Dawarich account below.");
    }
  }, [canSeeTeam]);

  return (
    <div>
      <h1>Map</h1>
      <p>{readings.length} readings loaded (map markers need GPS coordinates from mobile capture).</p>

      <h2>Dawarich overlay</h2>
      {connected === null ? <p>Checking…</p> : null}
      {connected === false ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setMsg("");
            apiPost<{ connected: boolean }>("/dawarich/connect", { baseUrl, apiKey })
              .then(() => {
                setApiKey("");
                void refreshStatus().then(() => void loadTimeline());
              })
              .catch(() => setMsg("Connect failed — check URL and API key (Dawarich account settings)."));
          }}
         
        >
          <input placeholder="https://dawarich.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          <input placeholder="API key (your Dawarich account)" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
          <button type="submit">Connect my Dawarich</button>
        </form>
      ) : null}
      {connected ? (
        <div>
          <button onClick={() => void loadTimeline()}>Load last 7 days</button>
          <DisconnectButton onDone={() => { setDays([]); setTeam([]); void refreshStatus(); }} />
        </div>
      ) : null}
      {msg ? <p>{msg}</p> : null}

      {days.map((d) => (
        <details key={d.date}>
          <summary>
            {d.date} — {(d.entries ?? []).length} entries, {(d.readings ?? []).length} readings
          </summary>
          <ul>
            {(d.readings ?? []).map((r) => (
              <li key={r.id}>
                {Number(r.bacPromille).toFixed(3)} ‰ at {new Date(r.measuredAt).toLocaleString()} ({r.origin})
              </li>
            ))}
          </ul>
        </details>
      ))}

      {canSeeTeam && team.length > 0 ? (
        <>
          <h2>Team timelines (consent: members linked their own accounts)</h2>
          {team.map((u) => (
            <details key={u.userId}>
              <summary>
                {u.displayName} — {u.days.length} days
              </summary>
              <ul>
                {u.days.map((d) => (
                  <li key={d.date}>
                    {d.date}: {(d.entries ?? []).length} entries, {(d.readings ?? []).length} readings
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </>
      ) : null}

      <div id="bac-map" />
    </div>
  );
}

function DisconnectButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        apiDelete("/dawarich/disconnect")
          .then(() => onDone())
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      Disconnect my Dawarich
    </button>
  );
}
