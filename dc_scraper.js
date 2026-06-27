// dc_scraper.js — Deccan Chronicle e-paper Classifieds Scraper
// Navigation: states.aspx → HYDERABAD → date select → page 8 (CLASSIFIEDS)
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
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ── KEY FIX 1: Upscale image 3x using Puppeteer before OCR ───────────────
// The DC classifieds page has 5 dense columns of tiny text (~8px per line).
// Tesseract needs at least 20px per line to read accurately.
// We render the downloaded image at 300% in a blank Puppeteer page and
// screenshot it — no browser chrome, just the scaled image pixels.
async function renderHighRes(rawImagePath, hiResPath, browser) {
  const base64 = fs.readFileSync(rawImagePath).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const pg = await browser.newPage();
  try {
    await pg.setContent(`
      <html>
        <head><style>
          * { margin:0; padding:0; }
          body { background:#fff; }
          img { display:block; width:300%; height:auto; image-rendering:high-quality; }
        </style></head>
        <body><img id="pg" src="${dataUrl}"></body>
      </html>
    `);

    await pg.waitForSelector('#pg', { timeout: 10000 });

    // Get rendered dimensions
    const box = await pg.$eval('#pg', el => ({
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    }));

    await pg.setViewport({
      width:  Math.ceil(box.w) + 20,
      height: Math.ceil(box.h) + 20,
    });

    // Screenshot just the image element — no browser chrome
    const imgEl = await pg.$('#pg');
    await imgEl.screenshot({ path: hiResPath });

    console.log(`[DC] High-res render: ${Math.ceil(box.w)}×${Math.ceil(box.h)}px`);
    return true;
  } catch(e) {
    console.log(`[DC] High-res render failed: ${e.message} — using raw image`);
    fs.copyFileSync(rawImagePath, hiResPath);
    return false;
  } finally {
    await pg.close();
  }
}

// ── Known DC Hyderabad classifieds section headers ─────────────────────────
// Scraped directly from the actual classifieds page layout.
const DC_SECTIONS = [
  'FOR SALE AUTOMOTIVE','FOUR WHEELERS','TWO WHEELERS',
  'FOR SALE PROPERTY','COMMERCIAL','MULTIPLE FLATS','INDEPENDENT HOUSE',
  'DOUBLE BEDROOM','THREE & MORE','FARM HOUSES SITES','FLATS',
  'SINGLE BEDROOM','INDEPENDENT HOUSES','PLOTS','VILLAS',
  'LEASE','RENTALS','COMMERCIAL RENTALS','INDUSTRIAL LAND',
  'MULTIPLE VACANCIES','ACCOUNTANT','ACCOUNTANT TALLY','SECURITY',
  'FIELD OFFICERS','TEACHERS','WANTED','WANTED LADY',
  'ACCOUNTS & FINANCE','ADVI SALES & MKTG','SALES & MARKETING',
  'ENGINEERS','HOTEL','LAW OFFICES','LECTURERS','TUTORS',
  'FURNITURE','FINANCE','BUILDING MATERIALS','LOST','POULTRY',
  'NOTICE','MATRIMONIAL','BRIDE WANTED','GROOM WANTED',
  'THREE MORE','SAI KOMAL',
];

// ── Category helpers ───────────────────────────────────────────────────────
function normalizeCategory(sectionText, adText) {
  const t = (sectionText + ' ' + adText).toUpperCase();
  if (/(AUTOMOTIVE|CAR|BIKE|VEHICLE|FOUR.?WHEELER|TWO.?WHEELER|SUV|MOTORCYCLE|SCOOTER)/.test(t)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|SHADI|ALLIANCE|MATCH\s+SOUGHT)/.test(t))                        return 'Matrimonial';
  if (/(VACANCY|VACANCIES|HIRING|RECRUIT|WANTED|CAREER|OPENING|TEACHER|DRIVER|MANAGER|ACCOUNTANT|SECURITY|ENGINEERS?|HOTEL|LAW OFFICE|LECTURER|FIELD OFFICER|SALES|MARKETING|FINANCE\s+JOB)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|HOSTEL|PG\b|PAYING GUEST|PLOT|FLAT|HOUSE|LAND|VILLA|APARTMENT|SHOP|BHK|SQFT|BEDROOM|LEASE|COMMERCIAL|FARM|INDUSTRIAL)/.test(t)) return 'Property';
  return 'Other';
}
function normalizeSubCategory(category, text) {
  const lower = text.toLowerCase();
  if (category === 'Property') {
    if (lower.includes('rent') || lower.includes('lease') || lower.includes('rental')) return 'For Rent';
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

// OCR-tolerant phone extraction
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
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]+)\s*(?:lac|lakh)/i);   if (m) return `₹${m[1]} L`;
  m = text.match(/(?:₹|Rs\.?)\s*([\d,]{4,})/);                 if (m) return `₹${m[1]}`;
  m = text.match(/(\d+)\s*(?:lac|lakh)/i);                     if (m) return `₹${m[1]} L`;
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
];
function extractLocation(text) {
  for (const loc of HYD_LOCALITIES) {
    if (text.toLowerCase().includes(loc.toLowerCase())) return `${loc}, Hyderabad`;
  }
  return '';
}

