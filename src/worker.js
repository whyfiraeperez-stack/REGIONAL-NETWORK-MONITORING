const ALLOWED = ["DATABASE", "DAILY REPORT", "OUTAGE ADVISORY", "GNOC"];
let cachedGoogleToken = null;
let googleTokenExpiresAt = 0;
let cachedSpreadsheetId = null;
let cachedSheetTitles = null;
let sheetTitlesExpiresAt = 0;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");

const enc = (value) => b64url(new TextEncoder().encode(value));

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, options);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
        return response;
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5000)
        : 300 * (2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Google request failed after retries.");
}

function pemBytes(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

async function googleAccessToken(env) {
  if (cachedGoogleToken && Date.now() < googleTokenExpiresAt - 60000) return cachedGoogleToken;
  const service = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = enc(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = enc(JSON.stringify({
    iss: service.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = header + "." + claim;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(service.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = unsigned + "." + b64url(signature);
  const response = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Google OAuth token request failed");
  }
  cachedGoogleToken = payload.access_token;
  googleTokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
  return cachedGoogleToken;
}

function parseDashboardColumns(valueRanges) {
  const ticketValues = valueRanges[0]?.values || [];   // A: ticket number
  const statusValues = valueRanges[1]?.values || [];   // B: status
  const provinceValues = valueRanges[2]?.values || []; // E: type/province display
  const typeValues = valueRanges[3]?.values || [];     // H: BB / OLT classification
  const rowCount = Math.max(ticketValues.length, statusValues.length, provinceValues.length, typeValues.length);
  const rows = [];
  const counts = { BB: 0, OLT: 0, LCP: 0, NAP: 0 };

  for (let i = 1; i < rowCount; i++) {
    const status = String(statusValues[i]?.[0] ?? "").trim().toUpperCase();
    if (status !== "RUNNING") continue;

    const type = String(typeValues[i]?.[0] ?? "").trim();
    const normalizedType = type.toUpperCase();
    if (/BACKBONE|\bBB\b/.test(normalizedType)) counts.BB++;
    else if (/\bOLT\b/.test(normalizedType)) counts.OLT++;
    else if (/\bLCP\b/.test(normalizedType)) counts.LCP++;
    else if (/\bNAP\b/.test(normalizedType)) counts.NAP++;

    rows.push({
      "TICKET NUMBER": String(ticketValues[i]?.[0] ?? "").trim(),
      STATUS: status,
      TYPE: type,
      "TYPE/PROVINCE": String(provinceValues[i]?.[0] ?? "").trim(),
    });
  }
  return { headers: ["TICKET NUMBER", "STATUS", "TYPE", "TYPE/PROVINCE"], rows, counts };
}
function parseSheet(values) {
  const headers = (values[0] || []).map((value, index) =>
    String(value || "Column " + (index + 1)).trim()
  );
  const rows = values.slice(1)
    .filter((row) => row.some((value) => String(value ?? "").trim() !== ""))
    .map((row) => Object.fromEntries(
      headers.map((header, index) => [header, row[index] ?? ""])
    ));
  // Return only the normalized representation. Never attach the original
  // Google Sheets grid: retaining both raw cells and row objects duplicates
  // the sheet payload in Worker memory.
  return { headers, rows };
}

async function loadSheetsFromGoogle(request, env) {
  const params = new URL(request.url).searchParams;
  const requested = params.get("tab");
  const view = params.get("view");
  const canonicalRequested = requested === "GNOC UPDATE" ? "GNOC" : requested;
  if (view && !(view === "dashboard" && canonicalRequested === "DATABASE")) {
    return Response.json({ error: "Unsupported spreadsheet view." }, { status: 400 });
  }
  if (requested && !ALLOWED.includes(canonicalRequested)) {
    return Response.json({ error: "Unknown spreadsheet tab." }, { status: 400 });
  }
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_SPREADSHEET_ID) {
    return Response.json(
      { error: "Google Sheets credentials are not configured in Cloudflare secrets." },
      { status: 503 },
    );
  }

  try {
    const accessToken = await googleAccessToken(env);
    let availableTabs;
    if (cachedSpreadsheetId === env.GOOGLE_SPREADSHEET_ID && cachedSheetTitles && Date.now() < sheetTitlesExpiresAt) {
      availableTabs = cachedSheetTitles;
    } else {
      const metadataUrl =
        "https://sheets.googleapis.com/v4/spreadsheets/" +
        env.GOOGLE_SPREADSHEET_ID +
        "?fields=sheets.properties.title";
      const metadataResponse = await fetchWithRetry(metadataUrl, {
        headers: { authorization: "Bearer " + accessToken },
      });
      const metadata = await metadataResponse.json();
      if (!metadataResponse.ok) {
        throw new Error(metadata.error?.message || "Unable to read spreadsheet tabs");
      }
      availableTabs = (metadata.sheets || [])
        .map((sheet) => sheet.properties?.title)
        .filter(Boolean);
      cachedSpreadsheetId = env.GOOGLE_SPREADSHEET_ID;
      cachedSheetTitles = availableTabs;
      sheetTitlesExpiresAt = Date.now() + 5 * 60 * 1000;
    }
    const names = requested ? [canonicalRequested] : ALLOWED;
    // Read tabs one at a time to keep peak memory usage within Worker limits.
    const pairs = [];
    for (const name of names) {
      const candidates = name === "GNOC" ? ["GNOC", "GNOC UPDATE"] : [name];
      const actualName = candidates.find((candidate) => availableTabs.includes(candidate));
      if (!actualName) {
        throw new Error("Missing spreadsheet tab: " + candidates.join(" or "));
      }
      let endpoint;
      if (view === "dashboard") {
        const escapedName = actualName.replace(/'/g, "''");
        const params = new URLSearchParams();
        for (const column of ["A:A", "B:B", "E:E", "H:H"]) {
          params.append("ranges", "'" + escapedName + "'!" + column);
        }
        params.set("valueRenderOption", "FORMATTED_VALUE");
        endpoint = "https://sheets.googleapis.com/v4/spreadsheets/" +
          env.GOOGLE_SPREADSHEET_ID + "/values:batchGet?" + params.toString();
      } else {
        const range = "'" + actualName.replace(/'/g, "''") + "'!A:ZZ";
        endpoint = "https://sheets.googleapis.com/v4/spreadsheets/" +
          env.GOOGLE_SPREADSHEET_ID + "/values/" + encodeURIComponent(range) +
          "?valueRenderOption=FORMATTED_VALUE";
      }
      const response = await fetchWithRetry(endpoint, {
        headers: { authorization: "Bearer " + accessToken },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(actualName + ": " + (body.error?.message || "Google Sheets API error"));
      }
      if (view === "dashboard") {
        const summary = parseDashboardColumns(body.valueRanges || []);
        pairs.push([name, { headers: summary.headers, rows: summary.rows }]);
        pairs.push(["dashboardCounts", summary.counts]);
      } else {
        pairs.push([name, parseSheet(body.values || [])]);
      }
    }
    return Response.json(
      { syncedAt: new Date().toISOString(), sheets: Object.fromEntries(pairs) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "google_sheets_read_failed",
      error: error instanceof Error ? error.message : String(error),
      requestedTab: requested || "ALL",
      timestamp: new Date().toISOString(),
    }));
    return Response.json(
      { error: error.message || "Unable to read Google Sheets." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}


async function sheetsResponse(request, env) {
  // Spreadsheet contents are request-scoped only. No sheet rows, cell grids,
  // or serialized sheet responses are retained in module-level caches.
  return loadSheetsFromGoogle(request, env);
}

export default {
  async fetch(request, env) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname === "/api/health") {
        response = Response.json({
          ok: true,
          service: "regional-network-monitoring",
          timestamp: new Date().toISOString(),
          spreadsheetConfigured: Boolean(env.GOOGLE_SPREADSHEET_ID),
          credentialsConfigured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
        }, { headers: { "cache-control": "no-store" } });
      } else if (url.pathname === "/api/sheets") {
        if (request.method !== "GET") {
          response = new Response("Method not allowed", {
            status: 405,
            headers: { allow: "GET" },
          });
        } else {
          response = await sheetsResponse(request, env);
        }
      } else {
        response = await env.ASSETS.fetch(request);
      }

      const headers = new Headers(response.headers);
      headers.set("x-regional-network-worker", "handled");
      const markedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      console.log(JSON.stringify({
        event: "request_complete",
        path: url.pathname,
        status: markedResponse.status,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }));
      return markedResponse;
    } catch (error) {
      console.error(JSON.stringify({
        event: "worker_request_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      }));
      return Response.json(
        { error: "The dashboard service encountered an internal error." },
        {
          status: 500,
          headers: {
            "cache-control": "no-store",
            "x-regional-network-worker": "handled",
          },
        },
      );
    }
  },
};
