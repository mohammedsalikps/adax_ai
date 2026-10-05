CREATE TABLE "thermal_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"capture_id" uuid NOT NULL,
	"composer_version" text NOT NULL,
	"rules_version" text,
	"model" jsonb NOT NULL,
	"statements" jsonb NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"final_text" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thermal_summaries_status_check" CHECK ("thermal_summaries"."status" in ('pending', 'accepted', 'edited', 'rejected')),
	CONSTRAINT "thermal_summaries_decision_check" CHECK (("thermal_summaries"."status" = 'pending') = ("thermal_summaries"."decided_at" is null) and (("thermal_summaries"."status" = 'edited') = ("thermal_summaries"."final_text" is not null)))
);
--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "capture_source" text DEFAULT 'file_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "device_reported" jsonb;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD COLUMN "std_c" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "thermal_rois" ADD COLUMN "points" jsonb;--> statement-breakpoint
ALTER TABLE "thermal_rois" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_capture_id_thermal_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."thermal_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_summaries" ADD CONSTRAINT "thermal_summaries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thermal_summaries_capture_idx" ON "thermal_summaries" USING btree ("capture_id");--> statement-breakpoint
CREATE INDEX "thermal_summaries_encounter_idx" ON "thermal_summaries" USING btree ("encounter_id");--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD CONSTRAINT "thermal_captures_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD CONSTRAINT "thermal_captures_source_check" CHECK ("thermal_captures"."capture_source" in ('live_capture', 'gallery_import', 'file_upload', 'simulator'));--> statement-breakpoint
ALTER TABLE "thermal_captures" ADD CONSTRAINT "thermal_captures_simulated_check" CHECK ("thermal_captures"."simulated" = ("thermal_captures"."capture_source" = 'simulator') and (not "thermal_captures"."simulated" or "thermal_captures"."data_origin" = 'synthetic'));--> statement-breakpoint
ALTER TABLE "thermal_rois" ADD CONSTRAINT "thermal_rois_shape_check" CHECK ("thermal_rois"."shape" in ('rect', 'ellipse', 'polygon') and (("thermal_rois"."shape" = 'polygon') = ("thermal_rois"."points" is not null)));--> statement-breakpoint

-- Hand-written (V6). 1. Where a thermal capture came from (its source, the simulator mark, the device, what the device reported, when it was
--    taken, the original file) cannot be changed after it is stored. Review and the region statistics still update the row as before.
CREATE FUNCTION thermal_capture_provenance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.capture_source IS DISTINCT FROM OLD.capture_source
     OR NEW.simulated IS DISTINCT FROM OLD.simulated
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.device_reported IS DISTINCT FROM OLD.device_reported
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.raw_file_id IS DISTINCT FROM OLD.raw_file_id
     OR NEW.matrix_file_id IS DISTINCT FROM OLD.matrix_file_id
     OR NEW.data_origin IS DISTINCT FROM OLD.data_origin THEN
    RAISE EXCEPTION 'where a thermal image came from cannot be changed after it is stored' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER thermal_capture_provenance_guard BEFORE UPDATE ON thermal_captures
  FOR EACH ROW EXECUTE FUNCTION thermal_capture_provenance_guard();
--> statement-breakpoint

-- 2. A thermal summary says what it said when it was composed, and is decided once: the only change allowed is from pending to a decision.
--    None is deleted. Its simulated mark is its capture's.
CREATE FUNCTION thermal_summary_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  capture_simulated boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT simulated INTO capture_simulated FROM public.thermal_captures WHERE id = NEW.capture_id;
    IF NEW.simulated IS DISTINCT FROM capture_simulated OR NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a thermal summary starts pending and is simulated exactly when its capture is' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'thermal summaries are kept' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending'
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW.statements IS DISTINCT FROM OLD.statements
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.capture_id IS DISTINCT FROM OLD.capture_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.composer_version IS DISTINCT FROM OLD.composer_version
     OR NEW.rules_version IS DISTINCT FROM OLD.rules_version
     OR NEW.simulated IS DISTINCT FROM OLD.simulated
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a thermal summary is decided once and what it says never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER thermal_summary_guard BEFORE INSERT OR UPDATE OR DELETE ON thermal_summaries
  FOR EACH ROW EXECUTE FUNCTION thermal_summary_guard();
--> statement-breakpoint
CREATE TRIGGER thermal_summaries_no_truncate BEFORE TRUNCATE ON thermal_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
