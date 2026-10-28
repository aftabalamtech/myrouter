
import { getProviderConnectionById } from "../../../../models/index.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "../../../../shared/constants/providers.js";
import { GEMINI_CONFIG } from "../../../../lib/oauth/constants/oauth.js";
import { refreshGoogleToken, updateProviderCredentials } from "../../../../sse/services/tokenRefresh.js";
import { resolveOllamaLocalHost } from "../../../../../open-sse/config/providers.js";
import { resolveKiroModels } from "../../../../../open-sse/services/kiroModels.js";
import { resolveQoderModels } from "../../../../../open-sse/services/qoderModels.js";
import { fetchWithTimeout } from "../../../../lib/net/fetchWithTimeout.js";
import { buildCompatibleModelsUrl } from "../../../../lib/net/compatibleUrl.js";
import { readResponseOnce, parseErrorPayload } from "../../../../lib/net/httpBody.js";
import { fetchCatalogFollowUpPages } from "../../../../lib/net/catalogPagination.js";

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

/**
 * Normalize ONE upstream catalog entry to `{ id, name, ... }` without mutating
 * the upstream model id. Compatible upstreams disagree on the id field:
 * OpenAI uses `id`, Ollama-style gateways use `model`, some use `slug`, and a
 * few return a bare string array. Anything without a usable identifier is
 * dropped rather than shown as "undefined".
 */
const normalizeCatalogEntry = (entry) => {
  if (typeof entry === "string") {
    const id = entry.trim();
    return id ? { id, name: id } : null;
  }
  if (!entry || typeof entry !== "object") return null;
  const rawId = entry.id || entry.model || entry.slug || entry.name;
  if (typeof rawId !== "string" || !rawId.trim()) return null;
  const id = rawId.trim();
  const name =
    (typeof entry.display_name === "string" && entry.display_name.trim()) ||
    (typeof entry.displayName === "string" && entry.displayName.trim()) ||
    (typeof entry.name === "string" && entry.name.trim() && entry.name.trim() !== id
      ? entry.name.trim()
      : "") ||
    id;
  return { ...entry, id, name };
};

const parseGeminiCliModels = (data) => {
  if (Array.isArray(data?.models)) {
    return data.models
      .map((item) => {
        const id = item?.id || item?.model || item?.name;
        if (!id) return null;
        return { id, name: item?.displayName || item?.name || id };
      })
      .filter(Boolean);
  }

  if (data?.models && typeof data.models === "object") {
    return Object.entries(data.models)
      .filter(([, info]) => !info?.isInternal)
      .map(([id, info]) => ({
        id,
        name: info?.displayName || info?.name || id,
      }));
  }

  return [];
};

const appendCodexReviewModels = (models) => models.flatMap((model) => {
  const id = model?.id || model?.slug || model?.model || model?.name;
  if (!id) return [];
  const name = model?.display_name || model?.displayName || model?.name || id;
  const normalized = { ...model, id, name };
  const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed");
  if (!isChatModel || id.endsWith("-review")) return [normalized];
  return [
    normalized,
    {
      ...normalized,
      id: `${id}-review`,
      name: `${name} Review`,
      upstreamModelId: id,
      quotaFamily: "review",
    },
  ];
});

const parseCodexModels = (data) => appendCodexReviewModels(parseOpenAIStyleModels(data));

const createOpenAIModelsConfig = (url) => ({
  url,
  method: "GET",
  headers: { "Content-Type": "application/json" },
  authHeader: "Authorization",
  authPrefix: "Bearer ",
  parseResponse: parseOpenAIStyleModels
});

const resolveQwenModelsUrl = (connection) => {
  const fallback = "https://portal.qwen.ai/v1/models";
  const raw = connection?.providerSpecificData?.resourceUrl;
  if (!raw || typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value) return fallback;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return `${value.replace(/\/$/, "")}/models`;
  }
  return `https://${value.replace(/\/$/, "")}/v1/models`;
};

