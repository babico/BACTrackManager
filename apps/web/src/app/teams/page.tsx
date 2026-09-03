"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

function vapidKey(): string {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC ?? "";
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  status: string;
}

export default function TeamsPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const m = await apiGet<{ members: Member[] }>("/orgs/members");
      setMembers(m.members);
      const inv = await apiGet<{ invites: Invite[] }>("/orgs/invites");
      setInvites(inv.invites);
    } catch {
      setError("Could not load team (owner/admin only for invites).");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>Team</h1>
      {error ? <p>{error}</p> : null}
      <h2>Members</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.displayName}</td>
              <td>{m.email}</td>
              <td>{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Invite</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apiPost("/orgs/invites", { email, role })
            .then(() => {
              setEmail("");
              void load();
            })
            .catch(() => setError("Invite failed (owner/admin only)."));
        }}
       
      >
        <input type="email" required placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Invite</button>
      </form>
      <h2>Pending invites</h2>
      <ul>
        {invites.map((i) => (
          <li key={i.id}>
            {i.email} ({i.role})
          </li>
        ))}
      </ul>
      <h2>Push notifications</h2>
      <button
        onClick={() => {
          if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
            setError("Push not supported in this browser.");
            return;
          }
          const key = vapidKey();
          if (!key) {
            setError("Push not configured (VAPID key missing).");
            return;
          }
          Notification.requestPermission()
            .then((perm) => {
              if (perm !== "granted") throw new Error("denied");
              return navigator.serviceWorker.register("/sw.js");
            })
            .then((reg) => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
            .then((sub) =>
              apiPost("/push/subscriptions", { endpoint: sub.endpoint, keys: sub.toJSON().keys }),
            )
            .then(() => setError(""))
            .catch(() => setError("Push subscribe failed."));
        }}
      >
        Enable push notifications
      </button>
    </div>
  );
}
