-- Service delivery tracking: per-stage timestamps on `requests`, plus a
-- `request_reminders` log of every "still open after 30 min" reminder sent to
-- reception. Additive only; the backfill below rebuilds the new timestamps
-- for existing rows from `request_status_history`, which has recorded every
-- status change since requests were introduced.

-- AlterTable
ALTER TABLE "requests" ADD COLUMN     "accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "request_reminders" (
    "reminder_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "hotel_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status_at_send" "request_status" NOT NULL,
    "open_minutes" INTEGER NOT NULL,
    "status_minutes" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),

    CONSTRAINT "request_reminders_pkey" PRIMARY KEY ("reminder_id")
);

-- CreateIndex
CREATE INDEX "idx_request_reminders_hotel_ack" ON "request_reminders"("hotel_id", "acknowledged_at");

-- CreateIndex
CREATE INDEX "idx_request_reminders_hotel_sent_at" ON "request_reminders"("hotel_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "request_reminders_request_id_sequence_key" ON "request_reminders"("request_id", "sequence");

-- AddForeignKey
ALTER TABLE "request_reminders" ADD CONSTRAINT "request_reminders_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("hotel_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "request_reminders" ADD CONSTRAINT "request_reminders_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "requests"("request_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "request_reminders" ADD CONSTRAINT "request_reminders_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "users"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Backfill: accepted = first move into `assigned` (a staff self-claim from
-- `pending`, or confirming a reception hand-off from `pending_acceptance`).
UPDATE "requests" r SET "accepted_at" = h.first_at
FROM (
    SELECT request_id, MIN(changed_at) AS first_at
    FROM "request_status_history"
    WHERE to_status = 'assigned' AND from_status IN ('pending', 'pending_acceptance')
    GROUP BY request_id
) h
WHERE h.request_id = r.request_id;

-- Backfill: cancelled_at for requests that are currently cancelled.
UPDATE "requests" r SET "cancelled_at" = h.last_at
FROM (
    SELECT request_id, MAX(changed_at) AS last_at
    FROM "request_status_history"
    WHERE to_status = 'cancelled'
    GROUP BY request_id
) h
WHERE h.request_id = r.request_id AND r.status = 'cancelled';

-- Backfill: status_changed_at = the last history row that actually changed
-- status (note-only rows keep from_status = to_status and are skipped),
-- falling back to created_at.
UPDATE "requests" r SET "status_changed_at" = COALESCE(h.last_at, r.created_at)
FROM (
    SELECT q.request_id, MAX(sh.changed_at) AS last_at
    FROM "requests" q
    LEFT JOIN "request_status_history" sh
      ON sh.request_id = q.request_id
     AND sh.from_status IS DISTINCT FROM sh.to_status
    GROUP BY q.request_id
) h
WHERE h.request_id = r.request_id;
