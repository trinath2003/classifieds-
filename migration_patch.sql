-- ============================================================
-- ClassifiedsDesk — Schema Patch
-- Run AFTER the original migration.sql if you already ran it,
-- OR merge these into migration.sql for a fresh install.
-- ============================================================

USE newspaper_db;

-- ── 1. Add missing columns that server.js expects ──────────
--    (IF NOT EXISTS is safe to re-run)
ALTER TABLE classified_ads
  ADD COLUMN IF NOT EXISTS `newspaper_name` VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `source`         ENUM('scraper','pdf','seller') NOT NULL DEFAULT 'scraper',
  ADD COLUMN IF NOT EXISTS `status`         ENUM('active','pending','rejected') NOT NULL DEFAULT 'active';

-- ── 2. Backfill existing rows with newspaper_name ──────────
UPDATE classified_ads
SET newspaper_name = 'Deccan Chronicle'
WHERE newspaper_name IS NULL;

-- ── 3. Add index on newspaper_name for fast filtering ──────
CREATE INDEX IF NOT EXISTS idx_newspaper ON classified_ads (newspaper_name);

-- ── 4. Verify ──────────────────────────────────────────────
SELECT
  newspaper_name,
  COUNT(*) AS total_ads,
  SUM(date_published = CURDATE()) AS today_ads,
  MAX(scraped_at) AS last_scraped
FROM classified_ads
GROUP BY newspaper_name;

-- ============================================================
-- SCRAPER FIX SUMMARY (scraper.js changes — see scraper_fixed.js)
-- ============================================================
--
-- PROBLEM: Original scraper uses DATE(publish_date) = CURDATE()
--   → Can miss today's rows when:
--       a) MySQL timezone ≠ Node.js timezone
--       b) The DATE() cast prevents index use, causing a full table scan
--       c) Ads published late in the day (after 6 AM cron) are missed
--
-- FIX in scraper_fixed.js:
--   WHERE publish_date >= DATE_FORMAT(NOW(), '%Y-%m-%d 00:00:00')
--     AND publish_date <= NOW()
--   → Range query uses index, timezone-safe, catches all of today's ads
--
-- ADDITIONAL FIX: Added 'newspaper_name' to every INSERT
--   so /stats and /ads API filters by newspaper_name work correctly.
--
-- CRON FIX in server.js — add a noon run to catch late-published ads:
--   cron.schedule('0 6,12 * * *', () => scrapeAndSave());
--
-- DEDUP FIX: Changed INSERT to INSERT IGNORE
--   so re-running the scraper never creates duplicates
--   (relies on UNIQUE KEY uq_ad on title+location+phone).
