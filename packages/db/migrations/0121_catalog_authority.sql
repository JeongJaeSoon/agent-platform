CREATE TABLE "catalog_authority" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_authority_singleton_check" CHECK ("catalog_authority"."id" = 1)
);
