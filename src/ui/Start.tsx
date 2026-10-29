'use client';

/** Landing actions: WhatsApp is the sign-in, so there is no account form. */
export function Start({ pairingEnabled, demoEnabled, signedIn }: { pairingEnabled: boolean; demoEnabled: boolean; signedIn: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
      {signedIn ? (
        // Signed in on this browser: offer the way back to your chats rather than a new link.
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Welcome back</h2>
          <p>You are signed in to ThreadMap on this browser. Continue to your chats and maps, or finish connecting WhatsApp.</p>
          <a href="/api/view?to=mine">
            <button className="primary">Open ThreadMap</button>
          </a>
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Connect your WhatsApp</h2>
          <p>
            Scan a QR code with WhatsApp (Settings → Linked Devices), or link with your phone number if you can&apos;t scan. The WhatsApp account you link becomes your
            ThreadMap account — no email or password. Every link starts fresh: anything from an earlier link of the same number is deleted.
          </p>
          {pairingEnabled ? (
            <a href="/connect">
              <button className="primary">Connect WhatsApp</button>
            </a>
          ) : (
            <p className="counts">Connecting WhatsApp is disabled on this deployment.</p>
          )}
        </div>
      )}
      {/* Signed in, the demo opens as a separate view: your account and chats stay as they are. */}
      {demoEnabled ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Try the demo</h2>
          <p>
            An isolated workspace with three synthetic chats (300 messages, replayed and labeled as such). No WhatsApp pairing, no private data.
            {signedIn ? ' Your own chats stay linked: press “My chats” to go back.' : ''}
          </p>
          <a href={signedIn ? '/api/view?to=demo' : '/demo'}>
            <button className="primary">Open demo</button>
          </a>
        </div>
      ) : null}
    </div>
  );
}
