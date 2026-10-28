# ThreadMap on NVIDIA Brev (or any VM) with Docker

One instance runs everything with Docker Compose: PostgreSQL and the ThreadMap app
(web, WhatsApp companion and Nemotron worker). Nemotron itself runs on Nebius
Token Factory; the instance only needs a CPU.

## Where your data lives

| Data | Stored in | In git? |
|---|---|---|
| Messages, maps, summaries, the WhatsApp link | Docker volume `threadmap_pgdata` | No |
| Downloaded photos and files | Docker volume `threadmap_objects` | No |
| Secrets (`.env.vm`) | `deploy/vm/.env.vm` on the instance | No (git-ignored) |

Nothing is stored until you scan the QR code, and only chats you open keep their
messages. Recreating or updating containers keeps both volumes; deleting the Brev
instance deletes them. **Disconnect and delete my data** in the app deletes the
account's rows and files from them.

**Moving ThreadMap onto a Brev instance:** step-by-step checklist in [`BREV.md`](BREV.md).

**The database is on Supabase** (since 28 Oct 2026). On the instance, add
`compose.supabase.yaml` to every command — it leaves the bundled database out and connects to
Supabase with its certificate and hostname verified, refusing to start without the
certificate:

```
docker compose --env-file .env.vm -f compose.yaml -f compose.supabase.yaml up -d --build
```

It needs `SUPABASE_DB_URL` in `.env.vm` (the Session pooler URI, port 5432) and Supabase's CA
saved as `deploy/vm/supabase-ca.crt`. Details: [`docs/threadmap/ENCRYPTION.md`](../../docs/threadmap/ENCRYPTION.md).
Run only one ThreadMap per WhatsApp account: stop the local one before starting this.

## 1. Create the instance

On [brev.nvidia.com](https://brev.nvidia.com), create a CPU instance (2 vCPU / 8 GB is
enough) with Docker, then open a terminal on it (`brev shell <instance>` or the
console). Copy the repository onto it (`git clone …`).

## 2. Choose how people reach it

WhatsApp sign-in needs an **HTTPS** address. Pick one:

- **A. Brev tunnel (simplest).** In the instance's **Access** tab, add a tunnel for
  port **3000** and copy the HTTPS URL Brev shows. Brev puts its
  own sign-in in front of tunnels on first visit, so check that the people you share
  it with (e.g. judges) can open it.
- **B. Open ports + automatic HTTPS (public, no Brev sign-in).** Expose TCP ports
  **80** and **443** to all IP addresses in the instance's port settings. Use a domain
  pointing at the instance's public IP — or, with no domain, `<public-ip-with-dashes>.sslip.io`
  (e.g. `203-0-113-7.sslip.io`). Caddy then gets a certificate for it by itself.

## 3. Configure and start

```
cd deploy/vm
cp env.vm.example .env.vm      # fill in DOMAIN (the host from step 2, no https://), POSTGRES_PASSWORD and the secrets
docker compose --env-file .env.vm up -d --build                   # option A (tunnel)
docker compose --env-file .env.vm --profile https up -d --build   # option B (open ports + Caddy)
```

Open `https://<DOMAIN>`, then **Connect WhatsApp** and scan the QR code, or **Try the demo**.

## Update to a new version

```
git pull
cd deploy/vm && docker compose --env-file .env.vm up -d --build    # add --profile https for option B
```

The database and files stay; migrations run on start.

## Back up and restore the database

```
docker compose --env-file .env.vm exec -T db pg_dump -U threadmap threadmap > threadmap.sql
docker compose --env-file .env.vm exec -T db psql -U threadmap threadmap < threadmap.sql
```

A backup holds your messages: keep it private.

## Delete everything

`docker compose --env-file .env.vm down -v` removes the containers **and both
volumes**: every message, map and file on the instance is gone. Plain `down`
(without `-v`) keeps them.
