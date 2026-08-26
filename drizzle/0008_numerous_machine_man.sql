CREATE TABLE "admin_allowlist" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"note" text,
	"added_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_allowlist" ADD CONSTRAINT "admin_allowlist_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;