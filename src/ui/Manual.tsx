// The user manual: shown in the app as a panel and on its own at /manual.
import { RootIcon } from './RootIcon';

export function ManualContent() {
  return (
    <div className="manual">
      <section>
        <h3>1. Connect WhatsApp</h3>
        <ol>
          <li>
            Click <strong>Connect WhatsApp</strong>, then on your phone open WhatsApp → Settings → <strong>Linked devices</strong> → Link a device and scan the QR code. Can&apos;t scan? Click{' '}
            <em>Link with phone number</em>, enter your number, and type the 8-character code shown into WhatsApp (Link with phone number instead).
          </li>
          <li>The WhatsApp account you link is your ThreadMap account — there is no email or password. Every new link starts fresh.</li>
          <li>
            Pick chats in the list (tabs All / Groups / People, or search by name or number) and click <strong>Open</strong>. Open the chats you want within a few minutes of
            linking: that is when your phone sends their recent history.
          </li>
          <li>Chats you never open are not stored — only their name, type, last-message time and photo.</li>
        </ol>
      </section>

      <section>
        <h3>2. Read the map</h3>
        <p>Every chat is sorted by NVIDIA Nemotron under four roots:</p>
        <ul className="manual-roots">
          <li>
            <RootIcon root="KNOWLEDGE" size={28} /> <strong>Knowledge</strong> — explanations, how-tos, ideas.
          </li>
          <li>
            <RootIcon root="GENERAL_CHAT" size={28} /> <strong>General Chat</strong> — banter, check-ins, everyday talk.
          </li>
          <li>
            <RootIcon root="EVENTS_ACTIVITIES" size={28} /> <strong>Events and Activities</strong> — meetups, plans, dates and places.
          </li>
          <li>
            <RootIcon root="RESOURCES" size={28} /> <strong>Resources</strong> — links, files, images and repos people shared.
          </li>
        </ul>
        <ul>
          <li>A bigger circle holds more messages. The number inside is the message count; <span className="missed">missed</span> counts messages you have not read yet.</li>
          <li>
            Click <strong>▾ N topics</strong> under a circle to open just that branch; <strong>▴ Hide</strong> closes it. <strong>Expand all</strong> / <strong>Collapse all</strong> sit at
            the top right of the map.
          </li>
          <li>
            Lost the map off-screen? <strong>Double-click</strong> an empty part of the map, or click <strong>⌖ Re-centre</strong>, to fit it back in view.
          </li>
          <li>Click a circle to list its messages in the side panel. <strong>Focus branch</strong> shows only that part of the map.</li>
          <li>
            <strong>Missed / All / Read</strong> and the <strong>From / To</strong> dates filter what the circles count. Every level is loaded; click <strong>▾ topics</strong> under a circle to open its subtopics.{' '}
            <strong>Outline</strong> shows the same tree as an indented list.
          </li>
          <li>
            Tick <strong>discussions</strong> to add the individual conversations under each topic as extra circles — the groups of related messages Nemotron found (one
            exchange about one thing), with their own title and count. Leave it off for a cleaner map of topics only.
          </li>
        </ul>
      </section>

      <section>
        <h3>3. Open messages</h3>
        <ul>
          <li>
            In a topic&apos;s message list, <strong>✓ Read</strong> beside a missed message marks it read without opening it; <strong>Bulk review…</strong> marks the whole
            list at once.
          </li>
          <li>Opening a message shows it in its conversation (five messages before and after), with images, videos and voice notes inline.</li>
          <li>
            With <strong>auto-read</strong> on, a message you keep open for two seconds is marked read. Images are described by Nemotron vision so you can search for what is in them.
          </li>
        </ul>
      </section>

      <section>
        <h3>4. Keep it up to date</h3>
        <ul>
          <li>
            Nemotron analyses a chat when you first open it, and afterwards only when you click <strong>Refresh (N new)</strong> in the top bar — new messages wait there until you do.
          </li>
          <li>
            <strong>Load older messages</strong> asks your phone for the 50 messages before the oldest one stored; they join the Refresh count. WhatsApp may return fewer or none.
          </li>
        </ul>
      </section>

      <section>
        <h3>5. Ask</h3>
        <ul>
          <li>
            Type what you are looking for in plain words in the <strong>Ask</strong> box (e.g. “where did we decide the venue?”). Nemotron turns it into search terms and picks the
            topics that fit.
          </li>
          <li>
            The answer appears as a <strong>concept map</strong>: your question → broader topics (abstraction) → the topics picked (topic) and other topics with matches (sibling) →
            the best messages (detail). A message in several topics appears once, with dashed “also in” links.
          </li>
          <li>
            Click a message to read it, or a topic to jump to it on the chat map. <strong>+ Concept</strong> adds your own notes (drag from a node’s right edge to link them),{' '}
            <strong>Tidy layout</strong> rearranges, <strong>Export</strong> saves the map as a file. <strong>← Back to chat map</strong> returns.
          </li>
        </ul>
      </section>

      <section>
        <h3>6. Layout, account and privacy</h3>
        <ul>
          <li>
            <strong>☰</strong> hides or shows the chat list; <strong>Night / Twilight</strong> switches the theme.
          </li>
          <li>
            <strong>Connect / manage WhatsApp</strong> returns to the chat picker. <strong>Sign out</strong> (or Disconnect &amp; delete my data) unlinks ThreadMap from your phone and
            deletes your account, chats and maps.
          </li>
        </ul>
      </section>
    </div>
  );
}
