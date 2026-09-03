"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "../auth-context";

function LoginInner() {
  const { login, consume, user, ready } = useAuth();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = params.get("token");
    if (token && ready && !user) {
      setBusy(true);
      consume(token).catch(() => {
        setMsg("Login link invalid or expired.");
        setBusy(false);
      });
    }
  }, [params, ready, user, consume]);

  if (!ready || busy) return <p>Loading…</p>;
  if (user) return <p>Logged in as {user.email}.</p>;

  return (
    <div>
      <h1>Login</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setMsg("");
          login(email)
            .then(({ devToken }) => {
              if (devToken) {
                void consume(devToken);
              } else {
                setMsg("Check your email for the login link.");
                setBusy(false);
              }
            })
            .catch(() => {
              setMsg("Could not start login.");
              setBusy(false);
            });
        }}
      >
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Send magic link
        </button>
      </form>
      {msg ? <p>{msg}</p> : null}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <LoginInner />
    </Suspense>
  );
}
