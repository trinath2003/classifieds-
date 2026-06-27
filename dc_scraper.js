// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
require('dotenv').config();
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const mysql     = require('mysql2/promise');
const https     = require('https');
const http      = require('http');
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

// ── FIX 1: IST-aware date helpers ─────────────────────────────────────────
// Railway runs UTC. Without offset, late-night IST runs build wrong dates.
function toIST(d) {
  return new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000);
}
function isoDate(d)  { return toIST(d).toISOString().slice(0, 10); }
function dayName(d)  {
  return toIST(d).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
}

// ── FIX 2: Download image directly instead of Puppeteer screenshot ─────────
// page.goto(imageUrl) + page.screenshot() captures the BROWSER WINDOW
// (with chrome, padding, scaling) — OCR on that gives garbage like
// "ALLL UVILANAN". Downloading the raw file gives clean pixel-perfect input.
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Referer': EPAPER_URL,
    }}, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch (_) {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error',  reject);
    }).on('error', reject);
  });
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

// ── FIX 3: OCR-tolerant phone extraction ──────────────────────────────────
// Tesseract substitutes: 0→O/o, 6→G/g, 9→q/Q, 8→B/b
function extractPhone(text) {
  const m = text.match(/(?:\+91[-\s]?)?[6-9GoOqQBb][0-9GoOqQBb]{9}/);
  if (!m) return '';
  const fixed = m[0]
    .replace(/[Oo]/g, '0').replace(/[Gg]/g, '6')
    .replace(/[qQ]/g, '9').replace(/[Bb]/g, '8')
    .replace(/\D/g, '');
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
  const ads       = [];
  const lines     = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
  const today     = isoDate(publishDate);
  const dayPub    = dayName(publishDate);
  const SECTION_RE = /^[A-Z][A-Z\s\/&\-]{4,}$/;
  let currentSection = 'CLASSIFIEDS';
  let block = [];

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    // FIX 4: No hard phone gate — keep ads even if phone OCR failed
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
    } catch (e) { console.error('[DC] Row error:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── FIX 5: Discover real image URLs from the live epaper DOM ──────────────
// Instead of guessing URL patterns, we let Puppeteer load the page and
// extract whatever image src the site actually uses for each page.
async function discoverPageImageUrls(page, targetDate) {
  const dateStr = isoDate(targetDate);
  console.log(`[DC] Discovering image URLs for ${dateStr}…`);

  await page.goto(EPAPER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(3000);

  // Try selecting Hyderabad edition
  try {
    await page.select('select', 'Hyderabad');
    await delay(2000);
  } catch (_) {}

  // Select date if not today
  const todayStr = isoDate(new Date());
  if (dateStr !== todayStr) {
    const ist      = toIST(targetDate);
    const label    = ist.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    console.log(`[DC] Selecting date label: "${label}"`);
    try {
      const ok = await page.evaluate((lbl) => {
        for (const sel of document.querySelectorAll('select')) {
          const opt = [...sel.options].find(o => o.text.includes(lbl));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); return true; }
        }
        return false;
      }, label);
      if (ok) {
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }),
          delay(12000),
        ]);
        await delay(2000);
      }
    } catch (_) {}
  }

  // Click Thumbnails to reveal all page labels
  try {
    await page.evaluate(() => {
      if (typeof __doPostBack === 'function') __doPostBack('btn_thumbnails', '');
    });
    await delay(4000);
  } catch (_) {}

  // Grab every img src from the page that looks like a newspaper page image
  const allImgSrcs = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .map(i => i.src)
      .filter(s => s && (s.includes('.jpg') || s.includes('.png') || s.includes('Page')) &&
                   !s.includes('logo') && !s.includes('icon') &&
                   !s.includes('fb.') && !s.includes('tw.'))
  );

  // Find the CLASSIFIEDS page number from thumbnail labels
  const classifiedsPageNum = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim().toUpperCase();
      const m = t.match(/CLASSIFIEDS\((\d+)\)/);
      if (m) return parseInt(m[1]);
    }
    // Also check element text
    for (const el of document.querySelectorAll('*')) {
      const t = el.textContent.trim().toUpperCase();
      if (t.startsWith('CLASSIFIEDS(') && t.length < 25) {
        const m = t.match(/\((\d+)\)/);
        if (m) return parseInt(m[1]);
      }
    }
    return null;
  });

  console.log(`[DC] CLASSIFIEDS page number from DOM: ${classifiedsPageNum}`);
  console.log(`[DC] All img srcs found (${allImgSrcs.length}):`, allImgSrcs.slice(0, 8));

  return { classifiedsPageNum, allImgSrcs };
}

