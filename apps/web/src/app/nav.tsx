"use client";

import Link from "next/link";
import { useAuth } from "./auth-context";

export function Nav() {
  const { user, orgs, orgId, ready, selectOrg, logout } = useAuth();
  if (!ready) return <nav>…</nav>;
  return (
    <nav>
      <strong>BACTrack</strong>
      {user ? (
        <>
          <Link href="/">History</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/teams">Teams</Link>
          <Link href="/audit">Audit</Link>
          <Link href="/map">Map</Link>
          <select value={orgId ?? ""} onChange={(e) => selectOrg(e.target.value)} aria-label="Organization">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.role})
              </option>
            ))}
          </select>
          <span>{user.email}</span>
          <button onClick={() => void logout()}>Logout</button>
        </>
      ) : (
        <Link href="/login">Login</Link>
      )}
    </nav>
  );
}
