// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// Strategy: epaper_main.aspx → Thumbnails → find CLASSIFIEDS label → OCR
require('dotenv').config();
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const mysql     = require('mysql2/promise');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const NEWSPAPER  = 'Deccan Chronicle';
const EPAPER_URL = 'http://epaper.deccanchronicle.com/epaper_main.aspx';

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

// ── FIX #1: Use IST (UTC+5:30) for all date strings ───────────────────────
// Railway runs in UTC. Without this, dates after 6:30 PM IST roll over to
// the next UTC date, so "today" builds the wrong image URL.
function isoDate(d) {
  const dt     = new Date(d);
  const IST_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30
  return new Date(dt.getTime() + IST_MS).toISOString().slice(0, 10);
}

function dayName(d) {
  const dt     = new Date(d);
  const IST_MS = 5.5 * 60 * 60 * 1000;
  return new Date(dt.getTime() + IST_MS)
    .toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
}

// ── Category helpers ───────────────────────────────────────────────────────
function normalizeCategory(text) {
  const t = text.toUpperCase();
  if (/(AUTOMOTIVE|CAR|BIKE|VEHICLE|FOUR.?WHEELER|SUV|MOTORCYCLE|SCOOTER)/.test(t)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|SHADI|ALLIANCE|MATCH\s+SOUGHT)/.test(t))            return 'Matrimonial';
  if (/(JOB|JOBS|VACANCY|VACANT|HIRING|REQUIRED|RECRUIT|WANTED|CAREER|OPENING|TEACHER|DRIVER|MANAGER)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|HOSTEL|PG\b|PAYING GUEST|PLOT|FLAT|HOUSE|LAND|VILLA|APARTMENT|SHOP|BHK|SQFT)/.test(t)) return 'Property';
  return 'Other';
}

function normalizeSubCategory(category, text) {
  const lower = text.toLowerCase();
  if (category === 'Property') {
    if (lower.includes('rent') || lower.includes('lease'))                               return 'For Rent';
    if (lower.includes('pg') || lower.includes('hostel') || lower.includes('paying guest')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category === 'Automotive')  return 'Used vehicle';
  if (category === 'Jobs')        return lower.includes('part') ? 'Part-time' : 'Full-time';
  if (category === 'Matrimonial') {
    if (lower.includes('bride') || lower.includes('girl')) return 'Bride Sought';
    if (lower.includes('groom') || lower.includes('boy'))  return 'Groom Sought';
    return 'Alliance';
  }
  return 'General';
}

// ── FIX #2: OCR-tolerant phone extraction ─────────────────────────────────
// Tesseract commonly substitutes: 0→O/o, 6→G, 9→q/Q, 8→B
// We broaden the character class then correct known substitutions.
function extractPhone(text) {
  const m = text.match(/(?:\+91[-\s]?)?[6-9GoOqQBb]\d{8,9}/);
  if (!m) return '';
  const corrected = m[0]
    .replace(/[Oo]/g, '0')
    .replace(/[Gg]/g, '6')
    .replace(/[qQ]/g, '9')
    .replace(/[Bb]/g, '8')
    .replace(/\D/g, '');
  return corrected.length >= 10 ? corrected.slice(-10) : '';
}

function extractPrice(text) {
  let m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*Cr(?:ore)?/i); if (m) return `₹${m[1].trim()} Cr`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*L(?:akh)?\b/i);   if (m) return `₹${m[1].trim()} L`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]{4,})/);                 if (m) return `₹${m[1]}`;
  return 'Not mentioned';
}

