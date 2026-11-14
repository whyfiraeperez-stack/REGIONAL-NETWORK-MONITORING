const ALLOWED = ["DATABASE", "DAILY REPORT", "OUTAGE ADVISORY", "GNOC"];

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");

const enc = (value) => b64url(new TextEncoder().encode(value));

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
  const response = await fetch("https://oauth2.googleapis.com/token", {
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

function parseSheet(values) {
  const headers = (values[0] || []).map((value, index) =>
    String(value || "Column " + (index + 1)).trim()
  );
  const rows = values.slice(1)
    .filter((row) => row.some((value) => String(value ?? "").trim() !== ""))
    .map((row) => Object.fromEntries(
      headers.map((header, index) => [header, row[index] ?? ""])
    ));
  return { headers, rows, raw: values };
}

async function sheetsResponse(request, env) {
  const requested = new URL(request.url).searchParams.get("tab");
  const canonicalRequested = requested === "GNOC UPDATE" ? "GNOC" : requested;
  const allowed = ["DATABASE", "DAILY REPORT", "OUTAGE ADVISORY", "GNOC"];
  if (requested && !allowed.includes(canonicalRequested)) {
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
    const metadataResponse = await fetch(metadataUrl, {
      headers: { authorization: "Bearer " + accessToken },
    });
    const metadata = await metadataResponse.json();
    if (!metadataResponse.ok) {
      throw new Error(metadata.error?.message || "Unable to read spreadsheet tabs");
    }

    const availableTabs = (metadata.sheets || [])
      .map((sheet) => sheet.properties?.title)
      .filter(Boolean);
    const names = requested ? [canonicalRequested] : allowed;
    const pairs = await Promise.all(names.map(async (name) => {
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
      const response = await fetch(endpoint, {
        headers: { authorization: "Bearer " + accessToken },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(actualName + ": " + (body.error?.message || "Google Sheets API error"));
      }
      return [name, parseSheet(body.values || [])];
    }));
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
