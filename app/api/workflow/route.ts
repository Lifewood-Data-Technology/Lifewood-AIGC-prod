import { runWorkflowAction, workflowSubmissionDatabase, authorizeWorkflowSubmission } from "../../../db/backend";
import { apiError, authenticatedEmail } from "../_auth";
import { canonicalSubmission, executeSubmission, protectedCreates, submissionDigest } from "../../../lib/submission-policy";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; payload?: Record<string, string> };
    if (protectedCreates.has(body.action || "")) {
      const email = authenticatedEmail(request);
      await authorizeWorkflowSubmission(email, body.action || "");
      const result = await executeSubmission(workflowSubmissionDatabase(), email, request.headers.get("x-lifewood-submission") || "",
        await submissionDigest(canonicalSubmission(body.action || "", body.payload || {})),
        () => runWorkflowAction(email, body.action || "", body.payload || {}, new URL(request.url).origin));
      return Response.json(result.body, { status: result.status });
    }
    return Response.json(await runWorkflowAction(authenticatedEmail(request), body.action ?? "", body.payload ?? {}, new URL(request.url).origin));
  } catch (error) {
    return apiError(error, "Action failed.");
  }
}
