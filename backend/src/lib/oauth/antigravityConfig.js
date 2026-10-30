import { validateGoogleOAuthClient } from "./redirectUri.js";

/**
 * Pure Antigravity (Google) OAuth request helpers.
 *
 * Kept free of network/DB imports so the redirect_uri / PKCE / custom-client
 * rules can be unit-tested directly.
 */

export const ANTIGRAVITY_FLOW_TYPE = "authorization_code_pkce";

export function prepareAntigravityConfig(config, meta = {}) {
  const checked = validateGoogleOAuthClient({
    clientId: meta.antigravityClientId,
    clientSecret: meta.antigravityClientSecret,
  });
  if (!checked.ok) {
    throw new Error(`Antigravity OAuth: ${checked.message}`);
  }
  if (checked.customClient) {
    return {
      ...config,
      clientId: checked.clientId,
      clientSecret: checked.clientSecret,
      customClient: true,
    };
  }
  return { ...config, customClient: false };
}

export function buildAntigravityAuthUrl(config, redirectUri, state, codeChallenge) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${config.authorizeUrl}?${params.toString()}`;
}

export function buildAntigravityTokenRequest(config, code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  return body;
}
