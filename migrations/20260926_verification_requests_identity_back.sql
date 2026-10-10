-- Back side of the Aadhaar card, stored alongside the front (document_path).
-- Idempotent — safe to re-run.
alter table verification_requests
  add column if not exists document_path_back text;

comment on column verification_requests.document_path_back is
  'Storage path (private "verification-documents" bucket, same {userId}/{verificationType}/{randomUUID()}.{ext} shape as document_path) for the BACK side of the Aadhaar card. Only populated when verification_type = ''identity''; null otherwise.';
