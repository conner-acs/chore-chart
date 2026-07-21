// HTTP response helpers for API Gateway (HTTP API, payload format 2.0).
// CORS is handled at the API level (serverless.yml httpApi.cors), so responses
// here only carry the content type.

export const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: body === undefined || body === "" ? "" : JSON.stringify(body),
});

// FastAPI returns errors as {"detail": "..."} — preserve that shape so the
// existing frontend's error handling keeps working unchanged.
export const error = (statusCode, detail) => json(statusCode, { detail });

// Thrown by handlers/middleware to short-circuit with a specific HTTP status.
export class HttpError extends Error {
  constructor(statusCode, detail) {
    super(detail);
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

// Decode a request body, accounting for API Gateway base64-encoding it
// (non-text content types) before JSON-parsing. Returns {} for an empty body.
export const parseBody = (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  return raw ? JSON.parse(raw) : {};
};
