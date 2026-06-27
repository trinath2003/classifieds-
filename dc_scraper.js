// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// Flow: states.aspx → HYDERABAD → date select → page 8 → split 5 cols → OCR each col
require('dotenv').config();
const puppeteer = require('puppeteer');
const Tesseract = require('tesseract.js');
const mysql     = require('mysql2/promise');
const https     = require('https');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const NEWSPAPER        = 'Deccan Chronicle';
const STATES_URL       = 'http://epaper.deccanchronicle.com/states.aspx';
const CLASSIFIEDS_PAGE = 8;
const NUM_COLUMNS      = 5;   // DC Hyderabad classifieds always 5 columns
const SCALE            = 3;   // 3× upscale so each column is ~450px wide for Tesseract

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

// ── IST date helpers ───────────────────────────────────────────────────────
function toIST(d)   { return new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000); }
function isoDate(d) { return toIST(d).toISOString().slice(0, 10); }
function dayName(d) {
  return toIST(d).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
}

// ── Download raw image ─────────────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(destPath);
    proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Referer': STATES_URL,
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

// ── THE CORE FIX: split image into columns, OCR each separately ───────────
//
// WHY: Tesseract reads a 5-column newspaper page left→right, row by row.
// Each "row" mixes text from all 5 columns → total garbage like:
//   "H muLnipLe vacancies SVK ENGINEERING. 8 Ifa Pv Lig | COMMERCIAL §"
//
// FIX: Crop each column, scale it 3×, OCR it alone with PSM 6 (single block).
// Each column then reads cleanly top→bottom within that column.
//
async function ocrByColumns(rawImagePath, browser, tmpDir) {
  const base64  = fs.readFileSync(rawImagePath).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  // Step 1: get natural image dimensions
  const dimPage = await browser.newPage();
  let dims;
  try {
    await dimPage.setContent(`<html><body style="margin:0;padding:0"><img id="i" src="${dataUrl}"></body></html>`);
    await dimPage.waitForSelector('#i');
    dims = await dimPage.$eval('#i', el => ({ w: el.naturalWidth, h: el.naturalHeight }));
    console.log(`[DC] Image natural size: ${dims.w}×${dims.h}px`);
  } finally {
    await dimPage.close();
  }

  const columnTexts = [];

  for (let col = 0; col < NUM_COLUMNS; col++) {
    const x = Math.floor(col       * dims.w / NUM_COLUMNS);
    const w = Math.floor((col + 1) * dims.w / NUM_COLUMNS) - x;
    const scaledW = w    * SCALE;
    const scaledH = dims.h * SCALE;

    const colPage = await browser.newPage();
    const colPath = path.join(tmpDir, `col_${col}.png`);

    try {
      // Render just this column at SCALE× by positioning the full image
      // with a negative left offset inside an overflow:hidden container
      await colPage.setViewport({ width: scaledW, height: scaledH });
      await colPage.setContent(`
        <html><head><style>
          * { margin:0; padding:0; }
          body { background:#fff; overflow:hidden; width:${scaledW}px; height:${scaledH}px; }
          img {
            position:absolute;
            left:${-x * SCALE}px;
            top:0;
            width:${dims.w * SCALE}px;
            height:auto;
            image-rendering:high-quality;
          }
        </style></head>
        <body><img src="${dataUrl}"></body>
      `);

      await colPage.waitForSelector('img');
      await delay(400); // let image paint

      await colPage.screenshot({ path: colPath });

      // PSM 6 = "assume single uniform block of text"
      // This is perfect for a single newspaper column read top-to-bottom
      const { data } = await Tesseract.recognize(colPath, 'eng', {
        logger: () => {},
        tessedit_pageseg_mode:    '6',
        tessedit_ocr_engine_mode: '1', // LSTM neural net
        preserve_interword_spaces: '1',
      });

      const preview = data.text.slice(0, 120).replace(/\n/g, ' ');
      console.log(`[DC] Col ${col + 1} OCR: "${preview}"`);
      columnTexts.push(data.text);

    } catch(e) {
      console.log(`[DC] Col ${col + 1} failed: ${e.message}`);
      columnTexts.push('');
    } finally {
      await colPage.close();
      try { fs.unlinkSync(colPath); } catch(_) {}
    }
  }

  // Join columns with a clear separator the parser uses to reset section context
  return columnTexts.join('\n\n===COLUMN_BREAK===\n\n');
}

