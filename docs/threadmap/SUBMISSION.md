# ThreadMap — submission packet (prepared, not published)

Placeholders in `<angle brackets>` must be replaced with real, observed values before publishing.

## Project description (Devpost)

**ThreadMap: find anything in a busy WhatsApp chat.**

Useful ideas, links and decisions disappear inside busy chats. ThreadMap links to WhatsApp as a linked device (you scan a QR code, like WhatsApp Web), keeps only the chats you open, and turns each one into a mind map with four fixed roots: **Knowledge**, **General Chat**, **Events and Activities** and **Resources**. NVIDIA Nemotron models on Nebius Token Factory read the messages and build the map top-down: a few broad subjects under each root, then narrower ones, one level at a time, never more than six branches per node.

- **Read the chat, not just the words.** Nemotron reads each message with the conversation around it and its WhatsApp reply chain, so a short "yes, Friday works" is filed with the question it answers. Small talk ("ok", "lol") stays out of the map's counts; anything a summary cites stays in.
- **Subjects, not chatter.** Anything about a subject — however casually said — goes to Knowledge; named software and AI services (ElevenLabs, Claude, Vultr…) are gathered under Knowledge › Software. Topics are named by subject ("Nebius (NBIS)", not "Request for explanation on NBIS").
- **Every node is a door to the source.** Node size shows how many messages a branch holds; click any node to read its messages and files from every level beneath it, with a Nemotron summary whose points cite the exact messages.
- **Open a message, see its conversation.** *Discussion* shows its reply chain, including answers given without pressing Reply (worked out by Nemotron); *Chatroom* shows the chat around it in time order, scrolling further either way; *Topic thread* shows everything grouped with it.
- **Ask in plain words.** Ask finds messages however a name is written — typos, other spellings, and other names the chat uses for the same thing ("davinci = Elucidex") — and Nemotron answers with numbered sources. Matches show at once; when Nemotron is slow, its answer appears as soon as it is ready.
- **Your side or theirs.** *Map from: Everyone / Others / You* builds a separate map from only the other people's messages or only yours, so their knowledge and yours never blur.
- **Missed and Read** are per message and revision-aware (an edited message becomes Missed again), with date, topic and Missed filters that agree across the map, lists and Ask.

**Models (Nebius Token Factory):** Nemotron 3 **Nano** (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) reads messages into discussions, places new discussions, screens small talk, turns questions into search terms and finds answers given without Reply. Nemotron 3 **Super** (`nvidia/nemotron-3-super-120b-a12b`) builds and refines the map, groups and splits topics, repairs invalid output and writes Ask answers. Nemotron **VL** (`nvidia/Nemotron-3.5-Super-VL`) describes shared images so they can be found by what they show. (IDs as observed in the model-call log.)

**NVIDIA Brev:** the whole app — Next.js web/API, a long-running WhatsApp companion and the Nemotron worker — runs as one Docker image on an NVIDIA Brev instance (`<public URL>`), with its PostgreSQL database on Supabase (Singapore), reached only over verified TLS. Capture runs in the cloud while a ThreadMap page is open, even if your phone is offline.

**Privacy notes:** only chats you open are stored (for others, only name, type, last-message time and photo). Stored messages stay in the app's own database (Supabase, encrypted at rest); the text of messages being analysed is sent to Nebius Token Factory. "Disconnect and delete my data" unlinks the device and deletes everything, files included — and if you forget, the same happens by itself once no ThreadMap page has been open for 30 minutes. ThreadMap never sends WhatsApp messages or read receipts, and has no internet search.

**Honesty notes:** Baileys is an unofficial WhatsApp Web library; this is an experimental prototype. WhatsApp sends a chat's full history only once, at linking; older messages of a chat opened later depend on the phone answering on-demand requests.

## Testing instructions for judges

1. Open `<public URL>` → **Try the demo**. You get an isolated workspace with three synthetic chats (300 messages, labelled replay; pairing disabled).
2. Pick **Builders and Hackathons** and switch the status filter to **All**. Node circles grow with message count; click **▾ N topics** under a circle to open its branch.
3. Click **Knowledge** → **Programming** → **Files**: `refresh-flow-diagram.pdf` appears with its full path, six topic levels deep, without expanding anything.
4. Double-click a message in a topic's list: **Discussion** shows its reply chain, **Chatroom** the chat around it (scroll for more), **Topic thread** what was grouped with it. Single-click and drag to select and copy words.
5. **Ask** "refresh tokens" (or a misspelling like "refesh tokns"): the Ask map lays out your question, the topics it fits and the best messages; the answer cites numbered sources. **Find in this map** highlights boxes; **← Back to mind map** returns.
6. Switch to **Missed** and add a date range (2–3 Sep 2026): every bubble's count updates to match, and a topic's list shows only those messages.
7. Owner-only features (live WhatsApp linking, Map from You/Others on a real chat) are shown in the video; judges cannot link a phone.

## Technology feedback (draft — fill with real observations)

- **Token Factory:** the OpenAI-compatible API made switching Nemotron roles a one-line change, and `GET /v1/models` gave exact IDs. Observed: Super's answers for 40 discussions at a time often hit the 4,096-token output limit, so the map builder now shrinks its window after a cut-off answer; 503/529 "overloaded" replies are retried with backoff. `<add capability report observations>`
- **Nemotron Nano vs Super:** Nano handled high-volume, structured jobs (segmenting messages, small-talk screening, question terms) cheaply; Super was needed for consistent hierarchy building. Nano sometimes split a reply off from the discussion it answered, so a code check now joins small fragments into the discussion they reply to. From the model-call log so far: 517 Nano extraction calls, none failed; 51 of 66 Super map-building calls needed a repair (mostly answers cut off at the output limit), which led to the shrinking windows.
- **NVIDIA Brev:** `<observations: instance setup, Docker, exposing the app (tunnel vs open ports), restarts>`
- Wish list: `<…>`

## 2:45 video script

| Time | Shot | Narration |
| --- | --- | --- |
| 0:00–0:15 | A busy group chat scrolling | "Great ideas and links vanish in busy chats. ThreadMap gets them back." |
| 0:15–0:35 | Public URL (address bar visible), connected; phone sends a message; it appears without refresh | "ThreadMap runs on NVIDIA Brev as a WhatsApp linked device. New messages arrive live." (QR never shown) |
| 0:35–1:00 | Map: four roots; open Knowledge → Software → Voice tools; click a node, summary with sources | "Nemotron Super builds the map top-down — never more than six branches — and every summary point cites its message." |
| 1:00–1:25 | Double-click a message → Discussion (an answer given without Reply) → Chatroom scroll | "Nemotron links answers even when Reply wasn't pressed, and the whole conversation is one click away." |
| 1:25–1:55 | Ask with a misspelt name; Ask map; answer with numbered sources; Find in this map | "Ask in plain words. Typos and nicknames still match, and the answer shows where it came from." |
| 1:55–2:20 | Map from: You — the owner's own map beside Everyone | "Build a map from only your messages, or only theirs — their knowledge never blurs into yours." |
| 2:20–2:45 | Model IDs, Brev instance, closing shot | "Nemotron Nano, Super and VL on Nebius Token Factory; one Docker image on NVIDIA Brev. ThreadMap." |
