export const legacyFinalSubmissionOperation = "production.deseret_final_submitted";

// Both callers bind the project_files row as pf and its exact aigc_file_versions row as version.
export const finalSubmissionEvidenceSql = `(
  EXISTS(SELECT 1 FROM production_final_submissions submitted
    JOIN production_submission_receipts receipt ON receipt.id=submitted.id
    WHERE submitted.final_version_id=pf.id AND submitted.language_project_id=pf.language_project_id
      AND receipt.actor_email=submitted.submitted_by
      AND json_extract(receipt.response_json,'$.deseretPhase')='final'
      AND json_extract(receipt.response_json,'$.finalVersionId')=pf.id)
  OR EXISTS(SELECT 1 FROM aigc_file_operations operation
    WHERE operation.file_id=version.file_id AND operation.details=pf.id
      AND operation.operation='${legacyFinalSubmissionOperation}')
)`;
