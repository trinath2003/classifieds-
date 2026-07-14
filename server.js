// server.js — ClassifiedsDesk backend
require('dotenv').config();
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const cron    = require('node-cron');
const multer  = require('multer');

// ── FIX: destructure named exports from new dc_scraper ────────────────────
const {
  scrapeAndSave, scrapeCurrentWeek,
  processAndSaveUploadedImage, // NEW: manual classifieds-image upload path
} = require('./dc_scraper');
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

// ── Admin auth (for bulk/CSV import) ────────────────────────────────────────
// Set ADMIN_KEY in your environment (Railway → Variables) in production —
// this MUST match the ADMIN_PASSCODE in index.html's <script> for the CSV
// import button to work. Falls back to a shared default so it works out of
// the box; change both if you want this to actually be private.
const ADMIN_KEY = process.env.ADMIN_KEY || 'dc-admin-2026';

function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid admin key' });
  }
  next();
}

// ── IST date helper ────────────────────────────────────────────────────────
// Railway runs UTC. Always use IST for "today" so Sunday/Monday don't get
// missed when IST is ahead of UTC by 5h30m.
function todayIST() {
  return new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}

// ── FIX: explicit DD/MM/YYYY parsing ────────────────────────────────────────
// The old version of this function handed ambiguous date strings straight to
// `new Date(raw)`. JavaScript's native Date parser assumes US-style
// MM/DD/YYYY for slash/dash-separated dates — so a CSV date written the
// Indian way as "10/07/2026" (10 July) was silently misread as "October 7,
// 2026" (month 10, day 07). That's not a timezone issue — it lands on a
// completely different date (and therefore a completely different weekday,
// e.g. Wednesday instead of Friday).
//
// This version explicitly handles:
//   - YYYY-MM-DD (ISO, unambiguous — used as-is)
//   - DD/MM/YYYY or DD-MM-YYYY (Indian format — used explicitly, never
//     handed to the native parser)
// and only falls back to native `Date` parsing for anything else (e.g. full
// datetime strings from the scraper), with a safe today-IST fallback if that
// also fails to parse.
function toDateValue(value) {
  if (!value) return todayIST();
  const raw = String(value).trim();
  if (!raw) return todayIST();

  // ISO format: YYYY-MM-DD
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Indian format: DD/MM/YYYY or DD-MM-YYYY
  m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // Fallback: native parsing (e.g. scraped datetime strings like
  // "2026-07-10T06:30:00.000Z"), with a safe default if unparseable.
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return todayIST();
  return date.toISOString().slice(0, 10);
}

