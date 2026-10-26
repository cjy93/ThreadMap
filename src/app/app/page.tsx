import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { ThreadMapApp } from '@/ui/ThreadMapApp';

export const dynamic = 'force-dynamic';

export default async function AppPage() {
  const auth = await getAuth();
  if (!auth) redirect('/');
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');
  const mode = (session.user as { isAnonymous?: boolean | null }).isAnonymous ? 'demo' : 'private';
  return <ThreadMapApp mode={mode} />;
}