// Generic custom resolver for OAuth providers that need refresh-on-401 + token persist.
// Receives a `fetchFn(token)` and returns parsed models or throws.
const buildOAuthResolver = ({ refreshFn, fetchFn, parseFn, errorLabel }) => async (connection) => {
  const { accessToken, refreshToken } = connection;
  if (!accessToken) {
    return { error: "No valid token found", status: 401 };
  }
  let warning;
  try {
    let response = await fetchFn(accessToken, connection);
    if (!response.ok && (response.status === 401 || response.status === 403) && refreshToken) {
      const refreshed = await refreshFn(connection);
      if (refreshed?.accessToken) {
        await updateProviderCredentials(connection.id, {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken || refreshToken,
          expiresIn: refreshed.expiresIn,
        });
        connection.accessToken = refreshed.accessToken;
        if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
        response = await fetchFn(refreshed.accessToken, connection);
      }
    }
    // Read the body EXACTLY ONCE. The previous `if (ok) json() else text()`
    // pair was only accidentally safe: a 200 response carrying a non-JSON body
    // consumed the stream in json(), and any later read of the same response
    // (including the 401/403 retry path above re-using `response`) threw
    // "Body is unusable: Body has already been read". readResponseOnce makes
    // that class of bug unrepresentable.
    const body = await readResponseOnce(response);
    if (body.okStatus) {
      if (!body.parsed) {
        warning = `${errorLabel}: upstream returned a non-JSON catalog`;
      } else {
        const models = parseFn(body.json);
        if (models.length > 0) return { models };
      }
    } else {
      // Never log the raw body verbatim — an upstream may echo the
      // Authorization header back inside its error page.
      const detail = parseErrorPayload(body.text, { status: body.status });
      warning = `${errorLabel}: ${body.status} ${detail}`;
      console.log(`${errorLabel} (falling back to static):`, detail);
    }
  } catch (error) {
    warning = `${errorLabel}: ${error.message}`;
    console.log(`${errorLabel} (falling back to static):`, error.message);
  }
  return { models: [], warning };
};