// ── Extract a phone number embedded in free text ────────────────────────────
// Handles CSV rows (or scraped/OCR'd ads) where the phone number was only
// ever present inside the description/title — e.g. "Please call: 9642851000"
// — rather than in its own column. Matches Indian mobile numbers (10 digits,
// starting 6-9), optionally prefixed with +91/91/0 and with spaces or
// dashes in between (e.g. "+91 96428 51000", "0964-285-1000").
function extractPhoneFromText(text) {
  if (!text) return '';
  const s = String(text);
  // Look for any run of digits/spaces/dashes that, once separators are
  // stripped, yields a plausible Indian mobile number (10 digits starting
  // 6-9, optionally with a 0/91/+91 prefix). Grouping in the wild varies
  // ("96428 51000", "0964-285-1000", "9642851000"), so this matches loosely
  // and validates by stripping non-digits rather than requiring a fixed
  // 3-3-4 split.
  const re = /(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}/g;
  const candidates = s.match(re) || [];
  for (const c of candidates) {
    const digits = c.replace(/\D/g, '');
    const last10 = digits.slice(-10);
    if (/^[6-9]\d{9}$/.test(last10)) return last10;
  }
  return '';
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

// ── State → known cities/towns/localities, for the "state" ad filter ──────
// Ads only ever carry a free-text `location` (e.g. "Jubilee Hills",
// "Chennai", "Kondapur") — there's no dedicated state column. So filtering
// by state has to recognise city/locality names that belong to that state,
// not just the literal state name. This list is deliberately weighted
// toward Hyderabad/Telangana localities since that's where the vast
// majority of current ads are (Deccan Chronicle Hyderabad edition), plus
// major cities for every other state/UT so the filter still does something
// sensible if ads from other editions get added later.
const STATE_LOCALITIES = {
  'Telangana': [
    'telangana','hyderabad','secunderabad','jubilee hills','banjara hills','kondapur',
    'gachibowli','kukatpally','miyapur','uppal','lb nagar','malkajgiri','shamshabad',
    'kompally','bachupally','chikkadpally','himayatnagar','bowenpally','sangareddy',
    'shankarpally','patancheru','vidyanagar','masabtank','musheerabad','rajendranagar',
    'pocharam','mettuguda','padmarao nagar','chandanagar','attapur','manikonda',
    'nizampet','alwal','yapral','tirumalagiri','bibinagar','shamirpet','medchal',
    'sikh village','malakpet','balanagar','cherlapally','dhoolpally','gandimaisamma',
    'hyderguda','narayanaguda','bhuvanagiri','karimnagar','warangal','nizamabad',
    'khammam','adilabad','mahbubnagar','nalgonda','ameerpet','somajiguda','begumpet',
    'madhapur','kokapet','tellapur','narsingi','moosapet','erragadda','sainikpuri',
    'ecil','dilsukhnagar','abids','koti','tarnaka','ramanthapur','uppal bhagayath',
    'shadnagar','ida bollaram','annojiguda','puppalguda',
  ],
  'Andhra Pradesh': ['andhra pradesh','vijayawada','visakhapatnam','vizag','guntur','tirupati','nellore','kurnool','rajahmundry','kakinada'],
  'Tamil Nadu': ['tamil nadu','chennai','coimbatore','madurai','trichy','tiruchirappalli','salem','vellore','erode'],
  'Karnataka': ['karnataka','bangalore','bengaluru','mysore','mysuru','mangalore','hubli','belgaum'],
  'Maharashtra': ['maharashtra','mumbai','pune','nagpur','nashik','thane','aurangabad','navi mumbai'],
  'Delhi': ['delhi','new delhi'],
  'Kerala': ['kerala','kochi','cochin','thiruvananthapuram','trivandrum','kozhikode','calicut','kannur'],
  'West Bengal': ['west bengal','kolkata','calcutta','howrah','durgapur','siliguri'],
  'Gujarat': ['gujarat','ahmedabad','surat','vadodara','rajkot','gandhinagar'],
  'Rajasthan': ['rajasthan','jaipur','jodhpur','udaipur','kota','ajmer'],
  'Uttar Pradesh': ['uttar pradesh','lucknow','kanpur','noida','ghaziabad','agra','varanasi','allahabad','prayagraj'],
  'Madhya Pradesh': ['madhya pradesh','bhopal','indore','jabalpur','gwalior'],
  'Bihar': ['bihar','patna','gaya','muzaffarpur'],
  'Punjab': ['punjab','chandigarh','ludhiana','amritsar','jalandhar'],
  'Haryana': ['haryana','gurgaon','gurugram','faridabad','panipat'],
  'Odisha': ['odisha','orissa','bhubaneswar','cuttack','rourkela'],
  'Assam': ['assam','guwahati','dibrugarh'],
  'Jharkhand': ['jharkhand','ranchi','jamshedpur','dhanbad'],
  'Chhattisgarh': ['chhattisgarh','raipur','bhilai'],
  'Uttarakhand': ['uttarakhand','dehradun','haridwar','rishikesh'],
  'Himachal Pradesh': ['himachal pradesh','shimla','manali','dharamshala'],
  'Jammu and Kashmir': ['jammu and kashmir','srinagar','jammu'],
  'Ladakh': ['ladakh','leh'],
  'Goa': ['goa','panaji','margao'],
  'Tripura': ['tripura','agartala'],
  'Manipur': ['manipur','imphal'],
  'Meghalaya': ['meghalaya','shillong'],
  'Nagaland': ['nagaland','kohima','dimapur'],
  'Mizoram': ['mizoram','aizawl'],
  'Sikkim': ['sikkim','gangtok'],
  'Arunachal Pradesh': ['arunachal pradesh','itanagar'],
  'Chandigarh': ['chandigarh'],
  'Puducherry': ['puducherry','pondicherry'],
  'Andaman and Nicobar Islands': ['andaman','nicobar','port blair'],
  'Lakshadweep': ['lakshadweep'],
  'Dadra and Nagar Haveli and Daman and Diu': ['dadra','nagar haveli','daman','diu'],
};

function normalizeAd(row, sno) {
  const rawCategory = row.category     || row['Category']            || '';
  const rawSub      = row.sub_category || row['Sub-Category']        || '';
  const rawTitle    = row.title        || row['Title/Property Type'] || '';
  const rawDesc     = row.description  || row['Additional Details']  || '';
  const rawLocation = row.location     || row['Location']            || '';
  const rawPrice    = row.price        || row['Price/Details']       || '';
  const rawSize     = row.size_area    || row['Size/Area']           || '';
  // FIX: fall back to extracting a phone number from the description/title
  // if the phone column itself is empty (common with CSV rows where the
  // number was only ever written inline in the ad text).
  const rawPhone    = row.phone || row['Contact']
    || extractPhoneFromText(rawDesc)
    || extractPhoneFromText(rawTitle)
    || '';

  const datePublished = toDateValue(row.date_published || row.scraped_at);
  const dayPublished  = row.day_published || dayName(datePublished);
  const normalizedCat = normalizeCategory(rawCategory);

  // NEW: category-specific extra fields (matrimonial/jobs/automotive) are
  // stored as JSON text in the `details` column so we don't need a new DB
  // column per field. Parse defensively — bad/legacy data should never
  // break the whole ad listing.
  let details = null;
  if (row.details) {
    try { details = JSON.parse(row.details); } catch (_) { details = null; }
  }

  return {
    id:             row.id,
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
    scraped_at:     row.scraped_at || null,
    created_at:     row.created_at || null,
    details,
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
        console.error('[DB] All retries exhausted.');
      }
    }
  }
}

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
  if (!process.env.MYSQL_URL) {
    const bootstrapCfg = {
      host:           process.env.DB_HOST     || 'localhost',
      port:           Number(process.env.DB_PORT) || 3306,
      user:           process.env.DB_USER     || 'root',
      password:       process.env.DB_PASSWORD || '',
      connectTimeout: 20000,
    };
    const bootstrap = await mysql.createConnection(bootstrapCfg);
    const dbName    = process.env.DB_NAME || 'newspaper_db';
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await bootstrap.end();
  }

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
      scraped_at      DATETIME      DEFAULT NULL,
      details         TEXT          DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // NEW: anonymous per-ad chat. No accounts — each browser generates a
  // random `sender_token` client-side (stored in localStorage) purely to
  // tell "you" apart from "the other person" in a thread. It carries no
  // real identity, phone, or email, and is never cross-referenced with the
  // seller's contact info stored on the ad itself.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ad_messages (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      ad_id         INT NOT NULL,
      sender_token  VARCHAR(64) NOT NULL,
      message       TEXT NOT NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ad_id (ad_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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
    // NEW: exact moment this ad entered the database — distinct from
    // date_published (the newspaper edition's date, which can be backdated
    // via CSV import). Existing rows get filled with "now" at migration
    // time as a reasonable stand-in, since their true upload time was never
    // recorded.
    ['created_at',     "DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    // NEW: JSON-as-text store for category-specific extra fields
    // (matrimonial/jobs/automotive). Using information_schema-based
    // addColumnIfMissing (not "ADD COLUMN IF NOT EXISTS") since that
    // syntax isn't supported on MySQL 5.7, which Railway runs here.
    ['details',        "TEXT          DEFAULT NULL"],
  ];
  for (const [col, def] of cols) await addColumnIfMissing('classified_ads', col, def);

  try { await db.query(`CREATE INDEX idx_newspaper_date ON classified_ads (newspaper_name, date_published)`); } catch (_) {}
  try { await db.query(`CREATE INDEX idx_day_published  ON classified_ads (day_published)`); }               catch (_) {}

  await db.query(`UPDATE classified_ads SET newspaper_name = 'Deccan Chronicle' WHERE newspaper_name IS NULL`);
  await db.query(`
    UPDATE classified_ads
    SET date_published = DATE(scraped_at), day_published = DAYNAME(scraped_at)
    WHERE date_published IS NULL AND scraped_at IS NOT NULL
  `);
}

