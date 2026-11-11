# Verifiable deletion

1. `DELETE /v1/organizations/{org}/documents/{id}` → document `deleting` (excluded from retrieval instantly).
2. The worker purges chunks, embeddings and S3 objects of all versions and leaves a `document.purged` event.
3. Non-recovery check: query with questions about the document → abstention; `SELECT count(*) FROM chunks WHERE document_id = ...` = 0.
4. Limits to communicate to the customer: non-current S3 versions expire through the lifecycle (90 days by default);
   RDS backups keep data until their retention ends; `audit_events` is kept (without document content).
