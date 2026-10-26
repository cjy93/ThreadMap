import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuth } from '@/server/auth';
import { SignIn } from '@/ui/SignIn';
import { ThemeToggle } from '@/ui/ThemeToggle';

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
        <p className="lede">This deployment is starting up: its public origin has not been bootstrapped yet, so sign-in and pairing are disabled.</p>
      </main>
    );
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect('/app');
  return (
    <main className="landing">
      <LandingTop />
      <div className="kicker">WhatsApp → knowledge map · NVIDIA Nemotron on Nebius</div>
      <h1>
        Every busy chat, <em>mapped</em> to its sources.
      </h1>
      <p className="lede">
        Turn busy WhatsApp conversations into navigable knowledge maps. Every chat gets three roots — <strong>Knowledge</strong>, <strong>General Chat</strong> and{' '}
        <strong>Resources</strong> — with recursively nested topics found by NVIDIA Nemotron. Node size shows how many matching messages a branch holds, and every node opens
        the exact source messages and files beneath it.
      </p>
      <div className="roots" aria-hidden>
        <span className="pill k">Knowledge</span>
        <span className="pill g">General Chat</span>
        <span className="pill r">Resources</span>
      </div>
      <SignIn />
    </main>
  );
}
