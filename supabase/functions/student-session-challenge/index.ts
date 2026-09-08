import {
  handleStudentChallengeRequest,
  type StudentSessionDependencies,
} from "../_shared/student-session-service.ts";

export function handleRequest(
  request: Request,
  dependencies?: StudentSessionDependencies,
): Promise<Response> {
  return handleStudentChallengeRequest(request, dependencies);
}

if (import.meta.main) {
  Deno.serve((request) => handleRequest(request));
}
