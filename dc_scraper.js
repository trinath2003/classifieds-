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

const NEWSPAPER        = 'Deccan Chronicle';
const STATES_URL       = 'http://epaper.deccanchronicle.com/states.aspx';
const CLASSIFIEDS_PAGE = 8;
const NUM_COLUMNS      = 5;
const SCALE            = 3;

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
function isoDate(d) { return toIST(d).toISOString().slice(0,10); }
function dayName(d) { return toIST(d).toLocaleDateString('en-IN',{weekday:'long',timeZone:'Asia/Kolkata'}); }

// ── Download ───────────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Referer': STATES_URL,
    }}, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ── STEP 1: Preprocess image → clean B&W PNG at 3× scale ─────────────────
// WHY: The DC classifieds JPEG has:
//   • Compression artifacts that confuse Tesseract
//   • Colored section headers (red/blue boxes) that OCR reads as noise
//   • Tiny ~8px text that needs upscaling
// FIX: Canvas binarization (threshold) converts everything to pure black
//   or pure white. Colored boxes become black-on-white. JPEG noise disappears.
//   Then we scale 3× so text is ~24px — well above Tesseract's 20px minimum.
async function preprocessToBW(rawJpegPath, outPngPath, browser) {
  const base64  = fs.readFileSync(rawJpegPath).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const pg = await browser.newPage();
  try {
    await pg.setContent(`
      <html><head><style>*{margin:0;padding:0}</style></head>
      <body>
        <img  id="src" src="${dataUrl}" style="display:none">
        <canvas id="c"></canvas>
      </body></html>
    `);
    await pg.waitForSelector('#src');
    await delay(300);

    const pngBase64 = await pg.evaluate((scale) => {
      const img = document.getElementById('src');
      const c   = document.getElementById('c');
      c.width   = img.naturalWidth  * scale;
      c.height  = img.naturalHeight * scale;

      const ctx = c.getContext('2d');

      // Draw scaled image
      ctx.drawImage(img, 0, 0, c.width, c.height);

      // Binarize: grayscale then threshold at 160
      // Below 160 → black (captures light gray text too)
      // Above 160 → white
      const imgData = ctx.getImageData(0, 0, c.width, c.height);
      const px      = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        const gray = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        const bw   = gray < 160 ? 0 : 255;
        px[i] = px[i+1] = px[i+2] = bw;
        px[i+3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      return c.toDataURL('image/png').split(',')[1];
    }, SCALE);

    fs.writeFileSync(outPngPath, Buffer.from(pngBase64, 'base64'));
    const stat = fs.statSync(outPngPath);
    console.log(`[DC] Preprocessed B&W PNG: ${(stat.size/1024).toFixed(0)}KB`);
    return true;
  } catch(e) {
    console.log(`[DC] Preprocess failed: ${e.message} — using raw`);
    fs.copyFileSync(rawJpegPath, outPngPath);
    return false;
  } finally {
    await pg.close();
  }
}

// ── STEP 2: OCR each column separately ────────────────────────────────────
// WHY: Tesseract reads a 5-column page row-by-row, mixing all 5 columns.
// FIX: Crop each column from the B&W PNG, OCR it alone top-to-bottom.
async function ocrColumn(bwPngPath, col, browser, tmpDir) {
  // Get image dimensions first
  const base64  = fs.readFileSync(bwPngPath).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;

  const pg = await browser.newPage();
  const colPng = path.join(tmpDir, `col_${col}.png`);

  try {
    // Get natural dimensions
    await pg.setContent(`<html><body style="margin:0"><img id="i" src="${dataUrl}"></body></html>`);
    await pg.waitForSelector('#i');
    const dims = await pg.$eval('#i', el => ({ w: el.naturalWidth, h: el.naturalHeight }));

    const colW = Math.floor(dims.w / NUM_COLUMNS);
    const x    = col * colW;
    const w    = col === NUM_COLUMNS - 1 ? dims.w - x : colW;

    // Crop to this column
    await pg.setViewport({ width: w, height: dims.h });
    await pg.setContent(`
      <html><head><style>
        *{margin:0;padding:0}
        body{background:#fff;overflow:hidden;width:${w}px;height:${dims.h}px}
        img{position:absolute;left:${-x}px;top:0;width:${dims.w}px;height:auto}
      </style></head>
      <body><img src="${dataUrl}"></body>
    `);
    await pg.waitForSelector('img');
    await delay(300);
    await pg.screenshot({ path: colPng });

    // PSM 6 = single uniform text block — perfect for one column read top-to-bottom
    const { data } = await Tesseract.recognize(colPng, 'eng', {
      logger: () => {},
      tessedit_pageseg_mode:     '6',
      tessedit_ocr_engine_mode:  '1',  // LSTM
      preserve_interword_spaces: '1',
    });

    const preview = data.text.slice(0,150).replace(/\n/g,' ');
    console.log(`[DC] Col ${col+1}: "${preview}"`);
    return data.text;
  } catch(e) {
    console.log(`[DC] Col ${col+1} OCR failed: ${e.message}`);
    return '';
  } finally {
    await pg.close();
    try{fs.unlinkSync(colPng);}catch(_){}
  }
}

// ── Classifier / Parser ────────────────────────────────────────────────────
const DC_SECTIONS = new Set([
  'FOR SALE AUTOMOTIVE','FOUR WHEELERS','TWO WHEELERS',
  'FOR SALE PROPERTY','COMMERCIAL','MULTIPLE FLATS','INDEPENDENT HOUSE',
  'DOUBLE BEDROOM','THREE MORE','THREE & MORE','FARM HOUSES SITES',
  'FLATS','SINGLE BEDROOM','PLOTS','VILLAS','INDEPENDENT HOUSES',
  'LEASE','RENTALS','COMMERCIAL RENTALS','INDUSTRIAL LAND','FOR RENT',
  'MULTIPLE VACANCIES','ACCOUNTANT','ACCOUNTANT TALLY','SECURITY',
  'FIELD OFFICERS','TEACHERS','WANTED','WANTED LADY',
  'ACCOUNTS FINANCE','ACCOUNTS & FINANCE','SALES MARKETING',
  'ADVI SALES MKTG','ENGINEERS','HOTEL','LAW OFFICES','LECTURERS',
  'FURNITURE','FINANCE','BUILDING MATERIALS','LOST','POULTRY',
  'NOTICE','MATRIMONIAL','BRIDE WANTED','GROOM WANTED','TUTORS',
  'CLASSIFIEDS',
]);

function normalizeCategory(section, text) {
  const t = (section+' '+text).toUpperCase();
  if (/(AUTOMOTIVE|FOUR WHEELER|TWO WHEELER|CAR |BIKE|VEHICLE|SUV|SCOOTER)/.test(t))   return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|ALLIANCE)/.test(t))                                     return 'Matrimonial';
  if (/(VACANC|ACCOUNTANT|SECURITY|FIELD OFFICER|TEACHER|ENGINEER|LECTURER|HOTEL|LAW OFFICE|SALES|MARKET|RECRUIT|OPENING|TALLY|TUTOR)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|RENTAL|PLOT|FLAT|HOUSE|LAND|VILLA|APART|SHOP|BHK|SQFT|BEDROOM|LEASE|COMMERCIAL|FARM|INDUSTRIAL|HOSTEL|PG\b)/.test(t)) return 'Property';
  return 'Other';
}
function normalizeSubCategory(category, text) {
  const l = text.toLowerCase();
  if (category==='Property') {
    if (l.includes('rent')||l.includes('lease'))                           return 'For Rent';
    if (l.includes('pg')||l.includes('hostel')||l.includes('paying guest')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category==='Automotive')  return 'Used vehicle';
  if (category==='Jobs')        return l.includes('part') ? 'Part-time' : 'Full-time';
  if (category==='Matrimonial') {
    if (l.includes('bride')||l.includes('girl')) return 'Bride Sought';
    if (l.includes('groom')||l.includes('boy'))  return 'Groom Sought';
    return 'Alliance';
  }
  return 'General';
}
function extractPhone(text) {
  const m = text.match(/(?:\+91[-\s]?)?[6-9GoOqQBb][0-9GoOqQBb]{9}/);
  if (!m) return '';
  const f = m[0].replace(/[Oo]/g,'0').replace(/[Gg]/g,'6').replace(/[qQ]/g,'9').replace(/[Bb]/g,'8').replace(/\D/g,'');
  return f.length>=10 ? f.slice(-10) : '';
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
  'Chintal','Jeedimetla','Balanagar','SR Nagar','Erragadda','Sanath Nagar',
];
function extractLocation(text) {
  const l = text.toLowerCase();
  for (const loc of HYD_LOCALITIES) if (l.includes(loc.toLowerCase())) return `${loc}, Hyderabad`;
  return '';
}

function parseColumn(colText, publishDate) {
  const ads    = [];
  const today  = isoDate(publishDate);
  const dayPub = dayName(publishDate);
  const lines  = colText
    .replace(/[✓√]/g,'').replace(/\|{2,}/g,'')
    .replace(/['']/g,"'").replace(/[""]/g,'"').replace(/§/g,'S')
    .split('\n').map(l=>l.trim()).filter(l=>l.length>1);

  let currentSection = 'CLASSIFIEDS';
  let block = [];

  function isSectionHeader(line) {
    const alpha = line.replace(/[^a-zA-Z]/g,'');
    if (alpha.length < 3 || line.length > 40) return false;
    const upRatio = line.replace(/[^A-Z]/g,'').length / alpha.length;
    if (upRatio < 0.75) return false;
    if (/\b(the|and|for|with|near|sqft|bhk|contact|call|ph:|mob:|email|apply|road|nagar)\b/i.test(line)) return false;
    if (/\d{5,}/.test(line)) return false;
    const up = line.toUpperCase().replace(/[^A-Z\s&]/g,'').trim();
    if (DC_SECTIONS.has(up)) return true;
    const words = up.split(/\s+/).filter(Boolean);
    if (words.length>=1 && words.length<=4 && upRatio>0.85 && !/\d/.test(line)) return true;
    return false;
  }

  function flushBlock() {
    if (!block.length) return;
    const text = block.join(' ').trim();
    if (text.length < 15) { block=[]; return; }
    const phone        = extractPhone(text);
    const category     = normalizeCategory(currentSection, text);
    const sub_category = normalizeSubCategory(category, currentSection+' '+text);
    let title = block.find(l=>l.length>4)?.replace(/^[^a-zA-Z0-9₹]+/,'').slice(0,120).trim() || text.slice(0,80);
    ads.push({
      date_published:today, day_published:dayPub, category, sub_category, title,
      description:text, location:extractLocation(text), price:extractPrice(text),
      size_area:extractSize(text), phone, source:'scraper', newspaper_name:NEWSPAPER,
    });
    block=[];
  }

  for (const line of lines) {
    if (/^[\-–—=_*#.]+$/.test(line)||/^\d{1,3}$/.test(line)) { flushBlock(); continue; }
    if (isSectionHeader(line)) {
      flushBlock(); currentSection=line.toUpperCase().trim();
      console.log(`[DC]   § ${currentSection}`); continue;
    }
    block.push(line);
    if (extractPhone(line)) flushBlock();
  }
  flushBlock();
  return ads;
}

// ── Classifieds page validator ─────────────────────────────────────────────
function isClassifiedsPage(text) {
  const phones = (text.match(/[6-9][0-9OoGgQqBb]{9}/g)||[]).length;
  const lines  = text.split('\n').filter(l=>l.trim());
  const short  = lines.filter(l=>l.trim().length<80).length;
  const long   = lines.filter(l=>l.trim().length>150).length;
  const score  = phones*3 + short - long*2;
  console.log(`[DC] Classifieds check: phones=${phones} score=${score}`);
  return score >= 8;
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
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'scraper','active',?,NOW())
      `, [
        ad.date_published, ad.day_published, ad.category, ad.sub_category,
        ad.title, ad.description, ad.location, ad.price, ad.size_area,
        ad.phone, '', '', ad.newspaper_name,
      ]);
      r.affectedRows>0 ? inserted++ : skipped++;
    } catch(e) { console.error('[DC] Row error:',e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Core scrape ────────────────────────────────────────────────────────────
async function scrapeDate(page, browser, targetDate) {
  const dateStr        = isoDate(targetDate);
  const [yyyy,mm,dd]   = dateStr.split('-');
  const todayStr       = isoDate(new Date());
  console.log(`\n[DC] ══ Scraping ${dateStr} (${dayName(targetDate)}) ══`);

  // Navigate states.aspx → HYDERABAD
  await page.goto(STATES_URL,{waitUntil:'networkidle2',timeout:60000});
  await delay(2000);
  await page.evaluate(()=>{
    const a=[...document.querySelectorAll('a')].find(x=>x.textContent.trim().toUpperCase()==='HYDERABAD');
    if(a)a.click();
  });
  await Promise.race([page.waitForNavigation({waitUntil:'networkidle2',timeout:20000}),delay(20000)]);
  await delay(3000);
  console.log(`[DC] Viewer: ${page.url()}`);

  // Select date
  if (dateStr !== todayStr) {
    const ist=toIST(targetDate);
    const month=ist.toLocaleDateString('en-US',{month:'short'});
    const day=ist.getDate(), year=ist.getFullYear();
    const picked = await page.evaluate((m,d,y)=>{
      for(const sel of document.querySelectorAll('select')){
        const opt=[...sel.options].find(o=>o.text.replace(/\s+/g,' ').includes(m)&&o.text.includes(String(d))&&o.text.includes(String(y)));
        if(opt){sel.value=opt.value;sel.dispatchEvent(new Event('change'));return opt.text;}
      }
      return null;
    },month,day,year);
    console.log(`[DC] Date: ${picked}`);
    if(picked){await Promise.race([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}),delay(15000)]);await delay(3000);}
  }

  // Thumbnails tab
  await page.evaluate(()=>{
    const t=[...document.querySelectorAll('a,button,li,span,td')].find(e=>/^thumbnails?$/i.test(e.textContent.trim()));
    if(t){t.click();return;}
    if(typeof __doPostBack==='function')try{__doPostBack('btn_thumbnails','');}catch(_){}
  });
  await delay(3000);

  // DOM img URL for page 8
  const domImgUrl = await page.evaluate(n=>{
    return [...document.querySelectorAll('img')].map(i=>i.src)
      .find(s=>s&&(s.includes('.jpg')||s.includes('.png'))&&
               (new RegExp(`[/_]0*${n}[._]`).test(s)||s.endsWith(`/${n}.jpg`))&&
               !s.includes('logo')&&!s.includes('icon'))||null;
  },CLASSIFIEDS_PAGE);
  console.log(`[DC] DOM img URL: ${domImgUrl}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(),'dc_'));
  const allAds = [];

  for (const pgNum of [CLASSIFIEDS_PAGE, CLASSIFIEDS_PAGE+1]) {
    const candidates = [
      ...(pgNum===CLASSIFIEDS_PAGE&&domImgUrl?[domImgUrl]:[]),
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/HYD/${yyyy}/${mm}/${dd}/HYD${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/PageImages/Hyderabad/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
      `http://epaper.deccanchronicle.com/epaperimages/HYD/${yyyy}/${mm}/${dd}/${pgNum}.jpg`,
    ];

    const rawPath = path.join(tmpDir,`raw_${pgNum}.jpg`);
    let downloaded=false;
    for(const url of candidates){
      try{
        console.log(`[DC] Downloading page ${pgNum}: ${url}`);
        await downloadFile(url,rawPath);
        const sz=fs.statSync(rawPath).size;
        if(sz<5000){try{fs.unlinkSync(rawPath);}catch(_){}continue;}
        console.log(`[DC] ✓ ${(sz/1024).toFixed(0)}KB`);
        downloaded=true; break;
      }catch(e){console.log(`[DC] ✗ ${e.message.slice(0,50)}`);try{fs.unlinkSync(rawPath);}catch(_){}}
    }
    if(!downloaded){console.log(`[DC] Page ${pgNum}: not found`);continue;}

    // Quick check: is this actually classifieds?
    const quickOcr=await Tesseract.recognize(rawPath,'eng',{logger:()=>{},tessedit_pageseg_mode:'3',tessedit_ocr_engine_mode:'0'});
    if(!isClassifiedsPage(quickOcr.data.text)){
      console.log(`[DC] Page ${pgNum}: not classifieds`);
      try{fs.unlinkSync(rawPath);}catch(_){}
      if(pgNum>CLASSIFIEDS_PAGE)break; continue;
    }
    console.log(`[DC] Page ${pgNum}: ✓ Classifieds — preprocessing…`);

    // STEP 1: Preprocess → clean B&W PNG at 3×
    const bwPath = path.join(tmpDir,`bw_${pgNum}.png`);
    await preprocessToBW(rawPath, bwPath, browser);
    try{fs.unlinkSync(rawPath);}catch(_){}

    // STEP 2: OCR each of the 5 columns separately
    console.log(`[DC] OCR-ing ${NUM_COLUMNS} columns…`);
    const colTexts = [];
    for(let col=0;col<NUM_COLUMNS;col++){
      const text = await ocrColumn(bwPath, col, browser, tmpDir);
      colTexts.push(text);
    }
    try{fs.unlinkSync(bwPath);}catch(_){}

    // Parse each column
    let pageAds=0;
    for(let col=0;col<colTexts.length;col++){
      const parsed=parseColumn(colTexts[col],targetDate);
      console.log(`[DC] Col ${col+1}: ${parsed.length} ads`);
      allAds.push(...parsed);
      pageAds+=parsed.length;
    }
    console.log(`[DC] Page ${pgNum} total: ${pageAds} ads`);
  }

  try{fs.rmSync(tmpDir,{recursive:true,force:true});}catch(_){}

  const seen=new Set();
  const unique=allAds.filter(ad=>{
    const k=`${ad.title}|${ad.phone}`;
    if(seen.has(k))return false; seen.add(k); return true;
  });
  console.log(`[DC] ${dateStr}: ${unique.length} unique ads`);
  return unique;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function scrapeAndSave(dateFrom, dateTo) {
  const dates=[], start=new Date(dateFrom||new Date()), end=new Date(dateTo||dateFrom||new Date());
  start.setHours(0,0,0,0); end.setHours(0,0,0,0);
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1))dates.push(new Date(d));
  console.log(`[DC] Dates: ${dates.map(isoDate).join(', ')}`);

  const browser=await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1400,900'],
  });
  const summary=[];
  try {
    const page=await browser.newPage();
    await page.setViewport({width:1400,height:900});
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    for(const date of dates){
      try{
        const ads=await scrapeDate(page,browser,date);
        const result=await saveAds(ads,date);
        console.log(`[DC] ✓ ${isoDate(date)}: inserted=${result.inserted} total=${ads.length}`);
        summary.push({date:isoDate(date),day:dayName(date),...result,total:ads.length});
      }catch(err){
        console.error(`[DC] ✗ ${isoDate(date)}: ${err.message}`);
        summary.push({date:isoDate(date),error:err.message});
      }
    }
  } finally {
    await browser.close();
    if(require.main===module){try{await db.end();}catch(_){}}
  }
  console.log('\n[DC] ══ Done ══'); console.table(summary); return summary;
}

if(require.main===module){
  const[,,a1,a2]=process.argv;
  scrapeAndSave(a1,a2).then(()=>process.exit(0)).catch(e=>{console.error('[DC] Fatal:',e.message);process.exit(1);});
}
module.exports=scrapeAndSave;
