// dc_scraper.js — Deccan Chronicle Classifieds Scraper
// Uses Claude Vision API + English/classified cross-verification
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
const CLASSIFIEDS_PAGE = 8;

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── DB ─────────────────────────────────────────────────────────────────────
const db = process.env.MYSQL_URL
  ? mysql.createPool(process.env.MYSQL_URL)
  : mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'newspaper_db',
      waitForConnections: true, connectionLimit: 10,
    });

// ── IST helpers ────────────────────────────────────────────────────────────
function toIST(d)   { return new Date(new Date(d).getTime() + 5.5*60*60*1000); }
function isoDate(d) { return toIST(d).toISOString().slice(0, 10); }
function dayName(d) { return toIST(d).toLocaleDateString('en-IN', { weekday:'long', timeZone:'Asia/Kolkata' }); }

// ── Download ───────────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Referer': STATES_URL,
    }}, res => {
      if (res.statusCode===301||res.statusCode===302) {
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode!==200) {
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', ()=>{ file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ── Claude API helper ──────────────────────────────────────────────────────
async function callClaude(messages, maxTokens=8192) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-api-key':        apiKey,
      'anthropic-version':'2023-06-01',
    },
    body: JSON.stringify({ model:'claude-opus-4-6', max_tokens:maxTokens, messages }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${err.slice(0,200)}`);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

function parseJSON(raw) {
  const clean = raw.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
  try { return JSON.parse(clean); } catch(_) {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error('JSON parse failed');
  }
}

// ── STEP 1: Extract ads from image using Claude Vision ─────────────────────
const EXTRACTION_PROMPT = `This is the CLASSIFIEDS page from Deccan Chronicle newspaper, Hyderabad edition.

Extract EVERY classified advertisement visible on this page.

IMPORTANT RULES:
- Only extract CLASSIFIED ADS — not news headlines, not editorial content, not article text
- Only extract text that is in ENGLISH — skip any Telugu or Hindi script text entirely
- A classified ad typically has: a short heading, description text, and a contact number
- Section headers like "FOR SALE PROPERTY", "MULTIPLE VACANCIES", "MATRIMONIAL", "LEASE", "RENTALS" etc. tell you the category

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
  const ext       = path.extname(imagePath).toLowerCase();
  const mediaType = ext==='.png' ? 'image/png' : 'image/jpeg';
  const imageData = fs.readFileSync(imagePath).toString('base64');
  console.log(`[DC] Vision: sending ${Math.round(imageData.length*0.75/1024)}KB to Claude…`);

  const raw = await callClaude([{
    role:'user',
    content:[
      { type:'image', source:{ type:'base64', media_type:mediaType, data:imageData }},
      { type:'text',  text: EXTRACTION_PROMPT },
    ]
  }]);

  console.log(`[DC] Vision raw (200 chars): ${raw.slice(0,200)}`);
  return parseJSON(raw);
}

// ── STEP 2: Cross-verify + OCR ambiguity correction ───────────────────────
//
// WHY: Even after Claude Vision extracts text, words can be garbled because
//   the newspaper image is compressed and small. Examples seen in real output:
//     "Eagineer"   → "Engineer"      (vowel swap)
//     "Expenenced" → "Experienced"   (missing letter)
//     "Fncla"      → "Financial"     (compression artifact)
//     "Regured"    → "Required"      (transposition)
//     "Electrca"   → "Electrical"    (dropped vowel)
//     "muLnipLe"   → "Multiple"      (case corruption)
//     "Prectech"   → "Pretech / Prakash" (context-guessed)
//     "CO2683"     → probably a phone/ref number
//     "abad2020"   → "Hyderabad 2020" (city name OCR error)
//
// HOW: Send ads to Claude with explicit instructions to:
//   1. Treat every word as potentially OCR-corrupted
//   2. Use surrounding context to infer the intended word
//   3. Fix silently — don't flag, just correct
//   4. Drop non-English / non-classified items
//
async function crossVerifyAds(rawAds, dateStr, imagePath) {
  if (!rawAds.length) return [];

  const ext       = path.extname(imagePath).toLowerCase();
  const mediaType = ext==='.png' ? 'image/png' : 'image/jpeg';
  const imageData = fs.readFileSync(imagePath).toString('base64');

  const BATCH = 15;
  const allVerified = [];

  for (let i = 0; i < rawAds.length; i += BATCH) {
    const batch        = rawAds.slice(i, i + BATCH);
    const batchNum     = Math.floor(i/BATCH) + 1;
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
      `- "Kal Eagineer" -> read image -> correct job title (e.g. "Civil Engineer")`,
      `- "for Msdie Scho" -> read image -> correct school/institution name`,
      `- "e- Pancipals, T" -> likely "Experienced Principals, Teachers"`,
      `- "OMce Furnd" -> likely "Office Furniture"`,
      `- "Bonerpaly" -> "Bowenpally" (Hyderabad area)`,
      `- "Expenenced" -> "Experienced"`,
      `- "Electrca" -> "Electrical"`,
      `- "Regured" -> "Required"`,
      `- "Fncla" -> "Financial"`,
      `- "muLnipLe" -> "Multiple"`,
      `- Symbols like a section sign or cent sign mixed in words -> remove them`,
      `- "0" vs "O", "1" vs "l" -> use image context to decide`,
      ``,
      `DROP these (not real classified ads):`,
      `- News headlines like "Turncoats likely to get" or "AAP and Shiv Sena"`,
      `- Section headers alone with no ad body`,
      `- Fragments under 5 meaningful words`,
      `- Mostly non-English (Telugu or Hindi) text`,
      ``,
      `Return ONLY a valid JSON array. Same schema, drop invalid items:`,
      `[{"title":"corrected title","description":"corrected English description",`,
      ` "phone":"10 digits or empty","price":"Rs.X L or Not mentioned",`,
      ` "location":"Hyderabad area or empty",`,
      ` "category":"Property|Jobs|Automotive|Matrimonial|Other",`,
      ` "sub_category":"For Sale|For Rent|PG / Hostel|Full-time|Part-time|Used vehicle|Bride Sought|Groom Sought|Alliance|General"}]`,
    ].join('\n');

    const raw = await callClaude([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
        { type: 'text',  text: verifyPrompt },
      ]
    }], 8192);

    console.log(`[DC] Batch ${batchNum} (150 chars): ${raw.slice(0,150)}`);

    try {
      const verified = parseJSON(raw);
      console.log(`[DC] Batch ${batchNum}: ${batch.length} in -> ${verified.length} corrected`);
      allVerified.push(...verified);
    } catch(e) {
      console.error(`[DC] Batch ${batchNum} parse failed: ${e.message}`);
      allVerified.push(...batch);
    }
  }

  console.log(`[DC] Cross-verify: ${rawAds.length} in -> ${allVerified.length} corrected English ads`);
  return allVerified;
}

