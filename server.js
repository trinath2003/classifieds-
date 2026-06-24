// server.js — ClassifiedsDesk backend
// ─────────────────────────────────────────────────────────────────────────────
// CHANGES in this version:
//   • Replaced scraper.js import with dc_scraper.js (Puppeteer + OCR)
//   • Cron: 6 AM daily scrapes today; Sunday midnight kicks off full week backfill
//   • GET /days returns each of the last 7 actual calendar dates with ad counts
//   • GET /ads?day=Sunday returns ads for ALL Sundays in the last 7 days' data
//   • GET /ads?date=2026-06-22 returns ads for that exact date
//   • GET /scrape?date=2026-06-22 triggers on-demand scrape for any date
//   • GET /scrape/week triggers scrape for current Mon–Sun week
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const path    = require('path');
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const cron    = require('node-cron');
const multer  = require('multer');

const scrapeAndSave   = require('./dc_scraper');
const parsePdfAndSave = require('./pdfParser');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── DB pool ────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:             process.env.DB_HOST     || 'localhost',
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME     || 'newspaper_db',
  waitForConnections: true,
  connectionLimit:  10
});

const upload = multer({ storage: multer.memoryStorage() });

// ── Helpers ────────────────────────────────────────────────────────────────
function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}

function toDateValue(value) {
  const raw  = value || new Date();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeCategory(raw) {
  const text = String(raw || '').toUpperCase();
  if (/(AUTOMOTIVE|CAR|BIKE|BIKES|VEHICLE|FOUR.?WHEELER|SUV|SEDAN|MOTORCYCLE|TWO.?WHEELER|SCOOTER|AUTO)/.test(text)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|SHADI|SHAADI|MATCH\s+SOUGHT|ALLIANCE)/.test(text))                                   return 'Matrimonial';
  if (/(JOB|JOBS|VACANT|VACANCY|TEACHER|DRIVER|LECTUR|MANAGER|MEDICAL|WALK.IN|HIRING|REQUIRED|RECRUIT|EMPLOYMENT|WANTED|OPENING|CAREER)/.test(text)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|HOSTEL|PG\b|PAYING GUEST|PLOT|FLAT|HOUSE|LAND|BUILDING|VILLA|APARTMENT|COMMERCIAL|OFFICE|SHOP|BHK|SQFT|SQ\.FT)/.test(text)) return 'Property';
  return 'Other';
}

function normalizeSubCategory(category, raw) {
  const text  = String(raw || '').trim();
  const lower = text.toLowerCase();
  if (category === 'Property') {
    if (lower.includes('rent') || lower.includes('rental') || lower.includes('lease')) return 'For Rent';
    if (lower.includes('pg')   || lower.includes('hostel') || lower.includes('paying guest')) return 'PG / Hostel';
    return text || 'For Sale';
  }
  if (category === 'Automotive') return text || 'Used vehicle';
  if (category === 'Jobs')       return text || 'Full-time';
  return text || 'General';
}

function normalizeAd(row, sno) {
  const rawCategory = row.category    || row['Category']            || '';
  const rawSub      = row.sub_category|| row['Sub-Category']        || '';
  const rawTitle    = row.title       || row['Title/Property Type'] || '';
  const rawDesc     = row.description || row['Additional Details']  || '';
  const rawLocation = row.location    || row['Location']            || '';
  const rawPrice    = row.price       || row['Price/Details']       || '';
  const rawSize     = row.size_area   || row['Size/Area']           || '';
  const rawPhone    = row.phone       || row['Contact']             || '';

  const datePublished = toDateValue(row.date_published || row.scraped_at);
  const dayPublished  = row.day_published || dayName(datePublished);
  const normalizedCat = normalizeCategory(rawCategory);

  return {
    sno,
    date_published: datePublished,
    day_published:  dayPublished,
    category:       normalizedCat,
    sub_category:   normalizeSubCategory(normalizedCat, rawSub || rawCategory),
    title:          rawTitle,
    description:    rawDesc,
    location:       rawLocation,
    price:          rawPrice,
    size_area:      rawSize,
    phone:          rawPhone,
    whatsapp:       row.whatsapp || '',
    email:          row.email    || '',
    source:         row.source   || (row.scraped_at ? 'scraper' : 'seller'),
    status:         row.status   || 'active',
    scraped_at:     row.scraped_at || null
  };
}

