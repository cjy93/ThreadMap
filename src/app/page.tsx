import { headers } from 'next/headers';
import { loadAppConfig } from '@/lib/config';
import { getAuth } from '@/server/auth';
import { RootIcon } from '@/ui/RootIcon';
import { Start } from '@/ui/Start';
import { ThemeToggle } from '@/ui/ThemeToggle';
import { MadeBy } from '@/ui/MadeBy';

export const dynamic = 'force-dynamic';

function LandingTop() {
  return (
    <>
      <div className="sky" aria-hidden />
      <div className="landing-top">
        <span className="brand">
          Thread<em>Map</em>
        </span>
        <ThemeToggle />
      </div>
    </>
  );
}

export default async function Home() {
  const auth = await getAuth();
  if (!auth) {
    return (
      <main className="landing">
        <LandingTop />
        <div className="kicker">Starting up</div>
        <h1>ThreadMap</h1>
        <p className="lede">This deployment is starting up: its public origin has not been bootstrapped yet, so connecting WhatsApp is disabled.</p>
      </main>
    );
  }
  const session = await auth.api.getSession({ headers: await headers() });
  // The landing page is always the front door; signed-in visitors get "Welcome back" with the
  // way into their chats (and the demo), never a forced jump to the app.
  const cfg = loadAppConfig();
  return (
    <main className="landing">
      <LandingTop />
      <div className="kicker">WhatsApp → knowledge map · NVIDIA Nemotron on Nebius Token Factory · hosted on NVIDIA Brev</div>
      <h1>
        Every busy chat, <em>mapped</em> to its sources.
      </h1>
      <p className="lede">
        Turn busy WhatsApp conversations into navigable knowledge maps. Every chat starts from four roots — <strong>Knowledge</strong>, <strong>General Chat</strong>,{' '}
        <strong>Events and Activities</strong> and <strong>Resources</strong> — with recursively nested topics found by NVIDIA Nemotron. Find the explanation, the meetup
        details or the shared link without scrolling: node size shows how many matching messages a branch holds, and every node opens the exact source messages and files
        beneath it.
      </p>
      <div className="roots" aria-hidden>
        <span className="pill k">
          <RootIcon root="KNOWLEDGE" size={22} /> Knowledge
        </span>
        <span className="pill g">
          <RootIcon root="GENERAL_CHAT" size={22} /> General Chat
        </span>
        <span className="pill e">
          <RootIcon root="EVENTS_ACTIVITIES" size={22} /> Events and Activities
        </span>
        <span className="pill r">
          <RootIcon root="RESOURCES" size={22} /> Resources
        </span>
      </div>
      <Start pairingEnabled={cfg.WHATSAPP_PAIRING_ENABLED} demoEnabled={cfg.PUBLIC_DEMO_ENABLED} signedIn={Boolean(session)} />
      <MadeBy />
    </main>
  );
}
