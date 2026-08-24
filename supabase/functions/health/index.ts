export function handleRequest(request: Request): Response {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      headers: {
        allow: "GET",
        "cache-control": "no-store",
      },
      status: 405,
    });
  }

  return Response.json(
    {
      schemaGeneration: 2,
      service: "desmoslock-v2",
      status: "ok",
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

if (import.meta.main) {
  Deno.serve(handleRequest);
}
