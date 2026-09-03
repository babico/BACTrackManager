"use client";

// Supervised kiosk: operator unlocks with PIN, picks device + subject,
// starts a session, watches live status. The blow step happens on the
// paired mobile app against the SAME session (lease held server-side);
// this page deliberately has NO manual BAC entry (integrity).
// PIN is demo-grade (client-side check, default "1234") — physical
// supervision is the real control; harden in P10 if kiosk goes public.
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

interface Device {
  id: string;
  serialNumber: string;
  status: string;
}

interface Member {
  userId: string;
  displayName: string;
}

const KIOSK_PIN = process.env.NEXT_PUBLIC_KIOSK_PIN ?? "1234";

export default function KioskPage() {
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!unlocked) return;
    apiGet<Device[]>("/devices")
      .then((d) => setDevices(Array.isArray(d) ? d : []))
      .catch(() => undefined);
    apiGet<{ members: Member[] }>("/orgs/members")
      .then((m) => setMembers(m.members))
      .catch(() => undefined);
  }, [unlocked]);

  useEffect(() => {
    if (!sessionId) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await apiGet<{ status: string }>(`/sessions/${sessionId}`);
        if (!stop) setStatus(s.status);
        if (s.status === "completed" || s.status === "failed" || s.status === "expired") {
          if (!stop) setSessionId(null);
          return;
        }
      } catch {
        // keep polling
      }
      if (!stop) setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [sessionId]);

  if (!unlocked) {
    return (
      <div>
        <h1>Kiosk</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pin === KIOSK_PIN) {
              setUnlocked(true);
              setMsg("");
            } else {
              setMsg("Wrong PIN.");
            }
          }}
        >
          <input type="password" inputMode="numeric" placeholder="Kiosk PIN" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="Kiosk PIN" />
          <button type="submit">Unlock</button>
        </form>
        {msg ? <p>{msg}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <h1>Kiosk — supervised test</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setMsg("");
          apiPost<{ session: { id: string } }>("/sessions", {
            deviceId,
            subjectUserId: subjectId,
            clientSessionId: `kiosk-${Date.now()}`,
          })
            .then((s) => {
              setSessionId(s.session.id);
              setStatus("pending");
            })
            .catch(() => setMsg("Could not start (device busy?)."));
        }}
      >
        <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} required aria-label="Device">
          <option value="">Pick device</option>
          {devices
            .filter((d) => d.status === "active")
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.serialNumber}
              </option>
            ))}
        </select>
        <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required aria-label="Subject">
          <option value="">Pick subject</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
        <button type="submit">Start supervised test</button>
      </form>
      {msg ? <p>{msg}</p> : null}
      {status ? <p>Session status: {status} — blow on the paired mobile app now.</p> : null}
    </div>
  );
}
