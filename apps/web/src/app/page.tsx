"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { useAuth } from "./auth-context";

interface Reading {
  id: string;
  bacPromille: string;
  deviceSerial: string;
  origin: string;
  subjectUserId: string;
  measuredAt: string;
  acknowledgedAt: string | null;
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

export default function HistoryPage() {
  const { user, ready } = useAuth();
  const router = useRouter();
  const [readings, setReadings] = useState<Reading[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ limit: "200" });
      if (subject) q.set("subjectUserId", subject);
      if (from) q.set("from", new Date(from).toISOString());
      if (to) q.set("to", new Date(to).toISOString());
      const res = await apiGet<{ readings: Reading[] }>(`/readings?${q.toString()}`);
      setReadings(res.readings);
      setError("");
    } catch {
      setError("Could not load history.");
    }
  }, [subject, from, to]);

  useEffect(() => {
    if (ready && !user) router.push("/login");
  }, [ready, user, router]);

  useEffect(() => {
    if (!user) return;
    apiGet<{ members: Member[] }>("/orgs/members")
      .then((m) => setMembers(m.members))
      .catch(() => undefined);
  }, [user]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!ready || !user) return <p>Loading…</p>;

  const names = new Map(members.map((m) => [m.userId, m.displayName] as const));

  return (
    <div>
      <h1>History</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
       
      >
        <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
          <option value="">All subjects</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <button type="submit">Filter</button>
      </form>
      {error ? <p>{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Measured</th>
            <th>BAC ‰</th>
            <th>Subject</th>
            <th>Device</th>
            <th>Origin</th>
            <th>Ack</th>
          </tr>
        </thead>
        <tbody>
          {readings.map((r) => (
            <tr key={r.id}>
              <td>
                <Link href={`/readings/${r.id}`}>{new Date(r.measuredAt).toLocaleString()}</Link>
              </td>
              <td>{Number(r.bacPromille).toFixed(3)}</td>
              <td>{names.get(r.subjectUserId) ?? r.subjectUserId.slice(0, 8)}</td>
              <td>{r.deviceSerial}</td>
              <td>{r.origin}</td>
              <td>{r.acknowledgedAt ? "yes" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
