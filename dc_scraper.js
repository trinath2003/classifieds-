// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
require('dotenv').config();
const puppeteer  = require('puppeteer');
const Tesseract  = require('tesseract.js');
const mysql      = require('mysql2/promise');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const NEWSPAPER  = 'Deccan Chronicle';
const EPAPER_URL = 'http://epaper.deccanchronicle.com/epaper_main.aspx';
const EDITION    = 'Hyderabad';

// Safe delay — page.waitForTimeout removed in Puppeteer v22+
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── DB Pool — respects MYSQL_URL (Railway) OR individual env vars (local) ──
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
    });

// ── Helpers ────────────────────────────────────────────────────────────────
function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}
function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

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
    if (lower.includes('rent') || lower.includes('lease'))                              return 'For Rent';
    if (lower.includes('pg') || lower.includes('hostel') || lower.includes('paying guest')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category === 'Automotive') return 'Used vehicle';
  if (category === 'Jobs')       return lower.includes('part') ? 'Part-time' : 'Full-time';
  if (category === 'Matrimonial') {
    if (lower.includes('bride') || lower.includes('girl')) return 'Bride Sought';
    if (lower.includes('groom') || lower.includes('boy'))  return 'Groom Sought';
    return 'Alliance';
  }
  return 'General';
}
function extractPhone(text) {
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

function parseAdsFromText(ocrText, publishDate) {
  const ads    = [];
  const lines  = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);
  const SECTION_RE = /^[A-Z][A-Z\s\/&]{4,}$/;
  let currentSection = '';
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 20) { block = []; return; }
    const phone = extractPhone(text);
    if (!phone && !/matrimonial|alliance|bride|groom/i.test(currentSection)) {
      block = []; return;
    }
    const category     = normalizeCategory(currentSection + ' ' + text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);
    ads.push({
      date_published: today,
      day_published:  dayPub,
      category,
      sub_category,
      title:          block[0].slice(0, 120).trim(),
      description:    text,
      location:       extractLocation(text),
      price:          extractPrice(text),
      size_area:      extractSize(text),
      phone,
      source:         'scraper',
      newspaper_name: NEWSPAPER,
    });
    block = [];
  }

  for (const line of lines) {
    if (SECTION_RE.test(line) && line.length >= 5) { flushBlock(); currentSection = line; continue; }
    if (line === '' || line === '|') { flushBlock(); continue; }
    block.push(line);
  }
  flushBlock();
  return ads;
}

