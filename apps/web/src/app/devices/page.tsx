"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

interface Device {
  id: string;
  serialNumber: string;
  model: string;
  status: string;
  lastSeenAt: string | null;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [serial, setSerial] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await apiGet<Device[]>("/devices");
      setDevices(Array.isArray(res) ? res : []);
    } catch {
      setError("Could not load devices.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>Devices</h1>
      {error ? <p>{error}</p> : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apiPost("/devices", { serialNumber: serial, model: "C6" })
            .then(() => {
              setSerial("");
              void load();
            })
            .catch(() => setError("Register failed (duplicate serial?)."));
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input placeholder="Serial number" value={serial} onChange={(e) => setSerial(e.target.value)} required />
        <button type="submit">Register C6</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Serial</th>
            <th>Model</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id}>
              <td>{d.serialNumber}</td>
              <td>{d.model}</td>
              <td>{d.status}</td>
              <td style={{ display: "flex", gap: 4 }}>
                {d.status === "provisioned" ? (
                  <button onClick={() => apiPatch(`/devices/${d.id}`, { status: "active" }).then(() => void load())}>
                    Activate
                  </button>
                ) : null}
                <button
                  onClick={() =>
                    apiPost(`/devices/${d.id}/release`, {})
                      .then(() => void load())
                      .catch(() => setError("No active lease (nothing to release)."))
                  }
                >
                  Release lease
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
