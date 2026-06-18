import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TODOS_TABLE;

export const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Decode the request body, accounting for API Gateway base64-encoding it
// (which happens for non-text content types like x-www-form-urlencoded),
// then parse it as JSON. Throws on malformed JSON so callers can 400.
export const parseBody = (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  return JSON.parse(raw || "{}");
};
