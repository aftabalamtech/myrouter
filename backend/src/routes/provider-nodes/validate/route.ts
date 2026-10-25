

import { normalizeCompatibleBaseUrl, buildCompatibleModelsUrl, buildCompatibleChatUrl, buildCompatibleEmbeddingsUrl } from "@/lib/net/compatibleUrl.js";

// Fetch with timeout wrapper
const fetchWithTimeout = (url, options, timeout = 10000) => {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error("Request timeout")), timeout)
    )
  ]);
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

// Get status-specific error message for /models endpoint
const getModelsErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found - try chat validation with model ID";
  if (status >= 500) return "Server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status >= 500) return "Server error - try again later";
  return `Chat request failed (${status})`;
};

const readErrorBody = async (response) => {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    return data?.error?.message || data?.error || data?.message || data?.msg || text;
  } catch {
    return text;
  }
};

const isAuthFailure = (status) => status === 401 || status === 403;

const isReachableInferenceStatus = (status) => !isAuthFailure(status) && status < 500;

// POST /api/provider-nodes/validate - Validate API key against base URL
// API key is OPTIONAL: self-hosted gateways (LM Studio, Ollama OpenAI shim,
// LiteLLM, vLLM…) frequently run unauthenticated. An empty key must validate
// against /models instead of being rejected up front.
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { baseUrl, apiKey, type, modelId } = body;

    if (!baseUrl) {
      return res.status(400).json({ error: "Base URL is required" });
    }

    // Validate URL format
    if (!isValidUrl(baseUrl)) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      const embedUrl = buildCompatibleEmbeddingsUrl(baseUrl);
      if (!embedUrl) {
        return res.status(400).json({ error: "Invalid or empty base URL" });
      }
      if (!modelId?.trim()) {
        return res.json({ valid: false, error: "Model ID required for embedding validation" });
      }
      const embedHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) embedHeaders["Authorization"] = `Bearer ${apiKey}`;
      const embedRes = await fetchWithTimeout(embedUrl, {
        method: "POST",
        headers: embedHeaders,
        body: JSON.stringify({ model: modelId.trim(), input: "ping" })
      });
      if (embedRes.ok) {
        const data = await embedRes.json().catch(() => null);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
        return res.json({ valid: true, method: "embeddings", dimensions: dims });
      }
      if (embedRes.status === 401 || embedRes.status === 403) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }
      const errBody = await embedRes.text().catch(() => "");
      return res.json({
        valid: false,
        error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        method: "embeddings"
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      const normalizedBase = normalizeCompatibleBaseUrl(baseUrl);
      if (!normalizedBase) {
        return res.status(400).json({ error: "Invalid or empty base URL" });
      }

      const modelsUrl = `${normalizedBase}/models`;
      const anthHeaders: Record<string, string> = { "anthropic-version": "2023-06-01" };
      if (apiKey) {
        anthHeaders["x-api-key"] = apiKey;
        anthHeaders["Authorization"] = `Bearer ${apiKey}`;
      }
      const res = await fetchWithTimeout(modelsUrl, {
        method: "GET",
        headers: anthHeaders,
      });

      if (res.ok) return res.json({ valid: true });

      if (isAuthFailure(res.status)) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }

      // Fallback: Anthropic-compatible services usually expose /messages, not /models.
      if (modelId) {
        const msgHeaders: Record<string, string> = {
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        };
        if (apiKey) {
          msgHeaders["x-api-key"] = apiKey;
          msgHeaders["Authorization"] = `Bearer ${apiKey}`;
        }
        const messagesRes = await fetchWithTimeout(`${normalizedBase}/messages`, {
          method: "POST",
          headers: msgHeaders,
          body: JSON.stringify({
            model: modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          })
        });
        if (messagesRes.ok || isReachableInferenceStatus(messagesRes.status)) {
          const errorText = messagesRes.ok ? "" : await readErrorBody(messagesRes);
          return res.json({
            valid: true,
            method: "messages",
            warning: errorText ? String(errorText).slice(0, 200) : undefined,
          });
        }
        if (isAuthFailure(messagesRes.status)) {
          return res.json({ valid: false, error: "API key unauthorized", method: "messages" });
        }
        return res.json({
          valid: false,
          error: getChatErrorMessage(messagesRes.status),
          method: "messages"
        });
      }

      return res.json({ valid: false, error: getModelsErrorMessage(res.status) });
    }

    // OpenAI Compatible Validation (Default)
    const normalizedBase = normalizeCompatibleBaseUrl(baseUrl);
    if (!normalizedBase) {
      return res.status(400).json({ error: "Invalid or empty base URL" });
    }
    const modelsUrl = buildCompatibleModelsUrl(baseUrl);
    const requestHeaders: Record<string, string> = {};
    if (apiKey) requestHeaders["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetchWithTimeout(modelsUrl, { headers: requestHeaders });

    if (res.ok) {
      // Surface the discovered model list so the caller can offer one-click
      // import right after a successful Test Connection.
      let models: Array<{ id: string; name?: string }> = [];
      try {
        const data = await res.json();
        const raw = Array.isArray(data) ? data : (data?.data || data?.models || data?.results || []);
        if (Array.isArray(raw)) {
          models = raw
            .map((m: { id?: unknown; name?: unknown; model?: unknown }) => {
              const id = typeof m === "string" ? m : (m?.id || m?.model || "");
              if (!id || typeof id !== "string") return null;
              const name = typeof m === "object" && m && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : id;
              return { id, name };
            })
            .filter(Boolean)
            .slice(0, 500);
        }
      } catch { /* body wasn't JSON — validation still succeeded */ }
      return res.json({ valid: true, method: "models", models });
    }

    if (isAuthFailure(res.status)) {
      return res.json({ valid: false, error: "API key unauthorized" });
    }

    // Some gateways reject GET /models with 405 (method not allowed) even
    // though they serve chat — treat that as "reachable, no listing".
    if (res.status === 405) {
      return res.json({ valid: true, method: "no-models", models: [], warning: "Upstream has no /models endpoint — add model IDs manually." });
    }

    // Fallback: try chat/completions if modelId provided
    if (modelId) {
      const chatHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) chatHeaders["Authorization"] = `Bearer ${apiKey}`;
      const chatRes = await fetchWithTimeout(buildCompatibleChatUrl(baseUrl), {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1
        })
      });
      if (chatRes.ok || isReachableInferenceStatus(chatRes.status)) {
        const errorText = chatRes.ok ? "" : await readErrorBody(chatRes);
        return res.json({
          valid: true,
          method: "chat",
          warning: errorText ? String(errorText).slice(0, 200) : undefined,
        });
      }
      if (isAuthFailure(chatRes.status)) {
        return res.json({ valid: false, error: "API key unauthorized", method: "chat" });
      }
      return res.json({
        valid: false,
        error: getChatErrorMessage(chatRes.status),
        method: "chat"
      });
    }

    return res.json({ valid: false, error: getModelsErrorMessage(res.status) });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return res.status(500).json({
      valid: false,
      error: errorMessage
    });
  }
}