// ── Core: scrape one date ──────────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr        = isoDate(targetDate);
  const [yyyy, mm, dd] = dateStr.split('-');
  console.log(`\n[DC] ══ Scraping ${dateStr} ══`);

  const { classifiedsPageNum, allImgSrcs } = await discoverPageImageUrls(page, targetDate);

  // Build candidate URLs from known DC patterns + any DOM-discovered URLs
  // FIX 6: Expanded page range — DC Hyd classifieds can be on pages 8-20
  const pagesToTry = classifiedsPageNum
    ? [classifiedsPageNum, classifiedsPageNum + 1]
    : [8,9,10,11,12,13,14,15,16,17,18,19,20];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  for (const pgNum of pagesToTry) {
    // Prefer any URL already discovered in DOM for this page number
    const domUrl = allImgSrcs.find(u =>
      new RegExp(`[/_]${pgNum}[._]`).test(u) || u.endsWith(`/${pgNum}.jpg`) || u.endsWith(`/${pgNum}.png`)
    );

    const candidateUrls = [
      ...(domUrl ? [domUrl] : []),
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${String(pgNum).padStart(2,'0')}.jpg`,
    ];

    let fetched = false;
    for (const url of candidateUrls) {
      const imgPath = path.join(tmpDir, `page_${pgNum}.jpg`);
      try {
        console.log(`[DC] Downloading: ${url}`);
        // ── THE KEY FIX: download the raw image file, don't screenshot a browser ──
        await downloadFile(url, imgPath);
        const stat = fs.statSync(imgPath);
        console.log(`[DC] ✓ Downloaded page ${pgNum} (${(stat.size/1024).toFixed(0)} KB) from ${url}`);

        if (stat.size < 5000) {
          console.log(`[DC] File too small (${stat.size} bytes) — likely an error page, skipping`);
          fs.unlinkSync(imgPath);
          continue;
        }

        // OCR the raw downloaded image — clean pixels, no browser chrome
        const { data } = await Tesseract.recognize(imgPath, 'eng', {
          logger: () => {},
          tessedit_pageseg_mode: '1',
        });
        const ocrText = data.text;

        console.log(`[DC] OCR page ${pgNum} preview:\n  ${ocrText.slice(0, 400).replace(/\n/g, '\n  ')}`);
        console.log(`[DC] OCR total chars: ${ocrText.length}`);

        // Only parse pages that actually contain classifieds content
        const looksLikeClassifieds =
          /classif|property|matrimon|job|automotive|wanted|required|rent|sale|flat|bhk|bride|groom/i.test(ocrText);
        if (!looksLikeClassifieds && !classifiedsPageNum) {
          console.log(`[DC] Page ${pgNum} doesn't look like classifieds — skipping`);
          fs.unlinkSync(imgPath);
          fetched = true; // mark as fetched so we don't do viewer fallback
          break;
        }

        const parsed = parseAdsFromText(ocrText, targetDate);
        console.log(`[DC] Page ${pgNum}: parsed ${parsed.length} ads`);
        allAds.push(...parsed);
        try { fs.unlinkSync(imgPath); } catch (_) {}
        fetched = true;
        break;
      } catch (e) {
        console.log(`[DC] Failed (${e.message.slice(0, 60)}): ${url}`);
        try { fs.unlinkSync(imgPath); } catch (_) {}
      }
    }

    if (!fetched) {
      console.log(`[DC] All URLs failed for page ${pgNum}`);
    }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  // Deduplicate
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
      } catch (err) {
        console.error(`[DC] ✗ Error on ${isoDate(date)}: ${err.message}`);
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
