// Regression tests for the Antigravity OAuth redirect_uri_mismatch /
// connection-reliability task.
//
// Run: node --test test/antigravity-oauth.test.js
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRedirectUri,
  normalizeRedirectUri,
  compareRedirectUris,
  isLoopbackRedirect,
  validateRedirectUriForClient,
  validateGoogleOAuthClient,
  defaultAntigravityRedirectUri,
} from "../src/lib/oauth/redirectUri.js";

import {
  ANTIGRAVITY_FLOW_TYPE,
  prepareAntigravityConfig,
  buildAntigravityAuthUrl,
  buildAntigravityTokenRequest,
} from "../src/lib/oauth/antigravityConfig.js";
import { ANTIGRAVITY_CONFIG } from "../src/lib/oauth/constants/oauth.js";
import {
  registerAntigravitySession,
  getAntigravitySessionStatus,
  toPublicAntigravitySession,
  clearAntigravitySession,
  ANTIGRAVITY_SESSION_TTL_MS,
} from "../src/lib/oauth/utils/server.js";
import { redactSettingsForClient } from "../src/lib/auth/publicSettings.js";

const LOOPBACK = "http://localhost:51121/oauth-callback";
const CUSTOM = {
  antigravityClientId: "1234567890-custom.apps.googleusercontent.com",
  antigravityClientSecret: "GOCSPX-abcdefghijklmnopqrstuvwxyz",
};

// --- redirect URI parsing / comparison --------------------------------------

test("normalizes only the trailing slash, preserving the exact authority", () => {
  assert.equal(normalizeRedirectUri("http://localhost:51121/oauth-callback/"), LOOPBACK);
  assert.equal(normalizeRedirectUri("https://app.example.com/callback/"), "https://app.example.com/callback");
  assert.equal(parseRedirectUri("not a url"), null);
});

test("accepts the exact same redirect URI in authorize and exchange", () => {
  const result = compareRedirectUris(LOOPBACK, LOOPBACK);
  assert.equal(result.ok, true);
  assert.equal(result.normalized, LOOPBACK);
});

test("rejects scheme/port/path differences with an actionable mismatch", () => {
  const scheme = compareRedirectUris(LOOPBACK, "https://localhost:51121/oauth-callback");
  assert.equal(scheme.ok, false);
  assert.equal(scheme.reason, "scheme_mismatch");
  assert.match(scheme.message, /redirect_uri_mismatch/);
  assert.match(scheme.message, /localhost:51121/);

  const port = compareRedirectUris(LOOPBACK, "http://localhost:51122/oauth-callback");
  assert.equal(port.ok, false);
  assert.equal(port.reason, "host_port_path_mismatch");
  assert.match(port.message, /51122/);

  const path = compareRedirectUris(LOOPBACK, "http://localhost:51121/callback");
  assert.equal(path.ok, false);
});

test("loopback validation only accepts http loopback hosts", () => {
  assert.equal(isLoopbackRedirect(LOOPBACK), true);
  assert.equal(isLoopbackRedirect("http://127.0.0.1:51121/oauth-callback"), true);
  assert.equal(isLoopbackRedirect("https://localhost:51121/oauth-callback"), false);
  assert.equal(isLoopbackRedirect("http://app.example.com/callback"), false);
  assert.equal(validateRedirectUriForClient(LOOPBACK).ok, true);
});

