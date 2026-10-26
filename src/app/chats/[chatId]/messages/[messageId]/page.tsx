import { redirect } from 'next/navigation';

// Stable source route: opens the same canonical message after reconnect,
// restart or taxonomy changes (authorization is enforced by the API).
export default async function MessageRoute({ params }: { params: Promise<{ chatId: string; messageId: string }> }) {
  const { chatId, messageId } = await params;
  redirect(`/app?chat=${encodeURIComponent(chatId)}&message=${encodeURIComponent(messageId)}`);
}
