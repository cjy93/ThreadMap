import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth, viewsDemo, workspaceModeFor } from '@/server/auth';
import { getDb } from '@/server/db';
import { ThreadMapApp } from '@/ui/ThreadMapApp';

export const dynamic = 'force-dynamic';

export default async function AppPage() {
  const auth = await getAuth();
  if (!auth) redirect('/');
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) redirect('/');
  const user = session.user as { id: string; isAnonymous?: boolean | null };
  const mode = await workspaceModeFor(getDb(), user, viewsDemo(h.get('cookie')));
  // A WhatsApp account viewing the demo goes back to its chats instead of signing out.
  return <ThreadMapApp mode={mode} ownAccount={!user.isAnonymous} />;
}
