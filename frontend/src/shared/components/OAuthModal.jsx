
import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * OAuth Modal Component
 * - Localhost: Auto callback via popup message
 * - Remote: Manual paste callback URL
 */
export default function OAuthModal({ isOpen, provider, providerInfo, onSuccess, onClose, oauthMeta, idcConfig }) {
  const [step, setStep] = useState("waiting"); // waiting | input | success | error
  const [authData, setAuthData] = useState(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState(null);
  // §3 Antigravity: user-configured Google OAuth credentials (headless
  // deployments register their own client). Secrets are write-only: persisted
  // via PATCH /api/settings and never sent in a URL or echoed back by the API.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [googleClientId, setGoogleClientId] = useState("");
  const [googleClientSecret, setGoogleClientSecret] = useState("");
  const [googleRedirectUri, setGoogleRedirectUri] = useState("");
  const [hasGoogleSecret, setHasGoogleSecret] = useState(false);
  const [antigravityConfigReady, setAntigravityConfigReady] = useState(false);
  const antigravityLoadedRef = useRef(false);
  const [googleConfigError, setGoogleConfigError] = useState(null);
  const [isDeviceCode, setIsDeviceCode] = useState(false);
  const [deviceData, setDeviceData] = useState(null);
  const [polling, setPolling] = useState(false);
  const popupRef = useRef(null);
  const pollingAbortRef = useRef(false);
  const { copied, copy } = useCopyToClipboard();

  // State for client-only values to avoid hydration mismatch
  const [isLocalhost, setIsLocalhost] = useState(false);
  const [placeholderUrl, setPlaceholderUrl] = useState("/callback?code=...");
  const [manifest, setManifest] = useState(null);
  const callbackProcessedRef = useRef(false);

  // Detect if running on localhost (client-side only)
  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsLocalhost(
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "[::1]" ||
        window.location.hostname === "::1"
      );
      setPlaceholderUrl(`${window.location.origin}/callback?code=...`);
    }
  }, []);

  const defaultAntigravityRedirect = isLocalhost
    ? "http://localhost:51121/oauth-callback"
    : (typeof window !== "undefined" ? `${window.location.origin}/callback` : "");
  const effectiveAntigravityRedirect = googleRedirectUri.trim() || defaultAntigravityRedirect;
  const isLoopbackAntigravityRedirect = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(effectiveAntigravityRedirect);

  // Load saved Antigravity Google OAuth configuration. The secret is
  // write-only: the API only returns `antigravityOAuthConfigured`.
  useEffect(() => {
    if (!isOpen || provider !== "antigravity") {
      antigravityLoadedRef.current = true;
      setAntigravityConfigReady(true);
      return;
    }
    let cancelled = false;
    antigravityLoadedRef.current = false;
    setAntigravityConfigReady(false);
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not load settings");
        if (cancelled) return;
        setGoogleClientId(data.antigravityOAuthClientId || "");
        setGoogleRedirectUri(data.antigravityOAuthRedirectUri || "");
        setHasGoogleSecret(!!data.antigravityOAuthConfigured);
        if (data.antigravityOAuthClientId && !data.antigravityOAuthConfigured) {
          setGoogleConfigError("A Client ID is saved without a Client Secret. Add the secret or clear both fields.");
          setShowAdvanced(true);
        }
      } catch (err) {
        if (!cancelled) setGoogleConfigError(err.message);
      } finally {
        if (!cancelled) {
          antigravityLoadedRef.current = true;
          setAntigravityConfigReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, provider]);

  // Registry manifest: provider notice + docs link (no secrets — public metadata)
  useEffect(() => {
    if (!isOpen || !provider) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/oauth/providers?id=${encodeURIComponent(provider)}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setManifest(data.provider || null);
      } catch {
        if (!cancelled) setManifest(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, provider]);

  // Define all useCallback hooks BEFORE the useEffects that reference them

  // Exchange tokens
  const exchangeTokens = useCallback(async (code, state) => {
    if (!authData) return;
    try {
      const res = await fetch(`/api/oauth/${provider}/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          redirectUri: authData.redirectUri,
          codeVerifier: authData.codeVerifier,
          state,
          ...(oauthMeta ? { meta: oauthMeta } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStep("success");
      onSuccess?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, [authData, provider, onSuccess]);

  const completeXaiManualCode = useCallback(async (code) => {
    if (!authData?.state) return;
    try {
      const res = await fetch("/api/oauth/xai/manual-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state: authData.state }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setStep("success");
      onSuccess?.();
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, [authData, onSuccess]);

  // Poll for device code token
  const startPolling = useCallback(async (deviceCode, codeVerifier, interval, extraData, deadlineMs) => {
    pollingAbortRef.current = false;
    setPolling(true);
    // Honor the upstream's expires_in when supplied (qoder sets 300s) so we
    // don't time out earlier than the device code itself. Default 120s
    // matches the prior behavior for providers that don't surface a value.
    const startedAt = Date.now();
    const deadline = startedAt + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 120_000);

    while (Date.now() < deadline) {
      // Check if polling should be aborted
      if (pollingAbortRef.current) {
        console.log("[OAuthModal] Polling aborted");
        setPolling(false);
        return;
      }

      await new Promise((r) => setTimeout(r, interval * 1000));

      // Check again after sleep
      if (pollingAbortRef.current) {
        console.log("[OAuthModal] Polling aborted after sleep");
        setPolling(false);
        return;
      }

      try {
        const res = await fetch(`/api/oauth/${provider}/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode, codeVerifier, extraData }),
        });

        const data = await res.json();

        if (data.success) {
          pollingAbortRef.current = true; // Stop polling immediately
          setStep("success");
          setPolling(false);
          onSuccess?.();
          return;
        }

        if (data.error === "expired_token" || data.error === "access_denied") {
          throw new Error(data.errorDescription || data.error);
        }

        if (data.error === "slow_down") {
          interval = Math.min(interval + 5, 30);
        }
      } catch (err) {
        setError(err.message);
        setStep("error");
        setPolling(false);
        return;
      }
    }

    setError("Authorization timeout");
    setStep("error");
    setPolling(false);
  }, [provider, onSuccess]);

  // Start OAuth flow
  const startOAuthFlow = useCallback(async () => {
    if (!provider) return;
    try {
      setError(null);

      // Device code flow providers
      const deviceCodeProviders = ["github", "qwen", "kiro", "kimi-coding", "kilocode", "codebuddy", "qoder"];
      if (deviceCodeProviders.includes(provider)) {
        setIsDeviceCode(true);
        setStep("waiting");

        const deviceCodeUrl = new URL(`/api/oauth/${provider}/device-code`, window.location.origin);
        if (provider === "kiro" && idcConfig?.startUrl) {
          deviceCodeUrl.searchParams.set("start_url", idcConfig.startUrl);
          if (idcConfig.region) {
            deviceCodeUrl.searchParams.set("region", idcConfig.region);
          }
          deviceCodeUrl.searchParams.set("auth_method", "idc");
        }
        const res = await fetch(deviceCodeUrl.toString());
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setDeviceData(data);

        // Auto-open verification URL in new tab
        const verifyUrl = data.verification_uri_complete || data.verification_uri;
        if (verifyUrl) window.open(verifyUrl, "_blank", "noopener,noreferrer");

        // Pass extraData for Kiro (contains _clientId, _clientSecret) and
        // Qoder (contains _qoderMachineId / _qoderNonce — needed so mapTokens
        // can persist the machine id alongside the token).
        const extraData = provider === "kiro"
          ? {
              _clientId: data._clientId,
              _clientSecret: data._clientSecret,
              _region: data._region,
              _authMethod: data._authMethod,
              _startUrl: data._startUrl,
            }
          : provider === "qoder"
          ? {
              _qoderNonce: data._qoderNonce,
              _qoderMachineId: data._qoderMachineId,
              _qoderVerifier: data.codeVerifier,
            }
          : null;
        startPolling(
          data.device_code,
          data.codeVerifier,
          data.interval || 5,
          extraData,
          // Use the upstream's expires_in if present so we don't time out
          // before the device code itself (qoder gives 300s).
          Number.isFinite(data.expires_in) && data.expires_in > 0
            ? data.expires_in * 1000
            : undefined,
        );
        return;
      }

      // Authorization code flow - build redirect URI (some providers require fixed ports)
      const appPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
      let redirectUri;
      if (provider === "codex") {
        redirectUri = "http://localhost:1455/auth/callback";
      } else if (provider === "xai") {
        redirectUri = "http://127.0.0.1:56121/callback";
      } else if (provider === "antigravity") {
        // Local dashboards use the fixed loopback callback the built-in
        // client accepts. Public/headless dashboards use their own origin
        // (/callback), which MUST be registered on the user's Google OAuth
        // client. An explicit configured URI always wins.
        redirectUri = googleRedirectUri.trim() || defaultAntigravityRedirect;
        const typedSecret = googleClientSecret.trim();
        const customClientConfigured = !!googleClientId.trim() && (!!typedSecret || hasGoogleSecret);
        if (!isLoopbackAntigravityRedirect && !customClientConfigured) {
          setShowAdvanced(true);
          throw new Error(
            `This dashboard is served from a public origin, so Antigravity needs your own Google OAuth client. ` +
            `Register exactly "${redirectUri}" as an Authorized redirect URI in Google Cloud Console, ` +
            `then enter the Client ID and Client Secret under Advanced Google OAuth configuration.`
          );
        }
        // Persist the credentials server-side BEFORE authorize: the secret
        // must never travel in a URL/query string or browser history.
        const patch = { antigravityOAuthRedirectUri: googleRedirectUri.trim() };
        if (googleClientId.trim()) patch.antigravityOAuthClientId = googleClientId.trim();
        if (typedSecret) patch.antigravityOAuthClientSecret = typedSecret;
        const saveRes = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const saveData = await saveRes.json().catch(() => ({}));
        if (!saveRes.ok) throw new Error(saveData.error || "Could not save Google OAuth configuration");
        if (typedSecret) {
          setHasGoogleSecret(true);
          setGoogleClientSecret("");
        }
        setGoogleConfigError(null);
      } else {
        redirectUri = `http://localhost:${appPort}/callback`;
      }

      // Build authorize URL first to get codeVerifier/state for codex server-side mode
      const authorizeUrl = new URL(`/api/oauth/${provider}/authorize`, window.location.origin);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      if (oauthMeta) {
        Object.entries(oauthMeta).forEach(([k, v]) => { if (v) authorizeUrl.searchParams.set(k, v); });
      }
      const res = await fetch(authorizeUrl.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Codex: start proxy with server-side session (auto-exchange) + fallback to channels
      let codexProxyActive = false;
      let codexServerSide = false;
      if (provider === "codex") {
        try {
          const proxyUrl = new URL(`/api/oauth/codex/start-proxy`, window.location.origin);
          proxyUrl.searchParams.set("app_port", appPort);
          proxyUrl.searchParams.set("state", data.state);
          proxyUrl.searchParams.set("code_verifier", data.codeVerifier);
          proxyUrl.searchParams.set("redirect_uri", redirectUri);
          const proxyRes = await fetch(proxyUrl.toString());
          const proxyData = await proxyRes.json();
          codexProxyActive = proxyData.success;
          codexServerSide = !!proxyData.serverSide;
        } catch {
          codexProxyActive = false;
        }
      }

      // xAI: same fixed-port server-side proxy pattern as codex (port 56121)
      let xaiProxyActive = false;
      let xaiServerSide = false;
      if (provider === "xai") {
        try {
          const proxyUrl = new URL(`/api/oauth/xai/start-proxy`, window.location.origin);
          proxyUrl.searchParams.set("app_port", appPort);
          proxyUrl.searchParams.set("state", data.state);
          proxyUrl.searchParams.set("code_verifier", data.codeVerifier);
          proxyUrl.searchParams.set("redirect_uri", redirectUri);
          const proxyRes = await fetch(proxyUrl.toString());
          const proxyData = await proxyRes.json();
          xaiProxyActive = proxyData.success;
          xaiServerSide = !!proxyData.serverSide;
          if (!xaiProxyActive && proxyData.reason === "port_busy") {
            throw new Error("Port 56121 in use; close the conflicting process and retry");
          }
        } catch (e) {
          if (e?.message) throw e;
          xaiProxyActive = false;
        }
      }

      // Antigravity: the fixed-port proxy only works for loopback callbacks.
      // Public HTTPS callbacks are handled by the dashboard /callback page.
      let antigravityProxyActive = false;
      let antigravityServerSide = false;
      if (provider === "antigravity" && isLoopbackAntigravityRedirect) {
        try {
          const proxyUrl = new URL(`/api/oauth/antigravity/start-proxy`, window.location.origin);
          proxyUrl.searchParams.set("app_port", appPort);
          proxyUrl.searchParams.set("state", data.state);
          proxyUrl.searchParams.set("redirect_uri", redirectUri);
          const proxyRes = await fetch(proxyUrl.toString());
          const proxyData = await proxyRes.json();
          antigravityProxyActive = proxyData.success;
          antigravityServerSide = !!proxyData.serverSide;
          if (!antigravityProxyActive && proxyData.reason === "port_busy") {
            throw new Error("Port 51121 in use; close conflicting process and retry");
          }
        } catch (e) {
          if (e?.message) throw e;
          antigravityProxyActive = false;
        }
      }

      setAuthData({ ...data, redirectUri, codexServerSide, xaiServerSide, antigravityServerSide });

      if (provider === "codex" && codexProxyActive) {
        // Proxy active: callback will be handled server-side (auto-exchange) or via channels (fallback)
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      } else if (provider === "xai" && xaiProxyActive) {
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      } else if (provider === "antigravity" && antigravityProxyActive) {
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      } else if (!isLocalhost || provider === "codex" || provider === "xai" || provider === "antigravity") {
        // Non-localhost or proxy failed: manual input mode
        setStep("input");
        window.open(data.authUrl, "_blank");
      } else {
        // Localhost (non-Codex/xAI/Antigravity): Open popup and wait for message
        setStep("waiting");
        popupRef.current = window.open(data.authUrl, "oauth_popup", "width=600,height=700");
        if (!popupRef.current) {
          setStep("input");
        }
      }
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  }, [provider, isLocalhost, startPolling, oauthMeta, idcConfig, googleClientId, googleClientSecret, googleRedirectUri, hasGoogleSecret, defaultAntigravityRedirect, isLoopbackAntigravityRedirect]);

  // Keep the latest flow function without making the open-effect re-run every
  // time an advanced field changes (which would restart the OAuth popup).
  const startOAuthFlowRef = useRef(startOAuthFlow);
  useEffect(() => {
    startOAuthFlowRef.current = startOAuthFlow;
  }, [startOAuthFlow]);

  // Reset state and start OAuth when modal opens
  useEffect(() => {
    if (isOpen && provider) {
      setAuthData(null);
      setCallbackUrl("");
      setError(null);
      setIsDeviceCode(false);
      setDeviceData(null);
      setPolling(false);
      pollingAbortRef.current = false;
      // Antigravity must load saved credentials/redirect URI first so a
      // public deployment never starts a loopback-only flow by accident.
      // Use the ref (not only state) so reopening the modal cannot race a
      // stale "ready" value from the previous open.
      if (provider === "antigravity" && !antigravityLoadedRef.current) return;
      startOAuthFlowRef.current();
    } else if (!isOpen) {
      // Abort polling and cleanup proxy when modal closes
      pollingAbortRef.current = true;
      if (provider === "codex") {
        fetch("/api/oauth/codex/stop-proxy").catch(() => {});
      } else if (provider === "xai") {
        fetch("/api/oauth/xai/stop-proxy").catch(() => {});
      } else if (provider === "antigravity") {
        fetch("/api/oauth/antigravity/stop-proxy").catch(() => {});
      }
    }
  }, [isOpen, provider, antigravityConfigReady]);

  // Fixed-port server-side mode: poll status (proxy auto-exchanges + saves DB)
  useEffect(() => {
    const pollProvider = authData?.codexServerSide 
      ? "codex" 
      : authData?.xaiServerSide 
      ? "xai" 
      : authData?.antigravityServerSide 
      ? "antigravity" 
      : null;
    if (!pollProvider || !authData?.state) return;
    if (callbackProcessedRef.current) return;
    let cancelled = false;
    const POLL_INTERVAL_MS = 1500;
    const MAX_ATTEMPTS = 200; // ~5 minutes
    let attempts = 0;

    const tick = async () => {
      if (cancelled || callbackProcessedRef.current) return;
      attempts += 1;
      try {
          const res = await fetch(`/api/oauth/${pollProvider}/poll-status?state=${encodeURIComponent(authData.state)}`);
        const data = await res.json();
        if (cancelled || callbackProcessedRef.current) return;
        if (data.status === "done") {
          callbackProcessedRef.current = true;
          setStep("success");
          onSuccess?.();
          return;
        }
        if (data.status === "error") {
          callbackProcessedRef.current = true;
          setError(data.error || "Authentication failed");
          setStep("error");
          return;
        }
      } catch {
        // Network error, keep polling
      }
      if (attempts >= MAX_ATTEMPTS) {
        callbackProcessedRef.current = true;
        setError("Authentication timeout");
        setStep("error");
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; };
  }, [authData, onSuccess]);

  // Listen for OAuth callback via multiple methods
  useEffect(() => {
    if (!authData) return;
    callbackProcessedRef.current = false; // Reset when authData changes

    // Handler for callback data - only process once
    const handleCallback = async (data) => {
      if (callbackProcessedRef.current) return; // Already processed

      const { code, state, error: callbackError, errorDescription } = data;

      if (callbackError) {
        callbackProcessedRef.current = true;
        setError(errorDescription || callbackError);
        setStep("error");
        return;
      }

      if (code) {
        callbackProcessedRef.current = true;
        await exchangeTokens(code, state);
      }
    };

    // Method 1: postMessage from popup
    const handleMessage = (event) => {
      // Allow messages from same origin or localhost (any port)
      const isLocalhost = event.origin.includes("localhost") || event.origin.includes("127.0.0.1");
      const isSameOrigin = event.origin === window.location.origin;
      if (!isLocalhost && !isSameOrigin) return;
      
      if (event.data?.type === "oauth_callback") {
        handleCallback(event.data.data);
      }
    };
    window.addEventListener("message", handleMessage);

    // Method 2: BroadcastChannel
    let channel;
    try {
      channel = new BroadcastChannel("oauth_callback");
      channel.onmessage = (event) => handleCallback(event.data);
    } catch (e) {
      console.log("BroadcastChannel not supported");
    }

    // Method 3: localStorage event
    const handleStorage = (event) => {
      if (event.key === "oauth_callback" && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          handleCallback(data);
          localStorage.removeItem("oauth_callback");
        } catch (e) {
          console.log("Failed to parse localStorage data");
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    // Also check localStorage on mount (in case callback already happened)
    try {
      const stored = localStorage.getItem("oauth_callback");
      if (stored) {
        const data = JSON.parse(stored);
        if (data.timestamp && Date.now() - data.timestamp < 30000) {
          handleCallback(data);
        }
        localStorage.removeItem("oauth_callback");
      }
    } catch {
      // localStorage may be unavailable or data may be malformed - ignore silently
    }

    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("storage", handleStorage);
      if (channel) channel.close();
    };
  }, [authData, exchangeTokens]);

  // Handle manual URL input
  const handleManualSubmit = async () => {
    try {
      setError(null);

      const input = callbackUrl.trim();

      // Detect raw JWT access token (starts with eyJ) — skip URL parsing
      if (input.startsWith("eyJ") && input.includes(".")) {
        await exchangeTokens(input, null);
        return;
      }

      if (provider === "xai" && input && !input.includes("://") && !input.includes("?") && !input.includes("code=")) {
        await completeXaiManualCode(input);
        return;
      }

      const url0 = new URL(input.startsWith("http") ? input : `http://placeholder.local/${input.replace(/^\?/, "")}`);
      const code0 = url0.searchParams.get("code");
      const state0 = url0.searchParams.get("state");

      // §4 Antigravity: complete the ORIGINAL authorization session server-side
      // (session owns state + exact redirect URI, rejects reuse/expiry) instead
      // of a stateless client-side exchange. This fixes manual callbacks, not
      // Google's redirect_uri_mismatch — the Google client must still have the
      // redirect URI registered.
      if (provider === "antigravity" && code0 && state0) {
        const res = await fetch("/api/oauth/antigravity/manual-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The server session already owns the exact redirect URI, PKCE
          // verifier and OAuth client captured at authorize time.
          body: JSON.stringify({ code: code0, state: state0 }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setStep("success");
        onSuccess?.();
        return;
      }

      const url = new URL(input);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");

      if (errorParam) {
        throw new Error(url.searchParams.get("error_description") || errorParam);
      }

      if (!code) {
        throw new Error(provider === "xai" ? "Paste the callback URL or copied xAI code" : "No authorization code found in URL");
      }

      await exchangeTokens(code, state);
    } catch (err) {
      setError(err.message);
      setStep("error");
    }
  };

  const clearAntigravityCredentials = useCallback(async () => {
    setGoogleConfigError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          antigravityOAuthClientId: "",
          antigravityOAuthClientSecret: "",
          antigravityOAuthRedirectUri: "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not clear Google OAuth configuration");
      setGoogleClientId("");
      setGoogleClientSecret("");
      setGoogleRedirectUri("");
      setHasGoogleSecret(false);
    } catch (err) {
      setGoogleConfigError(err.message);
    }
  }, []);

  // Clear session on modal close + cleanup proxy
  const handleClose = useCallback(() => {
    if (provider === "codex") {
      fetch("/api/oauth/codex/stop-proxy").catch(() => {});
    } else if (provider === "xai") {
      fetch("/api/oauth/xai/stop-proxy").catch(() => {});
    } else if (provider === "antigravity") {
      fetch("/api/oauth/antigravity/stop-proxy").catch(() => {});
    }
    onClose();
  }, [onClose, provider]);

  if (!provider || !providerInfo) return null;
  const isXaiProvider = provider === "xai";
  const isAntigravityProvider = provider === "antigravity";
  const deviceLoginUrl = deviceData?.verification_uri_complete || deviceData?.verification_uri || "";
  const modalTitle = isXaiProvider ? "Connect Grok Build OAuth" : isAntigravityProvider ? "Connect Antigravity" : `Connect ${providerInfo.name}`;
  const manualPlaceholder = isXaiProvider
    ? "http://127.0.0.1:56121/callback?code=... or copied code"
    : isAntigravityProvider
    ? `${effectiveAntigravityRedirect || "http://localhost:51121/oauth-callback"}?code=...`
    : placeholderUrl;

  const antigravityRedirectPanel = isAntigravityProvider ? (
    <div className="rounded-lg border border-border bg-sidebar/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          Exact redirect URI (register this in Google Cloud Console):
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={copied === "ag_redirect" ? "check" : "content_copy"}
          onClick={() => copy(effectiveAntigravityRedirect, "ag_redirect")}
          disabled={!effectiveAntigravityRedirect}
        />
      </div>
      <code className="mt-1 block break-all text-xs text-text-main">{effectiveAntigravityRedirect || "(not set)"}</code>
    </div>
  ) : null;

  const antigravityAdvancedPanel = isAntigravityProvider ? (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium"
        onClick={() => setShowAdvanced((value) => !value)}
      >
        <span className="flex items-center gap-2">
          <span className="material-symbols-outlined text-base text-text-muted">key</span>
          Advanced Google OAuth configuration
        </span>
        <span className="material-symbols-outlined text-base text-text-muted">
          {showAdvanced ? "expand_less" : "expand_more"}
        </span>
      </button>
      {showAdvanced && (
        <div className="space-y-3 border-t border-border p-3">
          <p className="text-xs text-text-muted">
            Public/headless deployments (Render, Docker, Cloud Workstations, tunnels) must use their own
            Google OAuth client. Create an OAuth client ID (Web application) in Google Cloud Console,
            add the exact redirect URI above to <strong>Authorized redirect URIs</strong>, then paste the
            Client ID and Client Secret here. Local dashboards can leave these blank to use the
            loopback-only built-in client.
          </p>
          <Input
            label="Google OAuth Client ID"
            value={googleClientId}
            onChange={(e) => setGoogleClientId(e.target.value)}
            placeholder="1234567890-xxxx.apps.googleusercontent.com"
            autoComplete="off"
            inputClassName="font-mono text-xs"
          />
          <Input
            label="Google OAuth Client Secret"
            type="password"
            value={googleClientSecret}
            onChange={(e) => setGoogleClientSecret(e.target.value)}
            placeholder={hasGoogleSecret ? "Saved — leave blank to keep" : "GOCSPX-..."}
            hint={hasGoogleSecret ? "A secret is saved. Enter a new value only to replace it." : "Stored server-side; never sent in a URL."}
            autoComplete="new-password"
            inputClassName="font-mono text-xs"
          />
          <Input
            label="Redirect URI"
            value={googleRedirectUri}
            onChange={(e) => setGoogleRedirectUri(e.target.value)}
            placeholder={defaultAntigravityRedirect}
            hint={`Leave blank to use ${defaultAntigravityRedirect || "the dashboard default"}.`}
            inputClassName="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={startOAuthFlow} disabled={!antigravityConfigReady}>
              Save & Retry
            </Button>
            {(hasGoogleSecret || googleClientId) && (
              <Button size="sm" variant="ghost" onClick={clearAntigravityCredentials}>
                Clear saved credentials
              </Button>
            )}
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noreferrer"
              className="self-center text-xs text-primary hover:underline"
            >
              Open Google Cloud Console
            </a>
          </div>
          {googleConfigError && (
            <p className="text-xs text-red-500">{googleConfigError}</p>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <Modal isOpen={isOpen} title={modalTitle} onClose={handleClose} size="lg">
      <div className="flex flex-col gap-4">
        {manifest?.notice && (
          <div className="flex items-start gap-2 px-3 py-2 border border-amber-500/40 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <span className="material-symbols-outlined text-base shrink-0">warning</span>
            <p className="text-xs whitespace-pre-line">{manifest.notice}</p>
          </div>
        )}
        {manifest?.docsUrl && (
          <a href={manifest.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline w-fit">
            Provider documentation
          </a>
        )}
        {isAntigravityProvider && (step === "waiting" || step === "input") && (
          <>
            {antigravityRedirectPanel}
            {antigravityAdvancedPanel}
          </>
        )}
        {isAntigravityProvider && step === "error" && (
          <>
            {antigravityRedirectPanel}
            {antigravityAdvancedPanel}
          </>
        )}
        {/* Waiting + Manual Input combined (non-device-code) */}
        {(step === "waiting" || step === "input") && !isDeviceCode && (
          <>
            {/* Option A: Auto via popup */}
            <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg bg-sidebar/50">
              <span className="material-symbols-outlined text-base text-primary animate-spin">
                progress_activity
              </span>
              <span className="text-sm">
                {isXaiProvider ? "Waiting for Grok Build OAuth…" : "Waiting for popup authorization…"}
              </span>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3 my-1">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-text-muted uppercase tracking-wider">Or paste callback URL manually</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Option B: Manual paste */}
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium mb-2">
                  Step 1: Open this {isXaiProvider ? "Grok Build OAuth URL" : "URL"} in your browser
                </p>
                <div className="flex gap-2">
                  <Input value={authData?.authUrl || ""} readOnly className="flex-1 font-mono text-xs" />
                  <Button variant="secondary" icon={copied === "auth_url" ? "check" : "content_copy"} onClick={() => copy(authData?.authUrl, "auth_url")} disabled={!authData?.authUrl}>
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">
                  Step 2: Paste the {provider === "xai" ? "callback URL or copied code" : "callback URL"} here
                </p>
                <p className="text-xs text-text-muted mb-2">
                  {provider === "xai"
                    ? "If xAI shows a code instead of redirecting, paste that code here."
                    : "After authorization, copy the full URL from your browser."}
                </p>
                <Input
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder={manualPlaceholder}
                  className="font-mono text-xs"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleManualSubmit} fullWidth disabled={!callbackUrl}>
                Connect
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </>
        )}

        {/* Device Code Flow - Waiting */}
        {step === "waiting" && isDeviceCode && deviceData && (
          <>
            <div className="text-center py-4">
              <p className="text-sm text-text-muted mb-4">
                Visit the login URL below and authorize:
              </p>
              <div className="bg-sidebar p-4 rounded-lg mb-4">
                <p className="text-xs text-text-muted mb-1">Login URL</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm break-all">{deviceLoginUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copied === "login_url" ? "check" : "content_copy"}
                    onClick={() => copy(deviceLoginUrl, "login_url")}
                    disabled={!deviceLoginUrl}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="open_in_new"
                    onClick={() => window.open(deviceLoginUrl, "_blank", "noopener,noreferrer")}
                    disabled={!deviceLoginUrl}
                  >
                    Open
                  </Button>
                </div>
              </div>
              <div className="bg-primary/10 p-4 rounded-lg">
                <p className="text-xs text-text-muted mb-1">Your Code</p>
                <div className="flex items-center justify-center gap-2">
                  <p className="text-2xl font-mono font-bold text-primary">{deviceData.user_code}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={copied === "user_code" ? "check" : "content_copy"}
                    onClick={() => copy(deviceData.user_code, "user_code")}
                  />
                </div>
              </div>
            </div>
            {polling && (
              <div className="flex items-center justify-center gap-2 text-sm text-text-muted">
                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                Waiting for authorization...
              </div>
            )}
          </>
        )}

        {/* Success Step */}
        {step === "success" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-green-600">check_circle</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connected Successfully!</h3>
            <p className="text-sm text-text-muted mb-4">
              Your {providerInfo.name} account has been connected.
            </p>
            <Button onClick={handleClose} fullWidth>
              Done
            </Button>
          </div>
        )}

        {/* Error Step */}
        {step === "error" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-red-600">error</span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Connection Failed</h3>
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={startOAuthFlow} variant="secondary" fullWidth>
                Try Again
              </Button>
              <Button onClick={handleClose} variant="ghost" fullWidth>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

OAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerInfo: PropTypes.shape({ name: PropTypes.string }),
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
  /** Extra metadata passed to /authorize and /exchange (e.g. gitlab clientId/baseUrl) */
  oauthMeta: PropTypes.object,
  /** Optional Kiro IDC config for AWS IAM Identity Center device flow */
  idcConfig: PropTypes.shape({
    startUrl: PropTypes.string,
    region: PropTypes.string,
  }),
};
