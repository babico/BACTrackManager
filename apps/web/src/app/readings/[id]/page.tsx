"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import { useAuth } from "../../auth-context";

interface Reading {
  id: string;
  bacPromille: string;
  deviceSerial: string;
  origin: string;
  operatorUserId: string;
  subjectUserId: string;
  measuredAt: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

export default function ReadingDetail() {
  const { user } = useAuth();
  const params = useParams();
  const id = params.id as string;
  const [reading, setReading] = useState<Reading | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ reading: Reading }>(`/readings/${id}`);
      setReading(res.reading);
      const m = await apiGet<{ members: Member[] }>("/orgs/members");
      setMembers(m.members);
    } catch {
      setError("Could not load reading.");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p>{error}</p>;
  if (!reading) return <p>Loading…</p>;

  const names = new Map(members.map((m) => [m.userId, `${m.displayName} <${m.email}>`] as const));
  const isSubject = user?.id === reading.subjectUserId;

  return (
    <div>
      <h1>Reading {Number(reading.bacPromille).toFixed(3)} ‰</h1>
      <dl>
        <dt>Measured</dt>
        <dd>{new Date(reading.measuredAt).toLocaleString()}</dd>
        <dt>Tested by (operator)</dt>
        <dd>{names.get(reading.operatorUserId) ?? reading.operatorUserId}</dd>
        <dt>Subject</dt>
        <dd>{names.get(reading.subjectUserId) ?? reading.subjectUserId}</dd>
        <dt>Device</dt>
        <dd>{reading.deviceSerial}</dd>
        <dt>Origin</dt>
        <dd>{reading.origin}</dd>
        <dt>Acknowledged</dt>
        <dd>{reading.acknowledgedAt ? new Date(reading.acknowledgedAt).toLocaleString() : "not yet"}</dd>
      </dl>
      {isSubject && !reading.acknowledgedAt ? (
        <button
          onClick={() => {
            apiPost<{ reading: Reading }>(`/readings/${reading.id}/acknowledge`, {})
              .then((r) => setReading(r.reading))
              .catch(() => setError("Acknowledge failed."));
          }}
        >
          Acknowledge
        </button>
      ) : null}
    </div>
  );
}