// Provider models endpoints configuration
const PROVIDER_MODELS_CONFIG = {
  claude: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authQuery: "key", // Use query param for API key
    parseResponse: (data) => data.models || [],
    // Gemini DOES paginate its catalog: the default page is ~50 entries and a
    // larger pageSize is still clamped upstream. Without following
    // nextPageToken, discovery silently truncated to the first page.
    pagination: {
      query: "pageToken",
      tokenField: "nextPageToken",
      maxPages: 20,
      maxModels: 5000,
    },
  },
  qwen: {
    url: "https://portal.qwen.ai/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  codex: {
    url: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
    method: "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: parseCodexModels
  },
  antigravity: {
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    body: {},
    parseResponse: (data) => data.models || []
  },
  github: {
    url: "https://api.githubcopilot.com/models",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "editor-version": "vscode/1.107.1",
      "editor-plugin-version": "copilot-chat/0.26.7",
      "user-agent": "GitHubCopilotChat/0.26.7"
    },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => {
      if (!data?.data) return [];
      // Filter out embeddings, non-chat models, and disabled models
      return data.data
        .filter(m => m.capabilities?.type === "chat")
        .filter(m => m.policy?.state !== "disabled") // Only return explicitly enabled models
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilities: m.capabilities,
          isDefault: m.model_picker_enabled === true
        }));
    }
  },
  openai: createOpenAIModelsConfig("https://api.openai.com/v1/models"),
  openrouter: createOpenAIModelsConfig("https://openrouter.ai/api/v1/models"),
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    method: "GET",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Content-Type": "application/json"
    },
    authHeader: "x-api-key",
    parseResponse: (data) => data.data || []
  },

  alicode: {
    url: "https://coding.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "alicode-intl": {
    url: "https://coding-intl.dashscope.aliyuncs.com/v1/models",
    method: "GET",
    headers: { "Content-Type": "application/json" },
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    parseResponse: (data) => data.data || []
  },
  "volcengine-ark": createOpenAIModelsConfig("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
  byteplus: createOpenAIModelsConfig("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),

  // OpenAI-compatible API key providers
  deepseek: createOpenAIModelsConfig("https://api.deepseek.com/models"),
  groq: createOpenAIModelsConfig("https://api.groq.com/openai/v1/models"),
  xai: createOpenAIModelsConfig("https://api.x.ai/v1/models"),
  mistral: createOpenAIModelsConfig("https://api.mistral.ai/v1/models"),
  perplexity: createOpenAIModelsConfig("https://api.perplexity.ai/models"),
  together: createOpenAIModelsConfig("https://api.together.xyz/v1/models"),
  fireworks: createOpenAIModelsConfig("https://api.fireworks.ai/inference/v1/models"),
  cerebras: createOpenAIModelsConfig("https://api.cerebras.ai/v1/models"),
  cohere: createOpenAIModelsConfig("https://api.cohere.ai/v1/models"),
  nebius: createOpenAIModelsConfig("https://api.studio.nebius.ai/v1/models"),
  siliconflow: createOpenAIModelsConfig("https://api.siliconflow.cn/v1/models"),
  hyperbolic: createOpenAIModelsConfig("https://api.hyperbolic.xyz/v1/models"),
  ollama: createOpenAIModelsConfig("https://ollama.com/api/tags"),
  // ollama-local: url resolved dynamically below via providerSpecificData.baseUrl
  nanobanana: createOpenAIModelsConfig("https://api.nanobananaapi.ai/v1/models"),
  chutes: createOpenAIModelsConfig("https://llm.chutes.ai/v1/models"),
  nvidia: createOpenAIModelsConfig("https://integrate.api.nvidia.com/v1/models"),
  assemblyai: createOpenAIModelsConfig("https://api.assemblyai.com/v1/models"),
  "vercel-ai-gateway": createOpenAIModelsConfig("https://ai-gateway.vercel.sh/v1/models"),

  // Custom resolvers (non-OpenAI-shaped APIs / token-refresh flows)
  codebuddy: {
    customResolver: async (connection) => {
      const { getModelsByProviderId } = await import("../../../../shared/constants/models");
      const models = getModelsByProviderId("codebuddy");
      return { models };
    }
  },
  cb: {
    customResolver: async (connection) => {
      const { getModelsByProviderId } = await import("../../../../shared/constants/models");
      const models = getModelsByProviderId("cb");
      return { models };
    }
  },
  kiro: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        providerSpecificData: connection.providerSpecificData || {}
      };
      let warning;
      try {
        const result = await resolveKiroModels(credentials, {
          log: console,
          onCredentialsRefreshed: async (refreshed) => {
            if (refreshed?.accessToken) {
              await updateProviderCredentials(connection.id, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken || connection.refreshToken,
                expiresIn: refreshed.expiresIn,
              });
              connection.accessToken = refreshed.accessToken;
              if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken;
            }
          }
        });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              id: m.id,
              name: m.name,
              upstreamModelId: m.upstreamModelId,
              contextLength: m.contextLength,
              rateMultiplier: m.rateMultiplier,
              capabilities: m.capabilities,
              description: m.description
            }))
          };
        }
        warning = "Kiro returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Kiro models: ${error.message}`;
        console.log("Failed to fetch Kiro models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    }
  },
  qoder: {
    customResolver: async (connection) => {
      const credentials = {
        accessToken: connection.accessToken,
        refreshToken: connection.refreshToken,
        email: connection.email,
        displayName: connection.displayName,
        providerSpecificData: connection.providerSpecificData || {},
      };
      let warning;
      try {
        const result = await resolveQoderModels(credentials, { forceRefresh: true });
        if (result?.models?.length) {
          return {
            models: result.models.map((m) => ({
              // Use the canonical "qoder/<key>" id so the dashboard
              // surfaces the same identifier the chat router expects.
              id: `qoder/${m.id}`,
              name: m.name,
              contextLength: m.contextLength,
              isVL: m.isVL,
              isReasoning: m.isReasoning,
              maxOutputTokens: m.maxOutputTokens,
              description: m.description,
            })),
          };
        }
        warning = "Qoder returned no models; falling back to static catalog.";
      } catch (error) {
        warning = `Failed to fetch Qoder models: ${error.message}`;
        console.log("Failed to fetch Qoder models dynamically, falling back to static:", error.message);
      }
      return { models: [], warning };
    },
  },
  "gemini-cli": {
    customResolver: buildOAuthResolver({
      refreshFn: (conn) => refreshGoogleToken(conn.refreshToken, GEMINI_CONFIG.clientId, GEMINI_CONFIG.clientSecret),
      fetchFn: (token, conn) => {
        const projectId = conn.projectId || conn.providerSpecificData?.projectId;
        const body = projectId ? { project: projectId } : {};
        return fetch(GEMINI_CLI_MODELS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            "User-Agent": "google-api-nodejs-client/9.15.1",
            "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1"
          },
          body: JSON.stringify(body)
        });
      },
      parseFn: parseGeminiCliModels,
      errorLabel: "Failed to fetch Gemini CLI models"
    })
  },
  "ollama-local": {
    customResolver: async (connection) => {
      const url = `${resolveOllamaLocalHost(connection)}/api/tags`;
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
      // Single read (see buildOAuthResolver for the rationale).
      const body = await readResponseOnce(response);
      if (!body.okStatus) {
        const detail = parseErrorPayload(body.text, { status: body.status });
        console.log("Error fetching models from ollama-local:", detail);
        return { error: `Failed to fetch models: ${body.status} ${detail}`, status: body.status };
      }
      if (!body.parsed) {
        return { error: "Ollama returned a non-JSON model catalog", status: 502 };
      }
      return { models: parseOpenAIStyleModels(body.json) };
    }
  }
};

