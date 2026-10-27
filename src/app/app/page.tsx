import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth, workspaceModeFor } from '@/server/auth';
import { getDb } from '@/server/db';
import { ThreadMapApp } from '@/ui/ThreadMapApp';

export const dynamic = 'force-dynamic';

export default async function AppPage() {
  const auth = await getAuth();
  if (!auth) redirect('/');
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');
  const mode = await workspaceModeFor(getDb(), session.user as { id: string; isAnonymous?: boolean | null });
  return <ThreadMapApp mode={mode} />;
}
