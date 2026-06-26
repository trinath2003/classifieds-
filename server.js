// server.js — ClassifiedsDesk backend
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
const db = process.env.MYSQL_URL
  ? mysql.createPool(process.env.MYSQL_URL)
  : mysql.createPool({
      host:               process.env.DB_HOST     || 'localhost',
      port:               Number(process.env.DB_PORT) || 3306,
      user:               process.env.DB_USER     || 'root',
      password:           process.env.DB_PASSWORD || '',
      database:           process.env.DB_NAME     || 'newspaper_db',
      waitForConnections: true,
      connectionLimit:    10,
      connectTimeout:     20000,
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
async function initDB(retries = 6, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await _initDBOnce();
      console.log('[DB] ✅ Schema ready');
      return;
    } catch (err) {
      console.error(`[DB] initDB attempt ${attempt}/${retries} failed: ${err.code} — ${err.message}`);
      if (attempt < retries) {
        console.log(`[DB] Retrying in ${delayMs / 1000}s…`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      } else {
        console.error('[DB] All retries exhausted. Server will start without a DB connection.');
      }
    }
  }
}

// ── MySQL 5.7-compatible column-adder ─────────────────────────────────────
// ALTER TABLE … ADD COLUMN IF NOT EXISTS is MySQL 8.0+ only.
// This helper checks information_schema first, then adds only missing columns.

// Extract DB name from MYSQL_URL (e.g. mysql://user:pass@host:3306/dbname)
// so information_schema queries work correctly on Railway where DB_NAME may not be set.
function getDbName() {
  if (process.env.MYSQL_URL) {
    try {
      const url = new URL(process.env.MYSQL_URL);
      return url.pathname.replace(/^\//, '') || 'newspaper_db';
    } catch (_) {}
  }
  return process.env.DB_NAME || 'newspaper_db';
}

async function addColumnIfMissing(tableName, columnName, columnDef) {
  const dbName = getDbName();
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, tableName, columnName]
  );
  if (!rows.length) {
    await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDef}`);
    console.log(`[DB] Added column: ${tableName}.${columnName}`);
  }
}

async function _initDBOnce() {
  // Only bootstrap CREATE DATABASE when using individual env vars (local dev).
  // When MYSQL_URL is set (Railway / hosted MySQL), the DB already exists.
  if (!process.env.MYSQL_URL) {
    const bootstrapCfg = {
      host:           process.env.DB_HOST     || 'localhost',
      port:           Number(process.env.DB_PORT) || 3306,
      user:           process.env.DB_USER     || 'root',
      password:       process.env.DB_PASSWORD || '',
      connectTimeout: 20000,
    };
    const bootstrap = await mysql.createConnection(bootstrapCfg);
    const dbName = process.env.DB_NAME || 'newspaper_db';
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();
  }

  // Step 2: create table — only lowercase canonical columns.
  // No duplicate backtick-quoted aliases: MySQL is case-insensitive on column names,
  // so having both `category` and `Category` in the same CREATE TABLE → ER_DUP_FIELDNAME.
  await db.query(`
    CREATE TABLE IF NOT EXISTS classified_ads (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      newspaper_name  VARCHAR(100)  DEFAULT NULL,
      source          ENUM('scraper','pdf','seller') NOT NULL DEFAULT 'scraper',
      status          ENUM('active','pending','rejected') NOT NULL DEFAULT 'active',
      date_published  DATE          DEFAULT NULL,
      day_published   VARCHAR(15)   DEFAULT NULL,
      category        VARCHAR(60)   DEFAULT NULL,
      sub_category    VARCHAR(60)   DEFAULT NULL,
      title           TEXT          DEFAULT NULL,
      description     TEXT          DEFAULT NULL,
      location        VARCHAR(255)  DEFAULT NULL,
      price           VARCHAR(100)  DEFAULT NULL,
      size_area       VARCHAR(100)  DEFAULT NULL,
      phone           VARCHAR(60)   DEFAULT NULL,
      whatsapp        VARCHAR(60)   DEFAULT NULL,
      email           VARCHAR(120)  DEFAULT NULL,
      scraped_at      DATETIME      DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Step 3: add any missing columns — works on MySQL 5.7 AND 8.0
  const cols = [
    ['newspaper_name', "VARCHAR(100)  DEFAULT NULL"],
    ['source',         "ENUM('scraper','pdf','seller') NOT NULL DEFAULT 'scraper'"],
    ['status',         "ENUM('active','pending','rejected') NOT NULL DEFAULT 'active'"],
    ['date_published', "DATE          DEFAULT NULL"],
    ['day_published',  "VARCHAR(15)   DEFAULT NULL"],
    ['category',       "VARCHAR(60)   DEFAULT NULL"],
    ['sub_category',   "VARCHAR(60)   DEFAULT NULL"],
    ['title',          "TEXT          DEFAULT NULL"],
    ['description',    "TEXT          DEFAULT NULL"],
    ['location',       "VARCHAR(255)  DEFAULT NULL"],
    ['price',          "VARCHAR(100)  DEFAULT NULL"],
    ['size_area',      "VARCHAR(100)  DEFAULT NULL"],
    ['phone',          "VARCHAR(60)   DEFAULT NULL"],
    ['whatsapp',       "VARCHAR(60)   DEFAULT NULL"],
    ['email',          "VARCHAR(120)  DEFAULT NULL"],
    ['scraped_at',     "DATETIME      DEFAULT NULL"],
  ];
  for (const [col, def] of cols) {
    await addColumnIfMissing('classified_ads', col, def);
  }

  // Step 4: indexes — silently ignore if they already exist
  try {
    await db.query(`CREATE INDEX idx_newspaper_date ON classified_ads (newspaper_name, date_published)`);
  } catch (_) {}
  try {
    await db.query(`CREATE INDEX idx_day_published ON classified_ads (day_published)`);
  } catch (_) {}

  await db.query(`UPDATE classified_ads SET newspaper_name = 'Deccan Chronicle' WHERE newspaper_name IS NULL`);
  await db.query(`
    UPDATE classified_ads
    SET date_published = DATE(scraped_at), day_published = DAYNAME(scraped_at)
    WHERE date_published IS NULL AND scraped_at IS NOT NULL
  `);
}

// ── Cron jobs ──────────────────────────────────────────────────────────────
cron.schedule('0 6 * * *', () => {
  console.log('[CRON] 6 AM — scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

cron.schedule('0 12 * * *', () => {
  console.log('[CRON] 12 PM — re-scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

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
    if (day)         { cond.push('DAYNAME(date_published) = ?');                              params.push(day); }
    if (date)        { cond.push('date_published = ?');                                       params.push(date); }
    if (dateFrom)    { cond.push('date_published >= ?');                                      params.push(dateFrom); }
    if (dateTo)      { cond.push('date_published <= ?');                                      params.push(dateTo); }

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

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM classified_ads ${where}`, params);
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
      sizeArea || 'Not mentioned', phone, whatsapp || '', email || ''
    ]);
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate ad.' });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /days ──────────────────────────────────────────────────────────────
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
    const [[totals]] = await db.query(`
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

// ── GET /scrape ────────────────────────────────────────────────────────────
app.get('/scrape', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json({ message: `Scraping ${date}…`, status: 'started' });
  scrapeAndSave(date, date)
    .then(r => console.log('[SCRAPE]', r))
    .catch(e => console.error('[SCRAPE]', e.message));
});

// ── GET /scrape/week ───────────────────────────────────────────────────────
app.get('/scrape/week', async (req, res) => {
  const today = new Date();
  const mon   = new Date(today);
  mon.setDate(today.getDate() - today.getDay() + 1);
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

// Start server immediately so Railway's health-check doesn't time out,
// then run DB init (with retries) in the background.
startServer(Number(process.env.PORT) || 8080);
initDB().catch(e => console.error('[DB] Fatal after all retries:', e.code, e.message));