/**
 * GET /api/providers/[id]/models - Get models list from provider
 */
export async function GET_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);

    if (!connection) {
      return res.status(404).json({ error: "Connection not found" });
    }

    // ── Custom (OpenAI/Anthropic-compatible) providers ────────────────────
    // One shared path for both flavours: the base URL is normalized by
    // normalizeCompatibleBaseUrl (which strips a pasted `/chat/completions`,
    // `/models` or `/messages` suffix so we never double the path), and the
    // response body is read EXACTLY ONCE via readResponseOnce. The old code
    // read `.text()` on the error branch and `.json()` on the success branch,
    // which threw "Body is unusable: Body has already been read" whenever an
    // upstream returned a non-JSON body on a 200.
    if (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider)) {
      const isAnthropic = isAnthropicCompatibleProvider(connection.provider);
      const url = buildCompatibleModelsUrl(connection.providerSpecificData?.baseUrl, connection.provider);
      if (!url) {
        return res.status(400).json({
          error: `No usable base URL configured for ${isAnthropic ? "Anthropic" : "OpenAI"} compatible provider`,
        });
      }
      // The API key may be empty for self-hosted / unauthenticated upstreams —
      // only send the header when a key exists so an empty "Bearer " never leaks.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (isAnthropic) headers["anthropic-version"] = "2023-06-01";
      if (connection.apiKey) {
        if (isAnthropic) {
          headers["x-api-key"] = connection.apiKey;
          headers["Authorization"] = `Bearer ${connection.apiKey}`;
        } else {
          headers["Authorization"] = `Bearer ${connection.apiKey}`;
        }
      }
      let response;
      try {
        response = await fetchWithTimeout(url, { method: "GET", headers });
      } catch (err) {
        return res.status(502).json({ error: `Failed to reach upstream: ${String(err?.message || err).slice(0, 200)}` });
      }
      const body = await readResponseOnce(response);
      if (!body.okStatus) {
        // Never log the raw body: it may echo back the Authorization header.
        console.warn(
          `Error fetching models from ${connection.provider} (HTTP ${body.status}):`,
          parseErrorPayload(body.text, { status: body.status }).slice(0, 200)
        );
        return res.status(body.status || 502).json({
          error: `Failed to fetch models: ${parseErrorPayload(body.text, { status: body.status })}`,
        });
      }
      if (!body.parsed) {
        return res.status(502).json({ error: "Upstream returned a non-JSON model catalog" });
      }
      const models = parseOpenAIStyleModels(body.json)
        .map(normalizeCatalogEntry)
        .filter((m): m is { id: string } => m !== null);

      return res.json({
        provider: connection.provider,
        providerName: connection.providerSpecificData?.nodeName || null,
        connectionId: connection.id,
        models,
      });
    }

    const config = PROVIDER_MODELS_CONFIG[connection.provider];
    if (!config) {
      return res.status(400).json(
        { error: `Provider ${connection.provider} does not support models listing` }
      );
    }

    // Config-driven custom resolver path (OAuth refresh, non-OpenAI shape, etc.)
    if (typeof config.customResolver === "function") {
      const result = await config.customResolver(connection);
      if (result.error) {
        return res.status(result.status || 500).json({ error: result.error });
      }
      return res.json({
        provider: connection.provider,
        connectionId: connection.id,
        models: result.models,
        ...(result.warning ? { warning: result.warning } : {})
      });
    }

    // Get auth token
    const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
    if (!token) {
      return res.status(401).json({ error: "No valid token found" });
    }

    // Build request URL
    let url = config.url;
    if (connection.provider === "qwen") {
      url = resolveQwenModelsUrl(connection);
    }
    if (config.authQuery) {
      // The config URL may already carry query params (e.g. Gemini's
      // pageSize) — append with the correct separator, never a second "?".
      const separator = url.includes("?") ? "&" : "?";
      url += `${separator}${config.authQuery}=${token}`;
    }

    // Build headers
    const headers = { ...config.headers };
    if (config.authHeader && !config.authQuery) {
      headers[config.authHeader] = (config.authPrefix || "") + token;
    }

    // Make request
    const fetchOptions = {
      method: config.method,
      headers
    };

    if (config.body && config.method === "POST") {
      fetchOptions.body = JSON.stringify(config.body);
    }

    const response = await fetchWithTimeout(url, fetchOptions);

    // Single read: a non-JSON 200 body used to be consumed by json() and then
    // throw on any later read of the same response.
    const body = await readResponseOnce(response);

    if (!body.okStatus) {
      const detail = parseErrorPayload(body.text, { status: body.status });
      // Do not log the raw body — an upstream may echo the auth header back.
      console.log(`Error fetching models from ${connection.provider}:`, detail);
      return res.status(body.status || 502).json({ error: `Failed to fetch models: ${detail}` });
    }
    if (!body.parsed) {
      return res.status(502).json({ error: "Upstream returned a non-JSON model catalog" });
    }

    const models = config.parseResponse(body.json);

    // Follow upstream pagination when the provider advertises a continuation
    // token (e.g. Gemini's `nextPageToken`). Without this, a paginated catalog
    // silently truncated to the first page — discovered-model counts lost the
    // models on every later page.
    const pagination = config.pagination;
    if (pagination) {
      const { pages, truncated } = await fetchCatalogFollowUpPages({
        firstBody: body.json,
        parseResponse: config.parseResponse,
        pagination,
        buildUrl: (t) => {
          const separator = url.includes("?") ? "&" : "?";
          return `${url}${separator}${pagination.query}=${encodeURIComponent(t)}`;
        },
        fetchPage: async (nextUrl) => {
          const nextRes = await fetchWithTimeout(nextUrl, {
            method: config.method,
            headers,
            ...(config.body && config.method === "POST" ? { body: JSON.stringify(config.body) } : {}),
          });
          return await readResponseOnce(nextRes);
        },
      });
      for (const pageModels of pages) models.push(...pageModels);
      if (truncated) {
        console.warn(`Catalog pagination incomplete for ${connection.provider}; returning ${models.length} collected models`);
      }
    }

    return res.json({
      provider: connection.provider,
      connectionId: connection.id,
      models
    });
  } catch (error) {
    console.log("Error fetching provider models:", error);
    return res.status(500).json({ error: "Failed to fetch models" });
  }
}