// ── Cron jobs ──────────────────────────────────────────────────────────────
// All times are IST (Railway runs UTC, cron times below are in IST offset).
// 6 AM IST = 0:30 UTC  → cron '30 0 * * *'
// 12 PM IST = 6:30 UTC → cron '30 6 * * *'
// Sun midnight IST = 18:30 UTC Sat → cron '30 18 * * 6'

cron.schedule('30 0 * * *', () => {
  console.log('[CRON] 6:00 AM IST — scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

cron.schedule('30 6 * * *', () => {
  console.log('[CRON] 12:00 PM IST — re-scraping today');
  scrapeAndSave().catch(e => console.error('[CRON]', e.message));
});

// ── FIX: Sunday midnight — use scrapeCurrentWeek() which is IST-aware ─────
cron.schedule('30 18 * * 6', () => {
  console.log('[CRON] Sunday midnight IST — scraping full week');
  scrapeCurrentWeek().catch(e => console.error('[CRON]', e.message));
});

// ── GET /test-key — verify ANTHROPIC_API_KEY is valid ─────────────────────
app.get('/test-key', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not set', length: 0 });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Hi' }],
      }),
    });
    const data = await resp.json();
    if (resp.ok) {
      res.json({ ok: true, message: 'API key is valid!', key_length: key.length, key_prefix: key.slice(0, 20) + '...' });
    } else {
      res.json({ ok: false, error: data.error?.message || JSON.stringify(data), key_length: key.length, key_prefix: key.slice(0, 20) + '...' });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message, key_length: key.length });
  }
});

