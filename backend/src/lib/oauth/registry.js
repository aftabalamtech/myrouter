import { getProvider, getProviderNames } from "./providers.js";

// Static metadata layered over the live PROVIDER map in providers.js.
// Capabilities that can be derived (flowType, refresh fn) are derived at
// runtime so manifests never drift from the real adapters.
const META = {
  claude: {
    displayName: "Claude Code",
    description: "Anthropic Claude subscription via CLI OAuth.",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    apiFormats: ["anthropic"],
    discovery: { supported: true, via: "native" },
  },
  codex: {
    displayName: "OpenAI Codex",
    description: "ChatGPT Plus/Pro account via OAuth with local proxy callback.",
    docsUrl: "https://developers.openai.com/codex/cli/",
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
    extras: { proxyCallback: true, tokenImport: true },
    notice: "Sign-in completes through a local callback server. Manual access-token paste is also supported.",
  },
  xai: {
    displayName: "Grok (xAI)",
    description: "xAI console OAuth with PKCE and manual code entry.",
    docsUrl: "https://docs.x.ai/",
    apiFormats: ["openai"],
    discovery: { supported: false },
    extras: { proxyCallback: true, manualCode: true },
  },
  antigravity: {
    displayName: "Antigravity",
    description: "Google-account sign-in for Antigravity CLI models.",
    docsUrl: "https://console.cloud.google.com/apis/credentials",
    apiFormats: ["anthropic", "openai"],
    discovery: { supported: true, via: "native" },
    extras: { proxyCallback: true },
    notice: "The exact redirect URI must be registered on the Google OAuth client. Local dashboard: http://localhost:51121/oauth-callback. Public/headless deployments: use your own Google OAuth client and register the exact https://<your-domain>/callback value shown in Advanced configuration. Google only releases the authorization code once, to the browser that approves the sign-in.",
  },
  iflow: {
    displayName: "iFlow",
    description: "iFlow CLI authentication, including browser-cookie import.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: false },
    extras: { cookieImport: true },
  },
  qoder: {
    displayName: "Qoder",
    description: "Qoder device-flow authentication with model discovery.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
  },
  qwen: {
    displayName: "Qwen Code",
    description: "Qwen device-flow authentication.",
    docsUrl: "https://chat.qwen.ai/",
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
  },
  github: {
    displayName: "GitHub Copilot",
    description: "GitHub device-flow authentication for Copilot models.",
    docsUrl: "https://docs.github.com/en/copilot",
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
  },
  kiro: {
    displayName: "Kiro AI",
    description: "Kiro device-flow and social OAuth authentication.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
    extras: { tokenImport: true },
  },
  cursor: {
    displayName: "Cursor",
    description: "Cursor token import (no browser OAuth flow).",
    docsUrl: "https://docs.cursor.com/",
    apiFormats: ["openai"],
    discovery: { supported: false },
    extras: { tokenImport: true },
  },
  kilocode: {
    displayName: "Kilo Code",
    description: "Kilo Code device-flow authentication.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: false },
  },
  cline: {
    displayName: "Cline",
    description: "Cline authorization-code authentication (no PKCE) with direct code paste.",
    docsUrl: null,
    apiFormats: ["openai", "anthropic"],
    discovery: { supported: false },
    extras: { directCodePaste: true },
  },
  gitlab: {
    displayName: "GitLab Duo",
    description: "GitLab OAuth or personal access token.",
    docsUrl: "https://docs.gitlab.com/ee/user/duo/",
    apiFormats: ["openai", "anthropic"],
    discovery: { supported: false },
    extras: { tokenImport: true },
  },
  codebuddy: {
    displayName: "CodeBuddy",
    description: "CodeBuddy device-flow authentication with static model catalog.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: true, via: "static" },
  },
  "kimi-coding": {
    displayName: "Kimi Coding",
    description: "Kimi device-flow authentication.",
    docsUrl: null,
    apiFormats: ["openai"],
    discovery: { supported: false },
  },
  openrouter: {
    displayName: "OpenRouter",
    description: "API-key authentication. OpenRouter does not offer a user-facing OAuth flow, so no OAuth adapter is registered.",
    docsUrl: "https://openrouter.ai/docs",
    apiFormats: ["openai"],
    discovery: { supported: true, via: "native" },
    oauth: false,
  },
};

