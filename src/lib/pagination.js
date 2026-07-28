// Cursor pagination helpers for DynamoDB list endpoints.
//
// A cursor is an opaque base64url-encoded JSON of the DynamoDB LastEvaluatedKey.
// Clients pass ?limit=&cursor= and get back { items, next_cursor }; next_cursor
// is null on the last page.

export const encodeCursor = (lastKey) =>
  lastKey ? Buffer.from(JSON.stringify(lastKey)).toString("base64url") : null;

export const decodeCursor = (cursor) => {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    return undefined; // a garbled cursor just starts from the beginning
  }
};

// Clamp a page size from a raw query value (default 25, max 100).
export const pageLimit = (raw, def = 25, max = 100) => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
};

// Count every item across a (possibly multi-page) Scan/Query. Uses Select=COUNT
// so no item bodies are transferred. `run(ExclusiveStartKey)` must return the
// AWS SDK response ({ Count, LastEvaluatedKey }).
export const countAll = async (run) => {
  let total = 0;
  let key;
  do {
    const { Count = 0, LastEvaluatedKey } = await run(key);
    total += Count;
    key = LastEvaluatedKey;
  } while (key);
  return total;
};
