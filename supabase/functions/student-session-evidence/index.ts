import {
  handleStudentEvidenceRequest,
  type StudentEvidenceDependencies,
} from "../_shared/student-protection-evidence.ts";

export function handleRequest(
  request: Request,
  dependencies?: StudentEvidenceDependencies,
): Promise<Response> {
  return handleStudentEvidenceRequest(request, dependencies);
}

if (import.meta.main) Deno.serve((request) => handleRequest(request));
