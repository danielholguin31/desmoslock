import http from "node:http";

const port = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(
    "serve-backend-health-fixture requires a non-privileged port",
  );
}

const healthBody = JSON.stringify({
  capabilities: ["auth", "database", "rest"],
  fixtureDigest:
    "7c84b474e409b79fdb11e537b29a48f56382c1f88afc28b213fb5043fff7f2ca",
  fixtureValid: true,
  fixtureVersion: "internal-baseline-v1",
  schemaGeneration: 3,
  service: "desmoslock-v2",
  status: "ready",
});

const server = http.createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/functions/v1/health") {
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("Not Found");
    return;
  }

  response.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(healthBody);
});

server.listen(port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
