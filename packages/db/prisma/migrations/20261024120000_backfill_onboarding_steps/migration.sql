-- Backfill onboarding_tracker rows that no code path ever completed before:
-- "Department Managers" (now marked by setDepartmentManager) and "Review"
-- (now marked by goLive). Data-only; idempotent.

-- Department Managers: complete if any department in the hotel has a manager.
UPDATE "onboarding_tracker" t
SET "status" = 'complete', "updated_at" = CURRENT_TIMESTAMP
WHERE t."step_name" = 'Department Managers'
  AND t."status" <> 'complete'
  AND EXISTS (
    SELECT 1 FROM "departments" d
    WHERE d."hotel_id" = t."hotel_id" AND d."manager_id" IS NOT NULL
  );

-- Review: complete if the hotel has already gone live.
UPDATE "onboarding_tracker" t
SET "status" = 'complete', "updated_at" = CURRENT_TIMESTAMP
FROM "hotels" h
WHERE t."hotel_id" = h."hotel_id"
  AND t."step_name" = 'Review'
  AND t."status" <> 'complete'
  AND h."status" NOT IN ('pending', 'onboarding');
