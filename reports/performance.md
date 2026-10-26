# ThreadMap performance

## Local measurement (not the declared cloud region)

Run: `DATABASE_URL=… npm run perf:run local-wsl-docker` on 25 Oct 2026. Laptop (Windows 11, Node 24.14.1) → PostgreSQL 17 in Docker (WSL2) over localhost. Generated data: **10,000 messages**, **1,011 topics**, max depth **8**, widest branch 41 children, 10% of messages with a second placement. 30 requests per operation after one warm-up. Raw data: `reports/performance-data.json`.

| Operation | p50 | p95 | Target |
| --- | --- | --- | --- |
| Map, status All, depth 2 (exact recursive counts for all nodes) | 315 ms | 346 ms | < 1 s ✅ |
| Map, status Missed, All levels (≤200 nodes) | 68 ms | 72 ms | < 1 s ✅ |
| Map, Date + Topic + Missed, depth 1 | 28 ms | 30 ms | < 1 s ✅ |
| Ancestor content first page (root, All) | 126 ms | 132 ms | < 1 s ✅ |
| Ancestor content first page (deep topic, Missed) | 13 ms | 17 ms | < 1 s ✅ |
| Size-aware layout, 200 visible nodes | 0.08 ms | 0.24 ms | — (0 overlaps; diameters 64–220 px) |

Counting, sizing and layout made zero model calls (asserted in `tests/graph-behaviour.test.ts`).

## Not yet measured (UNRUN / BLOCKED_EXTERNAL)

- Cloud-region map/filter/content p95 on the Nebius Endpoint → requires A20 (`npm run perf:run nebius-<region>` from inside the network, or via the hosted API).
- Source-receipt-to-UI p95 over 30 controlled WhatsApp events → requires A19.
- Model latency, capture-to-map latency, backlog and history-processing duration → requires A18/A19 (`reports/live-inference.json` records per-role p50/p95 once run).
- Infrastructure and inference costs → none incurred; estimates require the owner's region prices.