// ── Save ads to MySQL ──────────────────────────────────────────────────────
async function saveAds(ads, publishDate) {
  if (!ads.length) return { inserted: 0, skipped: 0 };
  await db.query(
    `DELETE FROM classified_ads WHERE newspaper_name = ? AND source = 'scraper' AND date_published = ?`,
    [NEWSPAPER, isoDate(publishDate)]
  );
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

// ── Puppeteer scraper ─────────────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr = isoDate(targetDate);
  console.log(`\n[DC] ── Scraping ${dateStr} (${dayName(targetDate)}) ──`);

  try {
    await page.goto(EPAPER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    // domcontentloaded is enough if networkidle2 times out
    await page.goto(EPAPER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await delay(2000);

  // Select edition
  try {
    await page.select('select[name*="edition"], select[id*="edition"], select[id*="Edition"]', EDITION);
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      delay(15000)
    ]);
    await delay(1500);
  } catch (_) {
    console.log('[DC] Edition select skipped (Hyderabad is likely default)');
  }

  // Select date
  const dateOptions = await page.$$eval(
    'select option, a[href*="date"], li[data-date]',
    els => els.map(e => ({ text: e.textContent.trim(), value: e.value || e.dataset.date || '' }))
  );
  const shortLabel = new Date(targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const matchedOption = dateOptions.find(o => o.text.includes(shortLabel));
  if (matchedOption) {
    try {
      await page.select('select', matchedOption.value);
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        delay(15000)
      ]);
      await delay(2000);
    } catch (_) {
      await page.evaluate((label) => {
        const el = [...document.querySelectorAll('a, li, option')].find(e => e.textContent.includes(label));
        if (el) el.click();
      }, shortLabel);
      await delay(3000);
    }
  }

  // Walk pages
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];
  let pageNum = 1;
  let classifiedPagesFound = 0;

  const totalPages = await page.evaluate(() => {
    const counter = document.querySelector('[class*="total"], [id*="total"], .page-count, #totalPages');
    if (counter) return parseInt(counter.textContent) || 20;
    const thumbs = document.querySelectorAll('[class*="thumb"], .thumbnail, [id*="thumb"]');
    return thumbs.length || 20;
  });
  console.log(`[DC] ~${totalPages} pages — scanning for Classifieds`);

  while (pageNum <= Math.min(totalPages, 40)) {
    console.log(`[DC] Page ${pageNum}/${totalPages}…`);

    const navigated = await page.evaluate((pn) => {
      const thumbs = [...document.querySelectorAll('[class*="thumb"] a, .thumbnail')];
      if (thumbs[pn - 1]) { thumbs[pn - 1].click(); return true; }
      if (typeof __doPostBack === 'function') {
        try { __doPostBack('page_' + pn, ''); return true; } catch (_) {}
        try { __doPostBack('btn_page', pn.toString()); return true; } catch (_) {}
      }
      const next = document.querySelector('#btn_next, [id*="next"], [class*="next-page"]');
      if (next) { next.click(); return true; }
      return false;
    }, pageNum);

    if (!navigated && pageNum > 1) {
      console.log(`[DC] Navigation stopped at page ${pageNum}`);
      break;
    }

    await delay(3000);

    const screenshotPath = path.join(tmpDir, `page_${pageNum}.png`);
    try {
      const contentArea = await page.$('#pageImage, .page-image, [id*="pageImg"], img[src*="page"], .epaper-page');
      if (contentArea) {
        await contentArea.screenshot({ path: screenshotPath });
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: false });
      }
    } catch (e) {
      console.log(`[DC] Screenshot failed page ${pageNum}: ${e.message}`);
      pageNum++; continue;
    }

    let quickText = '';
    try {
      const { data } = await Tesseract.recognize(screenshotPath, 'eng', {
        logger: () => {},
        tessedit_pageseg_mode: '1',
      });
      quickText = data.text;
    } catch (e) {
      console.log(`[DC] OCR failed page ${pageNum}: ${e.message}`);
      pageNum++; continue;
    }

    if (looksLikeClassifiedsPage(quickText)) {
      classifiedPagesFound++;
      console.log(`[DC] ✓ Page ${pageNum} = CLASSIFIEDS (#${classifiedPagesFound})`);
      const parsed = parseAdsFromText(quickText, targetDate);
      console.log(`[DC]   → ${parsed.length} ads`);
      allAds.push(...parsed);
    } else if (classifiedPagesFound > 0) {
      console.log(`[DC] Classifieds section ended at page ${pageNum}`);
      break;
    } else {
      console.log(`[DC] Page ${pageNum}: not classifieds`);
    }

    try { fs.unlinkSync(screenshotPath); } catch (_) {}
    pageNum++;
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  console.log(`[DC] Total parsed for ${dateStr}: ${allAds.length}`);

  // Deduplicate
  const seen = new Set();
  return allAds.filter(ad => {
    const key = `${ad.title}|${ad.phone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
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
    headless: 'new',   // use 'new' headless mode (Puppeteer v21+)
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
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    for (const date of dates) {
      try {
        const ads    = await scrapeDate(page, date);
        const result = await saveAds(ads, date);
        console.log(`[DC] Saved ${result.inserted} for ${isoDate(date)} (${result.skipped} skipped)`);
        summary.push({ date: isoDate(date), day: dayName(date), ...result, total: ads.length });
      } catch (err) {
        console.error(`[DC] Error scraping ${isoDate(date)}: ${err.message}`);
        summary.push({ date: isoDate(date), error: err.message });
      }
    }
  } finally {
    await browser.close();
    if (require.main === module) {
      try { await db.end(); } catch (_) {}
    }
  }

  console.log('\n[DC] ══ Scrape complete ══');
  console.table(summary);
  return summary;
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, arg1, arg2] = process.argv;
  scrapeAndSave(arg1, arg2)
    .then(r => { console.log('[DC] Done:', r); process.exit(0); })
    .catch(e => { console.error('[DC] Fatal:', e); process.exit(1); });
}

module.exports = scrapeAndSave;
