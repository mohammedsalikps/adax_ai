CREATE TYPE "public"."patient_document_status" AS ENUM('recorded', 'entered_in_error');--> statement-breakpoint
CREATE TYPE "public"."procedure_status" AS ENUM('recorded', 'entered_in_error');--> statement-breakpoint
CREATE TYPE "public"."service_order_status" AS ENUM('requested', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "encounter_handwriting" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"strokes_file_id" uuid NOT NULL,
	"stroke_count" integer NOT NULL,
	"page_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encounter_handwriting_counts_check" CHECK (version >= 1 and stroke_count between 0 and 20000 and page_count between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "mana_action_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mana_action_decisions_check" CHECK (kind in ('add_prescription_item') and decision in ('approved', 'declined'))
);
--> statement-breakpoint
CREATE TABLE "patient_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"category" text NOT NULL,
	"modality" text,
	"title" text NOT NULL,
	"study_date" date,
	"report_text" text,
	"file_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"status" "patient_document_status" DEFAULT 'recorded' NOT NULL,
	"status_reason" text,
	"data_origin" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_documents_category_check" CHECK (category in ('lab_report', 'imaging_report', 'imaging_image', 'other') and (modality is null or (modality in ('mri', 'ct', 'xray', 'ultrasound', 'other') and category in ('imaging_report', 'imaging_image')))),
	CONSTRAINT "patient_documents_text_check" CHECK (length(btrim(title)) between 1 and 160 and length(coalesce(report_text, '')) <= 20000 and length(coalesce(status_reason, '')) <= 200),
	CONSTRAINT "patient_documents_mime_check" CHECK (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "patient_documents_study_date_check" CHECK (study_date is null or study_date >= date '1900-01-01'),
	CONSTRAINT "patient_documents_error_reason_check" CHECK (status <> 'entered_in_error' or length(btrim(coalesce(status_reason, ''))) >= 3),
	CONSTRAINT "patient_documents_origin_check" CHECK (data_origin in ('synthetic', 'clinical'))
);
--> statement-breakpoint
CREATE TABLE "patient_procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"name" text NOT NULL,
	"performed_year" integer,
	"performed_month" integer,
	"status" "procedure_status" DEFAULT 'recorded' NOT NULL,
	"note" text,
	"status_reason" text,
	"source" text DEFAULT 'clinician_entered' NOT NULL,
	"data_origin" text NOT NULL,
	"entered_by" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_procedures_performed_check" CHECK ((performed_year is null or performed_year between 1900 and 2200) and (performed_month is null or (performed_year is not null and performed_month between 1 and 12))),
	CONSTRAINT "patient_procedures_text_check" CHECK (length(btrim(name)) between 1 and 120 and length(coalesce(note, '')) <= 300 and length(coalesce(status_reason, '')) <= 200),
	CONSTRAINT "patient_procedures_error_reason_check" CHECK (status <> 'entered_in_error' or length(btrim(coalesce(status_reason, ''))) >= 3),
	CONSTRAINT "patient_procedures_source_check" CHECK (source in ('clinician_entered') and data_origin in ('synthetic', 'clinical'))
);
--> statement-breakpoint
CREATE TABLE "service_order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"from_status" "service_order_status",
	"to_status" "service_order_status" NOT NULL,
	"source" text NOT NULL,
	"actor_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_order_events_source_check" CHECK (source in ('doctor', 'simulated_lab') and (source <> 'doctor' or actor_user_id is not null))
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"visit_id" uuid,
	"encounter_id" uuid NOT NULL,
	"ordered_by" uuid NOT NULL,
	"service_code" text NOT NULL,
	"service_name" text NOT NULL,
	"category" text NOT NULL,
	"note" text,
	"status" "service_order_status" DEFAULT 'requested' NOT NULL,
	"provider" text DEFAULT 'simulated' NOT NULL,
	"simulated" boolean NOT NULL,
	"turnaround_minutes" integer,
	"idempotency_key" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"report_text" text,
	"data_origin" text NOT NULL,
	CONSTRAINT "service_orders_category_check" CHECK (category in ('lab', 'imaging', 'other')),
	CONSTRAINT "service_orders_provider_check" CHECK (provider in ('simulated') and simulated = (provider = 'simulated') and (provider <> 'simulated' or turnaround_minutes is not null)),
	CONSTRAINT "service_orders_turnaround_check" CHECK (turnaround_minutes is null or turnaround_minutes between 1 and 10080),
	CONSTRAINT "service_orders_closed_check" CHECK ((status = 'completed') = (completed_at is not null) and (status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null) and (cancel_reason is null or status = 'cancelled') and (report_text is null or status = 'completed')),
	CONSTRAINT "service_orders_simulated_report_check" CHECK (not simulated or (report_text is null or report_text like 'Simulated %') and (status <> 'completed' or report_text is not null)),
	CONSTRAINT "service_orders_text_check" CHECK (length(btrim(service_code)) between 1 and 40 and length(btrim(service_name)) between 1 and 120 and length(coalesce(note, '')) <= 500 and length(coalesce(cancel_reason, '')) <= 200 and length(coalesce(report_text, '')) <= 2000),
	CONSTRAINT "service_orders_origin_check" CHECK (data_origin in ('synthetic', 'clinical'))
);
--> statement-breakpoint
ALTER TABLE "patient_history_events" DROP CONSTRAINT "patient_history_events_entity_check";--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "triage_note" text;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "triage_note_by" uuid;--> statement-breakpoint
ALTER TABLE "visits" ADD COLUMN "triage_note_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter_handwriting" ADD CONSTRAINT "encounter_handwriting_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_handwriting" ADD CONSTRAINT "encounter_handwriting_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_handwriting" ADD CONSTRAINT "encounter_handwriting_strokes_file_id_files_id_fk" FOREIGN KEY ("strokes_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_handwriting" ADD CONSTRAINT "encounter_handwriting_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mana_action_decisions" ADD CONSTRAINT "mana_action_decisions_message_id_mana_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mana_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mana_action_decisions" ADD CONSTRAINT "mana_action_decisions_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mana_action_decisions" ADD CONSTRAINT "mana_action_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_procedures" ADD CONSTRAINT "patient_procedures_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_procedures" ADD CONSTRAINT "patient_procedures_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_events" ADD CONSTRAINT "service_order_events_order_id_service_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."service_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_order_events" ADD CONSTRAINT "service_order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_ordered_by_users_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_handwriting_version_uq" ON "encounter_handwriting" USING btree ("encounter_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mana_action_decisions_message_uq" ON "mana_action_decisions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "patient_documents_patient_idx" ON "patient_documents" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "patient_documents_encounter_idx" ON "patient_documents" USING btree ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_documents_file_uq" ON "patient_documents" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "patient_procedures_patient_idx" ON "patient_procedures" USING btree ("patient_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_procedures_recorded_uq" ON "patient_procedures" USING btree ("patient_id",lower("name"),coalesce("performed_year", 0),coalesce("performed_month", 0)) WHERE status = 'recorded';--> statement-breakpoint
CREATE INDEX "service_order_events_order_idx" ON "service_order_events" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "service_orders_encounter_idx" ON "service_orders" USING btree ("encounter_id","requested_at");--> statement-breakpoint
CREATE INDEX "service_orders_patient_idx" ON "service_orders" USING btree ("patient_id","requested_at");--> statement-breakpoint
CREATE INDEX "service_orders_open_idx" ON "service_orders" USING btree ("facility_id","status") WHERE status in ('requested', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "service_orders_idempotency_uq" ON "service_orders" USING btree ("ordered_by","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_triage_note_by_users_id_fk" FOREIGN KEY ("triage_note_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_history_events" ADD CONSTRAINT "patient_history_events_entity_check" CHECK (entity_type in ('condition', 'medication', 'investigation', 'procedure', 'document') and action in ('created', 'status_changed'));--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_duration_days_check" CHECK (duration_days is null or duration_days between 1 and 3650);--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_triage_note_check" CHECK (length(coalesce(triage_note, '')) <= 1000 and (triage_note is null or (triage_note_by is not null and triage_note_at is not null)));
--> statement-breakpoint

-- ===========================================================================
-- Doctor HERO final. Everything above was generated from src/db/schema.ts; what follows is written by hand, in the same file, before it was
-- applied anywhere. Additive: no existing row is changed, every new column is nullable, and the one replaced function (visit_status_guard)
-- only refuses one more move.
-- ===========================================================================

-- 1. Signing no longer completes the visit: the visit of a signed consultation stays with the doctor until the doctor completes the
--    consultation (in_consultation -> completed, which already needs a signed consultation). Such a visit must not go back to the queue, so
--    in_consultation -> ready (what discarding a draft does) now needs the visit to have neither an unsigned draft nor a signed consultation.
--    The rest of the state machine of 0019 is unchanged (lifecycle.test.ts checks it against VISIT_TRANSITIONS).
CREATE OR REPLACE FUNCTION visit_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  f text;
  t text := NEW.status::text;
  draft boolean;
  signed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lifecycle_actor();
    IF t <> 'waiting' THEN
      RAISE EXCEPTION 'a visit starts as waiting, not %', t USING ERRCODE = 'AX003';
    END IF;
    RETURN NEW;
  END IF;
  f := OLD.status::text;
  IF f = t THEN
    RETURN NEW;
  END IF;
  PERFORM lifecycle_actor();
  IF f IN ('completed', 'cancelled', 'no_show') THEN
    RAISE EXCEPTION 'visit % is closed (%) and cannot move to %', OLD.id, f, t USING ERRCODE = 'AX003';
  END IF;
  draft := EXISTS (SELECT 1 FROM public.encounters e WHERE e.visit_id = NEW.id AND e.status = 'in_progress');
  signed := EXISTS (SELECT 1 FROM public.encounters e WHERE e.visit_id = NEW.id AND e.status = 'signed');
  IF t IN ('cancelled', 'no_show') AND draft THEN
    RAISE EXCEPTION 'visit % has an unsigned consultation; sign or discard it first', OLD.id USING ERRCODE = 'AX004';
  END IF;
  IF t = 'cancelled' AND length(btrim(coalesce(NEW.status_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'cancelling a visit needs a reason' USING ERRCODE = 'AX003';
  END IF;
  IF NOT (
       (f = 'waiting' AND t IN ('in_triage', 'ready', 'cancelled', 'no_show'))
    OR (f = 'in_triage' AND t IN ('ready', 'waiting', 'cancelled'))
    OR (f = 'ready' AND t IN ('in_triage', 'cancelled', 'no_show'))
    OR (f IN ('waiting', 'in_triage', 'ready') AND t = 'in_consultation' AND draft)
    OR (f = 'in_consultation' AND t = 'completed' AND signed)
    OR (f = 'in_consultation' AND t = 'ready' AND NOT draft AND NOT signed)
  ) THEN
    RAISE EXCEPTION 'visit % cannot move from % to %', OLD.id, f, t USING ERRCODE = 'AX003';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- 2. Service orders. An order belongs to its consultation's patient, visit and facility, and starts as requested. What was ordered, for whom,
--    by whom, from which provider and on what schedule never changes; the status moves requested -> in_progress -> completed, or to cancelled
--    while open, in time order, and a completed or cancelled order never changes again. Never deleted. (Refusals of a change: AX009.)
CREATE FUNCTION service_order_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  enc record;
  progress text[] := ARRAY['status', 'status_changed_at', 'completed_at', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'report_text'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT patient_id, facility_id, visit_id INTO enc FROM public.encounters WHERE id = NEW.encounter_id;
    IF NOT FOUND OR enc.patient_id IS DISTINCT FROM NEW.patient_id OR enc.facility_id IS DISTINCT FROM NEW.facility_id
       OR (NEW.visit_id IS NOT NULL AND NEW.visit_id IS DISTINCT FROM enc.visit_id) THEN
      RAISE EXCEPTION 'a service order belongs to its consultation''s patient, visit and facility' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'requested' THEN
      RAISE EXCEPTION 'a service order starts as requested' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'service orders are never deleted; cancel the order instead' USING ERRCODE = 'AX009';
  END IF;
  IF (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress) THEN
    RAISE EXCEPTION 'what was ordered, for whom and by whom cannot be changed' USING ERRCODE = 'AX009';
  END IF;
  IF NEW.status = OLD.status THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a service order changes only with its status' USING ERRCODE = 'AX009';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'requested' AND NEW.status IN ('in_progress', 'cancelled'))
       OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled'))) THEN
    RAISE EXCEPTION 'a service order cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'AX009';
  END IF;
  IF NEW.status_changed_at < OLD.status_changed_at THEN
    RAISE EXCEPTION 'a service order''s status changes in time order' USING ERRCODE = 'AX009';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER service_orders_guard BEFORE INSERT OR UPDATE OR DELETE ON service_orders
  FOR EACH ROW EXECUTE FUNCTION service_order_guard();
--> statement-breakpoint
CREATE TRIGGER service_orders_no_truncate BEFORE TRUNCATE ON service_orders
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 3. The status history of every order is written here, by the database, never by the application: placing and cancelling an order are the
--    doctor's (with the doctor), every other step is the simulated laboratory's. The time is the order's own (requested_at, status_changed_at),
--    so a simulated step that is applied when the order is next read carries the time its schedule gives, not the time it was read.
CREATE FUNCTION service_order_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.service_order_events (order_id, from_status, to_status, source, actor_user_id, at)
    VALUES (NEW.id, NULL, NEW.status, 'doctor', NEW.ordered_by, NEW.requested_at);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.service_order_events (order_id, from_status, to_status, source, actor_user_id, at)
    VALUES (NEW.id, OLD.status, NEW.status,
            CASE WHEN NEW.status = 'cancelled' THEN 'doctor' WHEN NEW.provider = 'simulated' THEN 'simulated_lab' END,
            CASE WHEN NEW.status = 'cancelled' THEN NEW.cancelled_by END,
            NEW.status_changed_at);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER service_orders_status_history AFTER INSERT OR UPDATE OF status ON service_orders
  FOR EACH ROW EXECUTE FUNCTION service_order_record();
--> statement-breakpoint
CREATE TRIGGER service_order_events_append_only BEFORE UPDATE OR DELETE ON service_order_events
  FOR EACH ROW EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint
CREATE TRIGGER service_order_events_no_truncate BEFORE TRUNCATE ON service_order_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 4. Patient documents, like the history entries of 0023/0024: the stored file is this patient's (and facility's), the consultation if any is
--    this patient's, and a document starts as recorded. Never deleted; its content never changes; the only change is to "entered in error",
--    with a reason, and that is final.
CREATE FUNCTION patient_documents_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = NEW.file_id AND f.patient_id = NEW.patient_id AND f.facility_id = NEW.facility_id)
       OR (NEW.encounter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.encounters e WHERE e.id = NEW.encounter_id AND e.patient_id = NEW.patient_id)) THEN
      RAISE EXCEPTION 'a document, its file and its consultation belong to one patient' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'recorded' THEN
      RAISE EXCEPTION 'a document starts as recorded' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Documents are never deleted; mark a document as entered in error instead' USING ERRCODE = 'AX008';
  END IF;
  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'A document marked as entered in error cannot be changed' USING ERRCODE = 'AX008';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'status_reason', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'status_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'The content of a document cannot be changed; mark it as entered in error and upload it again' USING ERRCODE = 'AX008';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION patient_documents_guard();
--> statement-breakpoint
CREATE TRIGGER patient_documents_no_truncate BEFORE TRUNCATE ON patient_documents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 5. Surgeries and procedures: the same rule as patient_conditions (0023).
CREATE FUNCTION patient_procedures_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'History entries are never deleted; mark an entry as entered in error instead' USING ERRCODE = 'AX008';
  END IF;
  IF OLD.status = 'entered_in_error' THEN
    RAISE EXCEPTION 'An entry marked as entered in error cannot be changed' USING ERRCODE = 'AX008';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'status_reason', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'status_reason', 'updated_at']) THEN
    RAISE EXCEPTION 'The content of a history entry cannot be changed; mark it as entered in error and enter a new one' USING ERRCODE = 'AX008';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER patient_procedures_guard BEFORE UPDATE OR DELETE ON patient_procedures
  FOR EACH ROW EXECUTE FUNCTION patient_procedures_guard();
--> statement-breakpoint
CREATE TRIGGER patient_procedures_no_truncate BEFORE TRUNCATE ON patient_procedures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 6. Handwritten notes. A version is added only while its consultation is an unsigned draft (the consultation row is locked, so a version
--    cannot slip in while the record is being signed), for that consultation's patient, from a strokes file of the same patient and
--    consultation, and versions are consecutive (1, 2, 3 ...): a version that is not the next one is refused as a conflict, like a duplicate.
--    Nothing is changed or deleted afterwards (append-only).
CREATE FUNCTION encounter_handwriting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  enc record;
  last_version integer;
BEGIN
  SELECT status, patient_id INTO enc FROM public.encounters WHERE id = NEW.encounter_id FOR SHARE;
  IF NOT FOUND OR enc.patient_id IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'handwritten notes belong to their consultation''s patient' USING ERRCODE = 'check_violation';
  END IF;
  IF enc.status <> 'in_progress' THEN
    RAISE EXCEPTION 'encounter % is %; its handwritten notes cannot be changed', NEW.encounter_id, enc.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = NEW.strokes_file_id AND f.patient_id = NEW.patient_id AND f.encounter_id = NEW.encounter_id) THEN
    RAISE EXCEPTION 'the strokes file belongs to the same patient and consultation' USING ERRCODE = 'check_violation';
  END IF;
  SELECT max(version) INTO last_version FROM public.encounter_handwriting WHERE encounter_id = NEW.encounter_id;
  IF NEW.version <> coalesce(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'handwritten notes version % is not the next one (%)', NEW.version, coalesce(last_version, 0) + 1 USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER encounter_handwriting_guard BEFORE INSERT ON encounter_handwriting
  FOR EACH ROW EXECUTE FUNCTION encounter_handwriting_guard();
--> statement-breakpoint
CREATE TRIGGER encounter_handwriting_append_only BEFORE UPDATE OR DELETE ON encounter_handwriting
  FOR EACH ROW EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint
CREATE TRIGGER encounter_handwriting_no_truncate BEFORE TRUNCATE ON encounter_handwriting
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 7. The doctor's decision on an action Mana proposed is made once and kept.
CREATE TRIGGER mana_action_decisions_append_only BEFORE UPDATE OR DELETE ON mana_action_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint
CREATE TRIGGER mana_action_decisions_no_truncate BEFORE TRUNCATE ON mana_action_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_change_append_only();
--> statement-breakpoint

-- 8. The application role keeps INSERT and SELECT only on the new append-only tables (policy of 0019).
INSERT INTO meta.append_only_tables (table_name) VALUES ('service_order_events'), ('encounter_handwriting'), ('mana_action_decisions') ON CONFLICT DO NOTHING;
