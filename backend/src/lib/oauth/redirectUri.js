// Pure redirect-URI and Google OAuth client validation for the Antigravity
// (Google) OAuth flow.
//
// Task §1/§3: the exact redirect URI sent in the authorization request must be
// identical to the one used in the token exchange (RFC 6749 §4.1.3, and
// Google enforces this via redirect_uri_mismatch). These helpers make the
// comparison explicit and testable instead of trusting string equality
// scattered through the flow.
//
// They never bypass Google's checks — they catch the mismatch BEFORE sending
// an authorization request Google will reject, and produce actionable errors
// that name the URI to register.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const GOOGLE_CLIENT_ID_RE = /^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;
const GOOGLE_CLIENT_SECRET_RE = /^(GOCSPX-[A-Za-z0-9_-]{10,}|[A-Za-z0-9_-]{24,})$/;

export function parseRedirectUri(rawUri) {
  try {
    return new URL(String(rawUri || "").trim());
  } catch {
    return null;
  }
}

export function normalizeRedirectUri(rawUri) {
  const parsed = parseRedirectUri(rawUri);
  if (!parsed) return null;
  // Google treats registered URIs literally, but /oauth-callback and
  // /oauth-callback/ are the common user typo class we reject early.
  let p = parsed.pathname;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return `${parsed.protocol}//${parsed.host}${p}`;
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}

export function isLoopbackRedirect(rawUri) {
  const parsed = parseRedirectUri(rawUri);
  if (!parsed) return false;
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

/**
 * Pairwise comparison used before exchanging a code:
 * - exact normalized match → ok
 * - any difference (scheme, host, port, path, trailing slash) → mismatch error
 *   with both URIs so the user can fix configuration without guessing.
 */
export function compareRedirectUris(authorizeUri, exchangeUri) {
  const a = parseRedirectUri(authorizeUri);
  const b = parseRedirectUri(exchangeUri);
  if (!a || !b) {
    return { ok: false, reason: "invalid", message: "Malformed redirect URI — cannot be parsed." };
  }
  const aNorm = normalizeRedirectUri(authorizeUri);
  const bNorm = normalizeRedirectUri(exchangeUri);
  if (aNorm === bNorm) {
    return { ok: true, reason: null, message: null, normalized: aNorm };
  }
  if (a.protocol !== b.protocol) {
    return {
      ok: false,
      reason: "scheme_mismatch",
      message: `Redirect URI scheme mismatch: authorization used "${a.protocol}//${a.host}" but exchange used "${b.protocol}//${b.host}". The exact same URI must be registered on the OAuth client and used in both steps (Google: redirect_uri_mismatch).`,
      normalized: aNorm,
    };
  }
  return {
    ok: false,
    reason: "host_port_path_mismatch",
    message: `Redirect URI mismatch: authorization used "${aNorm}" but exchange used "${bNorm}". The exact same URI must be used in both steps and registered on the OAuth client (Google: redirect_uri_mismatch).`,
    normalized: aNorm,
  };
}

/**
 * Validate that a redirect URI is usable for the configured client type.
 * - The built-in Google IDE client only accepts http loopback
 *   (localhost / 127.0.0.1 / ::1).
 * - A user-configured Google OAuth client may also register a public https URI
 *   (Cloud Workstations, Render, Docker + reverse proxy, tunnels).
 * Returns { ok, message } — on failure the message names the exact URI to register.
 */
export function validateRedirectUriForClient(rawUri, { customClient = false } = {}) {
  const parsed = parseRedirectUri(rawUri);
  if (!parsed) return { ok: false, message: "Malformed redirect URI" };
  if (parsed.hash) {
    return { ok: false, message: `Redirect URI "${rawUri}" must not contain a fragment (#...). Register and use exactly "${normalizeRedirectUri(rawUri) || rawUri}".` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "Redirect URI must not contain embedded credentials." };
  }
  if (isLoopbackRedirect(rawUri)) return { ok: true, message: null };
  if (parsed.protocol === "https:" && customClient) {
    return { ok: true, message: null };
  }
  if (parsed.protocol === "https:") {
    return {
      ok: false,
      message: `Non-loopback https redirect "${rawUri}" requires your OWN Google OAuth client (the built-in Antigravity client only accepts loopback). Configure it in the advanced credentials section, then register exactly "${rawUri}" as an Authorized redirect URI.`,
    };
  }
  return {
    ok: false,
    message: `Unsupported redirect URI "${rawUri}": use http://loopback (localhost / 127.0.0.1) or, with your own Google OAuth client, an https public URL registered exactly as "${rawUri}".`,
  };
}

/**
 * Validate a user-supplied Google OAuth client. Both fields are required
 * together: half-configured credentials are rejected instead of silently
 * falling back to a different client. Format checks catch the common
 * copy/paste mistakes before Google returns an opaque invalid_client error.
 */
export function validateGoogleOAuthClient({ clientId, clientSecret } = {}) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "").trim();
  if (!id && !secret) {
    return { ok: true, customClient: false, clientId: "", clientSecret: "", message: null };
  }
  if (!id) {
    return { ok: false, customClient: true, message: "A Google OAuth Client ID is required alongside the Client Secret (configure both or neither)." };
  }
  if (!secret) {
    return { ok: false, customClient: true, message: "A Google OAuth Client Secret is required alongside the Client ID (configure both or neither)." };
  }
  if (!GOOGLE_CLIENT_ID_RE.test(id)) {
    return { ok: false, customClient: true, message: `Malformed Google OAuth Client ID "${id}": expected a value ending in .apps.googleusercontent.com.` };
  }
  if (!GOOGLE_CLIENT_SECRET_RE.test(secret)) {
    return { ok: false, customClient: true, message: "Malformed Google OAuth Client Secret: expected a value starting with GOCSPX-." };
  }
  return { ok: true, customClient: true, clientId: id, clientSecret: secret, message: null };
}

/**
 * Build the redirect URI the dashboard should use for a given deployment.
 * - explicit user configuration always wins;
 * - loopback dashboards use the fixed callback the built-in client accepts;
 * - public dashboards use their own origin, which the user must register on
 *   their own Google OAuth client.
 */
export function defaultAntigravityRedirectUri({ origin, configuredRedirectUri = "", local = false, callbackPath = "/callback" } = {}) {
  const configured = String(configuredRedirectUri || "").trim();
  if (configured) return configured;
  if (local) return "http://localhost:51121/oauth-callback";
  const base = String(origin || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  return `${base}${callbackPath}`;
}
