ALTER TABLE "extensions" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "publish_tokens" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "publish_tokens" ALTER COLUMN "last_used_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "publish_tokens" ALTER COLUMN "revoked_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "created_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "expires_at" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE bigint;