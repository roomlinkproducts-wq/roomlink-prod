-- CreateView
-- Platform-level KPI summary, read by getPlatformKpis() in apps/super-admin.
CREATE OR REPLACE VIEW v_platform_kpis AS
SELECT
    (SELECT COUNT(*) FROM hotels) AS total_hotels,
    (SELECT COUNT(*) FROM hotels WHERE status = 'active') AS active_hotels,
    (SELECT COUNT(*) FROM hotels WHERE status = 'trial') AS trial_hotels,
    (SELECT COUNT(*) FROM hotels WHERE status = 'onboarding') AS onboarding_hotels,
    (SELECT COUNT(*) FROM rooms) AS total_rooms,
    (SELECT COUNT(*) FROM support_tickets WHERE status NOT IN ('resolved','closed')) AS open_support_tickets,
    (SELECT COUNT(*) FROM payments WHERE status = 'failed') AS failed_payments;

-- CreateView
-- Per-hotel onboarding completion percentage, read by getHotelDetail() in apps/super-admin.
CREATE OR REPLACE VIEW v_hotel_onboarding_progress AS
SELECT
    hotel_id,
    COUNT(*) FILTER (WHERE status = 'complete')::NUMERIC / COUNT(*)::NUMERIC * 100 AS percent_complete
FROM onboarding_tracker
GROUP BY hotel_id;
