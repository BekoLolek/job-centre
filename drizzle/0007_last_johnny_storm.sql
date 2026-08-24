CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"state" "availability_state" NOT NULL,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_exceptions_window" CHECK ("availability_exceptions"."start_minute" >= 0 and "availability_exceptions"."end_minute" > "availability_exceptions"."start_minute" and "availability_exceptions"."end_minute" <= 1740)
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"state" "availability_state" DEFAULT 'yes' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rules_weekday" CHECK ("availability_rules"."weekday" between 0 and 6),
	CONSTRAINT "availability_rules_window" CHECK ("availability_rules"."start_minute" >= 0 and "availability_rules"."end_minute" > "availability_rules"."start_minute" and "availability_rules"."end_minute" <= 1740),
	CONSTRAINT "availability_rules_state" CHECK ("availability_rules"."state" <> 'no')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_exceptions_user_id_idx" ON "availability_exceptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "availability_exceptions_date_idx" ON "availability_exceptions" USING btree ("on_date");--> statement-breakpoint
CREATE INDEX "availability_rules_user_id_idx" ON "availability_rules" USING btree ("user_id");