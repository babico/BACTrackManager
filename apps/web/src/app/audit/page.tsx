"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

interface Entry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entityType, setEntityType] = useState("");

  const load = useCallback(async () => {
    const q = entityType ? `?entityType=${encodeURIComponent(entityType)}` : "";
    const res = await apiGet<{ entries: Entry[] }>(`/audit${q}`);
    setEntries(res.entries);
  }, [entityType]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>Audit log</h1>
      <form onSubmit={(e) => { e.preventDefault(); void load(); }} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Entity type">
          <option value="">All types</option>
          <option value="session">session</option>
          <option value="reading">reading</option>
          <option value="device">device</option>
          <option value="invite">invite</option>
        </select>
        <button type="submit">Filter</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((a) => (
            <tr key={a.id}>
              <td>{new Date(a.createdAt).toLocaleString()}</td>
              <td>{a.action}</td>
              <td>
                {a.entityType}:{a.entityId?.slice(0, 8) ?? "—"}
              </td>
              <td>{a.actorUserId?.slice(0, 8) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