function extractSize(text) {
  let m = text.match(/([\d,]+)\s*sq\.?\s*(?:ft|feet)/i); if (m) return `${m[1]} sq ft`;
  m = text.match(/(\d)\s*BHK/i);                         if (m) return `${m[1]} BHK`;
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

// ── Parse OCR text into ads ────────────────────────────────────────────────
function parseAdsFromText(ocrText, publishDate) {
  const ads    = [];
  const lines  = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);
  const SECTION_RE = /^[A-Z][A-Z\s\/&\-]{4,}$/;
  let currentSection = 'CLASSIFIEDS';
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();

    // ── FIX #3: Removed hard phone gate ───────────────────────────────────
    // Previously any ad without a phone was silently dropped, including ads
    // where OCR misread digits. Now we keep the ad with phone = '' so it
    // still appears in the UI (shown as "N/A"). Only skip truly tiny fragments.
    if (text.length < 15) { block = []; return; }

    const phone        = extractPhone(text);
    const category     = normalizeCategory(currentSection + ' ' + text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);

    ads.push({
      date_published: today,
      day_published:  dayPub,
      category,
      sub_category,
      title:       block[0].slice(0, 120).trim(),
      description: text,
      location:    extractLocation(text),
      price:       extractPrice(text),
      size_area:   extractSize(text),
      phone,                        // may be '' — that's fine
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
        ad.phone, '', '', ad.newspaper_name,
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch (e) {
      console.error('[DC] Row error:', e.message);
      skipped++;
    }
  }
  return { inserted, skipped };
}

// ── Core: navigate to classifieds page image and OCR it ───────────────────
async function scrapeDate(page, targetDate) {
  const dateStr = isoDate(targetDate);
  console.log(`\n[DC] ── Scraping ${dateStr} ──`);

  // 1. Load the e-paper main page
  await page.goto(EPAPER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delay(2000);

  // 2. Select edition: Hyderabad
  try {
    await page.select('select[name*="ddl"], select[id*="ddl"], select[id*="Edition"], select', 'Hyderabad');
    await delay(1500);
  } catch (_) { console.log('[DC] Edition select skipped'); }

  // 3. Select date if not today (in IST)
  const todayStr = isoDate(new Date());
  if (dateStr !== todayStr) {
    const shortLabel = new Date(
      new Date(targetDate).getTime() + 5.5 * 60 * 60 * 1000
    ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`[DC] Selecting date: ${shortLabel}`);
    try {
      const selected = await page.evaluate((label) => {
        const selects = [...document.querySelectorAll('select')];
        for (const sel of selects) {
          const opts  = [...sel.options];
          const match = opts.find(o => o.text.includes(label));
          if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change')); return true; }
        }
        return false;
      }, shortLabel);
      if (selected) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
          delay(10000),
        ]);
        await delay(2000);
      }
    } catch (_) {}
  }

  // 4. Click "Thumbnails" tab
  console.log('[DC] Clicking Thumbnails…');
  try {
    await page.evaluate(() => {
      if (typeof __doPostBack === 'function') __doPostBack('btn_thumbnails', '');
    });
    await delay(3000);
  } catch (_) {}

  // 5. Find CLASSIFIEDS page number from thumbnail labels
  const classifiedsInfo = await page.evaluate(() => {
    const results = [];
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const t = el.textContent.trim().toUpperCase();
      if (t.startsWith('CLASSIFIEDS') && t.includes('(') && t.length < 30) {
        const m = t.match(/CLASSIFIEDS\((\d+)\)/);
        if (m) results.push({ label: t, page: parseInt(m[1]), tag: el.tagName });
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim().toUpperCase();
      if (t.includes('CLASSIFIEDS') && t.includes('(')) {
        const m = t.match(/CLASSIFIEDS\((\d+)\)/);
        if (m) results.push({ label: t, page: parseInt(m[1]), tag: 'TEXT' });
      }
    }
    return results;
  });

  console.log('[DC] Classifieds info found:', JSON.stringify(classifiedsInfo));

  // 6. Click on the CLASSIFIEDS thumbnail
  let classifiedsPageNum = null;
  if (classifiedsInfo.length > 0) {
    classifiedsPageNum = classifiedsInfo[0].page;
    console.log(`[DC] Classifieds is page ${classifiedsPageNum} — clicking it`);

    const clicked = await page.evaluate((pageNum) => {
      const all = [...document.querySelectorAll('img, div, td, li, a, span')];
      for (const el of all) {
        const t = el.textContent.trim().toUpperCase();
        if (t === `CLASSIFIEDS(${pageNum})` || t === 'CLASSIFIEDS') {
          const parent = el.closest('a, td, div, li') || el;
          parent.click();
          return true;
        }
      }
      if (typeof __doPostBack === 'function') {
        const attempts = [
          ['lnk_page_' + pageNum, ''],
          ['lnkPage' + pageNum, ''],
          ['GridView1', 'Page$' + pageNum],
        ];
        for (const [t, a] of attempts) {
          try { __doPostBack(t, a); return 'postback'; } catch (_) {}
        }
      }
      return false;
    }, classifiedsPageNum);

    console.log(`[DC] Thumbnail click result: ${clicked}`);
    await delay(4000);
  } else {
    console.log('[DC] Could not find CLASSIFIEDS thumbnail — will use URL pattern fallback');
  }

  // 7. Collect any DOM image URLs
  const imgUrls = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    return imgs
      .map(img => img.src)
      .filter(src =>
        src && (
          src.includes('PageImages') || src.includes('pageimage') ||
          src.includes('HYD') || src.includes('.jpg') || src.includes('.png')
        ) && !src.includes('logo') && !src.includes('icon') &&
        !src.includes('fb.') && !src.includes('tw.') && !src.includes('in.')
      );
  });
  console.log('[DC] Page image URLs found in DOM:', imgUrls.slice(0, 5));

  // 8. Build date parts from the IST date string (avoids UTC rollover)
  const [yyyy, mm, dd] = dateStr.split('-');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  // ── FIX #4: Expanded fallback page range ──────────────────────────────
  // DC Hyderabad classifieds can appear anywhere on pages 8-20 depending on
  // the day. The old range of 8-12 missed it on many editions.
  const pagesToTry = classifiedsPageNum
    ? [classifiedsPageNum, classifiedsPageNum + 1]
    : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

  for (const pgNum of pagesToTry) {
    const candidateUrls = [
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
    ];

    // Prefer DOM URL if present for this page number
    const domUrl = imgUrls.find(u => u.includes(`/${pgNum}.`) || u.includes(`_${pgNum}.`));
    if (domUrl) candidateUrls.unshift(domUrl);

    let fetched = false;
    for (const url of candidateUrls) {
      try {
        console.log(`[DC] Trying image URL: ${url}`);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (resp && resp.ok()) {
          const screenshotPath = path.join(tmpDir, `page_${pgNum}.png`);
          await page.screenshot({ path: screenshotPath });
          console.log(`[DC] ✓ Got image for page ${pgNum} from ${url}`);

          const { data } = await Tesseract.recognize(screenshotPath, 'eng', {
            logger: () => {},
            tessedit_pageseg_mode: '1',
          });
          const ocrText = data.text;

          // ── Debug log: always print OCR preview to Railway logs ──────────
          console.log(`[DC] OCR page ${pgNum} preview (500 chars):\n${ocrText.slice(0, 500).replace(/\n/g, ' ')}`);
          console.log(`[DC] OCR page ${pgNum} total lines: ${ocrText.split('\n').filter(l => l.trim()).length}`);

          const parsed = parseAdsFromText(ocrText, targetDate);
          console.log(`[DC] Page ${pgNum}: ${parsed.length} ads parsed`);
          allAds.push(...parsed);
          try { fs.unlinkSync(screenshotPath); } catch (_) {}
          fetched = true;
          break;
        }
      } catch (e) {
        console.log(`[DC] URL failed (${e.message.slice(0, 50)}): ${url}`);
      }
    }

    // Viewer screenshot fallback
    if (!fetched) {
      console.log(`[DC] Direct URL failed for page ${pgNum} — using viewer screenshot`);
      await page.goto(EPAPER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await delay(2000);
      await page.evaluate(() => {
        if (typeof __doPostBack === 'function') __doPostBack('btn_thumbnails', '');
      });
      await delay(2000);

      await page.evaluate((pn) => {
        const all = [...document.querySelectorAll('img, td, div, li')];
        const label = all.find(el => el.textContent.trim().toUpperCase().includes(`(${pn})`));
        if (label) { (label.closest('a,td,div') || label).click(); return; }
        if (typeof __doPostBack === 'function') {
          try { __doPostBack('lnk_page_' + pn, ''); } catch (_) {}
        }
      }, pgNum);
      await delay(4000);

      const screenshotPath = path.join(tmpDir, `viewer_${pgNum}.png`);
      try {
        const imgEl = await page.$('#imgPage, #pageImage, .page-image, img[id*="Page"], img[id*="page"]');
        if (imgEl) {
          await imgEl.screenshot({ path: screenshotPath });
        } else {
          await page.screenshot({ path: screenshotPath, clip: { x: 150, y: 100, width: 1000, height: 750 } });
        }
        const { data } = await Tesseract.recognize(screenshotPath, 'eng', { logger: () => {} });

        // ── Debug log for viewer fallback ────────────────────────────────
        console.log(`[DC] Viewer OCR page ${pgNum} preview:\n${data.text.slice(0, 300).replace(/\n/g, ' ')}`);

        const parsed = parseAdsFromText(data.text, targetDate);
        console.log(`[DC] Viewer screenshot page ${pgNum}: ${parsed.length} ads`);
        allAds.push(...parsed);
        try { fs.unlinkSync(screenshotPath); } catch (_) {}
      } catch (e) {
        console.log(`[DC] Viewer screenshot failed for page ${pgNum}: ${e.message}`);
      }
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  // Deduplicate by title + phone
  const seen   = new Set();
  const unique = allAds.filter(ad => {
    const key = `${ad.title}|${ad.phone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[DC] Total unique ads for ${dateStr}: ${unique.length}`);
  return unique;
}

// ── Main ───────────────────────────────────────────────────────────────────
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
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1400,900',
    ],
  });

  const summary = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    for (const date of dates) {
      try {
        const ads    = await scrapeDate(page, date);
        const result = await saveAds(ads, date);
        console.log(`[DC] ✓ ${isoDate(date)}: inserted=${result.inserted} skipped=${result.skipped} total=${ads.length}`);
        summary.push({ date: isoDate(date), day: dayName(date), ...result, total: ads.length });
      } catch (err) {
        console.error(`[DC] Error on ${isoDate(date)}: ${err.message}`);
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
