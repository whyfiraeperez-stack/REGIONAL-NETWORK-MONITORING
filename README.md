# Bicol Network Monitoring NOC Dashboard

React + Vite dashboard deployed as a Cloudflare Worker with static assets. The Worker serves the dashboard and reads the private Google Spreadsheet server-side.

## Spreadsheet tabs
- DATABASE
- DAILY REPORT
- OUTAGE ADVISORY
- GNOC

## Cloudflare Worker build configuration
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Build output directory: `dist` (configured as Worker static assets in `wrangler.toml`)
- Production branch: `main`

The Worker entrypoint is `src/worker.js`. It serves built frontend assets and handles `GET /api/sheets`. The Pages-specific `functions/api/sheets.js` is retained for reference but is not used by this Worker deployment.

## Required Worker variables and secrets
Configure these on the Cloudflare Worker named `regional-network-monitoring`, in its Production environment:

- `GOOGLE_SPREADSHEET_ID` (text): `1DgYA7-nM4DoVg70YOEGlu4Au7nb7xNpdSzyW8BZFsOg`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (secret): the complete JSON key contents for `bicol-network-monitoring@almasor-slr.iam.gserviceaccount.com`.

Create a JSON key in Google Cloud Console > IAM & Admin > Service Accounts > bicol-network-monitoring > Keys > Add Key > Create new key > JSON. Store the downloaded JSON only as a Cloudflare Worker secret. Never commit it or paste it into chat. Ensure Google Sheets API is enabled in project `almasor-slr` and the service account has Viewer access to the spreadsheet.

The frontend calls same-origin `/api/sheets`. Google credentials are only read by the server Worker, never returned to the browser. The API only permits the four allow-listed tabs and uses the read-only Sheets OAuth scope. This release is read-only; write-back is not enabled.

Dashboard auto-polling interval: 60 seconds. Dashboard sync reads only DATABASE columns A (ticket number), B (status), and H (type/province), and returns only RUNNING records plus counts. The full DATABASE tab is fetched when the DATABASE or GENERATE REPORT view is opened, with no recurring full-database polling. OUTAGE ADVISORY and GNOC tabs are fetched when their respective views are opened, with no recurring polling. The frontend retains previously loaded data after a subsequent request fails.

DAILY REPORT is treated as the KPI source when its values appear as recognizable label/value pairs. Confirm the actual sheet layout and adjust KPI mapping if necessary.

## Deployment notes
This repository is configured for a Cloudflare Worker with static assets, not a Cloudflare Pages project. Connect the GitHub repository `whyfiraeperez-stack/REGIONAL-NETWORK-MONITORING` to the Worker Builds workflow, use production branch `main`, build command `npm run build`, and deploy command `npx wrangler deploy`. Do not use `npx wrangler pages deploy` for this Worker. No Cloudflare API token is required in the application source; use Cloudflare's native Worker Builds integration.
