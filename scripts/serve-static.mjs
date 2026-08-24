import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const [rootArgument, portArgument] = process.argv.slice(2);
if (rootArgument === undefined || portArgument === undefined) {
  throw new Error("serve-static expects a root directory and port");
}

const root = path.resolve(rootArgument);
const port = Number(portArgument);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid static server port: ${portArgument}`);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const candidate = path.resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const contents = await fs.readFile(candidate);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type":
        contentTypes.get(path.extname(candidate)) ?? "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(500).end();
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving ${root} at http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
