// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// ─────────────────────────────────────────────────────────────
// HOW IT WORKS:
//   1. Puppeteer opens epaper.deccanchronicle.com (no login needed)
//   2. Selects the Hyderabad edition + the target date
//   3. Navigates through all pages, finds the Classifieds section
//   4. Screenshots each classifieds page
//   5. Tesseract OCR reads text from each screenshot
//   6. Parser extracts individual ads from raw OCR text
//   7. Saves structured ads to MySQL classified_ads table
//
// INSTALL (run once):
//   npm install puppeteer tesseract.js mysql2 dotenv
//
// USAGE:
//   node dc_scraper.js                     ← scrapes today
//   node dc_scraper.js 2026-06-22          ← scrapes specific date
//   node dc_scraper.js 2026-06-18 2026-06-24  ← scrapes date range (full week)
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const puppeteer  = require('puppeteer');
const Tesseract  = require('tesseract.js');
const mysql      = require('mysql2/promise');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const NEWSPAPER  = 'Deccan Chronicle';
const EPAPER_URL = 'http://epaper.deccanchronicle.com/epaper_main.aspx';
const EDITION    = 'Hyderabad';  // change to Chennai, Vijayawada, Vizag etc. if needed

// ── DB Pool ────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host:             process.env.DB_HOST     || 'localhost',
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME     || 'newspaper_db',
  waitForConnections: true,
  connectionLimit:  10,
});

// ── Helpers ────────────────────────────────────────────────────────────────
function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Keywords that indicate a classifieds page
const CLASSIFIED_KEYWORDS = [
  'matrimonial', 'property', 'jobs', 'recruitment', 'automotive',
  'for sale', 'for rent', 'wanted', 'vacancy', 'classifieds',
  'classified', 'pg ', 'hostel', 'alliance', 'bride', 'groom'
];

function looksLikeClassifiedsPage(text) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of CLASSIFIED_KEYWORDS) {
    if (lower.includes(kw)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

// ── Text → Ad parser ──────────────────────────────────────────────────────
function normalizeCategory(text) {
  const t = text.toUpperCase();
  if (/(AUTOMOTIVE|CAR|BIKE|VEHICLE|FOUR.?WHEELER|SUV|MOTORCYCLE|SCOOTER|TWO.?WHEELER)/.test(t)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|SHADI|ALLIANCE|MATCH\s+SOUGHT)/.test(t))                         return 'Matrimonial';
  if (/(JOB|JOBS|VACANCY|VACANT|TEACHER|LECTURER|MANAGER|MEDICAL|WALK.IN|HIRING|REQUIRED|RECRUIT|WANTED|CAREER|OPENING)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|HOSTEL|PG\b|PAYING GUEST|PLOT|FLAT|HOUSE|LAND|VILLA|APARTMENT|COMMERCIAL|OFFICE|SHOP|BHK|SQFT)/.test(t)) return 'Property';
  return 'Other';
}

function normalizeSubCategory(category, text) {
  const lower = text.toLowerCase();
  if (category === 'Property') {
    if (lower.includes('rent') || lower.includes('lease'))                    return 'For Rent';
    if (lower.includes('pg') || lower.includes('hostel') || lower.includes('paying guest')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category === 'Automotive') return 'Used vehicle';
  if (category === 'Jobs')       return lower.includes('part') ? 'Part-time' : 'Full-time';
  if (category === 'Matrimonial') {
    if (lower.includes('bride') || lower.includes('girl'))   return 'Bride Sought';
    if (lower.includes('groom') || lower.includes('boy'))    return 'Groom Sought';
    return 'Alliance';
  }
  return 'General';
}

function extractPhone(text) {
  // Indian mobile: 10 digits starting with 6-9; also handles +91 prefix
  const m = text.match(/(?:\+91[-\s]?)?[6-9]\d{9}/);
  return m ? m[0].replace(/\D/g, '').slice(-10) : '';
}

function extractPrice(text) {
  let m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*Cr(?:ore)?/i);
  if (m) return `₹${m[1].trim()} Cr`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*L(?:akh)?\b/i);
  if (m) return `₹${m[1].trim()} L`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*[kK]?\s*(?:\/mo|\/month|per\s*month|p\.?m\.?)/i);
  if (m) return `₹${m[1].trim()}${/[kK]/.test(m[0]) ? 'k' : ''}/mo`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]{4,})/);
  if (m) return `₹${m[1]}`;
  return 'Not mentioned';
}

