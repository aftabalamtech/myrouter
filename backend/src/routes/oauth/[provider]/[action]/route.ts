
import { 
  getProvider, 
  generateAuthData, 
  exchangeTokens, 
  requestDeviceCode, 
  pollForToken 
} from "../../../../lib/oauth/providers.js";
import { createProviderConnection } from "../../../../models/index.js";
import { getSettings } from "../../../../lib/db/repos/settingsRepo.js";
import {
  compareRedirectUris,
  validateRedirectUriForClient,
  validateGoogleOAuthClient,
  isLoopbackRedirect,
} from "../../../../lib/oauth/redirectUri.js";
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  getXaiSessionStatus,
  clearXaiSession,
  startAntigravityProxy,
  stopAntigravityProxy,
  registerAntigravitySession,
  getAntigravitySessionStatus,
  toPublicAntigravitySession,
  clearAntigravitySession,
} from "../../../../lib/oauth/utils/server.js";

async function completeXaiManualCode(code, state) {
  const session = state ? getXaiSessionStatus(state) : null;
  if (!session) {
    throw new Error("xAI OAuth session not found; restart the login flow and paste the code again");
  }
  if (!code) throw new Error("Missing xAI authorization code");

  try {
    const tokenData = await exchangeTokens(
      "xai",
      code,
      session.redirectUri,
      session.codeVerifier,
      state
    );
    const connection = await createProviderConnection({
      provider: "xai",
      authType: "oauth",
      ...tokenData,
      expiresAt: tokenData.expiresIn
        ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
        : null,
      testStatus: "active",
    });
    clearXaiSession(state);
    stopXaiProxy();
    return {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    };
  } catch (err) {
    clearXaiSession(state);
    stopXaiProxy();
    throw err;
  }
}

/**
 * Dynamic OAuth API Route
 * Handles: authorize, exchange, device-code, poll
 */