// ── STEP 3: Build final ad objects ─────────────────────────────────────────
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
    const d = String(p).replace(/\D/g,'');
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
    const l = (desc||'').toLowerCase();
    for (const place of HYD_LOCALITIES) {
      if (l.includes(place.toLowerCase())) return `${place}, Hyderabad`;
    }
    return '';
  }

  function isEnglish(text) {
    if (!text || text.length < 3) return false;
    // Count ASCII printable chars vs total chars
    const ascii = (text.match(/[\x20-\x7E]/g)||[]).length;
    return (ascii / text.length) > 0.7;
  }

  return verifiedAds
    .filter(a => a && typeof a==='object')
    .filter(a => {
      const txt = `${a.title||''} ${a.description||''}`.trim();
      if (txt.length < 10) return false;                    // too short
      if (!isEnglish(txt)) return false;                    // non-English
      if (/^\W+$/.test(a.title||'')) return false;          // title is all symbols
      return true;
    })
    .map(a => ({
      date_published: today,
      day_published:  dayPub,
      category:       a.category     || 'Other',
      sub_category:   a.sub_category || 'General',
      title:          String(a.title       ||'').slice(0,120).trim(),
      description:    String(a.description ||'').trim(),
      location:       cleanLocation(a.location||'', a.description||''),
      price:          a.price    || 'Not mentioned',
      size_area:      a.size_area|| 'Not mentioned',
      phone:          cleanPhone(a.phone),
      source: 'scraper', newspaper_name: NEWSPAPER,
    }));
}

