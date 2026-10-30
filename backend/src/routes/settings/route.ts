
import { getSettings, updateSettings } from "../../lib/localDb.js";
import { applyOutboundProxyEnv } from "../../lib/network/outboundProxy.js";
import { resetComboRotation } from "../../../open-sse/services/combo.js";
import { redactSettingsForClient } from "../../lib/auth/publicSettings.js";
import { parseRedirectUri, validateGoogleOAuthClient } from "../../lib/oauth/redirectUri.js";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

export async function GET(req, res) {
  try {
    const settings = await getSettings();
    const safeSettings = redactSettingsForClient(settings);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    res.set(SETTINGS_RESPONSE_HEADERS);
    return res.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!settings.password,
      initialPasswordConfigured: !!process.env.INITIAL_PASSWORD,
      passwordConfigured: !!settings.password || !!process.env.INITIAL_PASSWORD,
    });
  } catch (error) {
    console.log("Error getting settings:", error);
    return res.status(500).json({ error: error.message });
  }
}

export async function PATCH_handler(req, res) {
  try {
    const body = req.body;

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return res.status(400).json({ error: "Current password required" });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return res.status(401).json({ error: "Invalid current password" });
        }
      } else {
        // The request is already authenticated; no old password exists yet.
        delete body.currentPassword;
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // Antigravity Google OAuth client: a secret is write-only. Empty means
    // "keep the stored secret" unless the caller explicitly clears BOTH
    // fields. A half-configured client (ID without secret or vice versa) is
    // rejected instead of silently falling back to a different OAuth client.
    if (
      Object.prototype.hasOwnProperty.call(body, "antigravityOAuthClientId") ||
      Object.prototype.hasOwnProperty.call(body, "antigravityOAuthClientSecret") ||
      Object.prototype.hasOwnProperty.call(body, "antigravityOAuthRedirectUri")
    ) {
      const current = await getSettings();
      const hasId = Object.prototype.hasOwnProperty.call(body, "antigravityOAuthClientId");
      const hasSecret = Object.prototype.hasOwnProperty.call(body, "antigravityOAuthClientSecret");
      const bodyId = String((hasId ? body.antigravityOAuthClientId : "") || "").trim();
      const bodySecret = String((hasSecret ? body.antigravityOAuthClientSecret : "") || "").trim();
      // Empty fields normally mean "keep the stored value" (the secret is
      // never echoed back to the browser). Sending BOTH empty explicitly
      // clears the pair.
      const explicitClear = hasId && hasSecret && !bodyId && !bodySecret;
      const nextId = explicitClear ? "" : (bodyId || String(current.antigravityOAuthClientId || "").trim());
      const nextSecret = explicitClear ? "" : (bodySecret || String(current.antigravityOAuthClientSecret || "").trim());

      if (!explicitClear) {
        if (nextId && !nextSecret) {
          return res.status(400).json({ error: "Antigravity OAuth: a Client Secret is required alongside the Client ID (configure both or neither)." });
        }
        if (nextSecret && !nextId) {
          return res.status(400).json({ error: "Antigravity OAuth: a Client ID is required alongside the Client Secret (configure both or neither)." });
        }
        if (nextId && nextSecret) {
          const checked = validateGoogleOAuthClient({ clientId: nextId, clientSecret: nextSecret });
          if (!checked.ok) return res.status(400).json({ error: `Antigravity OAuth: ${checked.message}` });
        }
      }

      if (hasId) body.antigravityOAuthClientId = nextId;
      if (hasSecret) {
        if (!nextSecret && !explicitClear) delete body.antigravityOAuthClientSecret;
        else body.antigravityOAuthClientSecret = nextSecret;
      }
      if (Object.prototype.hasOwnProperty.call(body, "antigravityOAuthRedirectUri")) {
        const redirectUri = String(body.antigravityOAuthRedirectUri || "").trim();
        if (redirectUri && !parseRedirectUri(redirectUri)) {
          return res.status(400).json({ error: "Antigravity OAuth: the redirect URI is not a valid absolute URL." });
        }
        body.antigravityOAuthRedirectUri = redirectUri;
      }
    }

    const settings = await updateSettings(body);

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    res.set(SETTINGS_RESPONSE_HEADERS);
    return res.json(redactSettingsForClient(settings));
  } catch (error) {
    console.log("Error updating settings:", error);
    return res.status(500).json({ error: error.message });
  }
}
