import { createDeseretIntegrationService } from "./deseret-integration";
import { nativeIntegrationFiles } from "./deseret-native-files";
import { deseretProjectContext, deseretServiceProjectContext, projectSummaryUpdateStatement, productionStagingBucket, runWorkflowAction, workflowSubmissionDatabase } from "./backend";
import { parseIntegrationConfig } from "../lib/deseret-integration-contract";
import { PublicError } from "../lib/security-controls";

export { nativeIntegrationFiles };

export function runtimeDeseretIntegrationService() {
  const config = parseIntegrationConfig();
  if (!config.enabled) throw new PublicError("Deseret integration is disabled.", 503, "DESERET_DISABLED");
  return createDeseretIntegrationService({
    db: workflowSubmissionDatabase(), config,
    createNativeProject: (payload, commit) => runWorkflowAction(config.intakeOwnerEmail, "project.create", payload, undefined, commit),
    async projectContext(email, projectId, write) {
      const context = await deseretProjectContext(email, projectId);
      if (!write) return context;
      return deseretProjectContext(email, projectId, context.actor.access === "production" ? "files.upload" : "projects.manage");
    },
    serviceProjectContext: projectId => deseretServiceProjectContext(projectId),
    nativeFiles: nativeIntegrationFiles,
    projectSummaryStatement: projectId => projectSummaryUpdateStatement(workflowSubmissionDatabase(), projectId),
    async verifyNativeFiles(files) {
      for (const file of files) {
        if (!/^(?:[a-f0-9]{64}|wasabi-sha256-parts-v1:[a-f0-9]{64})$/.test(file.sha256))
          throw new PublicError("This file requires a verified integrity record before publication.", 409, "DESERET_INTEGRITY_REQUIRED");
        const head = await productionStagingBucket().head(file.objectKey);
        if (!head || head.size !== file.size || !file.etag || head.etag.replaceAll('"', "") !== file.etag.replaceAll('"', ""))
          throw new PublicError("A registered review object changed or is unavailable.", 409, "DESERET_OBJECT_UNAVAILABLE");
      }
    },
  });
}
