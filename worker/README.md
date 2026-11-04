# QikNet automation on Cloudflare Workers

This Worker runs the station monitor and the voucher sync on Cloudflare's free plan, so it doesn't depend on GitHub Actions. You don't need a card to use it.

| Job | Schedule | What it does |
|---|---|---|
| Station monitor | Every 15 minutes | Reads device status from the Ruijie API, keeps incident state in Workers KV, and sends tiered outage SMS alerts. |
| Voucher sync | 05:30 and 17:30 Africa/Harare, with follow-ups at :38, :46 and :54 | Refills any voucher group below 200 with fresh Ruijie codes and uploads them to QikNet. |

Each Worker run on the free plan can make at most 50 outbound requests. The sync handles one voucher group at a time: it creates the codes and uploads them before moving to the next group. When the request limit gets close, the run stops and leaves the remaining groups for the follow-up runs. A normal refill finishes in the first run. Refilling every group in every branch (28 in all) takes four runs.

Both jobs start in **safe mode**. The monitor sends no SMS, and the sync is a dry run that only reads.

## One-time setup (about 15 minutes)

You need Node.js 20 or later on any computer. These steps use PowerShell, but any terminal works.

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. In this repository, open the `worker` folder and sign in:

   ```powershell
   cd worker
   npm install
   npx wrangler login
   ```

3. Create the KV storage, then copy the `id` it prints into `wrangler.toml` in place of `REPLACE_WITH_KV_NAMESPACE_ID`:

   ```powershell
   npx wrangler kv namespace create STATE
   ```

4. Deploy:

   ```powershell
   npx wrangler deploy
   ```

   Make a note of the `https://qiknet-automation.<your-subdomain>.workers.dev` address it prints.

5. Add the secrets. Each command asks for the value, so it never appears in your shell history or in the repository. Use the same values as your GitHub Actions secrets:

   ```powershell
   npx wrangler secret put RUIJIE_API_APP_ID
   npx wrangler secret put RUIJIE_API_SECRET
   npx wrangler secret put QIKNET_EMAIL
   npx wrangler secret put QIKNET_PASSWORD
   npx wrangler secret put SMSPOP_TOKEN
   npx wrangler secret put STOCK_REPORT_RECIPIENT
   npx wrangler secret put DEFAULT_OUTAGE_RECIPIENTS
   npx wrangler secret put SPECIAL_OUTAGE_RECIPIENT
   npx wrangler secret put MANUAL_RUN_TOKEN
   ```

   `MANUAL_RUN_TOKEN` is a password you make up to protect the manual-run address. Use a long random string, for example from `[guid]::NewGuid()` in PowerShell.

## Test it

Replace the address and token with your own:

```powershell
$worker = "https://qiknet-automation.<your-subdomain>.workers.dev"
$auth = @{ Authorization = "Bearer <your MANUAL_RUN_TOKEN>" }

# Station monitor, read only (no SMS)
Invoke-RestMethod -Method Post -Uri "$worker/run/monitor?send_sms=false" -Headers $auth | ConvertTo-Json -Depth 6

# Voucher sync dry run (reads QikNet and Ruijie, creates and uploads nothing)
Invoke-RestMethod -Method Post -Uri "$worker/run/sync?dry_run=true" -Headers $auth | ConvertTo-Json -Depth 6

# Latest scheduled reports
Invoke-RestMethod -Uri "$worker/status" -Headers $auth | ConvertTo-Json -Depth 6
```

A good monitor result lists all seven stations and has an empty `errors` list. A good dry run has `"status": "dry-run-complete"` or `"healthy"`.

## Go live

When both tests look right, open `wrangler.toml`, change these two values to `"true"`, and deploy again:

```toml
MONITOR_SEND_SMS = "true"
SYNC_LIVE = "true"
```

```powershell
npx wrangler deploy
```

Alert history starts empty on the Worker. If a station is already down when you go live, it gets one fresh alert, and the usual 1, 2 and 4 hour spacing applies after that.

## Day to day

- **Logs:** run `npx wrangler tail`, or open the Worker in the Cloudflare dashboard and go to **Observability**.
- **A live manual sync**, for example for one branch: `POST $worker/run/sync?dry_run=false&confirm_live_upload=true&branches=Unit%20M`.
- **Branches, voucher groups and stock policy** still come from `config/sync.config.json`. Run `npx wrangler deploy` after you change it.
- **Tests:** `npm test` runs the Worker against fake QikNet, Ruijie and SMSPop APIs.

The GitHub Actions workflows remain for manual runs only. Their schedules are off, so jobs never run in both places.
