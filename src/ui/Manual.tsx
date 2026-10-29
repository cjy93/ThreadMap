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
            Pick chats in the list (tabs All / Groups / People, or search by name or number) and click <strong>Open</strong>. Open the chats you want within <strong>30 minutes</strong> of
            linking: your phone sends their recent history once, when you link, and ThreadMap holds it in memory only for that long.
          </li>
          <li>
            After 30 minutes the list shows only the chats you opened. To add more people or groups, click <strong>Disconnect &amp; delete my data</strong>, scan the QR code
            again and open them within 30 minutes (this deletes your current chats and maps first).
          </li>
          <li>Chats you never open are not stored — only their name, type, last-message time and photo.</li>
        </ol>
      </section>

      <section>
        <h3>2. Read the map</h3>
        <p>Every chat is sorted by NVIDIA Nemotron under four roots:</p>
        <ul className="manual-roots">
          <li>
            <RootIcon root="KNOWLEDGE" size={28} /> <strong>Knowledge</strong> — information you could learn from or reuse, however casually said: tech and tools (all named software under Software), how things work, tips, study, advice.
          </li>
          <li>
            <RootIcon root="GENERAL_CHAT" size={28} /> <strong>General Chat</strong> — personal and social talk: greetings, feelings, life updates (&ldquo;my boss scolded me&rdquo;) and personal arrangements (&ldquo;bring my gym clothes&rdquo;).
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
          <li>
            Click a circle to list its messages in the side panel. <strong>Focus branch</strong> shows only that part of the map; <strong>Full map</strong> (in the same place) brings the whole map back so you can pick another bubble. The controls at the top fold up while the panel
            is open; <strong>▾ Show controls</strong> brings them back (<strong>▴</strong> folds them yourself).
          </li>
          <li>
            <strong>Missed / All / Read</strong> and the <strong>From / To</strong> dates filter what the circles count. Every level is loaded; click <strong>▾ topics</strong> under a circle to open its subtopics.{' '}
            <strong>Outline</strong> shows the same tree as an indented list.
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
          <li>
            <strong>Double-click</strong> a message to open it (or select it with Tab and press Enter). A single click does nothing, so you can select words and copy them, for
            example to look up something you don&rsquo;t know. This works in topic lists, Starred, Ask results, discussions and reply chains.
          </li>
          <li>
            Opening a message shows it with images, videos and voice notes inline. Below it, three tabs show what surrounds it; double-click any message there to open it, and{' '}
            <strong>← Back</strong> returns to where you came from:
            <ul>
              <li>
                <strong>Discussion</strong>: its reply chain — what it replies to and every reply to it — including answers given without pressing Reply.
              </li>
              <li>
                <strong>Chatroom</strong>: the chat in time order, as in WhatsApp. Scroll up or down (or click <em>↑ Earlier</em> / <em>↓ Later messages</em>) to load more.
              </li>
              <li>
                <strong>Topic thread</strong>: the messages Nemotron grouped into its discussion, wherever they are in the chat, after a few earlier messages for context; replies
                show the message they quote.
              </li>
            </ul>
          </li>
          <li>
            People often answer a question from a few messages back without pressing Reply. The first time you open a discussion, Nemotron reads it once and works out which
            message answers which: those show <em>&ldquo;↪ answers …&rdquo;</em> above them (dashed, unlike a real WhatsApp reply &ldquo;↩&rdquo;).
          </li>
          <li>
            In <strong>Discussion</strong>, the chain runs earliest first: what the message replies to (and what that replies to), the message itself, then every reply to it and
            the replies to those, indented by how far along the chain they are. Steps Nemotron worked out (no Reply pressed) are marked <em>inferred</em>.
          </li>
          <li>Small talk with nothing to keep (&ldquo;ok&rdquo;, &ldquo;lol&rdquo;, throwaway quips) is left out of the map&rsquo;s counts and lists. It still appears, dimmed, in its discussion.</li>
          <li>
            <strong>Map from: Everyone / Others / You</strong> chooses whose messages a chat&rsquo;s map is built from. <em>Others</em> and <em>You</em> are separate maps: topics and
            summaries come only from that side, so what the others said never shapes your map. Nemotron still reads the other side&rsquo;s messages and replies around them, so
            short answers are understood. The first time you pick a side, its map is built (a few minutes for a long chat); Refresh keeps it up to date.
          </li>
          <li>
            A message you keep open for two seconds is marked read. Images are described by Nemotron vision so you can search for what is in them.
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
            Names are found however they are written: a typo (&ldquo;davincci&rdquo;) still finds &ldquo;Davinci&rdquo;, and other names your chat uses for the same thing
            (&ldquo;davinci = Elucidex&rdquo;) are searched too. Ask only searches your own chats, never the internet.
          </li>
          <li>
            The answer appears as a <strong>concept map</strong>: your question → broader topics (abstraction) → the topics picked (topic) and other topics with matches (sibling) →
            the best messages (detail). A message in several topics appears once, with dashed “also in” links.
          </li>
          <li>
            Click a message to read it, or a topic to jump to it on the chat map. <strong>Find in this map</strong> highlights matching boxes (Enter jumps to the next,
            Shift+Enter to the previous). <strong>+ Concept</strong> adds your own notes (drag from a node’s right edge to link them), <strong>Tidy layout</strong> rearranges,{' '}
            <strong>Export</strong> saves the map as a file. The top bar&rsquo;s controls belong to the mind map: on the Ask map, <strong>← Back to mind map</strong> takes their
            place and brings them back.
          </li>
          <li>
            If Nemotron is slow, the plain word matches show at once and the answer appears when it is ready (the search also refreshes once Nemotron has read your question).
            If your Nemotron allowance is used up, Ask says so and searches the plain words.
          </li>
          <li>Opening a circle on the map, clicking <strong>All roots</strong>, or opening another chat clears the Ask box and its results, so the map is never filtered by an old question.
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
          <li>
            <strong>Forgot to delete?</strong> If no ThreadMap page is open for 30 minutes, the same happens by itself: ThreadMap unlinks from your phone and deletes your
            chats, messages, maps and photos. Keep a ThreadMap tab open while you want it to keep capturing; reloading or briefly losing the connection is fine.
          </li>
        </ul>
      </section>
    </div>
  );
}
