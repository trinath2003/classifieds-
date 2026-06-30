
// dc_scraper.js — Deccan Chronicle Classifieds Scraper
// Uses Groq Vision API (free tier) for image extraction
require('dotenv').config();
const puppeteer = require('puppeteer');
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

// ── DB ─────────────────────────────────────────────────────────────────────
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

// ── IST helpers ────────────────────────────────────────────────────────────
function toIST(d)   { return new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000); }
function isoDate(d) { return toIST(d).toISOString().slice(0, 10); }
function dayName(d) { return toIST(d).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' }); }

// ── Download ───────────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Referer': STATES_URL,
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ── Groq API ───────────────────────────────────────────────────────────────
async function callGroq(imagePath, prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in .env file');

  const ext       = path.extname(imagePath).toLowerCase();
  const mimeType  = ext === '.png' ? 'image/png' : 'image/jpeg';
  const imageData = fs.readFileSync(imagePath).toString('base64');

  console.log(`[DC] Groq: sending ${Math.round(imageData.length * 0.75 / 1024)}KB image...`);

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageData}` } },
        ]
      }],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq API ${resp.status}: ${err.slice(0, 300)}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Groq returned empty response');
  return text;
}

function parseJSON(raw) {
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(clean); } catch (_) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error('JSON parse failed: ' + clean.slice(0, 100));
  }
}

// ── STEP 1: Extract ads from image using Gemini Vision ────────────────────
const EXTRACTION_PROMPT = `This is the CLASSIFIEDS page from Deccan Chronicle newspaper, Hyderabad edition.

Extract EVERY classified advertisement visible on this page.

IMPORTANT RULES:
- Only extract CLASSIFIED ADS — not news headlines, not editorial content, not article text
- Only extract text that is in ENGLISH — skip any Telugu or Hindi script text entirely
- A classified ad has: a heading, description text, and usually a contact number
- Section headers like "FOR SALE PROPERTY", "MULTIPLE VACANCIES", "MATRIMONIAL", "LEASE", "RENTALS" tell you the category

Return ONLY a valid JSON array (no markdown, no explanation):
[{
  "title": "heading or first meaningful line of the ad",
  "description": "complete ad text exactly as printed in English",
  "phone": "10-digit mobile number or empty string",
  "price": "price like Rs.45 L or Rs.2.5 Cr or Not mentioned",
  "location": "locality/area name in Hyderabad or empty string",
  "category": "Property | Jobs | Automotive | Matrimonial | Other",
  "sub_category": "For Sale | For Rent | PG / Hostel | Full-time | Part-time | Used vehicle | Bride Sought | Groom Sought | Alliance | General"
}]

Category guide:
- Property: flat/house/plot/land/villa/shop/commercial/farm/BHK/lease/rent/PG/hostel
- Jobs: vacancy/vacancies/required/wanted/hiring/engineer/teacher/accountant/security/sales
- Automotive: car/bike/vehicle/two-wheeler/four-wheeler/SUV
- Matrimonial: bride/groom/alliance/matrimonial/match
- Other: furniture/finance/lost/notice/poultry/building materials`;

async function extractAdsWithVision(imagePath) {
  const raw = await callGroq(imagePath, EXTRACTION_PROMPT);
  console.log(`[DC] Groq raw (200 chars): ${raw.slice(0, 200)}`);
  return parseJSON(raw);
}

// ── STEP 2: Cross-verify + correct OCR errors using the original image ─────
async function crossVerifyAds(rawAds, dateStr, imagePath) {
  if (!rawAds.length) return [];

  const BATCH       = 15;
  const allVerified = [];

  for (let i = 0; i < rawAds.length; i += BATCH) {
    const batch        = rawAds.slice(i, i + BATCH);
    const batchNum     = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(rawAds.length / BATCH);
    console.log(`[DC] Cross-verify batch ${batchNum}/${totalBatches}: ${batch.length} ads...`);

    const verifyPrompt = [
      `You are correcting classified ads extracted from Deccan Chronicle, Hyderabad, ${dateStr}.`,
      `I am giving you (1) the ORIGINAL NEWSPAPER IMAGE and (2) TEXT auto-extracted from it.`,
      `The text has OCR errors. Look at the image to find each ad and correct the words.`,
      ``,
      `EXTRACTED TEXT (has errors):`,
      JSON.stringify(batch, null, 2),
      ``,
      `CORRECTION RULES (look at image to verify each word):`,
      `- Fix garbled job titles, location names, company names by reading the image`,
      `- "Bonerpaly" -> "Bowenpally" (Hyderabad area)`,
      `- "Expenenced" -> "Experienced"`,
      `- "Electrca" -> "Electrical"`,
      `- "Regured" -> "Required"`,
      `- Symbols like cent sign or section sign mixed in words -> remove them`,
      `- "0" vs "O", "1" vs "l" -> use image context to decide`,
      ``,
      `DROP these (not real classified ads):`,
      `- News headlines`,
      `- Section headers alone with no ad body`,
      `- Fragments under 5 meaningful words`,
      `- Mostly non-English (Telugu or Hindi) text`,
      `- Items where the title is just a phone number or location name`,
      ``,
      `Return ONLY a valid JSON array. Same schema, drop invalid items:`,
      `[{"title":"corrected title","description":"corrected English description",`,
      ` "phone":"10 digits or empty","price":"Rs.X L or Not mentioned",`,
      ` "location":"Hyderabad area or empty",`,
      ` "category":"Property|Jobs|Automotive|Matrimonial|Other",`,
      ` "sub_category":"For Sale|For Rent|PG / Hostel|Full-time|Part-time|Used vehicle|Bride Sought|Groom Sought|Alliance|General"}]`,
    ].join('\n');

    try {
      const raw      = await callGroq(imagePath, verifyPrompt);
      console.log(`[DC] Batch ${batchNum} (150 chars): ${raw.slice(0, 150)}`);
      const verified = parseJSON(raw);
      console.log(`[DC] Batch ${batchNum}: ${batch.length} in -> ${verified.length} corrected`);
      allVerified.push(...verified);
    } catch (e) {
      console.error(`[DC] Batch ${batchNum} parse failed: ${e.message}`);
      allVerified.push(...batch);
    }
  }

  console.log(`[DC] Cross-verify: ${rawAds.length} in -> ${allVerified.length} corrected English ads`);
  return allVerified;
}

// ── STEP 3: Build + filter final ad objects ────────────────────────────────
const HYD_LOCALITIES = [
  'Jubilee Hills','Banjara Hills','Gachibowli','Madhapur','Hitech City','Kondapur',
  'Kukatpally','Miyapur','Ameerpet','Secunderabad','Begumpet','Somajiguda',
  'Masab Tank','Tolichowki','Mehdipatnam','LB Nagar','Dilsukhnagar','Uppal',
  'Kompally','Bachupally','Nizampet','Manikonda','Narsingi','Kokapet',
  'Nanakramguda','Raidurg','Shamshabad','Shamirpet','Patancheru','Sangareddy',
  'Beeramguda','Bowenpally','Malkajgiri','Alwal','Yapral','Nacharam',
  'Hayathnagar','Vanasthalipuram','Kothapet','Moosapet','Chintal','SR Nagar',
];

function buildAds(verifiedAds, publishDate) {
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);

  function cleanPhone(p) {
    if (!p) return '';
    const d = String(p).replace(/\D/g, '');
    if (d.length >= 10) {
      const num = d.slice(-10);
      return /^[6-9]\d{9}$/.test(num) ? num : '';
    }
    return '';
  }

  function cleanLocation(loc, desc) {
    if (loc && loc.length > 2 && /[a-zA-Z]/.test(loc)) {
      return loc.includes('Hyderabad') ? loc : `${loc.trim()}, Hyderabad`;
    }
    const l = (desc || '').toLowerCase();
    for (const place of HYD_LOCALITIES) {
      if (l.includes(place.toLowerCase())) return `${place}, Hyderabad`;
    }
    return '';
  }

  function isEnglish(text) {
    if (!text || text.length < 3) return false;
    const ascii = (text.match(/[\x20-\x7E]/g) || []).length;
    return (ascii / text.length) > 0.7;
  }

  function isBadTitle(t) {
    if (!t || t.length < 4) return true;
    if (/^[\d\s\+\-\(\)\.]{7,}$/.test(t.trim())) return true;
    if (/^[\W\d]+$/.test(t)) return true;
    if (/^(bonerpaly|bowenpally\s*:|secunderabad\s*:|hyderabad\s*:)[:\s]*$/i.test(t.trim())) return true;
    if (t.trim().split(/\s+/).length < 2) return true;
    return false;
  }

  return verifiedAds
    .filter(a => a && typeof a === 'object')
    .filter(a => {
      const txt = `${a.title || ''} ${a.description || ''}`.trim();
      if (txt.length < 20) return false;
      if (!isEnglish(txt)) return false;
      if (isBadTitle(a.title || '')) return false;
      const words = (a.description || '')
        .replace(/[^a-zA-Z\s]/g, ' ').trim()
        .split(/\s+/).filter(w => w.length > 2);
      if (words.length < 5) return false;
      return true;
    })
    .map(a => {
      let title = String(a.title || '').slice(0, 120).trim();
      if (isBadTitle(title)) {
        const firstSentence = (String(a.description || '').split('.')[0] || '').trim();
        title = firstSentence.slice(0, 120) || title;
      }
      return {
        date_published: today,
        day_published:  dayPub,
        category:       a.category     || 'Other',
        sub_category:   a.sub_category || 'General',
        title,
        description:    String(a.description || '').trim(),
        location:       cleanLocation(a.location || '', a.description || ''),
        price:          a.price     || 'Not mentioned',
        size_area:      a.size_area || 'Not mentioned',
        phone:          cleanPhone(a.phone),
        source: 'scraper', newspaper_name: NEWSPAPER,
      };
    });
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
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'scraper','active',?,NOW())
      `, [
        ad.date_published, ad.day_published, ad.category, ad.sub_category,
        ad.title, ad.description, ad.location, ad.price, ad.size_area,
        ad.phone, '', '', ad.newspaper_name,
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch (e) { console.error('[DC] Row:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Get page image from DC viewer via canvas export ────────────────────────
async function getPageImageFromViewer(page, pgNum, outPath) {
  console.log(`[DC] Clicking page ${pgNum} in viewer...`);
  await page.evaluate((n) => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const t = el.textContent.trim().toUpperCase();
      if (t === `CLASSIFIEDS(${n})` || (t.includes('CLASSIFIEDS') && t.includes(`(${n})`))) {
        (el.closest('a,td,div,li') || el).click(); return;
      }
    }
    if (typeof __doPostBack === 'function') {
      for (const [t, a] of [['lnk_page_'+n,''],['lnkPage'+n,''],['GridView1','Page$'+n]]) {
        try { __doPostBack(t, a); return; } catch (_) {}
      }
    }
  }, pgNum);
  await delay(5000);

  const pngBase64 = await page.evaluate(() => {
    const selectors = [
      '#imgPage','#pageImage','#mainImage',
      'img[id*="imgPage"]','img[id*="PageImage"]','img[id*="mainImg"]',
    ];
    let img = null;
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.naturalWidth > 400) { img = el; break; }
    }
    if (!img) {
      img = [...document.querySelectorAll('img')]
        .filter(i => i.naturalWidth > 400 && !i.src.includes('logo') && !i.src.includes('icon'))
        .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
    }
    if (!img) return null;
    console.log('img:', img.id, img.naturalWidth + 'x' + img.naturalHeight);
    try {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    } catch (e) { return '__SRC__' + img.src; }
  });

  if (!pngBase64) return false;
  if (pngBase64.startsWith('__SRC__')) {
    await downloadFile(pngBase64.slice(7), outPath);
  } else {
    fs.writeFileSync(outPath, Buffer.from(pngBase64, 'base64'));
    console.log(`[DC] Canvas export: ${(fs.statSync(outPath).size / 1024).toFixed(0)}KB PNG`);
  }
  return true;
}

