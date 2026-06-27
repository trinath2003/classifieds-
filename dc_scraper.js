// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// Navigates states.aspx → Hyderabad → finds Classifieds pages → OCR
require('dotenv').config();
const puppeteer  = require('puppeteer');
const Tesseract  = require('tesseract.js');
const mysql      = require('mysql2/promise');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const NEWSPAPER   = 'Deccan Chronicle';
const STATES_URL  = 'http://epaper.deccanchronicle.com/states.aspx';

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── DB Pool ────────────────────────────────────────────────────────────────
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
function dayName(d)  { return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' }); }
function isoDate(d)  { return new Date(d).toISOString().slice(0, 10); }

const CLASSIFIED_KEYWORDS = [
  'matrimonial','property','jobs','recruitment','automotive',
  'for sale','for rent','wanted','vacancy','classifieds',
  'classified','pg ','hostel','alliance','bride','groom','bhk',
  'sqft','flat','plot','contact','phone'
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
  let m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*Cr(?:ore)?/i); if (m) return `₹${m[1].trim()} Cr`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*L(?:akh)?\b/i);   if (m) return `₹${m[1].trim()} L`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]{4,})/);                 if (m) return `₹${m[1]}`;
  return 'Not mentioned';
}
function extractSize(text) {
  let m = text.match(/([\d,]+)\s*sq\.?\s*(?:ft|feet)/i); if (m) return `${m[1]} sq ft`;
  m = text.match(/(\d)\s*BHK/i);                          if (m) return `${m[1]} BHK`;
  return 'Not mentioned';
}
const HYD_LOCALITIES = [
  'Jubilee Hills','Banjara Hills','Gachibowli','Madhapur','Hitech City','Kondapur',
  'Kukatpally','Miyapur','Ameerpet','Secunderabad','Begumpet','Somajiguda',
  'Masab Tank','Tolichowki','Mehdipatnam','LB Nagar','Dilsukhnagar','Uppal',
  'Kompally','Bachupally','Nizampet','Manikonda','Narsingi','Kokapet',
  'Nanakramguda','Raidurg','Shamshabad','Shamirpet','Patancheru','Sangareddy',
];
function extractLocation(text) {
  for (const loc of HYD_LOCALITIES) {
    if (text.toLowerCase().includes(loc.toLowerCase())) return `${loc}, Hyderabad`;
  }
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
    if (!phone && !/matrimonial|alliance|bride|groom/i.test(currentSection)) { block = []; return; }
    const category     = normalizeCategory(currentSection + ' ' + text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);
    ads.push({
      date_published: today, day_published: dayPub,
      category, sub_category,
      title:       block[0].slice(0, 120).trim(),
      description: text,
      location:    extractLocation(text),
      price:       extractPrice(text),
      size_area:   extractSize(text),
      phone,
      source: 'scraper', newspaper_name: NEWSPAPER,
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

// ── Save to DB ─────────────────────────────────────────────────────────────
async function saveAds(ads, publishDate) {
  if (!ads.length) return { inserted: 0, skipped: 0 };
  await db.query(
    `DELETE FROM classified_ads WHERE newspaper_name=? AND source='scraper' AND date_published=?`,
    [NEWSPAPER, isoDate(publishDate)]
  );
  let inserted = 0, skipped = 0;
  for (const ad of ads) {
    try {
      const [r] = await db.query(`
        INSERT IGNORE INTO classified_ads
          (date_published,day_published,category,sub_category,title,description,
           location,price,size_area,phone,whatsapp,email,source,status,newspaper_name,scraped_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'scraper','active',?,NOW())
      `, [
        ad.date_published, ad.day_published, ad.category, ad.sub_category,
        ad.title, ad.description, ad.location, ad.price, ad.size_area,
        ad.phone, '', '', ad.newspaper_name
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch (e) { console.error('[DC] Row error:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Navigate to date ───────────────────────────────────────────────────────
async function selectDate(page, targetDate) {
  const dateStr   = isoDate(targetDate);
  const shortLabel = new Date(targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // e.g. "Jun 27 ,2026"
  const fullLabel  = new Date(targetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                       .replace(',', ' ,');

  console.log(`[DC] Selecting date: ${dateStr} (looking for "${fullLabel}")`);

  // Try clicking in the date dropdown
  const clicked = await page.evaluate((short, full) => {
    const links = [...document.querySelectorAll('a, li, option, span')];
    const match = links.find(el => {
      const t = el.textContent.trim();
      return t.includes(short) || t.includes(full);
    });
    if (match) { match.click(); return true; }
    return false;
  }, shortLabel, fullLabel);

  if (clicked) {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
      delay(15000)
    ]);
    await delay(2000);
    console.log(`[DC] Date selected`);
  } else {
    console.log(`[DC] Date option not found — using current edition`);
  }
}

// ── Main scrape for one date ───────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr = isoDate(targetDate);
  console.log(`\n[DC] ── Scraping ${dateStr} (${dayName(targetDate)}) ──`);

  // Step 1: Go to states.aspx
  console.log('[DC] Loading states.aspx…');
  await page.goto(STATES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(2000);

  // Step 2: Click Hyderabad (__doPostBack('lnk_hyd',''))
  console.log('[DC] Clicking Hyderabad…');
  await page.evaluate(() => {
    if (typeof __doPostBack === 'function') __doPostBack('lnk_hyd', '');
  });
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    delay(20000)
  ]);
  await delay(3000);
  console.log('[DC] On Hyderabad edition. URL:', page.url());

  // Step 3: Select date if not today
  const todayStr = isoDate(new Date());
  if (dateStr !== todayStr) {
    await selectDate(page, targetDate);
  }

  // Step 4: Look for "Classifieds" in thumbnail strip or page list
  console.log('[DC] Looking for Classifieds thumbnail…');
  const classifiedsIdx = await page.evaluate(() => {
    // Look for thumbnail labels or page titles containing "classifieds"
    const thumbLabels = [...document.querySelectorAll(
      '[class*="thumb"] span, [class*="page"] span, [class*="title"], td, li, a'
    )];
    for (let i = 0; i < thumbLabels.length; i++) {
      const t = thumbLabels[i].textContent.toLowerCase();
      if (t.includes('classif') || t.includes('property') || t.includes('matrimon')) {
        return i;
      }
    }
    return -1;
  });

  console.log(`[DC] Classifieds thumbnail index: ${classifiedsIdx}`);

  // Step 5: Get total pages
  const totalPages = await page.evaluate(() => {
    // Try various page count selectors
    const selectors = [
      '[id*="total"]', '[class*="total"]', '#totalPages',
      '[id*="pageCount"]', '[class*="pagecount"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { const n = parseInt(el.textContent); if (n > 0) return n; }
    }
    // Count thumbnails
    const thumbs = document.querySelectorAll(
      '[class*="thumb"] img, [id*="thumb"], [class*="thumbnail"]'
    );
    if (thumbs.length > 0) return thumbs.length;
    return 24; // DC Hyderabad typically has ~20 pages
  });
  console.log(`[DC] Total pages: ${totalPages}`);

  // Step 6: Scan pages for classifieds
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];
  let classifiedPagesFound = 0;
  let consecutiveNonClassified = 0;

  // DC classifieds are usually in the last 4-8 pages — start from page 14 onwards
  const startPage = Math.max(1, totalPages - 10);
  console.log(`[DC] Starting scan from page ${startPage}`);

  for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
    console.log(`[DC] → Page ${pageNum}/${totalPages}`);

    // Navigate to this page
    const nav = await page.evaluate((pn) => {
      // Try thumbnail click
      const thumbs = [
        ...document.querySelectorAll('[class*="thumb"] a, [class*="thumb"] li, [id*="thumb_'+pn+'"]')
      ];
      if (thumbs[pn - 1]) { thumbs[pn - 1].click(); return 'thumb'; }

      // Try __doPostBack patterns used by DC
      if (typeof __doPostBack === 'function') {
        const attempts = [
          ['lnk_page_' + pn, ''],
          ['btn_page',        pn.toString()],
          ['GridView1',       'Page$' + pn],
          ['lnkPage' + pn,    ''],
        ];
        for (const [t, a] of attempts) {
          try { __doPostBack(t, a); return 'postback:' + t; } catch (_) {}
        }
      }

      // Try next page button
      const next = document.querySelector(
        '#lnk_next, #btn_next, [id*="next"], [class*="next"]'
      );
      if (next && pageNum > 1) { next.click(); return 'next'; }
      return null;
    }, pageNum);

    if (!nav && pageNum > startPage) {
      console.log(`[DC] Navigation failed at page ${pageNum} — stopping`);
      break;
    }

    await delay(4000); // wait for page image to load

    // Screenshot
    const screenshotPath = path.join(tmpDir, `page_${pageNum}.png`);
    try {
      // Try to get the main page image element
      const imgEl = await page.$(
        '#imgPage, #pageImage, .page-image, [id*="pageImg"], [class*="epaper-page"], ' +
        'img[src*="page"], img[src*="Page"], img[src*="HYD"], img[src*="hyd"]'
      );
      if (imgEl) {
        await imgEl.screenshot({ path: screenshotPath });
      } else {
        await page.screenshot({ path: screenshotPath, clip: { x: 200, y: 80, width: 900, height: 750 } });
      }
    } catch (e) {
      console.log(`[DC] Screenshot failed: ${e.message}`);
      pageNum++; continue;
    }

    // OCR
    let ocrText = '';
    try {
      const { data } = await Tesseract.recognize(screenshotPath, 'eng', {
        logger: () => {},
        tessedit_pageseg_mode: '1',
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,₹/-:@+() \n',
      });
      ocrText = data.text;
    } catch (e) {
      console.log(`[DC] OCR failed: ${e.message}`);
      continue;
    }

    if (looksLikeClassifiedsPage(ocrText)) {
      classifiedPagesFound++;
      consecutiveNonClassified = 0;
      console.log(`[DC] ✓ Page ${pageNum} = CLASSIFIEDS (#${classifiedPagesFound})`);
      const parsed = parseAdsFromText(ocrText, targetDate);
      console.log(`[DC]   → ${parsed.length} ads parsed`);
      allAds.push(...parsed);
    } else {
      consecutiveNonClassified++;
      console.log(`[DC] Page ${pageNum}: not classifieds (${ocrText.slice(0,60).replace(/\n/g,' ')}…)`);
      // If we already found classifieds and now 2 non-classifieds in a row — stop
      if (classifiedPagesFound > 0 && consecutiveNonClassified >= 2) {
        console.log('[DC] Classifieds section ended');
        break;
      }
    }

    try { fs.unlinkSync(screenshotPath); } catch (_) {}
  }

  // If still 0 ads, scan ALL pages from beginning (classifieds might be early)
  if (allAds.length === 0 && classifiedPagesFound === 0) {
    console.log('[DC] No ads found in last 10 pages — scanning from page 1');
    for (let pageNum = 1; pageNum < startPage; pageNum++) {
      console.log(`[DC] → Page ${pageNum}`);
      const nav = await page.evaluate((pn) => {
        const thumbs = [...document.querySelectorAll('[class*="thumb"] a, [class*="thumb"] li')];
        if (thumbs[pn - 1]) { thumbs[pn - 1].click(); return true; }
        if (typeof __doPostBack === 'function') {
          try { __doPostBack('lnk_page_' + pn, ''); return true; } catch (_) {}
        }
        const next = document.querySelector('#lnk_next, #btn_next, [id*="next"]');
        if (next) { next.click(); return true; }
        return false;
      }, pageNum);

      if (!nav && pageNum > 1) break;
      await delay(3500);

      const screenshotPath = path.join(tmpDir, `page_${pageNum}.png`);
      try {
        const imgEl = await page.$('#imgPage, #pageImage, .page-image, img[src*="page"]');
        if (imgEl) await imgEl.screenshot({ path: screenshotPath });
        else await page.screenshot({ path: screenshotPath, clip: { x: 200, y: 80, width: 900, height: 750 } });
      } catch (_) { continue; }

      let ocrText = '';
      try {
        const { data } = await Tesseract.recognize(screenshotPath, 'eng', { logger: () => {} });
        ocrText = data.text;
      } catch (_) { continue; }

      if (looksLikeClassifiedsPage(ocrText)) {
        classifiedPagesFound++;
        console.log(`[DC] ✓ Page ${pageNum} = CLASSIFIEDS`);
        allAds.push(...parseAdsFromText(ocrText, targetDate));
      }
      try { fs.unlinkSync(screenshotPath); } catch (_) {}
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(`[DC] Total for ${dateStr}: ${allAds.length} ads (${classifiedPagesFound} classifieds pages)`);

  // Deduplicate
  const seen = new Set();
  return allAds.filter(ad => {
    const key = `${ad.title}|${ad.phone}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  const dates = [];
  const start = new Date(dateFrom || new Date());
  const end   = new Date(dateTo   || dateFrom || new Date());
  start.setHours(0,0,0,0); end.setHours(0,0,0,0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) dates.push(new Date(d));

  console.log(`[DC] Scraping ${dates.length} date(s): ${dates.map(isoDate).join(', ')}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1400,900',
    ]
  });

  const summary = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    // Log browser console for debugging
    page.on('console', m => { if (m.type() === 'error') console.log('[Browser]', m.text()); });

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
    if (require.main === module) { try { await db.end(); } catch (_) {} }
  }

  console.log('\n[DC] ══ Scrape complete ══');
  console.table(summary);
  return summary;
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, arg1, arg2] = process.argv;
  scrapeAndSave(arg1, arg2)
    .then(() => process.exit(0))
    .catch(e => { console.error('[DC] Fatal:', e.message); process.exit(1); });
}

module.exports = scrapeAndSave;
