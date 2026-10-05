CREATE TABLE "device_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"item_count" integer NOT NULL,
	"simulated" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD COLUMN "capture_method" text DEFAULT 'file_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD COLUMN "simulated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD COLUMN "input_label" text;--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD COLUMN "device_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD COLUMN "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "device_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "device_batches" ADD CONSTRAINT "device_batches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_batches" ADD CONSTRAINT "device_batches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_batches" ADD CONSTRAINT "device_batches_assignment_id_device_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."device_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_batches" ADD CONSTRAINT "device_batches_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_batches_key_uq" ON "device_batches" USING btree ("device_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "device_batches_patient_idx" ON "device_batches" USING btree ("patient_id","measured_at");--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD CONSTRAINT "auscultation_recordings_device_batch_id_device_batches_id_fk" FOREIGN KEY ("device_batch_id") REFERENCES "public"."device_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_device_batch_id_device_batches_id_fk" FOREIGN KEY ("device_batch_id") REFERENCES "public"."device_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observations_device_idx" ON "observations" USING btree ("device_id","measured_at") WHERE "observations"."device_id" is not null;--> statement-breakpoint

-- ===========================================================================
-- Slice V5 (devices). Everything above was generated from src/db/schema.ts; what follows is written by hand. All of it is additive: no column
-- is dropped or retyped, no row is changed, and existing device readings, assignments and recordings keep their meaning (a recording made
-- before this migration is a "file_upload" that is not simulated, which is what every one of them was).
-- ===========================================================================

-- 1. What a reading may claim about itself. The two checks are NOT VALID: they hold for every row written from now on, and are not run against
--    rows from before (the application only ever wrote 'manual_entry' and, with a device, 'device_unverified', so there is nothing to find; a
--    database that was edited by hand is not stopped from migrating).
ALTER TABLE "observations" ADD CONSTRAINT "observations_validation_status_chk"
  CHECK (validation_status IN ('manual_entry', 'device_unverified', 'simulated')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_device_validation_chk"
  CHECK (validation_status = 'manual_entry' OR (source = 'device' AND device_id IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_valid_until_chk" CHECK (valid_until IS NULL OR valid_until > assigned_at);
--> statement-breakpoint
ALTER TABLE "device_batches" ADD CONSTRAINT "device_batches_kind_chk" CHECK (kind IN ('readings', 'auscultation'));
--> statement-breakpoint
ALTER TABLE "auscultation_recordings" ADD CONSTRAINT "auscultation_capture_method_chk" CHECK (capture_method IN ('file_upload', 'browser_recording', 'gateway'));
--> statement-breakpoint

-- 2. Simulated data can never pass for device data, and device data can never be passed off as simulated: the database decides it from the device
--    record, whatever the application (or anyone with the application's role) writes.
--    (a) A device record is a simulator from the moment it is made, or never.
CREATE FUNCTION devices_simulator_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.integration = 'simulator') IS DISTINCT FROM (NEW.integration = 'simulator') THEN
    RAISE EXCEPTION 'a device record is a simulator from the start or never' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER devices_simulator_guard BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_simulator_guard();
--> statement-breakpoint
--    (b) A reading, a gateway batch and a recording say "simulated" exactly when the device record they came through is a simulator.
CREATE FUNCTION device_simulated_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_sim boolean := false;
  claimed boolean;
BEGIN
  IF NEW.device_id IS NOT NULL THEN
    SELECT integration = 'simulator' INTO is_sim FROM devices WHERE id = NEW.device_id;
  END IF;
  IF TG_TABLE_NAME = 'observations' THEN
    claimed := NEW.validation_status = 'simulated';
  ELSE
    claimed := NEW.simulated;
  END IF;
  IF claimed IS DISTINCT FROM coalesce(is_sim, false) THEN
    RAISE EXCEPTION 'a row is marked simulated exactly when its device record is a simulator (%)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER observations_simulated_guard BEFORE INSERT OR UPDATE OF validation_status, device_id ON observations
  FOR EACH ROW EXECUTE FUNCTION device_simulated_guard();
--> statement-breakpoint
CREATE TRIGGER device_batches_simulated_guard BEFORE INSERT ON device_batches
  FOR EACH ROW EXECUTE FUNCTION device_simulated_guard();
--> statement-breakpoint
CREATE TRIGGER auscultation_recordings_simulated_guard BEFORE INSERT ON auscultation_recordings
  FOR EACH ROW EXECUTE FUNCTION device_simulated_guard();
--> statement-breakpoint

-- 3. Gateway batches are append-only: the record of what a gateway sent, and the key that makes sending it again harmless, is never rewritten.
CREATE TRIGGER device_batches_append_only BEFORE UPDATE OR DELETE ON device_batches
  FOR EACH ROW EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint
CREATE TRIGGER device_batches_no_truncate BEFORE TRUNCATE ON device_batches
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint
INSERT INTO meta.append_only_tables (table_name) VALUES ('device_batches') ON CONFLICT DO NOTHING;
