import {
  handleStudentReadRequest,
  type StudentSessionDependencies,
} from "../_shared/student-session-service.ts";

export function handleRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handleStudentReadRequest(request, dependencies);
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
