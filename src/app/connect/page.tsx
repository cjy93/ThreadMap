'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, authClient } from '@/ui/client';

export default function Connect() {
  const [msg, setMsg] = useState('Preparing your WhatsApp QR code…');
  const router = useRouter();
  // Exactly one session and one QR request per visit, even when effects run twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const s = await authClient.getSession();
      if (!s.data) {
        const r = await authClient.signIn.anonymous();
        if (r.error) return setMsg(r.error.message ?? 'Connecting is unavailable right now.');
      }
      try {
        await api('/api/connect/start', { method: 'POST' });
      } catch (e) {
        return setMsg(e instanceof Error ? e.message : 'Connecting is unavailable right now.');
      }
      router.push('/app?setup=1');
    })();
  }, [router]);
  return (
    <main className="landing">
      <div className="sky" aria-hidden />
      <p role="status">{msg}</p>
    </main>
  );
}
