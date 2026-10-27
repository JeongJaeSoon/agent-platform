ALTER TABLE "turns" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_channel_check" CHECK ("turns"."channel" IN ('web','slack','api'));