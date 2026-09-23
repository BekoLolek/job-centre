ALTER TABLE "event_suggestions" DROP CONSTRAINT "event_suggestions_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "event_suggestions" DROP COLUMN "event_id";