// ── Known DC Hyderabad classifieds section headers ─────────────────────────
const DC_SECTIONS = new Set([
  'FOR SALE AUTOMOTIVE','FOUR WHEELERS','TWO WHEELERS',
  'FOR SALE PROPERTY','COMMERCIAL','MULTIPLE FLATS','INDEPENDENT HOUSE',
  'DOUBLE BEDROOM','THREE MORE','THREE & MORE','FARM HOUSES SITES',
  'FLATS','SINGLE BEDROOM','PLOTS','VILLAS','INDEPENDENT HOUSES',
  'LEASE','RENTALS','COMMERCIAL RENTALS','INDUSTRIAL LAND',
  'MULTIPLE VACANCIES','ACCOUNTANT','ACCOUNTANT TALLY','SECURITY',
  'FIELD OFFICERS','TEACHERS','WANTED','WANTED LADY',
  'ACCOUNTS FINANCE','ACCOUNTS & FINANCE','SALES MARKETING',
  'ADVI SALES MKTG','ENGINEERS','HOTEL','LAW OFFICES','LECTURERS',
  'FURNITURE','FINANCE','BUILDING MATERIALS','LOST','POULTRY',
  'NOTICE','MATRIMONIAL','BRIDE WANTED','GROOM WANTED','TUTORS',
  'CLASSIFIEDS','FOR RENT',
]);

// ── Category mapping ───────────────────────────────────────────────────────
function normalizeCategory(section, text) {
  const t = (section + ' ' + text).toUpperCase();
  if (/(AUTOMOTIVE|FOUR WHEELER|TWO WHEELER|CAR|BIKE|VEHICLE|SUV|SCOOTER)/.test(t)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|ALLIANCE)/.test(t))                                  return 'Matrimonial';
  if (/(VACANC|VACANCIE|HIRING|ACCOUNTANT|SECURITY|FIELD OFFICER|TEACHER|ENGINEER|LECTURER|HOTEL|LAW OFFICE|SALES|MARKET|WANTED|RECRUIT|CAREER|OPENING)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|PLOT|FLAT|HOUSE|LAND|VILLA|APART|SHOP|BHK|SQFT|BEDROOM|LEASE|COMMERCIAL|FARM|INDUSTRIAL|HOSTEL|PG\b)/.test(t)) return 'Property';
  return 'Other';
}
function normalizeSubCategory(category, text) {
  const l = text.toLowerCase();
  if (category === 'Property') {
    if (l.includes('rent') || l.includes('lease'))                               return 'For Rent';
    if (l.includes('pg') || l.includes('hostel') || l.includes('paying guest')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category === 'Automotive')  return 'Used vehicle';
  if (category === 'Jobs')        return l.includes('part') ? 'Part-time' : 'Full-time';
  if (category === 'Matrimonial') {
    if (l.includes('bride') || l.includes('girl')) return 'Bride Sought';
    if (l.includes('groom') || l.includes('boy'))  return 'Groom Sought';
    return 'Alliance';
  }
  return 'General';
}

function extractPhone(text) {
  const m = text.match(/(?:\+91[-\s]?)?[6-9GoOqQBb][0-9GoOqQBb]{9}/);
  if (!m) return '';
  const f = m[0].replace(/[Oo]/g,'0').replace(/[Gg]/g,'6').replace(/[qQ]/g,'9').replace(/[Bb]/g,'8').replace(/\D/g,'');
  return f.length >= 10 ? f.slice(-10) : '';
}
function extractPrice(text) {
  let m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*Cr(?:ore)?/i); if (m) return `₹${m[1].trim()} Cr`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,.]+)\s*L(?:akh)?\b/i);   if (m) return `₹${m[1].trim()} L`;
  m = text.match(/(\d+)\s*(?:lac|lakh)/i);                     if (m) return `₹${m[1]} L`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]{4,})/);                 if (m) return `₹${m[1]}`;
  return 'Not mentioned';
}
function extractSize(text) {
  let m = text.match(/([\d,]+)\s*sq\.?\s*(?:ft|feet)/i); if (m) return `${m[1]} sq ft`;
  m = text.match(/(\d)\s*BHK/i);                         if (m) return `${m[1]} BHK`;
  m = text.match(/(\d)\s*(?:bed|bedroom)/i);             if (m) return `${m[1]} BHK`;
  return 'Not mentioned';
}
const HYD_LOCALITIES = [
  'Jubilee Hills','Banjara Hills','Gachibowli','Madhapur','Hitech City','Kondapur',
  'Kukatpally','Miyapur','Ameerpet','Secunderabad','Begumpet','Somajiguda',
  'Masab Tank','Tolichowki','Mehdipatnam','LB Nagar','Dilsukhnagar','Uppal',
  'Kompally','Bachupally','Nizampet','Manikonda','Narsingi','Kokapet',
  'Nanakramguda','Raidurg','Shamshabad','Shamirpet','Patancheru','Sangareddy',
  'Beeramguda','Bowenpally','Malkajgiri','Alwal','Yapral','Nacharam',
  'Hayathnagar','Vanasthalipuram','Saroornagar','Kothapet','Moosapet',
  'Chintal','Jeedimetla','Balanagar','Sanath Nagar','Erragadda','SR Nagar',
];
function extractLocation(text) {
  const low = text.toLowerCase();
  for (const loc of HYD_LOCALITIES) {
    if (low.includes(loc.toLowerCase())) return `${loc}, Hyderabad`;
  }
  return '';
}

