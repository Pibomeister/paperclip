CREATE TABLE "issue_status_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"operation_digest" text NOT NULL,
	"operation_kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"expected_status" text NOT NULL,
	"expected_status_version" bigint NOT NULL,
	"expected_mutation_version" bigint NOT NULL,
	"requested_status" text NOT NULL,
	"applied" boolean NOT NULL,
	"status_before" text NOT NULL,
	"status_version_before" bigint NOT NULL,
	"mutation_version_before" bigint NOT NULL,
	"status_after" text NOT NULL,
	"status_version_after" bigint NOT NULL,
	"mutation_version_after" bigint NOT NULL,
	"comment_id" uuid,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "issue_mutation_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_status_operations" ADD CONSTRAINT "issue_status_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_status_operations" ADD CONSTRAINT "issue_status_operations_comment_id_issue_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_status_operations" ADD CONSTRAINT "issue_status_operations_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_status_operations_company_operation_uq" ON "issue_status_operations" USING btree ("company_id","operation_id");--> statement-breakpoint
CREATE INDEX "issue_status_operations_company_issue_created_idx" ON "issue_status_operations" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_bump_issue_mutation_version()
RETURNS trigger AS $$
BEGIN
	IF (to_jsonb(NEW) - 'issue_mutation_version') IS DISTINCT FROM (to_jsonb(OLD) - 'issue_mutation_version') THEN
		NEW."issue_mutation_version" := OLD."issue_mutation_version" + 1;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_mutation_version_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_mutation_version_trigger
BEFORE UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_mutation_version();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_touch_issue_mutation_version_from_comment()
RETURNS trigger AS $$
DECLARE
	target_issue_id uuid;
BEGIN
	target_issue_id := COALESCE(NEW."issue_id", OLD."issue_id");
	IF target_issue_id IS NOT NULL THEN
		UPDATE "issues"
		SET "issue_mutation_version" = "issue_mutation_version" + 1,
			"updated_at" = now()
		WHERE "id" = target_issue_id;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_comment_mutation_version_trigger ON "issue_comments";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_comment_mutation_version_trigger
AFTER INSERT OR UPDATE OR DELETE ON "issue_comments"
FOR EACH ROW EXECUTE FUNCTION paperclip_touch_issue_mutation_version_from_comment();
