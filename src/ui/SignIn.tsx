'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from './client';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) setErr(r.error.message ?? 'Sign-in failed');
    else router.push('/app');
  };
  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
      <form className="card" onSubmit={submit} aria-label="Owner sign in">
        <h2 style={{ marginTop: 0 }}>Owner sign in</h2>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Email
          <br />
          <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block', marginBottom: 8 }}>
          Password
          <br />
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
        </label>
        {err ? <p role="alert">{err}</p> : null}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Try the demo</h2>
        <p>An isolated workspace with three synthetic chats (300 messages, replayed and labeled as such). No WhatsApp pairing, no private data.</p>
        <a href="/demo">
          <button className="primary">Open demo</button>
        </a>
      </div>
    </div>
  );
}
