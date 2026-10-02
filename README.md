# QikNet Voucher Sync and Station Monitor

This package contains two scheduled jobs and one manual test:

1. **Voucher stock sync:** Runs twice daily at 05:30 and 17:30 Africa/Harare. A voucher group is low when it has fewer than **200** available codes. The job obtains **200** matching unused vouchers from Ruijie and uploads them to QikNet, ensuring at least **200** codes are available after a refill.
2. **Station monitor:** Runs every 15 minutes. It reads the online/total device counts on the Ruijie project overview and sends an outage SMS when a station becomes down or degraded.
3. **SMS test:** A manual-only workflow sends one test message to every unique configured report and outage recipient.

QikNet's built-in duplicate protection remains in control: duplicate voucher codes are skipped during import.

## Confirmed mappings

| QikNet branch | Station | Ruijie project | Status |
|---|---:|---|---|
| Chikwana | STN_3 | QikNet HotSpot 3: Chikwanha | Ready |
| Makoni | STN_05 | QikNet HotSpot 5: Makoni | Ready |
| Unit C | STN_04 | QikNet HotSpot 4: Unit C | Ready |
| Unit L | STN1 | QikNet HotSpot 1: Unit L | Ready |
| Unit M | STN_2 | QikNet HotSpot 2: Jambanja | Ready |
| Unit N | STN_08 | QikNet HotSpot 7: Unit N | Ready |
| Unit O | STN_07 | QikNet HotSpot 6: Unit O | Ready |
| Zengeza 4 | STN_06 | Removed station | Ignored |

## Voucher group mappings

| QikNet product | Price | QikNet API type | Ruijie user group |
|---|---:|---|---|
| 2 Hours Voucher | $0.25 | QikNet2hrsVoucher | QikNetDailyVoucher2hrs |
| 6 Hours Voucher | $0.50 | QikNetDailyVoucher | QikNetDailyVoucher6hrs |
| Full Day Voucher | $1.00 | QikNetBiDailyVoucher | QikNetDailyVoucher |
| Weekly Voucher | $5.00 | QikNetWeeklyVoucher | QikNetWeeklyVoucher |

The QikNet API type values are stable internal identifiers and may retain older wording. They are intentionally configured separately from the current product labels and Ruijie user-group names.

## Safety controls

- `DRY_RUN` defaults to `true`. A dry run checks QikNet, opens the correct Ruijie projects, and exports source stock, but does not upload anything.
- A branch without an exact Ruijie mapping is skipped.
- If a project match is missing or ambiguous, that branch fails closed instead of guessing.
- Credentials are read from environment variables and are not stored in the code.
- Each run writes a JSON report under `reports/`.
- Overlapping runs are prevented by the GitHub Actions concurrency rule.
- The monitor stores incident state and sends an SMS once per outage transition, rather than repeating the same alert every 15 minutes.
- If one device in a multi-device station goes offline, the station is reported as **degraded**.
- SMS tokens, portal passwords, and recipient numbers are supplied as encrypted deployment secrets.

## Recommended deployment: GitHub Actions

1. Create a private GitHub repository and place this package at its root.
2. In **Settings → Secrets and variables → Actions**, add these encrypted repository secrets:
   - `QIKNET_EMAIL`
   - `QIKNET_PASSWORD`
   - `RUIJIE_EMAIL`
   - `RUIJIE_PASSWORD`
   - `SMSPOP_TOKEN`
   - `STOCK_REPORT_RECIPIENT` — the daily stock-report number in international format
   - `DEFAULT_OUTAGE_RECIPIENTS` — comma-separated default outage numbers in international format
   - `SPECIAL_OUTAGE_RECIPIENT` — additional Unit M/N/O outage number
3. Add the repository variable `QIKNET_DRY_RUN` with the value `true`.
4. Run **Daily QikNet voucher sync** manually, keeping **dry_run** selected.
5. Run **QikNet station monitor** manually with **send_sms** disabled.
6. Review the uploaded JSON reports.
7. Run **Test QikNet SMS notifications** to verify one message reaches every configured number.
8. After successful dry runs, set `QIKNET_DRY_RUN` to `false` to activate scheduled replenishment.

The included schedule runs at **05:30 Africa/Harare** every day (`03:30 UTC`). GitHub schedules use UTC.

The **QikNet station monitor** workflow runs every 15 minutes. Default outage recipients receive alerts for all seven active stations. The additional special recipient receives alerts only for Unit M, Unit N, and Unit O.

The supplied SMSPop token must be rotated because it was shared in a chat message. Add only the replacement token to the encrypted `SMSPOP_TOKEN` secret.

## Local Windows test

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and complete the credential, SMS, and recipient values locally. Do not send that file through email or commit it to Git.
3. Keep `DRY_RUN=true` for the first test.
4. Open PowerShell in this folder and run:

   ```powershell
   .\run-local.ps1
   ```

## Configuration

Edit `config/sync.config.json` to change branch mappings or the stock policy. Zengeza 4 is disabled because the station was removed.

To test only one or more branches, set a comma-separated environment value such as:

```text
SYNC_BRANCHES=Unit M,Unit C
```

## Important operating note

Ruijie Cloud and QikNet are browser-based services, so a future redesign of either interface may require selector updates. The job fails and preserves the report if it cannot identify a page or project safely.