// ── GET /ads ───────────────────────────────────────────────────────────────
app.get('/ads', async (req, res) => {
  try {
    const {
      category, subCategory, source, day, date,
      dateFrom, dateTo, search, state, sort = 'newest',
      page = 1, limit: rawLimit = 24,
    } = req.query;

    const limit  = Math.min(Math.max(Number(rawLimit) || 24, 1), 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const cond   = ['newspaper_name = ?'];
    const params = ['Deccan Chronicle'];

    if (category)    { cond.push('LOWER(category) = LOWER(?)');     params.push(category); }
    if (subCategory) { cond.push('LOWER(sub_category) = LOWER(?)'); params.push(subCategory); }
    if (source)      { cond.push('source = ?');                      params.push(source); }
    if (day)         { cond.push('DAYNAME(date_published) = ?');     params.push(day); }
    if (date)        { cond.push('date_published = ?');              params.push(date); }
    if (dateFrom)    { cond.push('date_published >= ?');             params.push(dateFrom); }
    if (dateTo)      { cond.push('date_published <= ?');             params.push(dateTo); }
    // Filter by Indian state/UT — matches the location text against every
    // known city/town/locality belonging to that state (see
    // STATE_LOCALITIES above), not just the literal state name. So picking
    // "Telangana" also matches ads whose location just says "Jubilee
    // Hills" or "Kondapur" even though the word "Telangana" never appears.
    if (state) {
      const keywords = STATE_LOCALITIES[state] || [state.toLowerCase()];
      cond.push(`(${keywords.map(() => 'LOWER(location) LIKE LOWER(?)').join(' OR ')})`);
      keywords.forEach(k => params.push(`%${k}%`));
    }

    if (search) {
      const t = `%${search}%`;
      cond.push(`(
        LOWER(title)       LIKE LOWER(?) OR
        LOWER(description) LIKE LOWER(?) OR
        LOWER(location)    LIKE LOWER(?) OR
        LOWER(category)    LIKE LOWER(?)
      )`);
      params.push(t, t, t, t);
    }

    const where = `WHERE ${cond.join(' AND ')}`;
    const orderMap = {
      newest:     'date_published DESC, scraped_at DESC',
      oldest:     'date_published ASC,  scraped_at ASC',
      price_asc:  'price ASC',
      price_desc: 'price DESC',
    };
    const orderBy = orderMap[sort] || 'date_published DESC, scraped_at DESC';

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM classified_ads ${where}`, params
    );
    const [rows] = await db.query(`
      SELECT
        id, category, sub_category, title, description,
        location, price, size_area, phone,
        whatsapp, email, source, status,
        date_published, day_published, scraped_at, created_at, details
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
        id, category, sub_category, title, description,
        location, price, size_area, phone,
        whatsapp, email, source, status,
        date_published, day_published, scraped_at, created_at, details
      FROM classified_ads
      WHERE id = ? AND newspaper_name = 'Deccan Chronicle'
    `, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Ad not found' });
    res.json(normalizeAd(rows[0], id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /ads/:id — admin-only permanent delete ──────────────────────────
// Requires header: x-admin-key: <ADMIN_KEY>  (same key as /ads/bulk)
app.delete('/ads/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [result] = await db.query(
      `DELETE FROM classified_ads WHERE id = ? AND newspaper_name = 'Deccan Chronicle'`,
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Ad not found' });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anonymous per-ad chat ────────────────────────────────────────────────
// No accounts, no login. `sender_token` is a random ID the browser makes up
// for itself (see index.html) — it only distinguishes the two sides of a
// conversation, never reveals a name/phone/email. Every message is scoped
// to a single ad_id, so a buyer's messages on ad A don't leak into ad B.

function sanitizeToken(t) {
  const s = String(t || '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(s) ? s : null;
}

// GET /ads/:id/messages — full thread for one ad, oldest first
app.get('/ads/:id/messages', async (req, res) => {
  try {
    const adId = Number(req.params.id);
    if (!Number.isFinite(adId) || adId < 1) return res.status(400).json({ error: 'Invalid ad id' });
    const [rows] = await db.query(
      `SELECT id, ad_id, sender_token, message, created_at
       FROM ad_messages WHERE ad_id = ? ORDER BY created_at ASC, id ASC LIMIT 500`,
      [adId]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ads/:id/messages — body: { senderToken, message }
app.post('/ads/:id/messages', async (req, res) => {
  try {
    const adId = Number(req.params.id);
    if (!Number.isFinite(adId) || adId < 1) return res.status(400).json({ error: 'Invalid ad id' });

    const senderToken = sanitizeToken(req.body.senderToken);
    if (!senderToken) return res.status(400).json({ error: 'Invalid sender token' });

    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message cannot be empty' });
    if (message.length > 2000) return res.status(400).json({ error: 'Message too long (max 2000 chars)' });

    // Confirm the ad actually exists so chat threads can't pile up on
    // deleted/nonexistent ads.
    const [adRows] = await db.query(
      `SELECT id FROM classified_ads WHERE id = ? AND newspaper_name = 'Deccan Chronicle'`,
      [adId]
    );
    if (!adRows.length) return res.status(404).json({ error: 'Ad not found' });

    const [result] = await db.query(
      `INSERT INTO ad_messages (ad_id, sender_token, message) VALUES (?, ?, ?)`,
      [adId, senderToken, message]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/ads', async (req, res) => {
  try {
    const { category, subCategory, title, description, location, price, sizeArea, phone, whatsapp, email, details } = req.body;
    if (!category || !title || !phone) {
      return res.status(400).json({ error: 'category, title, and phone are required' });
    }
    const today  = todayIST();
    // FIX: was `dayName(new Date())`, which computes the weekday from the raw
    // current UTC instant — inconsistent with `today` (IST-adjusted) near
    // midnight. Now derives the day name from the same IST-adjusted date so
    // date_published and day_published always agree.
    const dayPub = dayName(today);
    // NEW: category-specific extra fields (matrimonial/jobs/automotive),
    // stored as JSON text. `details` is optional and category-shaped on the
    // frontend, but the backend just stores whatever object it's given.
    const detailsJson = JSON.stringify(details && typeof details === 'object' ? details : {});
    const [result] = await db.query(`
      INSERT INTO classified_ads
        (date_published, day_published, category, sub_category, title, description,
         location, price, size_area, phone, whatsapp, email,
         source, status, newspaper_name, scraped_at, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seller', 'active', 'Deccan Chronicle', NULL, ?)
    `, [
      today, dayPub, category, subCategory || 'General', title,
      description || '', location || '', price || 'Not mentioned',
      sizeArea || 'Not mentioned', phone, whatsapp || '', email || '',
      detailsJson,
    ]);
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate ad.' });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /ads/bulk (admin-only CSV import) ─────────────────────────────────
// Body: { ads: [ { category, title, subCategory, description, location,
//                  price, sizeArea, phone, whatsapp, email,
//                  datePublished, dayPublished, source }, ... ] }
// Requires header: x-admin-key: <ADMIN_KEY>
// Unlike POST /ads (seller form), phone is NOT required here, and the
// caller may specify source ('scraper' | 'pdf' | 'seller' — defaults to
// 'pdf' since this endpoint exists for bulk/CSV imports).
app.post('/ads/bulk', requireAdmin, async (req, res) => {
  try {
    const ads = Array.isArray(req.body.ads) ? req.body.ads : [];
    if (!ads.length) return res.status(400).json({ error: 'No ads provided' });
    if (ads.length > 500) return res.status(400).json({ error: 'Max 500 ads per request — split into smaller batches' });

    const results = [];
    for (const raw of ads) {
      const category = raw.category;
      const title    = raw.title;
      if (!category || !title) {
        results.push({ ok: false, error: 'category and title are required', row: raw });
        continue;
      }
      const source = ['scraper', 'pdf', 'seller'].includes(raw.source) ? raw.source : 'pdf';
      // FIX: toDateValue() now explicitly parses DD/MM/YYYY (and DD-MM-YYYY)
      // instead of handing ambiguous strings to the native Date parser, which
      // was misreading Indian-format dates as US-format (e.g. "10/07/2026"
      // read as October 7 instead of 10 July) — this was the actual cause of
      // the wrong weekday showing up after CSV import.
      const datePublished = raw.datePublished ? toDateValue(raw.datePublished) : todayIST();
      const dayPublished   = raw.dayPublished || dayName(datePublished);
      // NEW: category-specific extra fields, stored as JSON text. CSV rows
      // may supply a `details` object directly (e.g. programmatic import),
      // or nothing at all — either way we store a valid JSON object.
      const detailsJson = JSON.stringify(raw.details && typeof raw.details === 'object' ? raw.details : {});

      try {
        const [result] = await db.query(`
          INSERT INTO classified_ads
            (date_published, day_published, category, sub_category, title, description,
             location, price, size_area, phone, whatsapp, email,
             source, status, newspaper_name, scraped_at, details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'Deccan Chronicle', NULL, ?)
        `, [
          datePublished, dayPublished, category, raw.subCategory || 'General', title,
          raw.description || '', raw.location || '', raw.price || 'Not mentioned',
          raw.sizeArea || 'Not mentioned', raw.phone || '', raw.whatsapp || '', raw.email || '',
          source, detailsJson,
        ]);
        results.push({ ok: true, id: result.insertId });
      } catch (e) {
        results.push({ ok: false, error: e.message, row: raw });
      }
    }

    const inserted = results.filter(r => r.ok).length;
    res.json({
      success: true,
      total: ads.length,
      inserted,
      failed: ads.length - inserted,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /days ──────────────────────────────────────────────────────────────
app.get('/days', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        date_published,
        DAYNAME(date_published)              AS day_name,
        DATE_FORMAT(date_published, '%a, %d %b') AS label,
        COUNT(*)                             AS ad_count,
        SUM(category = 'Property')           AS property_count,
        SUM(category = 'Jobs')               AS jobs_count,
        SUM(category = 'Matrimonial')        AS matrimonial_count,
        SUM(category = 'Automotive')         AS automotive_count
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

// ── GET /admin/repeat-advertisers — admin-only, phone-based frequency intel ─
// Business intent: find phone numbers that post classifieds repeatedly
// within a time window, as candidates for a "switch to our flat monthly
// rate" pitch (e.g. someone posting 10x/month at the newspaper's per-ad
// rate may spend more than a single discounted package with us).
//
// IMPORTANT CAVEAT: we only know the ad's *sale price* (e.g. "₹28 Cr" for
// a property) — not what the advertiser paid the newspaper to run the
// classified. There's no per-ad billing data in this system. So this
// endpoint only returns frequency counts; any "estimated spend" or
// "savings" figure must be computed on the frontend using a cost-per-ad
// value the admin enters themselves (their actual rate card), not a number
// this endpoint invents.
//
// Query params:
//   days      — lookback window in days (default 30)
//   minCount  — only return phones with at least this many ads (default 3)
app.get('/admin/repeat-advertisers', requireAdmin, async (req, res) => {
  try {
    const days     = Math.max(Number(req.query.days) || 30, 1);
    const minCount = Math.max(Number(req.query.minCount) || 3, 1);

    const [rows] = await db.query(`
      SELECT
        phone,
        COUNT(*)                                   AS ad_count,
        SUM(category = 'Property')                 AS property_count,
        SUM(category = 'Matrimonial')               AS matrimonial_count,
        SUM(category = 'Jobs')                      AS jobs_count,
        SUM(category = 'Automotive')                AS automotive_count,
        SUM(category NOT IN ('Property','Matrimonial','Jobs','Automotive')) AS other_count,
        MIN(date_published)                        AS first_seen,
        MAX(date_published)                        AS last_seen,
        SUBSTRING_INDEX(GROUP_CONCAT(title ORDER BY date_published DESC SEPARATOR '||'), '||', 3) AS sample_titles
      FROM classified_ads
      WHERE newspaper_name = 'Deccan Chronicle'
        AND phone IS NOT NULL AND phone != ''
        AND date_published >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY phone
      HAVING ad_count >= ?
      ORDER BY ad_count DESC
      LIMIT 200
    `, [days, minCount]);

    const data = rows.map(r => {
      // Per-category breakdown, e.g. { Property: 5, Matrimonial: 2 } —
      // omits categories the advertiser never used, so the frontend can
      // show "Property: 5, Matrimonial: 2" instead of a flat count that
      // hides which category they're repeating in most.
      const categoryBreakdown = {};
      if (r.property_count)    categoryBreakdown.Property    = r.property_count;
      if (r.matrimonial_count) categoryBreakdown.Matrimonial = r.matrimonial_count;
      if (r.jobs_count)        categoryBreakdown.Jobs        = r.jobs_count;
      if (r.automotive_count)  categoryBreakdown.Automotive  = r.automotive_count;
      if (r.other_count)       categoryBreakdown.Other       = r.other_count;

      return {
        phone: r.phone,
        adCount: r.ad_count,
        categoryBreakdown,
        // true if this number advertises across more than one category
        // (e.g. Property AND Matrimonial) — worth flagging separately
        // since a multi-category repeat advertiser is a stronger sales
        // lead than someone just re-running the same single ad.
        multiCategory: Object.keys(categoryBreakdown).length > 1,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        sampleTitles: r.sample_titles ? r.sample_titles.split('||') : [],
      };
    });

    res.json({ days, minCount, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/advertiser/:phone — admin-only, one number's full history ──
// Drill-down for the Repeat Advertisers panel: given one phone number,
// return every ad they've ever posted (all-time, not windowed), so an
// admin can see exactly how many times "this specific person" has run
// classifieds and what they were about before making an outreach call.
app.get('/admin/advertiser/:phone', requireAdmin, async (req, res) => {
  try {
    const phone = String(req.params.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid Indian mobile number' });
    }
    const [rows] = await db.query(`
      SELECT id, category, sub_category, title, location, price,
             date_published, day_published, source
      FROM classified_ads
      WHERE newspaper_name = 'Deccan Chronicle'
        AND RIGHT(phone, 10) = ?
      ORDER BY date_published DESC
    `, [phone]);

    // Per-category breakdown for this one number — e.g. {Property: 5,
    // Matrimonial: 2} — so it's immediately clear if the same person is
    // running ads across genuinely different categories (a stronger
    // outreach signal than just "10 ads, all the same listing").
    const categoryBreakdown = {};
    rows.forEach(r => {
      categoryBreakdown[r.category] = (categoryBreakdown[r.category] || 0) + 1;
    });

    res.json({
      phone,
      totalAds: rows.length,
      categoryBreakdown,
      multiCategory: Object.keys(categoryBreakdown).length > 1,
      firstSeen: rows.length ? rows[rows.length - 1].date_published : null,
      lastSeen:  rows.length ? rows[0].date_published : null,
      ads: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// FIX: uses IST today, no longer passes UTC date
app.get('/scrape', async (req, res) => {
  const date = req.query.date || todayIST();
  res.json({ message: `Scraping ${date}…`, status: 'started' });
  scrapeAndSave(date, date)
    .then(r => console.log('[SCRAPE]', r))
    .catch(e => console.error('[SCRAPE]', e.message));
});

// ── GET /scrape/week ───────────────────────────────────────────────────────
// FIX: uses scrapeCurrentWeek() — always Mon→today in IST, includes Sunday
app.get('/scrape/week', async (req, res) => {
  res.json({ message: 'Scraping full week (Mon → today IST)…', status: 'started' });
  scrapeCurrentWeek()
    .then(r => console.log('[SCRAPE/WEEK]', r))
    .catch(e => console.error('[SCRAPE/WEEK]', e.message));
});

// ── POST /upload-pdf ───────────────────────────────────────────────────────
app.post('/upload-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const result = await parsePdfAndSave(req.file.buffer);
  res.json(result);
});

// ── POST /upload-image — NEW: manual classifieds photo/screenshot upload ──
// For when the automated epaper scrape misses a page (resolution issues,
// page-numbering drift, etc.) — a person can instead upload a clean photo
// or screenshot of just the classifieds section directly. Runs the same
// Groq vision extraction/verification pipeline as the scraper, tagged
// source='pdf' (matches the classified_ads.source ENUM already in use for
// non-scraper, non-seller ads).
//
// multer here uses memoryStorage (req.file.buffer, not req.file.path), but
// dc_scraper's Groq calls read from a file path — so we bridge by writing
// the buffer to a short-lived temp file, then clean it up afterward.
//
// form-data fields:
//   image  — the file (required)
//   date   — YYYY-MM-DD (optional, defaults to today IST)
app.post('/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const targetDate = req.body.date ? new Date(req.body.date) : new Date(todayIST());
  const ext        = path.extname(req.file.originalname || '') || '.jpg';
  const tmpPath     = path.join(os.tmpdir(), `upload_${Date.now()}${ext}`);

  try {
    fs.writeFileSync(tmpPath, req.file.buffer);
    const result = await processAndSaveUploadedImage(tmpPath, targetDate);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[Upload] Failed:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(tmpPath, () => {}); // best-effort temp file cleanup
  }
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

startServer(Number(process.env.PORT) || 8080);
initDB().catch(e => console.error('[DB] Fatal after all retries:', e.code, e.message));
