// Minimal dependency-free SSE mock server for the T1 spike.
// Serves GET /events as `text/event-stream`, emitting 5 `data:` chunks
// ("chunk 1".."chunk 5") 100 ms apart, then closing the stream.
//
// Usage: node test/mock-sse.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14321;
const TOTAL_CHUNKS = 5;
const CHUNK_INTERVAL_MS = 100;

const server = createServer((req, res) => {
  if (req.url !== "/events") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let sent = 0;
  const timer = setInterval(() => {
    sent += 1;
    res.write(`data: chunk ${sent}\n\n`);
    if (sent >= TOTAL_CHUNKS) {
      clearInterval(timer);
      res.end();
    }
  }, CHUNK_INTERVAL_MS);

  // Stop the timer if the client disconnects early.
  req.on("close", () => clearInterval(timer));
});

server.listen(PORT, HOST, () => {
  console.log(`mock SSE server listening on http://${HOST}:${PORT}/events`);
});