function extractSize(text) {
  let m = text.match(/([\d,]+)\s*sq\.?\s*(?:ft|feet)/i);
  if (m) return `${m[1]} sq ft`;
  m = text.match(/(\d)\s*BHK/i);
  if (m) return `${m[1]} BHK`;
  m = text.match(/([\d.]+)\s*acres?/i);
  if (m) return `${m[1]} acres`;
  m = text.match(/([\d.]+)\s*cents?/i);
  if (m) return `${m[1]} cents`;
  return 'Not mentioned';
}

const HYD_LOCALITIES = [
  'Jubilee Hills','Banjara Hills','Gachibowli','Madhapur','Hitech City','HITEC City',
  'Kondapur','Kukatpally','Miyapur','Ameerpet','Secunderabad','Begumpet','Somajiguda',
  'Masab Tank','Tolichowki','Mehdipatnam','LB Nagar','Dilsukhnagar','Uppal',
  'Kompally','Bachupally','Nizampet','Manikonda','Narsingi','Kokapet','Financial District',
  'Nanakramguda','Raidurg','Shamshabad','Shamirpet','Patancheru','Sangareddy',
  'Warangal','Nizamabad','Karimnagar','Khammam','Nalgonda',
  'Vijayawada','Visakhapatnam','Guntur'
];

function extractLocation(text) {
  for (const loc of HYD_LOCALITIES) {
    if (text.toLowerCase().includes(loc.toLowerCase())) return `${loc}, Hyderabad`;
  }
  let m = text.match(/near\s+([A-Z][a-zA-Z\s]+?)(?:[,.]|$)/);
  if (m) return m[1].trim();
  m = text.match(/(?:at|in)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),\s*([A-Z][a-zA-Z]+)/);
  if (m) return `${m[1]}, ${m[2]}`;
  return '';
}

/**
 * Splits OCR'd classifieds page text into individual ads.
 *
 * Strategy:
 *  - DC classifieds are separated by category headers in ALL CAPS
 *    (e.g. MATRIMONIAL, PROPERTY FOR SALE, JOBS & CAREER)
 *  - Within each section, individual ads are separated by blank lines
 *    or a phone number at the end of a block
 */
function parseAdsFromText(ocrText, publishDate) {
  const ads    = [];
  const lines  = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);

  // Section headers — ALL CAPS lines ≥5 chars with no digits
  const SECTION_RE = /^[A-Z][A-Z\s\/&]{4,}$/;
  let currentSection = '';
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 20) { block = []; return; } // too short — noise

    const phone = extractPhone(text);
    // Only save if there's a phone number (real ad) or section is matrimonial
    if (!phone && !/matrimonial|alliance|bride|groom/i.test(currentSection)) {
      block = [];
      return;
    }

    const category    = normalizeCategory(currentSection + ' ' + text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);
    const price       = extractPrice(text);
    const size_area   = extractSize(text);
    const location    = extractLocation(text);

    // First line of block = title (trim to 120 chars)
    const title = block[0].slice(0, 120).trim();

    ads.push({
      date_published: today,
      day_published:  dayPub,
      category,
      sub_category,
      title,
      description:    text,
      location,
      price,
      size_area,
      phone,
      source:         'scraper',
      newspaper_name: NEWSPAPER,
    });

    block = [];
  }

  for (const line of lines) {
    if (SECTION_RE.test(line) && line.length >= 5) {
      flushBlock();
      currentSection = line;
      continue;
    }
    // Blank separator — flush current ad block
    if (line === '' || line === '|') {
      flushBlock();
      continue;
    }
    block.push(line);
  }
  flushBlock(); // flush last block

  return ads;
}