const REQUIRED_MANIFEST_FIELDS = ["id", "displayName", "description", "authMethods", "capabilities", "apiFormats", "adapter"];

export function buildManifest(id) {
  const meta = META[id];
  if (!meta) throw new Error(`Unknown OAuth provider: ${id}`);
  if (meta.oauth === false) {
    return {
      id,
      displayName: meta.displayName,
      description: meta.description,
      enabled: true,
      oauth: false,
      authMethods: ["apiKey"],
      capabilities: {
        pkce: false,
        deviceCode: false,
        authCode: false,
        manualCallback: false,
        manualCode: false,
        proxyCallback: false,
        tokenImport: false,
        cookieImport: false,
        directCodePaste: false,
        tokenRefresh: false,
      },
      discovery: meta.discovery,
      apiFormats: meta.apiFormats,
      docsUrl: meta.docsUrl,
      adapter: null,
      notice: null,
    };
  }
  const provider = getProvider(id);
  const flowType = provider.flowType || "unknown";
  const extras = meta.extras || {};
  return {
    id,
    displayName: meta.displayName,
    description: meta.description,
    enabled: true,
    oauth: true,
    authMethods: [
      ...(flowType === "device_code" ? ["deviceCode"] : []),
      ...(flowType === "authorization_code_pkce" || flowType === "authorization_code" ? ["authorizationCode"] : []),
      ...(extras.tokenImport ? ["tokenImport"] : []),
      ...(extras.cookieImport ? ["cookieImport"] : []),
    ],
    capabilities: {
      pkce: flowType === "authorization_code_pkce",
      deviceCode: flowType === "device_code",
      authCode: flowType === "authorization_code" || flowType === "authorization_code_pkce",
      manualCallback: flowType === "authorization_code" || flowType === "authorization_code_pkce",
      manualCode: extras.manualCode === true,
      proxyCallback: extras.proxyCallback === true,
      tokenImport: extras.tokenImport === true,
      cookieImport: extras.cookieImport === true,
      directCodePaste: extras.directCodePaste === true,
      tokenRefresh: typeof provider.refreshTokens === "function" || typeof provider.refreshToken === "function",
    },
    flowType,
    discovery: meta.discovery,
    apiFormats: meta.apiFormats,
    docsUrl: meta.docsUrl,
    adapter: "lib/oauth/providers.js",
    notice: meta.notice || null,
  };
}

export function listProviders() {
  return Object.keys(META).map((id) => {
    try {
      return buildManifest(id);
    } catch (err) {
      return { id, enabled: false, oauth: false, error: err.message };
    }
  });
}

export function getManifest(id) {
  if (typeof id !== "string" || !id || id.length > 80) throw new Error("Invalid provider id");
  return buildManifest(id);
}

export function validateManifest(manifest) {
  const errors = [];
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (field === "adapter" && manifest.oauth === false) continue;
    if (manifest[field] === undefined || manifest[field] === null) errors.push(`missing field: ${field}`);
  }
  if (manifest.id && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) errors.push("invalid id format");
  if (manifest.docsUrl !== null && manifest.docsUrl !== undefined) {
    try {
      const parsed = new URL(manifest.docsUrl);
      if (parsed.protocol !== "https:") errors.push("docsUrl must use https");
    } catch {
      errors.push("docsUrl is not a valid URL");
    }
  }
  // Secret hygiene: manifests must never carry credential material.
  // (Method names such as "apiKey" are labels, not secrets — only flag
  // assignments and token-shaped values.)
  const serialized = JSON.stringify(manifest);
  if (/eyJ[A-Za-z0-9-_]{8,}\.[A-Za-z0-9-_]{8,}/.test(serialized)) {
    errors.push("possible JWT material in manifest");
  }
  const assignment = /"(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?secret|password)"\s*:\s*"(?!(?:tokenImport|apiKey|oauth|code)\b)[^"]{4,}"/i.exec(serialized);
  if (assignment) errors.push(`possible credential material: ${assignment[1]}`);
  return errors;
}

export function validateRegistry() {
  const issues = [];
  for (const id of Object.keys(META)) {
    try {
      const manifest = buildManifest(id);
      for (const err of validateManifest(manifest)) issues.push(`${id}: ${err}`);
    } catch (err) {
      issues.push(`${id}: ${err.message}`);
    }
  }
  return issues;
}
