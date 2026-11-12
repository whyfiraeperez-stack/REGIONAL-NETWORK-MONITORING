# Bicol Network Monitoring NOC Dashboard

React + Vite frontend with a Cloudflare Pages Function that reads the private Google Spreadsheet server-side.

## Spreadsheet tabs
- DATABASE
- DAILY REPORT
- OUTAGE ADVISORY
- GNOC

## Cloudflare Pages configuration
Build command: `npm run build`
Build output directory: `dist`

Set these project variables/secrets:
- `GOOGLE_SPREADSHEET_ID`: `1DgYA7-nM4DoVg70YOEGlu4Au7nb7xNpdSzyW8BZFsOg`
- `GOOGLE_SERVICE_ACCOUNT_JSON`: complete JSON key contents for `bicol-network-monitoring@almasor-slr.iam.gserviceaccount.com`.

Create a JSON key in Google Cloud Console > IAM & Admin > Service Accounts > bicol-network-monitoring > Keys > Add Key > Create new key > JSON. Store the downloaded JSON only as a Cloudflare secret. Never commit it or paste it into chat. Ensure Google Sheets API is enabled in project `almasor-slr` and the service account has Viewer access to the spreadsheet.

The frontend calls same-origin `/api/sheets`. Google credentials are only read by the server function, never returned to the browser. The API only permits the four allow-listed tabs and uses the read-only Sheets OAuth scope. This release is read-only; write-back is not enabled.

Dashboard polling interval: 30 seconds. It displays last successful synchronization time and retains previously loaded data after a subsequent request fails.

DAILY REPORT is treated as the KPI source when its values appear as recognizable label/value pairs. Confirm the actual sheet layout and adjust KPI mapping if necessary.

## GitHub Actions deployment
The workflow builds on pushes to `main`. To enable the deployment step, add repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Create the Cloudflare Pages project named `bicol-network-monitoring` first, or create it during initial Cloudflare setup. Until those two GitHub secrets exist, the build runs and the deployment step is skipped.