// ── KEY FIX 2: Parser rebuilt for DC's 5-column classifieds layout ─────────
// DC classifieds OCR output has:
//   • Section headers in ALL CAPS (often 1 line, sometimes OCR-garbled)
//   • Ad blocks: 2-6 lines of dense text ending with a phone number
//   • Checkmarks (✓) at start of premium ads
//   • Mixed column reading order from Tesseract
//
// Strategy:
//   • Match lines against known DC section headers (fuzzy)
//   • Flush ad block whenever a new section or blank line appears
//   • Keep ads even without phone (phone may be OCR'd on a separate line)
function parseAdsFromText(ocrText, publishDate) {
  const ads    = [];
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);

  // Clean up common OCR noise
  const cleaned = ocrText
    .replace(/[✓√]/g, '')          // remove checkmarks
    .replace(/\|/g, 'I')           // | → I (common OCR swap)
    .replace(/['']/g, "'")         // smart quotes
    .replace(/[""]/g, '"');

  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

  let currentSection = 'CLASSIFIEDS';
  let block = [];

  // Fuzzy section header matcher
  // A line is a section header if:
  // (a) it matches a known DC section exactly or closely, OR
  // (b) it's ALL CAPS, 3-30 chars, no digits, looks like a label
  function isSectionHeader(line) {
    const upper = line.toUpperCase().replace(/[^A-Z\s&]/g, '').trim();
    if (upper.length < 3 || upper.length > 40) return false;
    // Must be mostly uppercase in original
    const alphaChars = line.replace(/[^a-zA-Z]/g, '');
    if (alphaChars.length === 0) return false;
    const upperRatio = (line.replace(/[^A-Z]/g, '').length) / alphaChars.length;
    if (upperRatio < 0.7) return false;
    // Must not look like a sentence (no long words typical of ad copy)
    if (/\b(the|and|for|with|near|sqft|bhk|contact|call|ph:|mob:)\b/i.test(line)) return false;
    // Match known sections
    for (const sec of DC_SECTIONS) {
      if (upper.includes(sec) || sec.includes(upper)) return true;
    }
    // Generic: short all-caps line with no digits (likely a section label)
    if (upperRatio > 0.85 && !/\d/.test(line) && line.length < 30) return true;
    return false;
  }

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 15) { block = []; return; }

    const phone        = extractPhone(text);
    const category     = normalizeCategory(currentSection, text);
    const sub_category = normalizeSubCategory(category, currentSection + ' ' + text);

    // Clean up the title: take first meaningful line
    let title = block[0].replace(/^[^a-zA-Z0-9₹]+/, '').slice(0, 120).trim();
    if (title.length < 4) title = block[1]?.slice(0, 120).trim() || title;

    ads.push({
      date_published: today, day_published: dayPub,
      category, sub_category,
      title,
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
    // Skip very short noise lines (single chars, dashes, page numbers)
    if (line.length < 3) { flushBlock(); continue; }
    if (/^[\-–—=_*#]+$/.test(line)) { flushBlock(); continue; }
    if (/^\d{1,3}$/.test(line)) { flushBlock(); continue; } // page numbers

    if (isSectionHeader(line)) {
      flushBlock();
      currentSection = line.toUpperCase().trim();
      console.log(`[DC] Section: ${currentSection}`);
      continue;
    }

    block.push(line);

    // Flush after a phone number appears (end of ad)
    if (extractPhone(line)) {
      flushBlock();
    }
  }
  flushBlock();
  return ads;
}

// ── Classifieds page validator ─────────────────────────────────────────────
function isClassifiedsPage(ocrText) {
  const phones     = (ocrText.match(/[6-9][0-9OoGgQqBb]{9}/g) || []).length;
  const lines      = ocrText.split('\n').filter(l => l.trim());
  const shortLines = lines.filter(l => l.trim().length < 80).length;
  const longLines  = lines.filter(l => l.trim().length > 150).length;
  const score      = phones * 3 + shortLines - longLines * 2;
  console.log(`[DC] Page check: phones=${phones} short=${shortLines} long=${longLines} → score=${score}`);
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
  console.log(`\n[DC] ══ Scraping ${dateStr} ══`);

  // Step 1: Load states.aspx and click HYDERABAD
  console.log('[DC] Loading states.aspx…');
  await page.goto(STATES_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);

  const hydClicked = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')];
    const hyd   = links.find(a => a.textContent.trim().toUpperCase() === 'HYDERABAD');
    if (hyd) { hyd.click(); return true; }
    return false;
  });
  console.log(`[DC] HYDERABAD clicked: ${hydClicked}`);

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    delay(20000),
  ]);
  await delay(3000);
  console.log(`[DC] Viewer URL: ${page.url()}`);

  // Step 2: Select date if not today
  if (dateStr !== todayStr) {
    const ist   = toIST(targetDate);
    const month = ist.toLocaleDateString('en-US', { month: 'short' }); // "Jun"
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

    console.log(`[DC] Date picked: ${picked}`);
    if (picked) {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
        delay(15000),
      ]);
      await delay(3000);
    }
  }

  // Step 3: Try to get DOM image URL for page 8 from the thumbnail strip
  // Click Thumbnails first
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('a,button,li,span,td')];
    const t   = els.find(e => /^thumbnails?$/i.test(e.textContent.trim()));
    if (t) { t.click(); return; }
    if (typeof __doPostBack === 'function') try { __doPostBack('btn_thumbnails',''); } catch(_){}
  });
  await delay(3000);

  // Grab any img srcs that look like page images
  const domImgUrl = await page.evaluate((pgNum) => {
    const imgs = [...document.querySelectorAll('img')];
    const match = imgs.find(img => {
      const s = img.src;
      return s && (s.includes('.jpg') || s.includes('.png')) &&
             (new RegExp(`[/_]0*${pgNum}[._]`).test(s) || s.endsWith(`/${pgNum}.jpg`)) &&
             !s.includes('logo') && !s.includes('icon');
    });
    return match ? match.src : null;
  }, CLASSIFIEDS_PAGE);
  console.log(`[DC] DOM img URL for page ${CLASSIFIEDS_PAGE}: ${domImgUrl}`);

  // Step 4: Build candidate URLs for page 8 (and 9 as overflow)
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
    const hiRes    = path.join(tmpDir, `hires_${pgNum}.png`);
    let downloaded = false;

    for (const url of candidates) {
      try {
        console.log(`[DC] Downloading page ${pgNum}: ${url}`);
        await downloadFile(url, rawPath);
        const sz = fs.statSync(rawPath).size;
        if (sz < 5000) { console.log(`[DC] Too small (${sz}B)`); try{fs.unlinkSync(rawPath);}catch(_){} continue; }
        console.log(`[DC] ✓ Downloaded (${(sz/1024).toFixed(0)}KB)`);
        downloaded = true;
        break;
      } catch(e) {
        console.log(`[DC] Failed: ${e.message.slice(0,60)}`);
        try{fs.unlinkSync(rawPath);}catch(_){}
      }
    }

    if (!downloaded) { console.log(`[DC] Page ${pgNum}: no URL worked`); continue; }

    // KEY FIX: Upscale 3x before OCR
    console.log(`[DC] Upscaling page ${pgNum} for OCR…`);
    await renderHighRes(rawPath, hiRes, browser);
    try{fs.unlinkSync(rawPath);}catch(_){}

    // OCR with PSM 3 (auto page segmentation — handles multi-column)
    console.log(`[DC] Running OCR on page ${pgNum}…`);
    const { data } = await Tesseract.recognize(hiRes, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode: '3',   // Auto — handles 5-column newspaper layout
      tessedit_ocr_engine_mode: '1', // LSTM neural net — better accuracy
      preserve_interword_spaces: '1',
    });
    try{fs.unlinkSync(hiRes);}catch(_){}

    const ocrText = data.text;
    console.log(`[DC] Page ${pgNum} OCR (first 500 chars):\n  ${ocrText.slice(0,500).replace(/\n/g,' | ')}`);

    if (!isClassifiedsPage(ocrText)) {
      console.log(`[DC] Page ${pgNum}: not a classifieds page — skipping`);
      if (pgNum > CLASSIFIEDS_PAGE) break;
      continue;
    }

    console.log(`[DC] Page ${pgNum}: ✓ Classifieds confirmed`);
    const parsed = parseAdsFromText(ocrText, targetDate);
    console.log(`[DC] Page ${pgNum}: ${parsed.length} ads`);
    allAds.push(...parsed);
  }

  try{fs.rmSync(tmpDir, { recursive:true, force:true });}catch(_){}

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
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

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
