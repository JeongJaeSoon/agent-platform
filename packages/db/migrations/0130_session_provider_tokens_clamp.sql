-- 0129 caps the count from then on; a count 0127 summed past the cap before
-- that stays there, and readers cannot hold it as a JS number.
UPDATE "sessions" SET "provider_tokens" = 9007199254740991
WHERE "provider_tokens" > 9007199254740991;
