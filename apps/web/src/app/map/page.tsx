"use client";

// BAC-only markers on OpenStreetMap tiles (no key needed).
// Tile usage policy: https://operations.osmfoundation.org/policies/tiles/
// Dawarich track overlay arrives in P8 behind a toggle (stubbed here).
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

interface Reading {
  id: string;
  bacPromille: string;
  measuredAt: string;
}

export default function MapPage() {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [dawarich, setDawarich] = useState(false);

  useEffect(() => {
    apiGet<{ readings: Reading[] }>("/readings?limit=1000")
      .then((r) => setReadings(r.readings))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (readings.length === 0) return;
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
  }, [readings]);

  return (
    <div>
      <h1>Map</h1>
      <p>{readings.length} readings loaded (markers need coordinates — captured from P6 mobile GPS).</p>
      <label>
        <input type="checkbox" checked={dawarich} onChange={(e) => setDawarich(e.target.checked)} /> Dawarich tracks
        (P8 — stubbed)
      </label>
      {dawarich ? <p>Dawarich overlay not connected yet.</p> : null}
      <div id="bac-map" style={{ height: 480, marginTop: 12 }} />
    </div>
  );
}