// ── Parser: processes one column's OCR text ────────────────────────────────
function parseColumn(colText, publishDate) {
  const ads    = [];
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);

  // Clean OCR noise
  const cleaned = colText
    .replace(/[✓√]/g, '')
    .replace(/\|{2,}/g, '')
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/§/g, 'S')
    .replace(/\f/g, '\n');

  const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 1);

  let currentSection = 'CLASSIFIEDS';
  let block = [];

  function isSectionHeader(line) {
    // Must be mostly uppercase
    const alpha = line.replace(/[^a-zA-Z]/g, '');
    if (alpha.length < 3) return false;
    const upRatio = line.replace(/[^A-Z]/g, '').length / alpha.length;
    if (upRatio < 0.75) return false;

    // Must not look like ad copy
    if (/\b(the|and|for|with|near|sqft|bhk|contact|call|ph:|mob:|email|apply)\b/i.test(line)) return false;

    // No digits mixed in (section headers don't have phone numbers)
    if (/\d{5,}/.test(line)) return false;

    const up = line.toUpperCase().replace(/[^A-Z\s&]/g, '').trim();

    // Exact match with known sections
    if (DC_SECTIONS.has(up)) return true;

    // Fuzzy: short all-caps line (2-4 words), no digits → likely a section label
    const words = up.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 4 && upRatio > 0.85 && !/\d/.test(line)) return true;

    return false;
  }

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 15) { block = []; return; }

    const phone        = extractPhone(text);
    const category     = normalizeCategory(currentSection, text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);

    // Use first non-noise line as title
    let title = block.find(l => l.length > 4)?.replace(/^[^a-zA-Z0-9₹]+/, '').slice(0, 120).trim() || text.slice(0, 80);

    ads.push({
      date_published: today, day_published: dayPub,
      category, sub_category, title,
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
    if (line.length < 2) continue;
    if (/^[\-–—=_*#.]+$/.test(line)) { flushBlock(); continue; }
    if (/^\d{1,3}$/.test(line))       { continue; } // page numbers

    if (isSectionHeader(line)) {
      flushBlock();
      currentSection = line.toUpperCase().trim();
      console.log(`[DC]   § ${currentSection}`);
      continue;
    }

    block.push(line);

    // End of ad: flush when phone number found
    if (extractPhone(line)) flushBlock();
  }
  flushBlock();
  return ads;
}

// ── Parse all columns ──────────────────────────────────────────────────────
function parseAdsFromColumns(combinedText, publishDate) {
  const columns = combinedText.split('===COLUMN_BREAK===');
  const allAds  = [];
  columns.forEach((colText, i) => {
    const ads = parseColumn(colText.trim(), publishDate);
    console.log(`[DC] Column ${i + 1}: ${ads.length} ads`);
    allAds.push(...ads);
  });
  return allAds;
}

// ── Classifieds page validator ─────────────────────────────────────────────
function isClassifiedsPage(text) {
  const phones = (text.match(/[6-9][0-9OoGgQqBb]{9}/g) || []).length;
  const lines  = text.split('\n').filter(l => l.trim());
  const short  = lines.filter(l => l.trim().length < 80).length;
  const long   = lines.filter(l => l.trim().length > 150).length;
  const score  = phones * 3 + short - long * 2;
  console.log(`[DC] Classifieds check: phones=${phones} score=${score}`);
  return score >= 8;
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

// ── Core: scrape one date ──────────────────────────────────────────────────
async function scrapeDate(page, browser, targetDate) {
  const dateStr        = isoDate(targetDate);
  const [yyyy, mm, dd] = dateStr.split('-');
  const todayStr       = isoDate(new Date());
  console.log(`\n[DC] ══ Scraping ${dateStr} (${dayName(targetDate)}) ══`);

  // Navigate: states.aspx → click HYDERABAD
  await page.goto(STATES_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  const hydClicked = await page.evaluate(() => {
    const hyd = [...document.querySelectorAll('a')]
      .find(a => a.textContent.trim().toUpperCase() === 'HYDERABAD');
    if (hyd) { hyd.click(); return true; }
    return false;
  });
  console.log(`[DC] HYDERABAD clicked: ${hydClicked}`);
  await Promise.race([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }), delay(20000)]);
  await delay(3000);

  // Select date if not today
  if (dateStr !== todayStr) {
    const ist   = toIST(targetDate);
    const month = ist.toLocaleDateString('en-US', { month: 'short' });
    const day   = ist.getDate();
    const year  = ist.getFullYear();
    console.log(`[DC] Selecting date: ${month} ${day}, ${year}`);

    const picked = await page.evaluate((m, d, y) => {
      for (const sel of document.querySelectorAll('select')) {
        const opt = [...sel.options].find(o => {
          const t = o.text.replace(/\s+/g,' ').trim();
          return t.includes(m) && t.includes(String(d)) && t.includes(String(y));
        });
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change')); return opt.text; }
      }
      return null;
    }, month, day, year);

    console.log(`[DC] Date selected: ${picked}`);
    if (picked) {
      await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }), delay(15000)]);
      await delay(3000);
    }
  }

  // Click Thumbnails tab
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('a,button,li,span,td')]
      .find(e => /^thumbnails?$/i.test(e.textContent.trim()));
    if (t) { t.click(); return; }
    if (typeof __doPostBack === 'function') try { __doPostBack('btn_thumbnails',''); } catch(_){}
  });
  await delay(3000);

  // Try DOM image URL for page 8
  const domImgUrl = await page.evaluate((pgNum) => {
    return [...document.querySelectorAll('img')]
      .map(i => i.src)
      .find(s => s && (s.includes('.jpg')||s.includes('.png')) &&
                 (new RegExp(`[/_]0*${pgNum}[._]`).test(s)||s.endsWith(`/${pgNum}.jpg`)) &&
                 !s.includes('logo') && !s.includes('icon')) || null;
  }, CLASSIFIEDS_PAGE);
  console.log(`[DC] DOM img URL: ${domImgUrl}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  for (const pgNum of [CLASSIFIEDS_PAGE, CLASSIFIEDS_PAGE + 1]) {
    const candidates = [
      ...(pgNum === CLASSIFIEDS_PAGE && domImgUrl ? [domImgUrl] : []),
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/0${pgNum}.jpg`,
    ];

    const rawPath  = path.join(tmpDir, `raw_${pgNum}.jpg`);
    let downloaded = false;

    for (const url of candidates) {
      try {
        console.log(`[DC] Downloading page ${pgNum}: ${url}`);
        await downloadFile(url, rawPath);
        const sz = fs.statSync(rawPath).size;
        if (sz < 5000) { console.log(`[DC] Too small (${sz}B)`); try{fs.unlinkSync(rawPath);}catch(_){} continue; }
        console.log(`[DC] ✓ Downloaded ${(sz/1024).toFixed(0)}KB`);
        downloaded = true;
        break;
      } catch(e) {
        console.log(`[DC] ✗ ${e.message.slice(0,60)}`);
        try{fs.unlinkSync(rawPath);}catch(_){}
      }
    }

    if (!downloaded) { console.log(`[DC] Page ${pgNum}: no URL worked`); continue; }

    // Quick full-page OCR first just to validate it's classifieds
    const quickOcr = await Tesseract.recognize(rawPath, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode: '3',
      tessedit_ocr_engine_mode: '0', // fast legacy for validation
    });
    if (!isClassifiedsPage(quickOcr.data.text)) {
      console.log(`[DC] Page ${pgNum}: not classifieds — skipping`);
      try{fs.unlinkSync(rawPath);}catch(_){}
      if (pgNum > CLASSIFIEDS_PAGE) break;
      continue;
    }
    console.log(`[DC] Page ${pgNum}: ✓ Classifieds confirmed — splitting into ${NUM_COLUMNS} columns`);

    // THE FIX: OCR each column separately at 3× scale
    const combinedText = await ocrByColumns(rawPath, browser, tmpDir);
    try{fs.unlinkSync(rawPath);}catch(_){}

    const parsed = parseAdsFromColumns(combinedText, targetDate);
    console.log(`[DC] Page ${pgNum}: ${parsed.length} total ads from ${NUM_COLUMNS} columns`);
    allAds.push(...parsed);
  }

  try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch(_){}

  // Deduplicate
  const seen   = new Set();
  const unique = allAds.filter(ad => {
    const key = `${ad.title}|${ad.phone}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    for (const date of dates) {
      try {
        const ads    = await scrapeDate(page, browser, date);
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