// ── Save ads to MySQL ──────────────────────────────────────────────────────
async function saveAds(ads, publishDate) {
  if (!ads.length) return { inserted: 0, skipped: 0 };

  // Delete stale scraper rows for this date (so re-running is safe/idempotent)
  await db.query(`
    DELETE FROM classified_ads
    WHERE newspaper_name = ? AND source = 'scraper' AND date_published = ?
  `, [NEWSPAPER, isoDate(publishDate)]);

  let inserted = 0, skipped = 0;
  for (const ad of ads) {
    try {
      const [r] = await db.query(`
        INSERT IGNORE INTO classified_ads
          (date_published, day_published, category, sub_category,
           title, description, location, price, size_area, phone,
           whatsapp, email, source, status, newspaper_name, scraped_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NOW())
      `, [
        ad.date_published, ad.day_published,
        ad.category, ad.sub_category,
        ad.title, ad.description,
        ad.location, ad.price, ad.size_area,
        ad.phone, '', '', ad.source, ad.newspaper_name
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch (e) {
      console.error(`[DC] Row error: ${e.message}`);
      skipped++;
    }
  }
  return { inserted, skipped };
}

// ── Puppeteer: select edition & date, then walk pages ─────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr = isoDate(targetDate);
  console.log(`\n[DC] ── Scraping ${dateStr} (${dayName(targetDate)}) ──`);

  // Navigate to e-paper home
  await page.goto(EPAPER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Select edition via dropdown (uses __doPostBack)
  // The edition dropdown triggers a postback when changed
  try {
    await page.select('select[name*="edition"], select[id*="edition"], select[id*="Edition"]', EDITION);
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (_) {
    // Hyderabad is usually the default edition — continue if select fails
    console.log('[DC] Edition select skipped (may already be Hyderabad)');
  }

  // Select date — find the date dropdown and pick our date
  // DC e-paper shows last 7 days in the dropdown (format: "Jun 24 ,2026")
  const dateOptions = await page.$$eval(
    'select option, a[href*="date"], li[data-date]',
    els => els.map(e => ({ text: e.textContent.trim(), value: e.value || e.dataset.date || '' }))
  );

  // Format target to match DC's "Jun 22 ,2026" style
  const targetLabel = new Date(targetDate).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  }).replace(',', ' ,'); // "Jun 22 ,2026"

  const matchedOption = dateOptions.find(o =>
    o.text.includes(targetLabel) ||
    o.text.replace(/\s+/g, ' ').includes(new Date(targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
  );

  if (matchedOption) {
    // Try selecting by value in the date dropdown
    try {
      await page.select('select', matchedOption.value);
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
    } catch (_) {
      // Try clicking the matching list item
      const clicked = await page.evaluate((label) => {
        const links = [...document.querySelectorAll('a, li, option')];
        const match = links.find(el => el.textContent.includes(label));
        if (match) { match.click(); return true; }
        return false;
      }, new Date(targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      if (clicked) {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }
  } else {
    // Default to today — if target IS today, nothing to select
    if (dateStr !== isoDate(new Date())) {
      console.warn(`[DC] Could not find date option for ${dateStr} — defaulting to current edition`);
    }
  }

  // ── Walk all pages, screenshot classifieds pages, run OCR ────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];
  let pageNum  = 1;
  let classifiedPagesFound = 0;

  // Get total page count from thumbnail strip or page counter
  const totalPages = await page.evaluate(() => {
    const counter = document.querySelector('[class*="total"], [id*="total"], .page-count, #totalPages');
    if (counter) return parseInt(counter.textContent) || 20;
    const thumbs = document.querySelectorAll('[class*="thumb"], .thumbnail, [id*="thumb"]');
    return thumbs.length || 20;
  });

  console.log(`[DC] Edition has ~${totalPages} pages — scanning for Classifieds section`);

  while (pageNum <= Math.min(totalPages, 40)) { // cap at 40 pages safety
    console.log(`[DC] Checking page ${pageNum}/${totalPages}…`);

    // Try to navigate to specific page
    const navigated = await page.evaluate((pn) => {
      // Try clicking page number in thumbnail strip
      const thumbs = [...document.querySelectorAll('[class*="thumb"] a, .thumbnail, [id*="page_' + pn + '"]')];
      if (thumbs[pn - 1]) { thumbs[pn - 1].click(); return true; }
      // Try __doPostBack with page number
      if (typeof __doPostBack === 'function') {
        try { __doPostBack('page_' + pn, ''); return true; } catch (_) {}
        try { __doPostBack('btn_page', pn.toString()); return true; } catch (_) {}
      }
      // Try next-page button
      const next = document.querySelector('#btn_next, [id*="next"], [class*="next-page"]');
      if (next) { next.click(); return true; }
      return false;
    }, pageNum);

    if (!navigated && pageNum > 1) {
      console.log(`[DC] Can't navigate further — stopped at page ${pageNum}`);
      break;
    }

    await page.waitForTimeout(3000); // wait for page image to load

    // Take a screenshot of the page content area
    const screenshotPath = path.join(tmpDir, `page_${pageNum}.png`);
    const contentArea = await page.$('#pageImage, .page-image, [id*="pageImg"], img[src*="page"], .epaper-page');
    if (contentArea) {
      await contentArea.screenshot({ path: screenshotPath });
    } else {
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    // Quick OCR pass to detect if this is a classifieds page
    console.log(`[DC] OCR-ing page ${pageNum}…`);
    const { data: { text: quickText } } = await Tesseract.recognize(
      screenshotPath,
      'eng',
      {
        logger: () => {}, // suppress progress logs
        tessedit_pageseg_mode: '1', // automatic page segmentation
      }
    );

    if (looksLikeClassifiedsPage(quickText)) {
      classifiedPagesFound++;
      console.log(`[DC] ✓ Page ${pageNum} is CLASSIFIEDS (hit #${classifiedPagesFound})`);

      const parsed = parseAdsFromText(quickText, targetDate);
      console.log(`[DC]   → Parsed ${parsed.length} ads from page ${pageNum}`);
      allAds.push(...parsed);

      // If we've already found classifieds and now hit a non-classifieds page, stop
    } else if (classifiedPagesFound > 0) {
      console.log(`[DC] Page ${pageNum} is not classifieds — classifieds section ended`);
      break;
    } else {
      console.log(`[DC] Page ${pageNum}: not classifieds, continuing scan…`);
    }

    // Clean up screenshot to save disk
    try { fs.unlinkSync(screenshotPath); } catch (_) {}

    pageNum++;
  }

  // Cleanup tmp dir
  try { fs.rmdirSync(tmpDir, { recursive: true }); } catch (_) {}

  console.log(`[DC] Total ads parsed for ${dateStr}: ${allAds.length}`);

  // Deduplicate by title+phone within same day
  const seen = new Set();
  const unique = allAds.filter(ad => {
    const key = `${ad.title}|${ad.phone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[DC] After dedup: ${unique.length} unique ads`);
  return unique;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  // Build list of dates to scrape
  const dates = [];
  const start = new Date(dateFrom || new Date());
  const end   = new Date(dateTo   || dateFrom || new Date());
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d));
  }

  console.log(`[DC] Scraping ${dates.length} date(s): ${dates.map(isoDate).join(', ')}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1400,900'
    ]
  });

  const summary = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    // Set a real browser UA to avoid bot detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    for (const date of dates) {
      try {
        const ads    = await scrapeDate(page, date);
        const result = await saveAds(ads, date);
        console.log(`[DC] Saved ${result.inserted} ads for ${isoDate(date)} (${result.skipped} skipped/dupes)`);
        summary.push({ date: isoDate(date), day: dayName(date), ...result, total: ads.length });
      } catch (err) {
        console.error(`[DC] Error scraping ${isoDate(date)}:`, err.message);
        summary.push({ date: isoDate(date), error: err.message });
      }
    }
  } finally {
    await browser.close();
    await db.end();
  }

  console.log('\n[DC] ══ Scrape complete ══');
  console.table(summary);
  return summary;
}

// ── CLI entry point ────────────────────────────────────────────────────────
// Usage:
//   node dc_scraper.js                            ← today only
//   node dc_scraper.js 2026-06-22                 ← specific date
//   node dc_scraper.js 2026-06-18 2026-06-24      ← date range (full week)
if (require.main === module) {
  const [,, arg1, arg2] = process.argv;
  scrapeAndSave(arg1, arg2)
    .then(r => { console.log('[DC] Done:', r); process.exit(0); })
    .catch(e => { console.error('[DC] Fatal:', e); process.exit(1); });
}

module.exports = scrapeAndSave;
