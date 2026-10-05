CREATE INDEX "device_batches_assignment_idx" ON "device_batches" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "observations_device_kind_idx" ON "observations" USING btree ("device_id","kind","measured_at") WHERE "observations"."device_id" is not null;--> statement-breakpoint

-- ===========================================================================
-- Slice V5, after the independent review of the uncommitted change (0029 had already been applied to the development, test and end-to-end
-- databases of the machine it was written on, so it is not edited). The two indexes above were generated from src/db/schema.ts; what follows
-- is written by hand. Additive: no column, row or existing constraint is changed.
-- ===========================================================================

-- 1. Where a reading came from is fixed when it is stored. The guard of 0029 looked only at the row as it would become, so one UPDATE could take
--    a simulated reading, give it a real device (or none) and a matching status, and pass: a simulator's value would have become a device
--    reading, or a staff measurement. Now source, device, validation status and gateway batch cannot change after the insert, for anyone. (What
--    may still change on a reading is what the application changes: marking it entered in error.)
CREATE FUNCTION observations_provenance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.validation_status IS DISTINCT FROM OLD.validation_status
     OR NEW.device_batch_id IS DISTINCT FROM OLD.device_batch_id THEN
    RAISE EXCEPTION 'where a reading came from (source, device, validation status, batch) cannot be changed after it is stored' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER observations_provenance_guard BEFORE UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION observations_provenance_guard();
--> statement-breakpoint

-- 2. The guards of 0029 read the devices table by its bare name. A session may create a temporary table of the same name, which is found first:
--    the table is now named with its schema, and the functions run with a fixed search path (temporary objects last).
CREATE OR REPLACE FUNCTION device_simulated_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  is_sim boolean := false;
  claimed boolean;
BEGIN
  IF NEW.device_id IS NOT NULL THEN
    SELECT integration = 'simulator' INTO is_sim FROM public.devices WHERE id = NEW.device_id;
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
CREATE OR REPLACE FUNCTION devices_simulator_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (OLD.integration = 'simulator') IS DISTINCT FROM (NEW.integration = 'simulator') THEN
    RAISE EXCEPTION 'a device record is a simulator from the start or never' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