test("public https callback requires a user-configured Google client", () => {
  const publicUri = "https://router.example.com/callback";
  const builtIn = validateRedirectUriForClient(publicUri, { customClient: false });
  assert.equal(builtIn.ok, false);
  assert.match(builtIn.message, /OWN Google OAuth client/);
  assert.match(builtIn.message, new RegExp(publicUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const custom = validateRedirectUriForClient(publicUri, { customClient: true });
  assert.equal(custom.ok, true);
});

test("rejects fragments, credentials and malformed redirect URIs", () => {
  assert.equal(validateRedirectUriForClient("http://localhost:51121/callback#frag").ok, false);
  assert.equal(validateRedirectUriForClient("http://user:pass@localhost:51121/callback").ok, false);
  assert.equal(validateRedirectUriForClient("nope").ok, false);
});

test("deployment-aware default redirect URI never silently uses localhost", () => {
  assert.equal(defaultAntigravityRedirectUri({ local: true, origin: "http://localhost:5177" }), LOOPBACK);
  assert.equal(
    defaultAntigravityRedirectUri({ local: false, origin: "https://router.example.com/" }),
    "https://router.example.com/callback"
  );
  assert.equal(
    defaultAntigravityRedirectUri({ local: false, origin: "https://router.example.com", configuredRedirectUri: "https://auth.example.com/ag" }),
    "https://auth.example.com/ag"
  );
});

// --- Google OAuth client configuration --------------------------------------

test("accepts a complete well-formed Google OAuth client", () => {
  const checked = validateGoogleOAuthClient({
    clientId: CUSTOM.antigravityClientId,
    clientSecret: CUSTOM.antigravityClientSecret,
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.customClient, true);
  assert.equal(checked.clientId, CUSTOM.antigravityClientId);
  assert.equal(checked.clientSecret, CUSTOM.antigravityClientSecret);
});

test("rejects half-configured and malformed Google OAuth clients", () => {
  const onlyId = validateGoogleOAuthClient({ clientId: CUSTOM.antigravityClientId });
  assert.equal(onlyId.ok, false);
  assert.match(onlyId.message, /Client Secret is required/);

  const onlySecret = validateGoogleOAuthClient({ clientSecret: CUSTOM.antigravityClientSecret });
  assert.equal(onlySecret.ok, false);
  assert.match(onlySecret.message, /Client ID is required/);

  const badId = validateGoogleOAuthClient({ clientId: "not-a-google-client", clientSecret: CUSTOM.antigravityClientSecret });
  assert.equal(badId.ok, false);
  assert.match(badId.message, /apps\.googleusercontent\.com/);

  const badSecret = validateGoogleOAuthClient({ clientId: CUSTOM.antigravityClientId, clientSecret: "abc" });
  assert.equal(badSecret.ok, false);
  assert.match(badSecret.message, /GOCSPX-/);
});

// --- authorize URL / PKCE / token exchange ----------------------------------

test("authorize URL carries the exact redirect URI, state and PKCE challenge", () => {
  const config = prepareAntigravityConfig(ANTIGRAVITY_CONFIG, CUSTOM);
  const state = "state-123";
  const challenge = "challenge-123";
  const url = new URL(buildAntigravityAuthUrl(config, LOOPBACK, state, challenge));
  assert.equal(url.searchParams.get("redirect_uri"), LOOPBACK);
  assert.equal(url.searchParams.get("client_id"), CUSTOM.antigravityClientId);
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("code_challenge"), challenge);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
});

test("Antigravity is registered as an authorization-code PKCE provider", () => {
  assert.equal(ANTIGRAVITY_FLOW_TYPE, "authorization_code_pkce");
});

test("token request uses the same redirect URI, client and PKCE verifier", () => {
  const config = prepareAntigravityConfig(ANTIGRAVITY_CONFIG, CUSTOM);
  const body = buildAntigravityTokenRequest(config, "the-code", LOOPBACK, "the-verifier");
  assert.equal(body.get("redirect_uri"), LOOPBACK);
  assert.equal(body.get("client_id"), CUSTOM.antigravityClientId);
  assert.equal(body.get("client_secret"), CUSTOM.antigravityClientSecret);
  assert.equal(body.get("code_verifier"), "the-verifier");
  assert.equal(body.get("grant_type"), "authorization_code");
});

test("prepareConfig rejects partial custom credentials instead of falling back", () => {
  assert.throws(
    () => prepareAntigravityConfig(ANTIGRAVITY_CONFIG, { antigravityClientId: CUSTOM.antigravityClientId }),
    /Client Secret is required/
  );
});

// --- server-side session lifecycle ------------------------------------------

test("session merge preserves authorize-time verifier and client credentials", () => {
  const state = "state-merge";
  registerAntigravitySession({
    state,
    redirectUri: LOOPBACK,
    codeVerifier: "verifier-1",
    clientId: CUSTOM.antigravityClientId,
    clientSecret: CUSTOM.antigravityClientSecret,
    customClient: true,
  });
  // start-proxy re-registers with only state/redirect: it must not erase them.
  registerAntigravitySession({ state, redirectUri: LOOPBACK });
  const session = getAntigravitySessionStatus(state);
  assert.equal(session.codeVerifier, "verifier-1");
  assert.equal(session.clientId, CUSTOM.antigravityClientId);
  assert.equal(session.clientSecret, CUSTOM.antigravityClientSecret);
  assert.equal(session.customClient, true);
  assert.equal(session.redirectUri, LOOPBACK);
  clearAntigravitySession(state);
});

test("poll-status projection never exposes the client secret or PKCE verifier", () => {
  const state = "state-public";
  registerAntigravitySession({
    state,
    redirectUri: LOOPBACK,
    codeVerifier: "secret-verifier",
    clientId: CUSTOM.antigravityClientId,
    clientSecret: CUSTOM.antigravityClientSecret,
    customClient: true,
  });
  const session = getAntigravitySessionStatus(state);
  session.status = "done";
  session.connectionId = "conn-1";
  const publicSession = toPublicAntigravitySession(session);
  assert.deepEqual(publicSession, { status: "done", connectionId: "conn-1" });
  assert.equal("clientSecret" in publicSession, false);
  assert.equal("codeVerifier" in publicSession, false);
  clearAntigravitySession(state);
});

test("cleared sessions cannot be replayed", () => {
  const state = "state-reuse";
  registerAntigravitySession({ state, redirectUri: LOOPBACK, codeVerifier: "v" });
  assert.ok(getAntigravitySessionStatus(state));
  clearAntigravitySession(state);
  assert.equal(getAntigravitySessionStatus(state), null);
});

test("expired sessions are rejected", () => {
  const state = "state-expired";
  const realNow = Date.now;
  const base = realNow();
  try {
    Date.now = () => base;
    registerAntigravitySession({ state, redirectUri: LOOPBACK, codeVerifier: "v" });
    assert.ok(getAntigravitySessionStatus(state));
    Date.now = () => base + ANTIGRAVITY_SESSION_TTL_MS + 1;
    assert.equal(getAntigravitySessionStatus(state), null);
  } finally {
    Date.now = realNow;
  }
});

// --- settings secret redaction ---------------------------------------------

test("settings projection strips both OIDC and Antigravity secrets", () => {
  const safe = redactSettingsForClient({
    password: "hash",
    oidcClientSecret: "oidc-secret",
    oidcIssuerUrl: "https://idp.example.com",
    oidcClientId: "oidc-client",
    antigravityOAuthClientId: CUSTOM.antigravityClientId,
    antigravityOAuthClientSecret: CUSTOM.antigravityClientSecret,
    antigravityOAuthRedirectUri: "https://router.example.com/callback",
  });
  assert.equal("password" in safe, false);
  assert.equal("oidcClientSecret" in safe, false);
  assert.equal("antigravityOAuthClientSecret" in safe, false);
  assert.equal(safe.oidcConfigured, true);
  assert.equal(safe.antigravityOAuthConfigured, true);
  assert.equal(safe.antigravityOAuthClientId, CUSTOM.antigravityClientId);
  assert.equal(safe.antigravityOAuthRedirectUri, "https://router.example.com/callback");
});