// ── DB init ────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await db.query(`
      ALTER TABLE classified_ads
        ADD COLUMN IF NOT EXISTS \`newspaper_name\` VARCHAR(100)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`source\`         ENUM('scraper','pdf','seller') NOT NULL DEFAULT 'scraper',
        ADD COLUMN IF NOT EXISTS \`status\`         ENUM('active','pending','rejected') NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS \`date_published\` DATE          DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`day_published\`  VARCHAR(15)   DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`category\`       VARCHAR(60)   DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`sub_category\`   VARCHAR(60)   DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`title\`          TEXT          DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`description\`    TEXT          DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`location\`       VARCHAR(255)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`price\`          VARCHAR(100)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`size_area\`      VARCHAR(100)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`phone\`          VARCHAR(60)   DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`whatsapp\`       VARCHAR(60)   DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`email\`          VARCHAR(120)  DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS \`scraped_at\`     DATETIME      DEFAULT NULL
    `);

    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_newspaper_date ON classified_ads (newspaper_name, date_published)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_day_published  ON classified_ads (day_published)`);
    } catch (_) {}

    await db.query(`
      UPDATE classified_ads SET newspaper_name = 'Deccan Chronicle' WHERE newspaper_name IS NULL
    `);
    await db.query(`
      UPDATE classified_ads
      SET date_published = DATE(scraped_at), day_published = DAYNAME(scraped_at)
      WHERE date_published IS NULL AND scraped_at IS NOT NULL
    `);

    console.log('[DB] ✅ Schema ready');
  } catch (err) {
    console.error('[DB] initDB error:', err.message);
  }
}

// ── Cron jobs ──────────────────────────────────────────────────────────────
// Daily at 6 AM: scrape today's paper
cron.schedule('0 6 * * *', () => {
  console.log('[CRON] 6 AM — scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

// Daily at 12 PM: re-scrape today (catches late ads)
cron.schedule('0 12 * * *', () => {
  console.log('[CRON] 12 PM — re-scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

// Every Sunday at midnight: scrape full Mon-Sun week (backfill / catch up)
cron.schedule('0 0 * * 0', () => {
  const today = new Date();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - 6);
  const monStr = mon.toISOString().slice(0, 10);
  const todStr = today.toISOString().slice(0, 10);
  console.log(`[CRON] Sunday midnight — scraping full week ${monStr} → ${todStr}`);
  scrapeAndSave(monStr, todStr).catch(e => console.error('[CRON]', e.message));
});

// ── GET /ads ───────────────────────────────────────────────────────────────
app.get('/ads', async (req, res) => {
  try {
    const {
      category, subCategory, source, day, date,
      dateFrom, dateTo, search, sort = 'newest',
      page = 1, limit: rawLimit = 24
    } = req.query;

    const limit  = Math.min(Math.max(Number(rawLimit) || 24, 1), 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const cond   = ['newspaper_name = ?'];
    const params = ['Deccan Chronicle'];

    if (category)    { cond.push('LOWER(COALESCE(category,     `Category`))     = LOWER(?)'); params.push(category); }
    if (subCategory) { cond.push('LOWER(COALESCE(sub_category, `Sub-Category`)) = LOWER(?)'); params.push(subCategory); }
    if (source)      { cond.push('source = ?');                                               params.push(source); }

    // day filter: e.g. ?day=Sunday → all Sundays in the DB
    if (day) {
      cond.push('DAYNAME(date_published) = ?');
      params.push(day);
    }
    // exact date filter: ?date=2026-06-22
    if (date) {
      cond.push('date_published = ?');
      params.push(date);
    }
    if (dateFrom) { cond.push('date_published >= ?'); params.push(dateFrom); }
    if (dateTo)   { cond.push('date_published <= ?'); params.push(dateTo); }

    if (search) {
      const t = `%${search}%`;
      cond.push(`(
        LOWER(COALESCE(title,       \`Title/Property Type\`)) LIKE LOWER(?) OR
        LOWER(COALESCE(description, \`Additional Details\`))  LIKE LOWER(?) OR
        LOWER(COALESCE(location,    \`Location\`))            LIKE LOWER(?) OR
        LOWER(COALESCE(category,    \`Category\`))            LIKE LOWER(?)
      )`);
      params.push(t, t, t, t);
    }

    const where = `WHERE ${cond.join(' AND ')}`;
    const orderMap = {
      newest:     'date_published DESC, scraped_at DESC',
      oldest:     'date_published ASC,  scraped_at ASC',
      price_asc:  'COALESCE(price, `Price/Details`) ASC',
      price_desc: 'COALESCE(price, `Price/Details`) DESC',
    };
    const orderBy = orderMap[sort] || 'date_published DESC, scraped_at DESC';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM classified_ads ${where}`, params
    );

    const [rows] = await db.query(`
      SELECT
        id,
        COALESCE(category,     \`Category\`)            AS category,
        COALESCE(sub_category, \`Sub-Category\`)        AS sub_category,
        COALESCE(title,        \`Title/Property Type\`) AS title,
        COALESCE(description,  \`Additional Details\`)  AS description,
        COALESCE(location,     \`Location\`)            AS location,
        COALESCE(price,        \`Price/Details\`)       AS price,
        COALESCE(size_area,    \`Size/Area\`)           AS size_area,
        COALESCE(phone,        \`Contact\`)             AS phone,
        whatsapp, email, source, status,
        date_published, day_published, scraped_at
      FROM classified_ads
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    const data = rows.map((row, i) => normalizeAd(row, offset + i + 1));
    res.json({ data, total, page: Number(page), totalPages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /ads/:id ───────────────────────────────────────────────────────────
app.get('/ads/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [rows] = await db.query(`
      SELECT
        COALESCE(category,     \`Category\`)            AS category,
        COALESCE(sub_category, \`Sub-Category\`)        AS sub_category,
        COALESCE(title,        \`Title/Property Type\`) AS title,
        COALESCE(description,  \`Additional Details\`)  AS description,
        COALESCE(location,     \`Location\`)            AS location,
        COALESCE(price,        \`Price/Details\`)       AS price,
        COALESCE(size_area,    \`Size/Area\`)           AS size_area,
        COALESCE(phone,        \`Contact\`)             AS phone,
        whatsapp, email, source, status, date_published, day_published, scraped_at
      FROM classified_ads
      WHERE id = ? AND newspaper_name = 'Deccan Chronicle'
    `, [id]);

    if (!rows.length) return res.status(404).json({ error: 'Ad not found' });
    res.json(normalizeAd(rows[0], id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /ads (seller submission) ──────────────────────────────────────────
app.post('/ads', async (req, res) => {
  try {
    const { category, subCategory, title, description, location, price, sizeArea, phone, whatsapp, email } = req.body;
    if (!category || !title || !phone) {
      return res.status(400).json({ error: 'category, title, and phone are required' });
    }
    const today  = new Date().toISOString().slice(0, 10);
    const dayPub = dayName(new Date());
    const [result] = await db.query(`
      INSERT INTO classified_ads
        (date_published, day_published, category, sub_category, title, description,
         location, price, size_area, phone, whatsapp, email,
         source, status, newspaper_name, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seller', 'active', 'Deccan Chronicle', NULL)
    `, [
      today, dayPub, category, subCategory || 'General', title,
      description || '', location || '', price || 'Not mentioned',
      sizeArea    || 'Not mentioned', phone, whatsapp || '', email || ''
    ]);
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate ad.' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /days — last 7 calendar dates that have ads, with counts ────────────
// This powers the day-pill UI so each pill shows real date + count
app.get('/days', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        date_published,
        DAYNAME(date_published)  AS day_name,
        DATE_FORMAT(date_published, '%a, %d %b') AS label,
        COUNT(*)                 AS ad_count,
        SUM(category = 'Property')    AS property_count,
        SUM(category = 'Jobs')        AS jobs_count,
        SUM(category = 'Matrimonial') AS matrimonial_count,
        SUM(category = 'Automotive')  AS automotive_count
      FROM classified_ads
      WHERE newspaper_name = 'Deccan Chronicle'
        AND date_published IS NOT NULL
        AND date_published >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY date_published
      ORDER BY date_published DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /stats ─────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const [[totals]]  = await db.query(`
      SELECT
        COUNT(*) AS total,
        SUM(date_published = CURDATE()) AS today,
        SUM(category = 'Property')    AS property,
        SUM(category = 'Jobs')        AS jobs,
        SUM(category = 'Matrimonial') AS matrimonial,
        SUM(category = 'Automotive')  AS automotive,
        SUM(source   = 'scraper')     AS from_scraper,
        SUM(source   = 'pdf')         AS from_pdf,
        SUM(source   = 'seller')      AS from_seller
      FROM classified_ads
      WHERE newspaper_name = 'Deccan Chronicle'
    `);
    res.json(totals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /scrape?date=YYYY-MM-DD — on-demand scrape (single date or today) ──
app.get('/scrape', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({ message: `Scraping ${date}…`, status: 'started' });
  scrapeAndSave(date, date)
    .then(r => console.log('[SCRAPE]', r))
    .catch(e => console.error('[SCRAPE]', e.message));
});

// ── GET /scrape/week — scrape full current Mon–Sun week ────────────────────
app.get('/scrape/week', async (req, res) => {
  const today = new Date();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - today.getDay() + 1); // Monday
  const monStr = mon.toISOString().slice(0, 10);
  const todStr = today.toISOString().slice(0, 10);
  res.json({ message: `Scraping full week ${monStr} → ${todStr}`, status: 'started' });
  scrapeAndSave(monStr, todStr)
    .then(r => console.log('[SCRAPE/WEEK]', r))
    .catch(e => console.error('[SCRAPE/WEEK]', e.message));
});

// ── POST /upload-pdf ───────────────────────────────────────────────────────
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const result = await parsePdfAndSave(req.file.buffer);
  res.json(result);
});

// ── Start ──────────────────────────────────────────────────────────────────
function startServer(port) {
  const server = app.listen(port, () =>
    console.log(`✅  ClassifiedsDesk → http://localhost:${port}`)
  );
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && port < 3010) { startServer(port + 1); return; }
    console.error('Server failed:', err.message);
  });
}

initDB().then(() => startServer(Number(process.env.PORT) || 3001));
