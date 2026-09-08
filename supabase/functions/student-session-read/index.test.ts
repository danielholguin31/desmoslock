import { handleRequest } from "./index.ts";
import { createStudentSessionDependencies } from "../_shared/student-session-service.ts";

Deno.test(
  "read entrypoint is POST-only and returns the fixed denial without target disclosure",
  async () => {
    const calls: string[] = [];
    const origin = "http://127.0.0.1:54321";
    const dependencies = createStudentSessionDependencies(
      {
        DESMOSLOCK_PUBLIC_BACKEND_ENVIRONMENT: "local",
        DESMOSLOCK_PUBLIC_BACKEND_URL: origin,
        DESMOSLOCK_EXPECTED_SUPABASE_ORIGIN: origin,
        SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key-only",
        SUPABASE_URL: origin,
      },
      (input) => {
        calls.push(new URL(String(input)).pathname);
        return Promise.resolve(Response.json([{ code: "ok" }]));
      },
    );
    const target = `${origin}/functions/v1/student-session-read`;
    for (const method of ["GET", "OPTIONS"]) {
      const response = await handleRequest(
        new Request(target, { method }),
        dependencies,
      );
      if (response.status !== 405 || response.headers.get("allow") !== "POST") {
        throw new Error("Unexpected method contract");
      }
      if (
        JSON.stringify(await response.json()) !==
        JSON.stringify({ status: "denied", code: "STUDENT_SESSION_DENIED" })
      )
        throw new Error("Unexpected public body");
    }
    const response = await handleRequest(
      new Request(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      dependencies,
    );
    if (
      response.status !== 403 ||
      JSON.stringify(await response.json()) !==
        JSON.stringify({ status: "denied", code: "STUDENT_SESSION_DENIED" })
    )
      throw new Error("Unexpected malformed request contract");
    const expected: string[] = [];
    if (JSON.stringify(calls) !== JSON.stringify(expected)) {
      throw new Error("Unexpected RPC or target lookup");
    }
  },
);
