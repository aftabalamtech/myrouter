import { getApiKeys } from "../../../lib/localDb.js";
import { UPDATER_CONFIG } from "../../../shared/constants/config.js";
import { getConsistentMachineId } from "../../../shared/utils/machineId.js";

const CLI_TOKEN_SALT = "9r-cli-auth";

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || 3001}`, timeoutMs = 15000) {
  const headers = await getInternalHeaders();
  const start = Date.now();
  const timeout = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 15000;

  if (kind === "embedding") {
    const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: AbortSignal.timeout(timeout),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetch(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
      signal: AbortSignal.timeout(timeout),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetch(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  const request = new Request(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: "Reply with OK." }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const { handleChat } = await import("../../../sse/handlers/chat.js");
  const response = await handleChat(request, {
    endpoint: "/v1/chat/completions",
    body: { model, stream: true, messages: [{ role: "user", content: "Reply with OK." }] },
    headers: Object.fromEntries(request.headers.entries()),
  });
  const latencyMs = Date.now() - start;
  const rawText = await response.text().catch(() => "");

  if (!response.ok) {
    const detail = readErrorDetail(rawText);
    return { ok: false, latencyMs, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`, status: response.status };
  }

  const result = validateChatCompletion(rawText);
  if (!result.ok) {
    return { ok: false, latencyMs, status: response.status, error: result.error };
  }

  return { ok: true, latencyMs, error: null, status: response.status };
}

function readErrorDetail(rawText) {
  try {
    const parsed = rawText ? JSON.parse(rawText) : null;
    return String(parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || "").slice(0, 240);
  } catch {
    return String(rawText || "").slice(0, 240);
  }
}

export function validateChatCompletion(rawText) {
  let sawCompletion = false;
  let providerError = null;
  const consume = (chunk) => {
    if (chunk?.error) {
      providerError = chunk.error?.message || chunk.error;
      return;
    }
    const choice = chunk?.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    if (typeof content === "string" && content.trim()) sawCompletion = true;
  };

  for (const line of String(rawText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { consume(JSON.parse(data)); } catch {}
  }

  if (!sawCompletion) {
    try { consume(JSON.parse(rawText)); } catch {}
  }
  if (providerError) return { ok: false, error: String(providerError).slice(0, 240) };
  if (!sawCompletion) return { ok: false, error: "Provider returned no completion content for this model" };
  return { ok: true };
}
