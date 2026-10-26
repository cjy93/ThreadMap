'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authClient } from '@/ui/client';

export default function Demo() {
  const [msg, setMsg] = useState('Preparing an isolated synthetic demo workspace…');
  const router = useRouter();
  useEffect(() => {
    void (async () => {
      const s = await authClient.getSession();
      if (!s.data) {
        const r = await authClient.signIn.anonymous();
        if (r.error) return setMsg(r.error.message ?? 'Demo unavailable');
      }
      // First request seeds the guest workspace (labeled fixture replay).
      const res = await fetch('/api/chats', { cache: 'no-store' });
      if (!res.ok) return setMsg('Demo unavailable right now.');
      router.push('/app');
    })();
  }, [router]);
  return (
    <main className="landing">
      <div className="sky" aria-hidden />
      <p role="status">{msg}</p>
    </main>
  );
}