// GET /api/oauth/[provider]/authorize - Generate auth URL
// GET /api/oauth/[provider]/device-code - Request device code (for device_code flow)
export async function GET_handler(req, res, { params }) {
  try {
    const { provider, action } = await params;
    const { searchParams } = new URL('http://localhost' + req.originalUrl);

    if (action === "authorize") {
      const redirectUri = searchParams.get("redirect_uri") || "http://localhost:8080/callback";
      // Collect provider-specific meta params (e.g. gitlab passes baseUrl, clientId, clientSecret)
      const reservedParams = new Set(["redirect_uri"]);
      const meta = {};
      searchParams.forEach((value, key) => { if (!reservedParams.has(key)) meta[key] = value; });

      // §2/§3 Antigravity: deployment-aware redirect_uri handling. The
      // authorization request is what Google rejects with 400
      // redirect_uri_mismatch — catch configuration errors here so the user
      // sees the exact URI to register BEFORE opening Google's consent page.
      let antigravityClient = { customClient: false, clientId: "", clientSecret: "" };
      if (provider === "antigravity") {
        if (!searchParams.get("redirect_uri")) {
          return res.status(400).json({
            error: "Antigravity requires an explicit redirect_uri — the default must never be silently substituted (§3).",
          });
        }
        const settings = await getSettings();
        // Prefer credentials explicitly supplied by the caller; otherwise use
        // the saved settings. Both are validated together: a half-configured
        // custom client is an error, never a silent fallback to another app.
        const checked = validateGoogleOAuthClient({
          clientId: meta.antigravityClientId || settings.antigravityOAuthClientId,
          clientSecret: meta.antigravityClientSecret || settings.antigravityOAuthClientSecret,
        });
        if (!checked.ok) {
          return res.status(400).json({
            error: checked.message,
            code: "invalid_oauth_client_config",
            redirectUri,
          });
        }
        antigravityClient = checked;
        if (checked.customClient) {
          meta.antigravityClientId = checked.clientId;
          meta.antigravityClientSecret = checked.clientSecret;
        } else {
          delete meta.antigravityClientId;
          delete meta.antigravityClientSecret;
        }
        const uriCheck = validateRedirectUriForClient(redirectUri, { customClient: checked.customClient });
        if (!uriCheck.ok) {
          return res.status(400).json({
            error: uriCheck.message,
            code: "redirect_uri_requires_custom_client",
            redirectUri,
            authorizeRedirectUri: redirectUri,
          });
        }
      }

      const authData = await generateAuthData(provider, redirectUri, Object.keys(meta).length ? meta : undefined);

      // §4: register the antigravity session at authorize time (not only via
      // start-proxy) so a manual callback can be completed server-side with
      // the EXACT redirect URI/state/PKCE verifier/OAuth client the
      // authorization request used.
      if (provider === "antigravity") {
        registerAntigravitySession({
          state: authData.state,
          redirectUri,
          codeVerifier: authData.codeVerifier,
          clientId: antigravityClient.customClient ? antigravityClient.clientId : "",
          clientSecret: antigravityClient.customClient ? antigravityClient.clientSecret : "",
          customClient: antigravityClient.customClient,
        });
      }

      return res.json(authData);
    }

    if (action === "start-proxy") {
      if (!["codex", "xai", "antigravity"].includes(provider)) {
        return res.status(400).json({ error: "Proxy only supported for codex/xai/antigravity" });
      }
      const appPort = searchParams.get("app_port");
      if (!appPort) {
        return res.status(400).json({ error: "Missing app_port" });
      }
      const state = searchParams.get("state");
      const codeVerifier = searchParams.get("code_verifier");
      const redirectUri = searchParams.get("redirect_uri");
      // Antigravity's fixed-port proxy can only receive loopback callbacks.
      // Public HTTPS deployments use the dashboard's /callback page instead;
      // starting a loopback proxy there would only confuse the flow.
      if (provider === "antigravity" && redirectUri && !isLoopbackRedirect(redirectUri)) {
        return res.json({ success: false, reason: "not_loopback", serverSide: false });
      }
      const result = provider === "xai"
        ? await startXaiProxy(Number(appPort))
        : provider === "antigravity"
        ? await startAntigravityProxy(Number(appPort))
        : await startCodexProxy(Number(appPort));
      let serverSide = false;
      if (result.success && state && redirectUri) {
        if (provider === "xai" && codeVerifier) {
          serverSide = registerXaiSession({ state, codeVerifier, redirectUri });
        } else if (provider === "antigravity") {
          // Merge, never replace: authorize already stored the verifier and
          // OAuth client credentials for this state.
          serverSide = registerAntigravitySession({ state, redirectUri });
        } else if (provider === "codex" && codeVerifier) {
          serverSide = registerCodexSession({ state, codeVerifier, redirectUri });
        }
      }
      return res.json({ ...result, serverSide });
    }

    if (action === "poll-status") {
      if (!["codex", "xai", "antigravity"].includes(provider)) {
        return res.status(400).json({ error: "Poll only supported for codex/xai/antigravity" });
      }
      const state = searchParams.get("state");
      if (!state) {
        return res.status(400).json({ error: "Missing state" });
      }
      const session = provider === "xai"
        ? getXaiSessionStatus(state)
        : provider === "antigravity"
        ? getAntigravitySessionStatus(state)
        : getCodexSessionStatus(state);
      if (!session) return res.json({ status: "unknown" });
      if (session.status === "done" || session.status === "error") {
        // Never return the raw session: it contains the OAuth client secret
        // and PKCE verifier on the server side.
        const payload = provider === "antigravity"
          ? toPublicAntigravitySession(session)
          : { ...session };
        if (provider === "xai") clearXaiSession(state);
        else if (provider === "antigravity") clearAntigravitySession(state);
        else clearCodexSession(state);
        return res.json(payload);
      }
      return res.json({ status: session.status });
    }

    if (action === "stop-proxy") {
      if (!["codex", "xai", "antigravity"].includes(provider)) {
        return res.status(400).json({ error: "Proxy only supported for codex/xai/antigravity" });
      }
      if (provider === "xai") stopXaiProxy();
      else if (provider === "antigravity") stopAntigravityProxy();
      else stopCodexProxy();
      return res.json({ success: true });
    }

    if (action === "device-code") {
      const providerData = getProvider(provider);
      if (providerData.flowType !== "device_code") {
        return res.status(400).json({ error: "Provider does not support device code flow" });
      }

      const authData = await generateAuthData(provider, null);
      const startUrl = searchParams.get("start_url");
      const region = searchParams.get("region");
      const authMethod = searchParams.get("auth_method");
      const deviceOptions = provider === "kiro"
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(region ? { region } : {}),
            ...(authMethod ? { authMethod } : {}),
          }
        : undefined;
      
      // Providers that don't use PKCE for device code
      const noPkceDeviceProviders = ["github", "kiro", "kimi-coding", "kilocode", "codebuddy", "qoder"];
      let deviceData;
      if (noPkceDeviceProviders.includes(provider)) {
        deviceData = await requestDeviceCode(provider, undefined, deviceOptions);
      } else {
        // Qwen and other PKCE providers
        deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
      }

      return res.json({
        ...deviceData,
        // Prefer the verifier the provider's requestDeviceCode generated for
        // itself (qoder rolls its own PKCE pair); fall back to the generic one.
        codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.log("OAuth GET error:", error);
    return res.status(500).json({ error: error.message });
  }
}

// POST /api/oauth/[provider]/exchange - Exchange code for tokens and save
// POST /api/oauth/[provider]/poll - Poll for token (device_code flow)
export async function POST_handler(req, res, { params }) {
  try {
    const { provider, action } = await params;
    let body;
    try {
      body = req.body;
    } catch {
      return res.status(400).json({ error: "Invalid or empty request body" });
    }

    if (action === "exchange") {
      const { code, redirectUri, codeVerifier, state, meta } = body;

      // Detect if "code" is actually a raw JWT access token (starts with eyJ)
      if (code && code.startsWith("eyJ") && code.includes(".")) {
        const { extractCodexAccountInfo } = await import("../../../../lib/oauth/providers");
        const info = extractCodexAccountInfo(code);

        // Also decode JWT directly for ChatGPT website tokens which use
        // top-level account_id/plan_type instead of nested openai auth claims
        let directPayload = {};
        try {
          const b64 = code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
          directPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        } catch {}

        const accountId = info.chatgptAccountId || directPayload.account_id;
        const planType = info.chatgptPlanType || directPayload.plan_type;
        const email = info.email || directPayload.email;

        const providerSpecificData = { authMethod: "access_token" };
        if (accountId) providerSpecificData.chatgptAccountId = accountId;
        if (planType) providerSpecificData.chatgptPlanType = planType;

        const connection = await createProviderConnection({
          provider,
          authType: "access_token",
          accessToken: code,
          email: email || null,
          providerSpecificData,
          testStatus: "active",
        });

        return res.json({
          success: true,
          connection: {
            id: connection.id,
            provider: connection.provider,
            email: connection.email,
            displayName: connection.displayName,
          }
        });
      }

      // Cline uses authorization_code without PKCE; Antigravity keeps the
      // PKCE verifier server-side in the authorize session, so the browser
      // does not have to send it back.
      const verifierOptionalProviders = ["cline", "antigravity"];
      if (!code || !redirectUri || (!codeVerifier && !verifierOptionalProviders.includes(provider))) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      // §4 Antigravity: the state must reference a live session created at
      // authorize time, and the exchange MUST use the same redirect URI,
      // PKCE verifier and OAuth client the authorization request used
      // (Google: redirect_uri_mismatch / invalid_grant).
      let exchangeCodeVerifier = codeVerifier;
      let exchangeMeta = meta;
      let exchangeRedirectUri = redirectUri;
      if (provider === "antigravity") {
        if (!state) {
          return res.status(400).json({ error: "Antigravity OAuth state is required — restart the login flow and try again." });
        }
        const session = getAntigravitySessionStatus(state);
        if (!session) {
          return res.status(400).json({ error: "Antigravity OAuth state not recognized or expired — restart the login flow and try again." });
        }
        const uriMatch = compareRedirectUris(session.redirectUri, redirectUri);
        if (!uriMatch.ok) {
          return res.status(400).json({ error: uriMatch.message, expectedRedirectUri: session.redirectUri });
        }
        if (codeVerifier && session.codeVerifier && codeVerifier !== session.codeVerifier) {
          return res.status(400).json({ error: "Antigravity OAuth PKCE verifier mismatch — restart the login flow and try again." });
        }
        exchangeCodeVerifier = session.codeVerifier || codeVerifier;
        exchangeRedirectUri = session.redirectUri;
        // Never trust credentials from the callback body: the token request
        // must use the exact OAuth client from the authorization request.
        exchangeMeta = { ...(meta || {}) };
        delete exchangeMeta.antigravityClientId;
        delete exchangeMeta.antigravityClientSecret;
        if (session.customClient) {
          if (!session.clientId || !session.clientSecret) {
            clearAntigravitySession(state);
            return res.status(400).json({ error: "Antigravity OAuth client session is incomplete — restart the login flow and try again." });
          }
          exchangeMeta.antigravityClientId = session.clientId;
          exchangeMeta.antigravityClientSecret = session.clientSecret;
        }
      }

      // Exchange code for tokens (meta carries provider-specific params, e.g. gitlab clientId/baseUrl)
      let tokenData;
      try {
        tokenData = await exchangeTokens(provider, code, exchangeRedirectUri, exchangeCodeVerifier, state, exchangeMeta);
      } catch (err) {
        // A failed exchange consumes the one-time session too: the code/state
        // pair must never be replayed after a terminal upstream response.
        if (provider === "antigravity" && state) clearAntigravitySession(state);
        throw err;
      }

      // Save to database
      const connection = await createProviderConnection({
        provider,
        authType: "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn 
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() 
          : null,
        testStatus: "active",
      });

      // §4 code-reuse prevention: a consumed state/successful exchange kills
      // its session — replaying the same code+state hits "not recognized".
      if (provider === "antigravity" && state) clearAntigravitySession(state);

      return res.json({ 
        success: true, 
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        }
      });
    }

    if (action === "poll") {
      const { deviceCode, codeVerifier, extraData } = body;

      if (!deviceCode) {
        return res.status(400).json({ error: "Missing device code" });
      }

      // Providers that don't use PKCE for device code
      const noPkceProviders = ["github", "kimi-coding", "kilocode", "codebuddy"];
      let result;
      if (noPkceProviders.includes(provider)) {
        result = await pollForToken(provider, deviceCode);
      } else if (provider === "kiro") {
        // Kiro needs extraData (clientId, clientSecret) from device code response
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "qoder") {
        // Qoder needs both the PKCE verifier (codeVerifier) and the machineId
        // captured at device-code time (extraData._qoderMachineId) so
        // mapTokens can persist it for COSY signing.
        if (!codeVerifier) {
          return res.status(400).json({ error: "Missing code verifier" });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier, extraData);
      } else {
        // Qwen and other PKCE providers
        if (!codeVerifier) {
          return res.status(400).json({ error: "Missing code verifier" });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier);
      }

      if (result.success) {
        // Save to database
        const connection = await createProviderConnection({
          provider,
          authType: "oauth",
          ...result.tokens,
          expiresAt: result.tokens.expiresIn 
            ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString() 
            : null,
          testStatus: "active",
        });

        return res.json({ 
          success: true, 
          connection: {
            id: connection.id,
            provider: connection.provider,
          }
        });
      }

      // Still pending or error - don't create connection for pending states
      const isPending = result.pending || result.error === "authorization_pending" || result.error === "slow_down";
      
      return res.json({
        success: false,
        error: result.error,
        errorDescription: result.errorDescription,
        pending: isPending,
      });
    }

    if (action === "manual-code") {
      if (provider === "xai") {
        const { code, state } = body;
        const connection = await completeXaiManualCode(String(code || "").trim(), String(state || "").trim());
        return res.json({ success: true, connection });
      }

      // §4 Antigravity manual callback: complete the ORIGINAL authorization
      // session server-side. Uses the session's stored redirect URI — never
      // a client-supplied one — so authorize and exchange are guaranteed to
      // match (this is not a workaround for redirect_uri_mismatch; the
      // registered redirect URI on the OAuth client is still authoritative).
      if (provider === "antigravity") {
        const { code, state } = body;
        const session = state ? getAntigravitySessionStatus(state) : null;
        if (!session) {
          return res.status(400).json({ error: "Antigravity OAuth session not found or expired; restart the login flow and paste the callback URL again" });
        }
        if (!code) {
          return res.status(400).json({ error: "Missing Antigravity authorization code" });
        }
        if (session.customClient && (!session.clientId || !session.clientSecret)) {
          clearAntigravitySession(state);
          return res.status(400).json({ error: "Antigravity OAuth client session is incomplete — restart the login flow and try again." });
        }
        // The session owns the exact redirect URI, PKCE verifier and OAuth
        // client captured at authorize time. Never trust body-supplied
        // credentials here: doing so could exchange the code with a different
        // client than the one Google saw in the authorization request.
        const exchangeMeta = session.customClient
          ? {
              antigravityClientId: session.clientId,
              antigravityClientSecret: session.clientSecret,
            }
          : undefined;
        try {
          const tokenData = await exchangeTokens("antigravity", String(code).trim(), session.redirectUri, session.codeVerifier, state, exchangeMeta);
          const connection = await createProviderConnection({
            provider: "antigravity",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });
          clearAntigravitySession(state);
          stopAntigravityProxy();
          return res.json({
            success: true,
            connection: { id: connection.id, provider: connection.provider, email: connection.email, displayName: connection.displayName },
          });
        } catch (err) {
          // Failed exchange: drop the one-time session so the same code/state
          // pair can never be replayed.
          clearAntigravitySession(state);
          throw err;
        }
      }
      return res.status(400).json({ error: "Manual code only supported for xai/antigravity" });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.log("OAuth POST error:", error);
    return res.status(500).json({ error: error.message });
  }
}