// ── Core scrape ────────────────────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr      = isoDate(targetDate);
  const [yyyy,mm,dd] = dateStr.split('-');
  console.log(`\n[DC] ══ ${dateStr} (${dayName(targetDate)}) ══`);

  await page.goto(STATES_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await delay(2000);
  await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')]
      .find(x => x.textContent.trim().toUpperCase() === 'HYDERABAD');
    if (a) a.click();
  });
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    delay(20000),
  ]);
  await delay(3000);
  console.log(`[DC] Viewer: ${page.url()}`);

  const ist      = toIST(targetDate);
  const isSunday = ist.getDay() === 0;
  if (isSunday) {
    console.log('[DC] Sunday detected — clicking Sunday Chronicle tab...');
    const clicked = await page.evaluate(() => {
      const tab = [...document.querySelectorAll('a,button,li,span,td,div')]
        .find(e => /sunday\s*chronicle/i.test(e.textContent.trim()));
      if (tab) { tab.click(); return true; }
      return false;
    });
    if (clicked) {
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        delay(15000),
      ]);
      await delay(2000);
    }
  }

  const month = ist.toLocaleDateString('en-US', { month: 'short' });
  const day   = ist.getDate();
  const year  = ist.getFullYear();
  console.log(`[DC] Selecting date: ${month} ${day}, ${year}...`);

  const picked = await page.evaluate((m, d, y) => {
    for (const s of document.querySelectorAll('select')) {
      const o = [...s.options].find(x => {
        const t = x.text.replace(/\s+/g, ' ').trim();
        return t.includes(m) && t.includes(String(d)) && t.includes(String(y));
      });
      if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); return o.text; }
    }
    return null;
  }, month, day, year);

  console.log(`[DC] Date selected: ${picked}`);
  if (picked) {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      delay(15000),
    ]);
    await delay(3000);
  } else {
    console.log('[DC] Date not in dropdown — viewer may already be on correct date');
    await delay(2000);
  }

  await page.evaluate(() => {
    const t = [...document.querySelectorAll('a,button,li,span,td')]
      .find(e => /^thumbnails?$/i.test(e.textContent.trim()));
    if (t) { t.click(); return; }
    if (typeof __doPostBack === 'function') try { __doPostBack('btn_thumbnails', ''); } catch (_) {}
  });
  await delay(3000);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  for (const pgNum of [CLASSIFIEDS_PAGE, CLASSIFIEDS_PAGE + 1]) {
    const imgPath = path.join(tmpDir, `page_${pgNum}.png`);

    let gotImage = await getPageImageFromViewer(page, pgNum, imgPath);

    if (!gotImage || !fs.existsSync(imgPath) || fs.statSync(imgPath).size < 5000) {
      console.log(`[DC] Canvas failed — trying direct URL download...`);
      const jpgPath = imgPath.replace('.png', '.jpg');
      const urls = [
        `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
        `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${pgNum}.jpg`,
        `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
        `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      ];
      gotImage = false;
      for (const url of urls) {
        try {
          await downloadFile(url, jpgPath);
          if (fs.statSync(jpgPath).size > 5000) { gotImage = true; break; }
          try { fs.unlinkSync(jpgPath); } catch (_) {}
        } catch (e) { console.log(`[DC] URL failed: ${e.message.slice(0, 50)}`); }
      }
    }

    if (!gotImage) { console.log(`[DC] Page ${pgNum}: no image found`); continue; }

    const actualPath = fs.existsSync(imgPath) ? imgPath : imgPath.replace('.png', '.jpg');
    console.log(`[DC] Image ready: ${(fs.statSync(actualPath).size / 1024).toFixed(0)}KB`);

    try {
      const rawAds = await extractAdsWithVision(actualPath);
      console.log(`[DC] Extracted: ${rawAds.length} raw items`);

      // Cross-verify skipped to stay under free-tier rate limits.
      // Re-enable by uncommenting the line below if you upgrade your Groq plan.
      // const verifiedAds = await crossVerifyAds(rawAds, dateStr, actualPath);
      const verifiedAds = rawAds;

      const ads = buildAds(verifiedAds, targetDate);
      console.log(`[DC] Page ${pgNum}: ${ads.length} verified English classified ads`);
      allAds.push(...ads);

      if (pgNum === CLASSIFIEDS_PAGE && ads.length > 10) {
        console.log(`[DC] Page 8 has ${ads.length} ads — skipping page 9`);
        try { fs.unlinkSync(actualPath); } catch (_) {}
        break;
      }
      // Pause between pages to stay under Groq free-tier tokens-per-minute limit
      await delay(15000);
    } catch (e) {
      console.error(`[DC] Page ${pgNum} failed: ${e.message}`);
    }
    try { fs.unlinkSync(actualPath); } catch (_) {}
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const seen   = new Set();
  const unique = allAds.filter(ad => {
    const k = `${ad.title}|${ad.phone}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  console.log(`[DC] ${dateStr}: ${unique.length} unique verified ads`);
  return unique;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  const dates = [];
  const start = new Date(dateFrom || new Date());
  const end   = new Date(dateTo   || dateFrom || new Date());
  start.setHours(0, 0, 0, 0); end.setHours(0, 0, 0, 0);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(new Date(d));
  console.log(`[DC] Dates: ${dates.map(isoDate).join(', ')}`);

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
        console.log(`[DC] ✓ ${isoDate(date)}: inserted=${result.inserted} total=${ads.length}`);
        summary.push({ date: isoDate(date), day: dayName(date), ...result, total: ads.length });
      } catch (err) {
        console.error(`[DC] ✗ ${isoDate(date)}: ${err.message}`);
        summary.push({ date: isoDate(date), error: err.message });
      }
    }
  } finally {
    await browser.close();
    if (require.main === module) try { await db.end(); } catch (_) {}
  }
  console.log('\n[DC] ══ Done ══');
  console.table(summary);
  return summary;
}

// ── IST-aware week helper ──────────────────────────────────────────────────
function getCurrentWeekDatesIST() {
  const nowIST    = toIST(new Date());
  const dayOfWeek = nowIST.getDay();
  const offset    = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const dates     = [];
  for (let i = offset; i >= 0; i--) {
    const d = new Date(nowIST);
    d.setDate(d.getDate() - i);
    dates.push(isoDate(d));
  }
  return dates;
}

async function scrapeCurrentWeek() {
  const dates = getCurrentWeekDatesIST();
  const first = dates[0];
  const last  = dates[dates.length - 1];
  console.log(`[DC] Scraping week (IST): ${first} to ${last} (${dates.length} days)`);
  return scrapeAndSave(first, last);
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, a1, a2] = process.argv;
  const cmd = a1 === '--week' ? scrapeCurrentWeek() : scrapeAndSave(a1, a2);
  cmd
    .then(() => process.exit(0))
    .catch(e => { console.error('[DC] Fatal:', e.message); process.exit(1); });
}

module.exports = { scrapeAndSave, scrapeCurrentWeek, getCurrentWeekDatesIST, isoDate };
