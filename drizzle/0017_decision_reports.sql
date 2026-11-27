CREATE TYPE "public"."report_reason" AS ENUM('personal_data', 'wrong_metadata', 'wrong_text', 'other');--> statement-breakpoint
CREATE TABLE "decision_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"message" text,
	"contact" text,
	"took_down" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "decision_reports_resolved" CHECK (("decision_reports"."resolved_at" IS NULL) = ("decision_reports"."resolved_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "decision_reports" ADD CONSTRAINT "decision_reports_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_reports" ADD CONSTRAINT "decision_reports_resolved_by_api_keys_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_reports_decision" ON "decision_reports" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "decision_reports_took_down" ON "decision_reports" USING btree ("created_at") WHERE "decision_reports"."took_down";