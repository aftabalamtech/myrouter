// Regression tests for OpenAI Chat streaming terminal ordering.
//
// Reported failure: "OpenAI Chat received content after the finish reason".
// OpenAI-compatible upstreams (SenseNova, DashScope, DeepSeek, Moonshot, ...)
// can send reasoning/content/tool deltas after the finish_reason chunk. Strict
// clients reject that ordering, so MyRoute defers the finish chunk until all
// content has been forwarded. Nothing is dropped.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAIStreamOrder,
  chunkHasContent,
  deltaHasContent,
} from "../open-sse/utils/openaiStreamOrder.js";

const chunk = (delta, finishReason = null, extra = {}) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...extra,
});

function run(order, chunks) {
  const emitted = [];
  for (const c of chunks) emitted.push(...order.push(c));
  return emitted;
}

describe("OpenAI stream terminal ordering", () => {
  it("keeps normal text before the finish chunk", () => {
    const order = createOpenAIStreamOrder();
    const early = run(order, [
      chunk({ role: "assistant" }),
      chunk({ content: "Hello" }),
      chunk({ content: " world" }),
      chunk({}, "stop"),
    ]);
    assert.deepEqual(early.map((c) => c.choices[0].delta.content), [undefined, "Hello", " world"]);
    const tail = order.flush();
    assert.equal(tail.length, 1);
    assert.equal(tail[0].choices[0].finish_reason, "stop");
    assert.deepEqual(order.flush(), [], "flush is idempotent");
  });

  it("moves trailing reasoning content before the finish chunk", () => {
    const order = createOpenAIStreamOrder();
    const emitted = run(order, [
      chunk({ reasoning_content: "thinking" }),
      chunk({}, "stop"),
      chunk({ reasoning_content: "late reasoning" }),
      chunk({ content: "answer" }),
    ]);
    const finish = order.markDone();

    const all = [...emitted, ...finish];
    const last = all[all.length - 1];
    assert.equal(last.choices[0].finish_reason, "stop", "finish must be terminal");
    assert.deepEqual(
      all.slice(0, -1).map((c) => c.choices[0].delta.reasoning_content || c.choices[0].delta.content),
      ["thinking", "late reasoning", "answer"],
      "no content is dropped and it all precedes finish"
    );
  });

  it("splits content that shares a chunk with finish_reason", () => {
    const order = createOpenAIStreamOrder();
    const emitted = run(order, [chunk({ content: "final text" }, "stop")]);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].choices[0].delta.content, "final text");
    assert.equal(emitted[0].choices[0].finish_reason, null);
    const finish = order.flush();
    assert.equal(finish.length, 1);
    assert.equal(finish[0].choices[0].finish_reason, "stop");
    assert.deepEqual(finish[0].choices[0].delta, {});
  });

  it("buffers fragmented tool-call arguments and emits them before finish", () => {
    const order = createOpenAIStreamOrder();
    const emitted = run(order, [
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] }),
      chunk({}, "tool_calls"),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] }),
    ]);
    assert.equal(emitted.length, 3, "tool start and both argument fragments are forwarded");
    const finish = order.flush();
    assert.equal(finish[0].choices[0].finish_reason, "tool_calls");
    assert.equal(finish[0].choices[0].delta.tool_calls, undefined);
  });

  it("merges a usage-only chunk after finish into the deferred finish", () => {
    const order = createOpenAIStreamOrder();
    const emitted = run(order, [
      chunk({ content: "hi" }),
      chunk({}, "stop"),
      {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    ]);
    assert.equal(emitted.length, 1, "usage-only chunk is not emitted separately");
    const finish = order.flush();
    assert.equal(finish.length, 1);
    assert.deepEqual(finish[0].usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  it("keeps a usage-only chunk before finish as a normal chunk", () => {
    const order = createOpenAIStreamOrder();
    const usageChunk = { id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1 } };
    const emitted = run(order, [usageChunk]);
    assert.deepEqual(emitted, [usageChunk]);
  });

  it("collapses duplicate finish chunks and calls prepareFinish once", () => {
    let prepared = 0;
    const order = createOpenAIStreamOrder({
      prepareFinish: (c) => {
        prepared += 1;
        return c;
      },
    });
    run(order, [
      chunk({ content: "a" }),
      chunk({}, "stop"),
      chunk({}, "stop"),
      chunk({ content: "b" }),
      chunk({}, "length"),
    ]);
    const first = order.markDone();
    const second = order.markDone();
    assert.equal(prepared, 1);
    assert.equal(first.length, 1);
    assert.deepEqual(second, []);
    assert.equal(first[0].choices[0].finish_reason, "stop", "first finish reason wins");
  });

  it("ignores late data after [DONE]", () => {
    const order = createOpenAIStreamOrder();
    run(order, [chunk({ content: "a" }), chunk({}, "stop")]);
    assert.equal(order.markDone().length, 1);
    assert.deepEqual(order.push(chunk({ content: "late" })), []);
    assert.deepEqual(order.flush(), []);
  });

  it("reports no terminal chunk when upstream never sent one", () => {
    const order = createOpenAIStreamOrder();
    run(order, [chunk({ content: "partial" })]);
    assert.equal(order.hasPendingFinish(), false);
    assert.deepEqual(order.flush(), []);
  });

  it("detects all late-content delta shapes", () => {
    assert.equal(deltaHasContent({ content: "x" }), true);
    assert.equal(deltaHasContent({ reasoning_content: "x" }), true);
    assert.equal(deltaHasContent({ reasoning: "x" }), true);
    assert.equal(deltaHasContent({ reasoning_details: [{ type: "reasoning.text" }] }), true);
    assert.equal(deltaHasContent({ tool_calls: [{ index: 0 }] }), true);
    assert.equal(deltaHasContent({ refusal: "no" }), true);
    assert.equal(deltaHasContent({ role: "assistant" }), true);
    assert.equal(deltaHasContent({}), false);
    assert.equal(deltaHasContent(null), false);
    assert.equal(chunkHasContent(chunk({ content: "x" }, "stop")), true);
  });
});
