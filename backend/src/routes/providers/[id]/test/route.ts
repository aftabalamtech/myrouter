
import { testSingleConnection } from "./testUtils.js";

// POST /api/providers/[id]/test - Test connection
export async function POST_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const result = await testSingleConnection(id);

    if (result.error === "Connection not found") {
      return res.status(404).json({ error: "Connection not found" });
    }

    return res.json({
      valid: result.valid,
      error: result.error,
      refreshed: result.refreshed || false,
      // Sanitized diagnostics (task §4): no tokens, cookies, API keys or
      // authorization headers — category/HTTP status/upstream code only.
      testStatus: result.testStatus || (result.valid ? "active" : "error"),
      category: result.category || null,
      httpStatus: result.httpStatus ?? null,
      upstreamCode: result.upstreamCode || null,
      detail: result.detail || null,
      providerBlocked: result.providerBlocked === true,
      recommendedAction: result.recommendedAction || null,
    });
  } catch (error) {
    console.log("Error testing connection:", error);
    return res.status(500).json({ error: "Test failed" });
  }
}
