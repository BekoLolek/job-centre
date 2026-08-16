"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Eyebrow, Field } from "@/components/ui";

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Sign-in failed");
        setBusy(false);
        return;
      }
      router.push("/draft");
      router.refresh();
    } catch {
      setError("Network error — try again");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm rise">
      <div className="lg:hidden mb-10">
        <h1 className="font-display text-6xl leading-[0.85]">
          JOB CENTRE
          <span className="block text-gold">EVENTS</span>
        </h1>
      </div>

      <Eyebrow className="mb-6">Sign in</Eyebrow>

      <Field
        label="Username"
        wrapperClassName="mb-4"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoFocus
        required
      />

      <Field
        label="Password"
        wrapperClassName="mb-6"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
      />

      {error && <Alert className="mb-4">{error}</Alert>}

      <Button variant="gold" className="w-full" disabled={busy}>
        {busy ? "Checking…" : "Enter the room"}
      </Button>

      <p className="mt-8 text-xs text-muted leading-relaxed">
        Credentials are handed out by the draft admin. One account per team.
      </p>
    </form>
  );
}
