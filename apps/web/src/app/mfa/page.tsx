"use client";

import { useState } from "react";
import { useAuth } from "../auth-context";

export default function MfaPage() {
  const { challenge } = useAuth();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <h1>Two-factor check</h1>
      <p>Enter the 6-digit code from your authenticator app (or a backup code).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setMsg("");
          challenge(code)
            .catch(() => {
              setMsg("Invalid code.");
              setBusy(false);
            });
        }}
      >
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Authenticator code"
          required
        />
        <button type="submit" disabled={busy}>
          Verify
        </button>
      </form>
      {msg ? <p>{msg}</p> : null}
    </div>
  );
}