// ── Save to DB ─────────────────────────────────────────────────────────────
async function saveAds(ads, publishDate) {
  if (!ads.length) return { inserted:0, skipped:0 };
  await db.query(
    `DELETE FROM classified_ads WHERE newspaper_name=? AND source='scraper' AND date_published=?`,
    [NEWSPAPER, isoDate(publishDate)]
  );
  let inserted=0, skipped=0;
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
      r.affectedRows>0 ? inserted++ : skipped++;
    } catch(e) { console.error('[DC] Row:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Get page image from DC viewer ──────────────────────────────────────────
async function getPageImageFromViewer(page, pgNum, outPath) {
  console.log(`[DC] Clicking page ${pgNum} in viewer…`);
  await page.evaluate((n) => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const t = el.textContent.trim().toUpperCase();
      if (t===`CLASSIFIEDS(${n})` || (t.includes('CLASSIFIEDS') && t.includes(`(${n})`))) {
        (el.closest('a,td,div,li')||el).click(); return;
      }
    }
    if (typeof __doPostBack==='function') {
      for (const [t,a] of [['lnk_page_'+n,''],['lnkPage'+n,''],['GridView1','Page$'+n]]) {
        try { __doPostBack(t,a); return; } catch(_) {}
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
      if (el && el.naturalWidth>400) { img=el; break; }
    }
    if (!img) {
      img = [...document.querySelectorAll('img')]
        .filter(i=>i.naturalWidth>400 && !i.src.includes('logo') && !i.src.includes('icon'))
        .sort((a,b)=>b.naturalWidth*b.naturalHeight - a.naturalWidth*a.naturalHeight)[0];
    }
    if (!img) return null;
    console.log('img:', img.id, img.naturalWidth+'×'+img.naturalHeight);
    try {
      const c=document.createElement('canvas');
      c.width=img.naturalWidth; c.height=img.naturalHeight;
      c.getContext('2d').drawImage(img,0,0);
      return c.toDataURL('image/png').split(',')[1];
    } catch(e) { return '__SRC__'+img.src; }
  });

  if (!pngBase64) return false;
  if (pngBase64.startsWith('__SRC__')) {
    await downloadFile(pngBase64.slice(7), outPath);
  } else {
    fs.writeFileSync(outPath, Buffer.from(pngBase64,'base64'));
    console.log(`[DC] Canvas: ${(fs.statSync(outPath).size/1024).toFixed(0)}KB PNG`);
  }
  return true;
}

// ── Core scrape ────────────────────────────────────────────────────────────
async function scrapeDate(page, targetDate) {
  const dateStr      = isoDate(targetDate);
  const [yyyy,mm,dd] = dateStr.split('-');
  const todayStr     = isoDate(new Date());
  console.log(`\n[DC] ══ ${dateStr} (${dayName(targetDate)}) ══`);

  // Navigate: states.aspx → HYDERABAD
  await page.goto(STATES_URL, { waitUntil:'networkidle2', timeout:60000 });
  await delay(2000);
  await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x=>x.textContent.trim().toUpperCase()==='HYDERABAD');
    if (a) a.click();
  });
  await Promise.race([page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}), delay(20000)]);
  await delay(3000);
  console.log(`[DC] Viewer: ${page.url()}`);

  // Select date
  if (dateStr !== todayStr) {
    const ist   = toIST(targetDate);
    const month = ist.toLocaleDateString('en-US',{month:'short'});
    const day   = ist.getDate(), year=ist.getFullYear();
    const picked = await page.evaluate((m,d,y) => {
      for (const s of document.querySelectorAll('select')) {
        const o = [...s.options].find(x=>{const t=x.text.replace(/\s+/g,' ');return t.includes(m)&&t.includes(String(d))&&t.includes(String(y));});
        if (o) { s.value=o.value; s.dispatchEvent(new Event('change')); return o.text; }
      }
      return null;
    }, month, day, year);
    console.log(`[DC] Date: ${picked}`);
    if (picked) {
      await Promise.race([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}), delay(15000)]);
      await delay(3000);
    }
  }

  // Thumbnails tab
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('a,button,li,span,td')].find(e=>/^thumbnails?$/i.test(e.textContent.trim()));
    if (t) { t.click(); return; }
    if (typeof __doPostBack==='function') try{__doPostBack('btn_thumbnails','');}catch(_){}
  });
  await delay(3000);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(),'dc_'));
  const allAds = [];

  for (const pgNum of [CLASSIFIEDS_PAGE, CLASSIFIEDS_PAGE+1]) {
    const imgPath = path.join(tmpDir, `page_${pgNum}.png`);

    // Primary: canvas export from viewer
    let gotImage = await getPageImageFromViewer(page, pgNum, imgPath);

    // Fallback: direct URL
    if (!gotImage || !fs.existsSync(imgPath) || fs.statSync(imgPath).size<5000) {
      console.log(`[DC] Falling back to direct URL download…`);
      const jpgPath = imgPath.replace('.png','.jpg');
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
          if (fs.statSync(jpgPath).size>5000) { gotImage=true; break; }
          try{fs.unlinkSync(jpgPath);}catch(_){}
        } catch(e) { console.log(`[DC] ✗ ${e.message.slice(0,50)}`); }
      }
    }

    if (!gotImage) { console.log(`[DC] Page ${pgNum}: no image`); continue; }

    const actualPath = fs.existsSync(imgPath) ? imgPath : imgPath.replace('.png','.jpg');
    console.log(`[DC] Image: ${(fs.statSync(actualPath).size/1024).toFixed(0)}KB`);

    try {
      // STEP 1: Extract ads via Claude Vision
      const rawAds = await extractAdsWithVision(actualPath);
      console.log(`[DC] Extracted: ${rawAds.length} raw items`);

      // STEP 2: Cross-verify — English only, real classifieds only, cleaned
      const verifiedAds = await crossVerifyAds(rawAds, dateStr, actualPath);

      // STEP 3: Build final objects
      const ads = buildAds(verifiedAds, targetDate);
      console.log(`[DC] Page ${pgNum}: ${ads.length} verified English ads`);
      allAds.push(...ads);

      if (pgNum===CLASSIFIEDS_PAGE && ads.length>10) {
        console.log(`[DC] Enough ads from page 8 — skipping page 9`);
        try{fs.unlinkSync(actualPath);}catch(_){} break;
      }
    } catch(e) {
      console.error(`[DC] Page ${pgNum} failed: ${e.message}`);
    }
    try{fs.unlinkSync(actualPath);}catch(_){}
  }

  try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch(_){}

  // Deduplicate
  const seen   = new Set();
  const unique = allAds.filter(ad=>{
    const k=`${ad.title}|${ad.phone}`;
    if(seen.has(k))return false; seen.add(k); return true;
  });
  console.log(`[DC] ${dateStr}: ${unique.length} unique verified English classified ads`);
  return unique;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  const dates=[],start=new Date(dateFrom||new Date()),end=new Date(dateTo||dateFrom||new Date());
  start.setHours(0,0,0,0); end.setHours(0,0,0,0);
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)) dates.push(new Date(d));
  console.log(`[DC] Dates: ${dates.map(isoDate).join(', ')}`);

  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1400,900'],
  });
  const summary = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({width:1400,height:900});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    for (const date of dates) {
      try {
        const ads    = await scrapeDate(page, date);
        const result = await saveAds(ads, date);
        console.log(`[DC] ✓ ${isoDate(date)}: inserted=${result.inserted} total=${ads.length}`);
        summary.push({date:isoDate(date), day:dayName(date), ...result, total:ads.length});
      } catch(err) {
        console.error(`[DC] ✗ ${isoDate(date)}: ${err.message}`);
        summary.push({date:isoDate(date), error:err.message});
      }
    }
  } finally {
    await browser.close();
    if (require.main===module) try{await db.end();}catch(_){}
  }
  console.log('\n[DC] ══ Done ══'); console.table(summary); return summary;
}

if (require.main===module) {
  const[,,a1,a2]=process.argv;
  scrapeAndSave(a1,a2).then(()=>process.exit(0)).catch(e=>{console.error('[DC] Fatal:',e.message);process.exit(1);});
}
module.exports = scrapeAndSave;
