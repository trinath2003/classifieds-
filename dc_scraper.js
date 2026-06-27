// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// Navigation: states.aspx → HYDERABAD → Thumbnails → Select Date → Page 8 (CLASSIFIEDS)
require('dotenv').config();
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const mysql     = require('mysql2/promise');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const NEWSPAPER   = 'Deccan Chronicle';
const STATES_URL  = 'http://epaper.deccanchronicle.com/states.aspx';
const CLASSIFIEDS_PAGE = 8; // Always page 8 for Hyderabad edition

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

// ── IST-aware date helpers ─────────────────────────────────────────────────
function toIST(d)   { return new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000); }
function isoDate(d) { return toIST(d).toISOString().slice(0, 10); }
function dayName(d) {
  return toIST(d).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
}

// ── Direct image download ──────────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Referer':    STATES_URL,
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); try { fs.unlinkSync(destPath); } catch(_) {}
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(destPath); } catch(_) {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error',  reject);
    }).on('error', reject);
  });
}

// ── Classifieds page validator ─────────────────────────────────────────────
// Real classifieds: many phone numbers, short ad blocks
// News pages: 0-1 phones, long prose paragraphs
function isClassifiedsPage(ocrText) {
  const phones     = (ocrText.match(/[6-9][0-9OoGgQqBb]{9}/g) || []).length;
  const lines      = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const shortLines = lines.filter(l => l.length > 5 && l.length < 80).length;
  const longLines  = lines.filter(l => l.length > 150).length;
  const score      = phones * 3 + shortLines - longLines * 2;
  console.log(`[DC] Page validator: phones=${phones} short=${shortLines} long=${longLines} score=${score}`);
  return score >= 8;
}

// ── Navigate to Hyderabad epaper and get the viewer URL ───────────────────
async function getViewerUrl(page) {
  console.log('[DC] Step 1: Loading states.aspx…');
  await page.goto(STATES_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  // Click HYDERABAD link under Telangana
  console.log('[DC] Step 2: Clicking HYDERABAD…');
  const clicked = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    const hyd = links.find(a => a.textContent.trim().toUpperCase() === 'HYDERABAD');
    if (hyd) { hyd.click(); return hyd.href; }
    return null;
  });

  if (!clicked) {
    // Fallback: try direct known viewer URL
    console.log('[DC] HYDERABAD link not found — trying direct viewer URL');
    return null;
  }

  console.log(`[DC] Clicked HYDERABAD → ${clicked}`);
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    delay(15000),
  ]);
  await delay(2000);

  const viewerUrl = page.url();
  console.log(`[DC] Viewer URL: ${viewerUrl}`);
  return viewerUrl;
}

// ── Select date in the viewer ──────────────────────────────────────────────
async function selectDate(page, targetDate) {
  const todayStr = isoDate(new Date());
  const dateStr  = isoDate(targetDate);
  if (dateStr === todayStr) {
    console.log('[DC] Target is today — no date selection needed');
    return;
  }

  const ist = toIST(targetDate);
  // DC date dropdown format: "Jun 27 ,2026" or "Jun 27, 2026"
  const month = ist.toLocaleDateString('en-US', { month: 'short' });      // "Jun"
  const day   = ist.getDate();                                              // 27
  const year  = ist.getFullYear();                                          // 2026

  console.log(`[DC] Step 3: Selecting date ${month} ${day}, ${year}…`);

  const selected = await page.evaluate((m, d, y) => {
    const selects = [...document.querySelectorAll('select')];
    for (const sel of selects) {
      const opts = [...sel.options];
      // Match patterns like "Jun 27 ,2026" or "Jun 27, 2026" or "Jun 27,2026"
      const opt = opts.find(o => {
        const t = o.text.replace(/\s+/g, ' ').trim();
        return t.startsWith(m) && t.includes(String(d)) && t.includes(String(y));
      });
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change'));
        return opt.text;
      }
    }
    return null;
  }, month, day, year);

  if (selected) {
    console.log(`[DC] Date selected: "${selected}"`);
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }),
      delay(12000),
    ]);
    await delay(3000);
  } else {
    console.log('[DC] Date option not found in dropdown — may already be on correct date');
  }
}

// ── Click Thumbnails tab ───────────────────────────────────────────────────
async function clickThumbnails(page) {
  console.log('[DC] Step 4: Clicking Thumbnails tab…');
  const clicked = await page.evaluate(() => {
    // Try clicking the Thumbnails nav item
    const els = [...document.querySelectorAll('a, button, span, li, td')];
    const thumb = els.find(el => /^thumbnails?$/i.test(el.textContent.trim()));
    if (thumb) { thumb.click(); return true; }
    // Try __doPostBack
    if (typeof __doPostBack === 'function') {
      try { __doPostBack('btn_thumbnails', ''); return 'postback'; } catch(_) {}
    }
    return false;
  });
  console.log(`[DC] Thumbnails click: ${clicked}`);
  await delay(3000);
}

// ── Get page 8 image URL from the live DOM ────────────────────────────────
async function getPageImageUrlFromDom(page, pgNum) {
  return page.evaluate((num) => {
    const imgs = [...document.querySelectorAll('img')];
    // Look for img src that contains the page number
    const match = imgs.find(img => {
      const s = img.src;
      return (s.includes('.jpg') || s.includes('.png')) &&
             (new RegExp(`[/_]0*${num}[._]`).test(s) || s.endsWith(`/${num}.jpg`));
    });
    return match ? match.src : null;
  }, pgNum);
}

