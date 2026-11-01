-- A session started without a repository on an `optional` profile keeps an
-- attached list too (session-repository-attachment.md decision 4). The row
-- cannot tell that session from a `none` one, so the session service, not a
-- CHECK, keeps `none` free of repositories.
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_attached_repositories_check";
