"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
          TOURNAMENT
          <span className="block text-gold">DRAFT</span>
        </h1>
      </div>

      <div className="eyebrow mb-6">Sign in</div>

      <label className="block mb-4">
        <span className="eyebrow block mb-2 text-chalk/70">Username</span>
        <input
          className="field"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </label>

      <label className="block mb-6">
        <span className="eyebrow block mb-2 text-chalk/70">Password</span>
        <input
          className="field"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>

      {error && (
        <p className="mb-4 border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
          {error}
        </p>
      )}

      <button className="btn btn-gold w-full" disabled={busy}>
        {busy ? "Checking…" : "Enter the room"}
      </button>

      <p className="mt-8 text-xs text-muted leading-relaxed">
        Credentials are handed out by the draft admin. One account per team.
      </p>
    </form>
  );
}
