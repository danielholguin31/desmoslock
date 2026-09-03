export interface StaticProtocolAsset {
  readonly body: ArrayBuffer | string;
  readonly contentType: string;
}

export interface StaticProtocolRequest {
  readonly method: string;
  readonly url: string;
}

export interface StaticProtocolHandlerOptions {
  readonly assets: Readonly<Record<string, StaticProtocolAsset>>;
  readonly connectionAllowlist: string;
  readonly contentSecurityPolicy: string;
}

export function createStaticProtocolHandler(
  options: StaticProtocolHandlerOptions,
): (request: StaticProtocolRequest) => Promise<Response> {
  const assets = new Map(Object.entries(options.assets));

  return async (request) => {
    if (request.method !== "GET") {
      return new Response("", { status: 405 });
    }

    const asset = assets.get(request.url);
    if (asset === undefined) {
      return new Response("", { status: 404 });
    }

    return new Response(asset.body, {
      headers: {
        "Cache-Control": "no-store",
        "Connection-Allowlist": options.connectionAllowlist,
        "Content-Security-Policy": options.contentSecurityPolicy,
        "Content-Type": asset.contentType,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
      status: 200,
    });
  };
}
