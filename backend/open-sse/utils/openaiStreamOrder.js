import { FORMATS } from "../translator/formats.js";

export function isOpenAIChatFormat(format) {
  return format === FORMATS.OPENAI;
}

export function deltaHasContent(delta) {
  if (!delta || typeof delta !== "object") return false;
  return Boolean(
    (typeof delta.content === "string" && delta.content !== "")
    || (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "")
    || (typeof delta.reasoning === "string" && delta.reasoning !== "")
    || (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0)
    || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
    || (typeof delta.refusal === "string" && delta.refusal !== "")
    || (typeof delta.role === "string" && delta.role !== "")
  );
}

export function chunkHasContent(chunk) {
  const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
  return choices.some((choice) => deltaHasContent(choice?.delta));
}

function splitChunk(chunk) {
  const choices = Array.isArray(chunk?.choices) ? chunk.choices : null;
  if (!choices || choices.length === 0) {
    return { contentChunk: null, finishChunk: null, metaOnly: true };
  }

  const contentChoices = [];
  const finishChoices = [];

  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    if (choice.finish_reason) {
      finishChoices.push({ ...choice, delta: {} });
      if (deltaHasContent(choice.delta)) {
        contentChoices.push({ ...choice, finish_reason: null });
      }
    } else {
      contentChoices.push(choice);
    }
  }

  return {
    contentChunk: contentChoices.length > 0 ? { ...chunk, choices: contentChoices } : null,
    finishChunk: finishChoices.length > 0 ? { ...chunk, choices: finishChoices } : null,
    metaOnly: false,
  };
}

export function createOpenAIStreamOrder(options = {}) {
  const prepareFinish = options.prepareFinish || ((chunk) => chunk);
  let pendingFinish = null;
  let finishEmitted = false;
  let doneSeen = false;

  function mergeUsage(chunk) {
    if (!chunk || chunk.usage === undefined || chunk.usage === null) return;
    pendingFinish = pendingFinish
      ? { ...pendingFinish, usage: chunk.usage }
      : pendingFinish;
  }

  return {
    push(chunk) {
      if (!chunk || chunk.done || doneSeen) return [];

      const { contentChunk, finishChunk, metaOnly } = splitChunk(chunk);

      if (metaOnly) {
        if (pendingFinish && !finishEmitted) {
          mergeUsage(chunk);
          return [];
        }
        return [chunk];
      }

      const out = contentChunk ? [contentChunk] : [];

      if (finishChunk) {
        if (!pendingFinish) pendingFinish = finishChunk;
        else mergeUsage(chunk);
      } else if (pendingFinish && !finishEmitted && chunk.usage) {
        mergeUsage(chunk);
        if (out.length === 0) return [];
      }

      return out;
    },

    markDone() {
      if (doneSeen) return [];
      doneSeen = true;
      return this.flush();
    },

    flush() {
      if (!pendingFinish || finishEmitted) return [];
      finishEmitted = true;
      const prepared = prepareFinish(pendingFinish);
      pendingFinish = null;
      return prepared ? [prepared] : [];
    },

    isDone() {
      return doneSeen;
    },

    hasPendingFinish() {
      return Boolean(pendingFinish) && !finishEmitted;
    },
  };
}