// ── Core: scrape one date ──────────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr        = isoDate(targetDate);
  const [yyyy, mm, dd] = dateStr.split('-');
  console.log(`\n[DC] ══ Scraping ${dateStr} (${dayName(targetDate)}) ══`);

  // Navigate: states.aspx → HYDERABAD
  const viewerUrl = await getViewerUrl(page);

  // If navigation failed, fall back to known viewer URL
  if (!viewerUrl || viewerUrl === STATES_URL) {
    const fallback = 'http://epaper.deccanchronicle.com/epaper_main.aspx';
    console.log(`[DC] Navigating to fallback viewer: ${fallback}`);
    await page.goto(fallback, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
  }

  // Select the target date
  await selectDate(page, targetDate);

  // Click Thumbnails to reveal page strip
  await clickThumbnails(page);

  // Try to get the real image URL from DOM for page 8
  const domImgUrl = await getPageImageUrlFromDom(page, CLASSIFIEDS_PAGE);
  console.log(`[DC] DOM img URL for page ${CLASSIFIEDS_PAGE}: ${domImgUrl}`);

  // Build candidate URLs — known DC patterns for page 8
  const candidateUrls = [
    ...(domImgUrl ? [domImgUrl] : []),
    `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${CLASSIFIEDS_PAGE}.jpg`,
    `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${CLASSIFIEDS_PAGE}.jpg`,
    `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${CLASSIFIEDS_PAGE}.jpg`,
    `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${CLASSIFIEDS_PAGE}.jpg`,
    `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/0${CLASSIFIEDS_PAGE}.jpg`,
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  // Try page 8 and page 9 (classifieds sometimes spills to next page)
  for (const pgNum of [CLASSIFIEDS_PAGE, CLASSIFIEDS_PAGE + 1]) {
    const urls = pgNum === CLASSIFIEDS_PAGE
      ? candidateUrls
      : candidateUrls.map(u => u.replace(`/${CLASSIFIEDS_PAGE}.jpg`, `/${pgNum}.jpg`)
                                 .replace(`/0${CLASSIFIEDS_PAGE}.jpg`, `/${pgNum}.jpg`));

    const imgPath = path.join(tmpDir, `page_${pgNum}.jpg`);
    let downloaded = false;

    for (const url of urls) {
      try {
        console.log(`[DC] Downloading page ${pgNum}: ${url}`);
        await downloadFile(url, imgPath);
        const stat = fs.statSync(imgPath);
        if (stat.size < 5000) {
          console.log(`[DC] Too small (${stat.size}B) — not a real page image`);
          try { fs.unlinkSync(imgPath); } catch(_) {}
          continue;
        }
        console.log(`[DC] ✓ Page ${pgNum} downloaded (${(stat.size/1024).toFixed(0)} KB)`);
        downloaded = true;
        break;
      } catch(e) {
        console.log(`[DC] Failed: ${e.message.slice(0,60)}`);
        try { fs.unlinkSync(imgPath); } catch(_) {}
      }
    }

    if (!downloaded) {
      console.log(`[DC] Could not download page ${pgNum}`);
      continue;
    }

    // OCR the raw image
    console.log(`[DC] Running OCR on page ${pgNum}…`);
    const { data } = await Tesseract.recognize(imgPath, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode: '1',
    });
    const ocrText = data.text;
    try { fs.unlinkSync(imgPath); } catch(_) {}

    console.log(`[DC] Page ${pgNum} OCR preview:\n  "${ocrText.slice(0,300).replace(/\n/g,' ')}"`);

    // Validate it's actually a classifieds page
    if (!isClassifiedsPage(ocrText)) {
      console.log(`[DC] Page ${pgNum}: failed classifieds validation — skipping`);
      if (pgNum > CLASSIFIEDS_PAGE) break; // stop checking further pages
      continue;
    }

    console.log(`[DC] Page ${pgNum}: ✓ Classifieds confirmed`);
    const parsed = parseAdsFromText(ocrText, targetDate);
    console.log(`[DC] Page ${pgNum}: ${parsed.length} ads parsed`);
    allAds.push(...parsed);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}

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
function extractPhone(text) {
  const m = text.match(/(?:\+91[-\s]?)?[6-9GoOqQBb][0-9GoOqQBb]{9}/);
  if (!m) return '';
  const fixed = m[0]
    .replace(/[Oo]/g,'0').replace(/[Gg]/g,'6')
    .replace(/[qQ]/g,'9').replace(/[Bb]/g,'8')
    .replace(/\D/g,'');
  return fixed.length >= 10 ? fixed.slice(-10) : '';
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
  const ads        = [];
  const lines      = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const today      = isoDate(publishDate);
  const dayPub     = dayName(publishDate);
  const SECTION_RE = /^[A-Z][A-Z\s\/&\-]{4,}$/;
  let currentSection = 'CLASSIFIEDS';
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 20) { block = []; return; }
    const phone        = extractPhone(text);
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
        ad.phone, '', '', ad.newspaper_name,
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch(e) { console.error('[DC] Row error:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  const dates = [];
  const start = new Date(dateFrom || new Date());
  const end   = new Date(dateTo   || dateFrom || new Date());
  start.setHours(0,0,0,0); end.setHours(0,0,0,0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) dates.push(new Date(d));

  console.log(`[DC] Scraping ${dates.length} date(s): ${dates.map(isoDate).join(', ')}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1400,900'],
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
        console.log(`[DC] ✓ ${isoDate(date)}: inserted=${result.inserted} skipped=${result.skipped} total=${ads.length}`);
        summary.push({ date: isoDate(date), day: dayName(date), ...result, total: ads.length });
      } catch(err) {
        console.error(`[DC] ✗ ${isoDate(date)}: ${err.message}`);
        summary.push({ date: isoDate(date), error: err.message });
      }
    }
  } finally {
    await browser.close();
    if (require.main === module) { try { await db.end(); } catch(_) {} }
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
