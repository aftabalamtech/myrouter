// Upstream model-catalog pagination (pure coordination, fetch injected).
//
// Some catalog endpoints paginate (Gemini's /v1beta/models returns ~50 entries
// per page with a nextPageToken). Without following the token, discovery
// silently truncated its result to the first page and every later model
// vanished from the discovered catalog. This helper formalizes the loop:
//
//   - `pagination.query`   query param that carries the continuation token
//   - `pagination.tokenField` response field holding the next token
//   - `pagination.maxPages` / `pagination.maxModels` hard stops (loop safety)
//
// The first page is already fetched by the caller; it passes that parsed body
// in and the helper returns the FOLLOW-UP model arrays only. Batching is the
// caller's job (route concatenates). Never throws: any failed follow-up page
// keeps the models collected so far and records `truncated: true` so upstreams
// degrading mid-pagination are visible in the response `warning`.
export async function fetchCatalogFollowUpPages({
  firstBody,
  parseResponse,
  pagination,
  buildUrl,
  fetchPage, // async (url) => { okStatus, parsed, json, status }
  log = console,
}) {
  const pages = [];
  let truncated = false;
  if (!pagination || typeof pagination.tokenField !== "string") {
    return { pages, truncated, pagesFetched: 0 };
  }
  const maxPages = Number.isFinite(pagination.maxPages) ? pagination.maxPages : 20;
  const maxModels = Number.isFinite(pagination.maxModels) ? pagination.maxModels : 5000;
  const seenTokens = new Set();
  let token = firstBody?.[pagination.tokenField];
  let collected = 0;
  while (
    typeof token === "string" && token.trim() &&
    !seenTokens.has(token) &&
    collected < maxModels &&
    pages.length < maxPages
  ) {
    seenTokens.add(token);
    let page;
    try {
      page = await fetchPage(buildUrl(token));
    } catch (err) {
      log?.warn?.(`Catalog pagination fetch failed: ${err?.message || err}`);
      truncated = true;
      break; // keep whatever was collected so far
    }
    if (!page?.okStatus || !page?.parsed) {
      truncated = true;
      break;
    }
    const models = parseResponse(page.json) || [];
    pages.push(models);
    collected += models.length;
    token = page.json?.[pagination.tokenField];
  }
  return { pages, truncated, pagesFetched: pages.length };
}
