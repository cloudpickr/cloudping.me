# ⚡ Cloudping.me

Real-time browser-based latency tester for **17 cloud providers** — including AWS, Azure, GCP, Akamai Cloud, and Korean CSP providers.

🌐 **[cloudping.me](https://cloudping.me)**

![Cloudping.me screenshot](./public/images/large-screenshot.png)

## Features

- 🌍 17 cloud providers, 300+ regions worldwide
- 📊 Real-time latency with P50 / P80 / P95 percentiles
- 🔍 Filter by provider and geographic location
- 🌙 Dark / Light theme toggle
- 🇰🇷 Korean CSPs: NAVER Cloud, Kakao Cloud, KT Cloud, NHN Cloud
- 📡 Shared [latency matrix](https://www.cloudping.me/health) from a Vercel Function probe (not from your browser)

## Cloud Providers

AWS · Azure · GCP · Oracle Cloud · Alibaba Cloud · IBM Cloud · Tencent Cloud · DigitalOcean · Akamai Cloud · Vultr · Hetzner · OVHcloud · Scaleway · NAVER Cloud · Kakao Cloud · KT Cloud · NHN Cloud

## Getting Started

```bash
npm install --omit=optional
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The latency tester only needs Next.js and React. Site URL, Google Analytics, and Vercel Analytics/Speed Insights are production-only and live in the Vercel project env — not in this repo.

| | App (OSS) | Production site |
|---|---|---|
| `next`, `react`, `react-dom` | required | required |
| `@vercel/analytics`, `@vercel/speed-insights` | omit | `optionalDependencies` + `NEXT_PUBLIC_SITE_TELEMETRY=1` |
| `NEXT_PUBLIC_SITE_URL` | unset | Vercel env (canonical / Open Graph) |
| `NEXT_PUBLIC_GA_ID` | unset | Vercel env |
| `NEXT_PUBLIC_HEALTH_JSON_URL` | GitHub `status` branch default | Vercel Blob snapshot URL (see Health board) |

See `.env.example`. Local clones do not send analytics.

## CLI

Ping the same regions from the terminal. Data comes from `src/data/datasource`, not from the website API.

```bash
go run ./cli
go run ./cli -geo Asia
go run ./cli -provider aws,linode   # Note: 'linode' is the provider key for Akamai Cloud
go run ./cli -c 6
go run ./cli -json
```

The `-provider` flag filters by the provider `key` defined in `src/data/datasource/providers.json`, rather than the display name. Where keys differ from display names:

| Display Name | Key (`-provider`) |
|---|---|
| Akamai Cloud | `linode` (Akamai acquired Linode) |
| NAVER Cloud | `ncp` |
| Kakao Cloud | `kakaocloud` |
| KT Cloud | `ktcloud` |
| NHN Cloud | `nhncloud` |

## Health board

`/` measures from the visitor's browser; `/health` is a shared **To × From**
latency heatmap (colors: &lt;100 / 100–180 / &gt;180ms).

- **Rows (To)** — cloud regions being measured. **Columns (From)** — probe
  origins in 30 regions across AWS, GCP, and Azure, grouped by continent then
  CSP. Both axes are filterable.
- Each cell's latest value = the fastest of up to 4 successful HTTP GETs to response
  headers after 2 warmups (at least 3 successes; not from your browser). A 24h P50
  view is available once enough samples accrue; it is the median of per-run values
  and may include older probe behavior.
- Snapshots refresh about every 30 minutes.

> Operating the probes (multi-cloud deploy, scheduling, secrets, free-tier
> budgets) is documented separately in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Based on

[webping.cloud](https://github.com/goenning/webping.cloud) by [@goenning](https://github.com/goenning)
