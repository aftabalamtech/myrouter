// Single-read HTTP response body helpers.
//
// Root cause of the long-standing "Body is unusable: Body has already been
// read" failure: several call sites did
//
//   try { data = await response.json(); }
//   catch { const text = await response.text(); }   // <-- stream already consumed
//
// When an upstream returns a non-JSON error page (HTML gateway error, proxy
// 502, empty body), `.json()` throws AFTER consuming the stream, so `.text()`
// inside the catch throws a TypeError that escapes the handler and the caller
// sees a body-less/undefined response instead of the upstream error message.
//
// These helpers read the body exactly once (as text) and then parse it, so an
// unparseable body still yields its raw text for diagnostics.

/** Read a response body once as text. Never throws. */
export async function readBodyText(res) {
  if (!res || typeof res.text !== "function") return "";
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Read a response body once as text and parse it as JSON. */
export async function readJsonBody(res) {
  const text = await readBodyText(res);
  if (!text) return { ok: false, json: null, text: "" };
  try {
    return { ok: true, json: JSON.parse(text), text };
  } catch {
    return { ok: false, json: null, text };
  }
}

/**
 * Build an actionable error message from an already-read body.
 * Precedence: error.message → message → error → raw text.
 */
export function parseErrorPayload(text, { status } = {}) {
  const raw = String(text || "").trim();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      const message =
        data?.error?.message
        || (typeof data?.error === "string" ? data.error : null)
        || data?.message
        || data?.msg
        || data?.detail;
      if (message) return String(message).slice(0, 300);
    } catch {
      // Not JSON — fall through to the raw snippet.
    }
    if (looksLikeHtml(raw)) {
      return status ? `Upstream returned an HTML error page (HTTP ${status})` : "Upstream returned an HTML error page";
    }
    return raw.slice(0, 300);
  }
  return status ? `HTTP ${status}` : "Upstream request failed";
}

function looksLikeHtml(text) {
  const lower = text.slice(0, 500).toLowerCase();
  return lower.includes("<!doctype") || lower.includes("<html") || lower.includes("<head") || /<[a-z][a-z0-9]*[\s>]/i.test(lower);
}

/**
 * One-shot reader for a provider response: returns status, parsed JSON (when
 * available) and the raw text, having consumed the body exactly once.
 * `ok` means "the body parsed as JSON", NOT "the request succeeded" — always
 * check `status`/`okStatus` for the HTTP outcome.
 */
export async function readResponseOnce(res) {
  const { json, text } = await readJsonBody(res);
  return {
    status: res?.status ?? null,
    okStatus: !!res?.ok,
    json,
    text,
    parsed: json !== null,
  };
}
