import http from "node:http";

const port = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(
    "serve-backend-health-fixture requires a non-privileged port",
  );
}

const healthBody = JSON.stringify({
  capabilities: ["auth", "database", "rest", "staff-auth"],
  fixtureDigest:
    "f1ecc4d44ca04b3395b565dd2fe9f7887147e34f6196772f18bae00638244201",
  fixtureValid: true,
  fixtureVersion: "internal-baseline-v2",
  schemaGeneration: 4,
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
