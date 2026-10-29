# "To Brev" — moving ThreadMap onto an NVIDIA Brev instance

The owner types **"to brev"** to get these steps. The instance runs in NVIDIA's cloud
(managed at [brev.nvidia.com](https://brev.nvidia.com)); the database is already on
Supabase, so the instance only runs the ThreadMap app.

## What goes onto the instance

| What | How it gets there |
|---|---|
| All source code | `git clone` from GitHub (only what has been **pushed**) |
| `.env.compose`, `.env.supabase`, `deploy/vm/supabase-ca.crt` | Uploaded by the owner from the PC — they hold the secrets and are git-ignored, so GitHub never has them |

## Steps

**1. On the PC — push the latest code.** All work is on `main`. Commit any pending changes
on `main` and push it to `https://github.com/cjy93/ThreadMap.git` (`git push origin main`),
so the clone has them.

**2. On brev.nvidia.com — create and open the instance.** A CPU instance with Docker
(2 vCPU / 8 GB is enough). If Brev offers a choice of region, pick one in Asia (ideally
Singapore): the database is on Supabase in Singapore, and the app makes many small queries. Open a terminal on it: the instance's **Open Notebook**
(JupyterLab) → **File → New → Terminal**, or `brev shell <instance>` with the Brev CLI on the PC.

**3. On the instance — get the code.**
```
git clone https://github.com/cjy93/ThreadMap.git
cd ThreadMap
```
This gives `main`, the latest version — no branch to switch to.
(Private repo: sign in with a GitHub personal access token, or `gh auth login`.)

**4. Upload the three secret files** into the instance (JupyterLab's **Upload** button, or
`scp` from the PC after `brev login`):
- `ThreadMap\.env.compose`
- `ThreadMap\.env.supabase`
- `ThreadMap\deploy\vm\supabase-ca.crt` → put it at `ThreadMap/deploy/vm/supabase-ca.crt` on the instance

Files starting with a dot can be hidden in the Windows file picker — type the name.

**5. Get the HTTPS address.** In the Brev console, the instance's **Access** tab → add a
tunnel for port **3000** → copy its URL. (Brev may ask visitors to sign in; if judges
cannot, open ports 80/443 instead and use `--profile https` — see `README.md` here.)

**6. Build `deploy/vm/.env.vm`** from the uploaded files (Claude on the instance can do this):

| Line | Value |
|---|---|
| `SUPABASE_DB_URL=` | the connection string from `.env.supabase` |
| `WHATSAPP_AUTH_ENCRYPTION_KEY=` | **exactly** as in `.env.compose` (else the WhatsApp link stored in Supabase cannot be decrypted → QR rescan) |
| `BETTER_AUTH_SECRET=`, `NEBIUS_API_KEY=` | as in `.env.compose` |
| `LLM_UNLIMITED_PHONES=` | as in `.env.compose` |
| `DOMAIN=` | the tunnel URL's host, without `https://` |
| `POSTGRES_PASSWORD=` | any text (unused with Supabase, currently required by the file) |
| `AUTO_DELETE_AFTER_MINUTES=` | `30` (the default; the owner found 2 too short) — already in the example file |

Start from `cp deploy/vm/env.vm.example deploy/vm/.env.vm`. Never print the values.

**7. On the PC — stop the local ThreadMap** (only one copy may be linked to the WhatsApp
account at a time): `docker compose -p tmlocal stop app`.

**8. On the instance — start ThreadMap on Supabase.**
```
cd deploy/vm
docker compose --env-file .env.vm -f compose.yaml -f compose.supabase.yaml up -d --build
```
Then open the tunnel URL: the chats should be there with no QR scan.

**9. Check:** `docker compose ... logs app` shows `connected`, no `EMAXCONNSESSION`
or TLS errors; a new WhatsApp message arrives.

## Not yet tested

None of this has been run on a real Brev instance yet. The compose files were only validated
on the owner's PC. Expect to fix things on the first run.
