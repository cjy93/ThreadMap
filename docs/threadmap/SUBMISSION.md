# ThreadMap — submission packet (prepared, not published)

Placeholders in `<angle brackets>` must be replaced with real, observed values. Do not publish until A18–A20 have genuine evidence.

## Project description (Devpost)

**ThreadMap: find anything in a busy WhatsApp chat — and see how your chats connect.**

Useful ideas and resources disappear inside busy group chats. ThreadMap links to WhatsApp as a linked device (owner scans a QR), captures only the chats you select, and turns each one into a map with three fixed roots: Knowledge, General Chat and Resources. NVIDIA Nemotron models on Nebius Token Factory build a recursive, evidence-backed topic hierarchy — Programming → Hackathons → Solutions → Authentication → Tokens → Refresh flow — that goes as deep as the content supports and no deeper.

- Every node's size reflects the exact number of matching messages in its whole subtree, on one shared compressed scale, with the exact count shown.
- *Show depth* changes only what is drawn: counts, sizes and contents stay identical. Click any root or topic to read the matching messages and files from all deeper levels without expanding anything.
- Every summary bullet cites the exact source messages; every map node leads back to captured messages and attachments.
- Read/Missed is per user and revision-aware: a message you read and is later edited becomes Missed again; date + topic + Missed filters agree across map, lists, search and counts.
- Related topics across chats are proposed from shared links and keywords and verified by Nemotron Super with evidence on both sides.

**Models:** Nemotron 3 Ultra builds and refines the taxonomy in bounded steps with a persisted refinement frontier; Nemotron 3 Nano does routine extraction and assignment; Nemotron 3 Super repairs invalid output, resolves ambiguous placements and verifies cross-chat links. Exact model IDs: `<from reports/live-inference.json>`.

**Nebius:** the whole app — Next.js web/API, a long-running Baileys companion and a pg-boss AI worker — runs as one image on a regular CPU **Nebius Serverless Endpoint** (`<https URL>`, image `<digest>`), with Managed PostgreSQL, private Object Storage and SecretStash. Closing your browser or turning off your laptop does not stop capture.

**Honesty notes:** Baileys is an unofficial WhatsApp Web library; this is an experimental prototype. Selected chat content is stored in the deployment's database and sent to Nebius Token Factory. ThreadMap never sends WhatsApp messages or read receipts.

## Testing instructions for judges

1. Open `<https URL>` → **Try the demo**. You get an isolated workspace with three synthetic chats (300 messages, labeled replay; pairing disabled).
2. Pick **Builders and Hackathons**. Switch the status filter to **All**. Node circles grow with message count; the legend explains the compressed scale.
3. Set **Show depth** to 1. Click **Programming** → **Files**: `refresh-flow-diagram.pdf` appears with its full path (six topic levels deep) — no expansion needed. Open the source message; after 2 s in view it turns Read (only that message).
4. Change Show depth to 0, 2, All: counts and sizes of the visible roots don't change.
5. Open **Programming Study Group** → Show depth **All** → **Tokens** → **Related chats**: evidence from both chats.
6. Combine a date range (2–3 Sep 2026), **Filter to this topic** and **Missed**: the root count equals the topic count.
7. Owner-only features (live WhatsApp pairing) are demonstrated in the video; judges cannot pair.

## Technology feedback (draft — fill with real observations)

- Token Factory's OpenAI-compatible API made swapping between Nemotron roles trivial; `GET /v1/models` exposed exact IDs. Observed JSON-schema support per role: `<from capability report>`.
- Serverless Endpoints: managed HTTPS per port and stop/start keeping the URL fit a long-running app; immutable settings meant implementing a database-backed origin bootstrap to avoid recreate loops. Observations: `<deploy notes>`.
- Wish list: documented in-network exec for Endpoints (we used one-off Serverless Jobs as the admin path), auto-restart policy for Endpoints, `--format json` documented on create.

## 2:45 video script

| Time | Shot | Narration |
| --- | --- | --- |
| 0:00–0:15 | A busy group chat scrolling | "Great ideas and links vanish in busy chats. ThreadMap gets them back." |
| 0:15–0:35 | Hosted URL (address bar visible), status Connected; phone sends a message; it appears without refresh | "ThreadMap runs on a Nebius Serverless Endpoint as a WhatsApp linked device. New messages arrive live." (QR never shown) |
| 0:35–1:05 | Map: large Knowledge node; expand to Programming → Hackathons → Solutions → … → Refresh flow; open file | "Nemotron Ultra built this hierarchy as deep as the evidence goes. Size = matching messages, exact counts on every node." |
| 1:05–1:30 | Show depth 1; open Programming → Files → deep PDF; apply Date + Topic + Missed | "Depth only changes the view. From one level down I can still open a file six levels deep. Filters agree everywhere." |
| 1:30–1:55 | Related chats tab → jump to study group; evidence both sides | "Nemotron Super verifies links between chats, with evidence on both sides." |
| 1:55–2:20 | Endpoint stop/start in console; same counts after restart; another phone message arrives | "State lives in Managed PostgreSQL and Object Storage — restart, and everything is still here." (label any replay segment) |
| 2:20–2:45 | Model IDs + endpoint/digest from reports | "Nemotron Ultra, Nano and Super on Token Factory; one CPU Endpoint on Nebius. ThreadMap." |
