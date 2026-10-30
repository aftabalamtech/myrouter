import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
} from "../services/auth.js";
import { authorizeClientRequest } from "../services/clientAccess.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "../../lib/localDb.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { isModelBlocked, partitionComboModels, loadBlocks } from "../../lib/models/eligibility.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";
import { sanitizeErrorMessage } from "../../lib/models/testBatch.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers?.["authorization"] ?? request.headers?.get?.("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings. First-party dashboard surfaces
  // (Playground) authenticate with the dashboard session cookie instead.
  const settings = await getSettings();
  const access = await authorizeClientRequest(request, apiKey, settings);
  if (!access.allowed) {
    log.warn("AUTH", `${access.message} (requireApiKey=true)`);
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, access.message);
  }
  if (access.via === "dashboard-session") {
    log.debug("AUTH", "Authorized by dashboard session");
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Exclude hard-disabled (blocked) models from combo execution.
    // Never silently substitute them — if none remain, fail clearly.
    let eligibleModels = comboModels;
    try {
      const blocks = await loadBlocks();
      const { eligible, blocked } = partitionComboModels(comboModels, blocks);
      if (blocked.length > 0) {
        log.warn("COMBO", `"${modelStr}" skipping disabled models: ${blocked.join(", ")}`);
      }
      if (eligible.length === 0) {
        return errorResponse(HTTP_STATUS.FORBIDDEN, `Combo "${modelStr}" is unavailable: all ${comboModels.length} model(s) are disabled. Re-enable a model on the Models page.`);
      }
      eligibleModels = eligible;
    } catch { /* on lookup failure, fall back to full list */ }
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${eligibleModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: eligibleModels,
      handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      // Exclude hard-disabled (blocked) models from combo execution.
      // Never silently substitute them — if none remain, fail clearly.
      let eligibleModels = comboModels;
      try {
        const blocks = await loadBlocks();
        const { eligible, blocked } = partitionComboModels(comboModels, blocks);
        if (blocked.length > 0) {
          log.warn("COMBO", `"${modelStr}" skipping disabled models: ${blocked.join(", ")}`);
        }
        if (eligible.length === 0) {
          return errorResponse(HTTP_STATUS.FORBIDDEN, `Combo "${modelStr}" is unavailable: all ${comboModels.length} model(s) are disabled. Re-enable a model on the Models page.`);
        }
        eligibleModels = eligible;
      } catch { /* on lookup failure, fall back to full list */ }
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      
      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${eligibleModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: eligibleModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Debug trace: requested vs resolved routing (no secrets — ids only).
  // Proves which provider/model actually serve the request and whether any
  // fallback to another connection happened.
  log.info("ROUTING", `requested=${modelStr} resolved=${provider}/${model}`);

  // Hard-disabled (blocked) models are rejected here — single choke point for
  // direct API calls, Playground, Model Test, and per-model combo execution.
  // Never fall through to another model as a silent replacement.
  try {
    const blocks = await loadBlocks();
    const alias = PROVIDER_ID_TO_ALIAS[provider] || provider;
    if (isModelBlocked(provider, model, alias, blocks)) {
      log.warn("BLOCKED", `Rejected request for disabled model: ${provider}/${model}`);
      return errorResponse(HTTP_STATUS.FORBIDDEN, `Model ${alias}/${model} is disabled and cannot receive requests. Re-enable it on the Models page.`);
    }
  } catch { /* on lookup failure, allow the request through */ }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Per-attempt fallback trail (§3): original request → actual destination
  // (always the SAME provider/model here), the account tried, and the
  // sanitized reason it was skipped. Cross-provider substitution never
  // happens in this loop; combos fall back only per their explicit
  // user-configured strategy.
  const fallbackTrail = [];
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      // §3: make every fallback attempt visible in diagnostics — sanitized
      // trail (account, status, reason) logged and echoed in the message.
      const trailReasons = fallbackTrail
        .map((t) => `${t.account} → ${t.status ?? "?"}: ${t.reason}`)
        .join(" | ");
      if (trailReasons) log.warn("ROUTING", `Fallback trail for ${modelStr}: ${trailReasons}`);
      const trailSummary = fallbackTrail.length > 0
        ? ` [fallback trail: ${fallbackTrail.map((t) => `${t.account} → ${t.status ?? "?"}`).join(" | ")}]`
        : "";
      if (credentials?.allRateLimited) {
        const errorMsg = sanitizeErrorMessage(`${lastError || credentials.lastError || "Unavailable"}${trailReasons ? ` | ${trailReasons}` : ""}`);
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, `${lastError || "All accounts unavailable"}${trailSummary}`);
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback (same provider ${provider}, same model ${model})`);
      fallbackTrail.push({
        requested: modelStr,
        destination: `${provider}/${model}`,
        account: credentials.connectionName || credentials.connectionId,
        status: result.status ?? null,
        reason: sanitizeErrorMessage(result.error || ""),
      });
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
