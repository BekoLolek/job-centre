CREATE TABLE "notification_dm_claims" (
	"user_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dm_claims_user_id_dedupe_key_pk" PRIMARY KEY("user_id","dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "notification_dm_claims" ADD CONSTRAINT "notification_dm_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;