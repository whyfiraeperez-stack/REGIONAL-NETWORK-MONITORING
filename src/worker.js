const ALLOWED = ["DATABASE", "DAILY REPORT", "OUTAGE ADVISORY", "GNOC"];

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
  return payload.access_token;
}

function parseSheet(values, includeRaw = false) {
  const headers = (values[0] || []).map((value, index) =>
    String(value || "Column " + (index + 1)).trim()
  );
  const rows = values.slice(1)
    .filter((row) => row.some((value) => String(value ?? "").trim() !== ""))
    .map((row) => Object.fromEntries(
      headers.map((header, index) => [header, row[index] ?? ""])
    ));
  // Only DAILY REPORT needs its original grid for the regional KPI extractor.
  // Avoid returning a second copy of the much larger DATABASE and GNOC tabs.
  return includeRaw ? { headers, rows, raw: values } : { headers, rows };
}

async function sheetsResponse(request, env) {
  const requested = new URL(request.url).searchParams.get("tab");
  const canonicalRequested = requested === "GNOC UPDATE" ? "GNOC" : requested;
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

    const availableTabs = (metadata.sheets || [])
      .map((sheet) => sheet.properties?.title)
      .filter(Boolean);
    const names = requested ? [canonicalRequested] : ALLOWED;
    // Read tabs one at a time to keep peak memory usage within Worker limits.
    const pairs = [];
    for (const name of names) {
      const candidates = name === "GNOC" ? ["GNOC", "GNOC UPDATE"] : [name];
      const actualName = candidates.find((candidate) => availableTabs.includes(candidate));
      if (!actualName) {
        throw new Error("Missing spreadsheet tab: " + candidates.join(" or "));
      }
      const range = "'" + actualName.replace(/'/g, "''") + "'!A:ZZ";
      const endpoint =
        "https://sheets.googleapis.com/v4/spreadsheets/" +
        env.GOOGLE_SPREADSHEET_ID +
        "/values/" + encodeURIComponent(range) +
        "?valueRenderOption=FORMATTED_VALUE";
      const response = await fetchWithRetry(endpoint, {
        headers: { authorization: "Bearer " + accessToken },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(actualName + ": " + (body.error?.message || "Google Sheets API error"));
      }
      pairs.push([name, parseSheet(body.values || [], name === "DAILY REPORT")]);
    }
    return Response.json(
      { syncedAt: new Date().toISOString(), sheets: Object.fromEntries(pairs) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error.message || "Unable to read Google Sheets." },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "regional-network-monitoring",
        timestamp: new Date().toISOString(),
        spreadsheetConfigured: Boolean(env.GOOGLE_SPREADSHEET_ID),
        credentialsConfigured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON),
      }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/sheets") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "GET" },
        });
      }
      return sheetsResponse(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
