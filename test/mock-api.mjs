// Minimal dependency-free OpenAI-compatible mock server for the T3
// connection test (pattern reused from mock-sse.mjs).
//
// GET /v1/models requires `Authorization: Bearer test-key-12345` and answers
// with an OpenAI-style model list of 3 entries; any missing or wrong token
// gets a 401. Any other path gets a 404.
//
// Usage: node test/mock-api.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14322;
const VALID_TOKEN = "test-key-12345"; // mock fixture, not a real credential

const MODELS = {
  object: "list",
  data: [
    { id: "glm-5.3", object: "model", owned_by: "nan-mock" },
    { id: "deepseek-v4-flash", object: "model", owned_by: "nan-mock" },
    { id: "qwen3.8-flash", object: "model", owned_by: "nan-mock" },
  ],
};

const server = createServer((req, res) => {
  if (req.url === "/v1/models") {
    if (req.headers.authorization !== `Bearer ${VALID_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "invalid api key", type: "invalid_request_error" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(MODELS));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(
    `mock OpenAI-compatible API listening on http://${HOST}:${PORT}/v1/models`,
  );
});
