
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
const { Jimp, ResizeStrategy } = require('jimp'); // pure-JS image crop/resize — no native build deps.
                                                    // npm install jimp (tested against jimp@1.6.1 API)

const NEWSPAPER        = 'Deccan Chronicle';
const STATES_URL       = 'http://epaper.deccanchronicle.com/states.aspx';
const CLASSIFIEDS_PAGE = 2; // City page with classifieds section, Hyderabad edition

// The classifieds box on a CITY page sits bottom-left (see reference
// screenshots): roughly the left half of the page, starting about halfway
// down. Generous padding on all sides so we never clip real ad text.
// If a future edition moves the box, adjust these fractions.
const CLASSIFIEDS_BOX_REGION = { xStart: 0, xEnd: 0.50, yStart: 0.48, yEnd: 1.0 };
const CLASSIFIEDS_ZOOM_TARGET_WIDTH = 1800; // upscale crop to at least this width

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

// ── STEP 1: Extract ads from image using Groq Vision ─────────────────────
// This prompt implements the full page-analysis pipeline: read the entire
// page first, classify every region (news / display ad / classified /
// notice / tender / etc.), locate classified sections by their heading
// words, then walk them line-by-line so no ad is skipped or truncated.
// The model still must return ONLY the JSON array below — the rigor lives
// in *how* it reads the page, not in a separate narrative report, since
// downstream code (buildAds/saveAds) needs strict JSON to run.
const EXTRACTION_PROMPT = `You are an advanced OCR, document-layout, and classified-ad extraction system specialized for Deccan Chronicle newspaper pages (Hyderabad edition).

STEP 1 — READ THE WHOLE PAGE FIRST.
Before extracting anything, scan the entire page top-to-bottom, left-to-right, and mentally tag every region as one of:
Headline, News Article, Editorial, Display Advertisement, Classified Advertisement, Public Notice, Tender Notice, Matrimonial, Recruitment / Situations Vacant, Property / Real Estate / Rentals, Education, Business Opportunity.

This page may be either:
1. A FULL CLASSIFIEDS PAGE (entire page filled with classified ads in multiple dense columns), or
2. A CITY PAGE with a boxed CLASSIFIEDS section, usually in the bottom-left corner.

STEP 2 — LOCATE CLASSIFIED SECTIONS.
Find every classified section using heading words such as: Classifieds, Situations Vacant, Recruitment, Wanted, Matrimonial, Property, Real Estate, Rentals, Education, Business Opportunities, Public Notices, Tender Notices. A page can contain more than one such section/column.

STEP 3 — READ EACH SECTION LINE BY LINE.
- Do not skip any line, including single-line ads packed tightly between others.
- An individual ad may span 1-4 lines — merge OCR fragments that clearly belong to the same ad into one entry.
- Preserve phone numbers, email addresses, prices, area/locality names, and any other contact detail exactly as printed. If a name is printed as part of the ad (owner name, contact person), keep it in the title/description exactly as spelled.
- Correct obvious OCR mistakes using surrounding context (e.g. "Regured" -> "Required", "Expenenced" -> "Experienced", "Electrca" -> "Electrical", "0"/"O" and "1"/"l" confusions, stray cent/section-sign symbols embedded in words) — but never invent details that are not visible on the page.
- Skip news articles, editorial content, and display/brand advertisements entirely — only extract individual classified listings.

CRITICAL — NEVER OUTPUT A HEADING AS IF IT WERE AN AD.
Headings like "CHANGE OF NAME", "BUSINESS OFFER", "SITUATION VACANT", "FOR SALE PROPERTY", "PUBLIC NOTICE", "TENDER NOTICE", "MATRIMONIAL" are CATEGORY LABELS, not ads. Every real ad must have actual body text underneath its heading: a name, item, job role, property description, phone number, or price. If you cannot read any body text under a heading — the box is empty, cut off, or too small to read — DO NOT output an entry for it. Do not invent a placeholder like "No ad", "Not mentioned" as the whole ad, or repeat the heading text as the description. Skipping a heading with no legible body is correct behavior; fabricating a hollow entry for it is a failure.
Bad output (never do this):
{"title": "SITUATION VACANT", "description": "Full-time", "phone": "", "price": "Not mentioned", ...}
{"title": "No ad", "description": "Not mentioned", ...}
Good output (only if real body text is visible):
{"title": "Accountant required, 5yrs exp", "description": "Wanted experienced accountant, 5yrs exp, good salary, call 9988776655", "phone": "9988776655", "email": "", ...}

STEP 4 — OUTPUT.
Return ONLY a valid JSON array (no markdown, no explanation, no page-analysis narrative — just the array):
[{
  "title": "first line or heading of the individual ad — include a person's name here if one is printed",
  "description": "complete full text of the ad, fragments merged, OCR-corrected",
  "phone": "10-digit number or empty string",
  "email": "email address exactly as printed, or empty string",
  "price": "price if mentioned or Not mentioned",
  "location": "area/locality in Hyderabad or empty string",
  "category": "Property | Jobs | Automotive | Matrimonial | Education | Tender | Notice | Other",
  "sub_category": "For Sale | For Rent | PG / Hostel | Full-time | Part-time | Used vehicle | Bride Sought | Groom Sought | Alliance | Tender Notice | Public Notice | General",
  "confidence": "High | Medium | Low"
}]

Example of what individual ads look like:
- "3BHK flat, Gachibowli, 1200sqft, Rs.85L, contact 9876543210"
- "Wanted experienced accountant, 5yrs exp, good salary, call 9988776655"
- "Maruti Swift 2019, good condition, Rs.4.5L, 8877665544"

If no individual classified ads are visible anywhere on the page, return: []`;

// ── DIAGNOSTIC: confirm the model can actually read the page ───────────────
// Runs every time before real extraction. Logs what the model sees —
// page date, headline text, whether it looks like classifieds — so we can
// tell "model is blind" apart from "this page genuinely has no ads yet".
const DIAGNOSTIC_PROMPT = `Look at this newspaper page image carefully. This is the CITY page of Deccan Chronicle.

Answer ONLY in this exact plain-text format, one line each, no markdown:
DATE_VISIBLE: <any date you can read on the page, or "none visible">
PAGE_NUMBER: <page number visible on the page, or "none visible">
CLASSIFIEDS_SECTION_VISIBLE: <yes | no — look for a section labeled CLASSIFIEDS, usually boxed, in bottom-left>
CLASSIFIEDS_COVERAGE: <boxed section | full page | none — "boxed section" if classifieds occupy roughly the bottom-left quarter/half of the page alongside news content; "full page" if classifieds/listings fill almost the entire page width and height>
SAMPLE_CLASSIFIED_TEXT: <copy first few words of any classified ad you see, or "none found">
NEWS_HEADLINES: <copy first headline you see>`;

// Returns the parsed diagnostic fields (not just logs them) so the caller
// can decide whether a classifieds section was reported visible even when
// the main extraction pass came back empty/near-empty — that mismatch is
// exactly what triggers the focused re-extraction pass below.
async function diagnosticCheck(imagePath) {
  try {
    const raw = await callGroq(imagePath, DIAGNOSTIC_PROMPT);
    console.log(`[DC] ── DIAGNOSTIC ──`);
    console.log(raw.trim());
    console.log(`[DC] ── END DIAGNOSTIC ──`);
    const get = (label) => {
      const m = raw.match(new RegExp(label + ':\\s*(.+)'));
      return m ? m[1].trim() : '';
    };
    return {
      classifiedsVisible: /^yes/i.test(get('CLASSIFIEDS_SECTION_VISIBLE')),
      coverage: get('CLASSIFIEDS_COVERAGE').toLowerCase(), // "boxed section" | "full page" | "none"
      sampleText: get('SAMPLE_CLASSIFIED_TEXT'),
    };
  } catch (e) {
    console.log(`[DC] DIAGNOSTIC FAILED: ${e.message}`);
    return { classifiedsVisible: false, coverage: '', sampleText: '' };
  }
}

// Focused re-extraction used only as a last-resort fallback — if the crop
// boundary missed the box for some reason, this re-attempt runs directly
// on the ORIGINAL full-page image and tells the model to ignore everything
// else and zoom into the classifieds box itself.
const ZOOM_CLASSIFIEDS_PROMPT = `Ignore every other part of this newspaper page — news, headlines, display ads, everything.
Focus ONLY on the boxed CLASSIFIEDS section (usually bottom-left, sometimes labeled with category headings like Situation Vacant, For Sale, Matrimonial, Public Notice, etc.).
Read every single line inside that box, no matter how small the font. Transcribe each individual listing separately — do not merge unrelated listings, and do not skip any because the text is dense or tiny.
Do NOT output a category heading on its own if there is no real ad text under it (see rules below).
Merge OCR fragments that clearly belong to the same ad. Preserve phone numbers, emails, prices, names, and locations exactly.

Return ONLY a valid JSON array, same schema as before:
[{
  "title": "first line or heading of the individual ad — include a person's name here if one is printed",
  "description": "complete full text of the ad, fragments merged, OCR-corrected",
  "phone": "10-digit number or empty string",
  "email": "email address exactly as printed, or empty string",
  "price": "price if mentioned or Not mentioned",
  "location": "area/locality in Hyderabad or empty string",
  "category": "Property | Jobs | Automotive | Matrimonial | Education | Tender | Notice | Other",
  "sub_category": "For Sale | For Rent | PG / Hostel | Full-time | Part-time | Used vehicle | Bride Sought | Groom Sought | Alliance | Tender Notice | Public Notice | General",
  "confidence": "High | Medium | Low"
}]

If, even after focusing only on this box, there is truly no legible ad text (only headings), return: []`;

// ── CROP + ZOOM: turn the full page screenshot into a close-up of just the
// classifieds box before it ever reaches the vision model. This is the main
// fix for dense small-print classifieds being unreadable in a full-page
// image: cropping throws away the irrelevant ~half of the page (news
// columns) and upscaling gives the model far more actual pixel detail on
// the text that matters.
//
// Returns { ready, imagePath, diagnostic, cropped }.
// - ready=false means: diagnostic found no classifieds section on this
//   page at all — caller should skip extraction entirely.
async function prepareClassifiedsImage(fullImagePath, tmpDir, pgNum) {
  const diagnostic = await diagnosticCheck(fullImagePath);

  if (!diagnostic.classifiedsVisible) {
    return { ready: false, imagePath: null, diagnostic, cropped: false };
  }

  const isFullPage = diagnostic.coverage.includes('full page');
  const outPath = path.join(tmpDir, `classifieds_${pgNum}.jpg`);

  try {
    const img = await Jimp.read(fullImagePath);
    const { width, height } = img.bitmap;

    if (!isFullPage) {
      const r = CLASSIFIEDS_BOX_REGION;
      const x = Math.round(r.xStart * width);
      const y = Math.round(r.yStart * height);
      const w = Math.round((r.xEnd - r.xStart) * width);
      const h = Math.round((r.yEnd - r.yStart) * height);
      img.crop({ x, y, w, h });
      console.log(`[DC] Page ${pgNum}: cropped to classifieds box (${w}x${h} from ${width}x${height})`);
    } else {
      console.log(`[DC] Page ${pgNum}: diagnostic says full-page classifieds — using whole page, no crop`);
    }

    if (img.bitmap.width < CLASSIFIEDS_ZOOM_TARGET_WIDTH) {
      img.resize({ w: CLASSIFIEDS_ZOOM_TARGET_WIDTH, mode: ResizeStrategy.BICUBIC });
      console.log(`[DC] Page ${pgNum}: upscaled to ${img.bitmap.width}x${img.bitmap.height} for legibility`);
    }

    await img.write(outPath, { quality: 92 });
    return { ready: true, imagePath: outPath, diagnostic, cropped: !isFullPage };
  } catch (e) {
    console.log(`[DC] Page ${pgNum}: crop/zoom failed (${e.message}) — falling back to original full page image`);
    return { ready: true, imagePath: fullImagePath, diagnostic, cropped: false };
  }
}

async function extractAdsWithVision(imagePath, diagnostic, fullImagePathForFallback) {
  const raw = await callGroq(imagePath, EXTRACTION_PROMPT);
  console.log(`[DC] Groq raw (200 chars): ${raw.slice(0, 200)}`);
  let ads = parseJSON(raw);

  // Safety net #1: still too few ads on the (likely cropped) image —
  // retry once with the more directive zoom-focus prompt on the same image.
  if (diagnostic.classifiedsVisible && ads.length < 2) {
    console.log(`[DC] Classifieds reported visible but only ${ads.length} ads found — retrying with focused prompt on same image...`);
    try {
      const zoomRaw = await callGroq(imagePath, ZOOM_CLASSIFIEDS_PROMPT);
      console.log(`[DC] Zoom pass raw (200 chars): ${zoomRaw.slice(0, 200)}`);
      const zoomAds = parseJSON(zoomRaw);
      console.log(`[DC] Zoom pass found ${zoomAds.length} ads`);
      const seen = new Set(ads.map(a => `${a.title}|${a.phone}`));
      for (const a of zoomAds) {
        const key = `${a.title}|${a.phone}`;
        if (!seen.has(key)) { seen.add(key); ads.push(a); }
      }
    } catch (e) {
      console.log(`[DC] Zoom pass failed: ${e.message}`);
    }
  }

  // Safety net #2: crop boundary may have missed the box entirely for this
  // day's layout — if we're still empty and we have the original full page
  // handy (and it's different from what we already tried), try that once.
  if (diagnostic.classifiedsVisible && ads.length === 0 &&
      fullImagePathForFallback && fullImagePathForFallback !== imagePath) {
    console.log(`[DC] Still 0 ads after crop+zoom — last resort: trying original full-page image...`);
    try {
      const fallbackRaw = await callGroq(fullImagePathForFallback, ZOOM_CLASSIFIEDS_PROMPT);
      const fallbackAds = parseJSON(fallbackRaw);
      console.log(`[DC] Full-page fallback found ${fallbackAds.length} ads`);
      ads = fallbackAds;
    } catch (e) {
      console.log(`[DC] Full-page fallback failed: ${e.message}`);
    }
  }

  return ads;
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
      `You are cross-verifying classified ads extracted from Deccan Chronicle, Hyderabad, ${dateStr}, against the ORIGINAL NEWSPAPER PAGE IMAGE.`,
      `I am giving you (1) the ORIGINAL IMAGE and (2) TEXT auto-extracted from it in a first pass.`,
      `The text may have OCR errors, merged/split ads, or misread contact details. Re-read the relevant lines in the image for each entry and correct it.`,
      ``,
      `FIRST-PASS TEXT (has errors):`,
      JSON.stringify(batch, null, 2),
      ``,
      `VERIFICATION RULES (check each entry against the image):`,
      `- Confirm the ad text against the actual printed line(s); fix garbled job titles, location names, company names.`,
      `- "Bonerpaly" -> "Bowenpally" (Hyderabad area)`,
      `- "Expenenced" -> "Experienced"`,
      `- "Electrca" -> "Electrical"`,
      `- "Regured" -> "Required"`,
      `- Symbols like cent sign or section sign mixed in words -> remove them`,
      `- "0" vs "O", "1" vs "l" -> use image context to decide`,
      `- Verify phone numbers digit-by-digit against the image; if a number can't be confirmed, leave phone empty rather than guessing.`,
      `- Verify any email address character-by-character against the image; if it can't be confirmed, leave email empty rather than guessing.`,
      `- If an entry is actually two ads merged together, split them into separate array items.`,
      `- If an entry is a fragment of a larger ad that continues on an adjacent line, merge it back into one item.`,
      `- Keep the "confidence" field: raise it to "High" once verified against the image, or lower it to "Low" if it still can't be confirmed.`,
      ``,
      `DROP these (not real classified ads):`,
      `- News headlines`,
      `- Section/category headers alone with no ad body (e.g. "SITUATION VACANT", "CHANGE OF NAME", "BUSINESS OFFER", "FOR SALE PROPERTY", "PUBLIC NOTICE" used as the title with generic filler like "Not mentioned" or "Full-time" as the only description)`,
      `- Any item whose title/description is literally a placeholder like "No ad", "None", "N/A", "Not mentioned" with nothing else`,
      `- Fragments under 5 meaningful words`,
      `- Mostly non-English (Telugu or Hindi) text`,
      `- Items where the title is just a phone number or location name`,
      `- Items with no phone number, no email, no real price, and under 8 words of description — these are almost certainly leftover headers, not ads`,
      `- Items still marked "confidence": "Low" after verification with fewer than 8 meaningful words`,
      ``,
      `Return ONLY a valid JSON array. Same schema, drop invalid items:`,
      `[{"title":"corrected title","description":"corrected English description",`,
      ` "phone":"10 digits or empty","email":"email exactly as printed or empty","price":"Rs.X L or Not mentioned",`,
      ` "location":"Hyderabad area or empty",`,
      ` "category":"Property|Jobs|Automotive|Matrimonial|Education|Tender|Notice|Other",`,
      ` "sub_category":"For Sale|For Rent|PG / Hostel|Full-time|Part-time|Used vehicle|Bride Sought|Groom Sought|Alliance|Tender Notice|Public Notice|General",`,
      ` "confidence":"High|Medium|Low"}]`,
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

// Categories the model may now emit (Education/Tender/Notice) get mapped
// back onto the DB's existing category set so we don't break any UI/enum
// that only expects Property | Jobs | Automotive | Matrimonial | Other.
// The original, more specific category is kept in sub_category context.
function normalizeCategory(cat) {
  const c = String(cat || '').trim();
  const known = ['Property', 'Jobs', 'Automotive', 'Matrimonial'];
  if (known.includes(c)) return c;
  if (c === 'Education' || c === 'Tender' || c === 'Notice') return 'Other';
  return 'Other';
}

// Section/category headings that the model sometimes echoes back as if
// they were individual ads (seen in production: "CHANGE OF NAME",
// "BUSINESS OFFER", "SITUATION VACANT", literally "No ad"). These are
// never real listings on their own — treat an exact/near match as a
// heading-echo unless the ad also carries real substance (phone/price/
// enough description) alongside it.
const HEADER_ECHO_TITLES = new Set([
  'change of name', 'business offer', 'business offers', 'situation vacant',
  'situations vacant', 'for sale property', 'for sale', 'for rent',
  'pg / hostel', 'pg/hostel', 'public notice', 'public notices',
  'tender notice', 'tender notices', 'matrimonial', 'wanted', 'recruitment',
  'real estate', 'rentals', 'education', 'business opportunities',
  'business opportunity', 'classifieds', 'classified', 'property',
  'general', 'no ad', 'none', 'n/a', 'not mentioned', 'not applicable',
]);

const PLACEHOLDER_DESCRIPTIONS = new Set([
  '', 'not mentioned', 'no ad', 'none', 'n/a', 'general', 'full-time',
  'part-time', 'not applicable',
]);

// An entry is "hollow" — a heading or placeholder masquerading as an ad —
// if it has no phone, no email, no real price, and either its title is a
// known heading/placeholder or its description is too thin to be an actual ad.
function isHollowAd(rawAd, cleanedPhone, cleanedEmail) {
  const title = String(rawAd.title || '').trim().toLowerCase();
  const desc  = String(rawAd.description || '').trim().toLowerCase();
  const price = String(rawAd.price || '').trim().toLowerCase();

  const hasPhone       = !!cleanedPhone;
  const hasEmail        = !!cleanedEmail;
  const hasRealPrice   = price && price !== 'not mentioned' && price !== 'n/a';
  const descWordCount  = desc ? desc.split(/\s+/).filter(Boolean).length : 0;

  if (hasPhone || hasEmail || hasRealPrice) return false; // has a concrete contact/price — trust it

  const titleIsHeading      = HEADER_ECHO_TITLES.has(title);
  const descIsPlaceholder   = PLACEHOLDER_DESCRIPTIONS.has(desc);
  const descTooThin         = descWordCount < 8;

  if (titleIsHeading && (descIsPlaceholder || descTooThin)) return true;
  if (descIsPlaceholder && descTooThin) return true;
  if (!hasPhone && !hasEmail && !hasRealPrice && descTooThin && titleIsHeading) return true;

  return false;
}

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

  function cleanEmail(e) {
    if (!e) return '';
    const trimmed = String(e).trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(trimmed) ? trimmed.toLowerCase() : '';
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

  let droppedHollow = 0;

  const result = verifiedAds
    .filter(a => a && typeof a === 'object')
    .filter(a => {
      const txt = `${a.title || ''} ${a.description || ''}`.trim();
      if (txt.length < 10) return false;
      if (!isEnglish(txt)) return false;
      // Drop anything still flagged Low confidence with too little content
      // (mirrors the verify-prompt drop rule, in case the model missed it).
      const confidence = String(a.confidence || '').toLowerCase();
      if (confidence === 'low' && txt.split(/\s+/).length < 8) return false;
      return true;
    })
    .filter(a => {
      const phoneRaw = cleanPhone(a.phone);
      const emailRaw = cleanEmail(a.email);
      if (isHollowAd(a, phoneRaw, emailRaw)) { droppedHollow++; return false; }
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
        category:       normalizeCategory(a.category),
        sub_category:   a.sub_category || 'General',
        title,
        description:    String(a.description || '').trim(),
        location:       cleanLocation(a.location || '', a.description || ''),
        price:          a.price     || 'Not mentioned',
        size_area:      a.size_area || 'Not mentioned',
        phone:          cleanPhone(a.phone),
        email:          cleanEmail(a.email),
        confidence:     a.confidence || 'Medium',
        source: 'scraper', newspaper_name: NEWSPAPER,
      };
    });

  if (droppedHollow > 0) {
    console.log(`[DC] Dropped ${droppedHollow} hollow/header-echo entries (no phone/price/body text)`);
  }
  return result;
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
        ad.phone, '', ad.email || '', ad.newspaper_name,
      ]);
      r.affectedRows > 0 ? inserted++ : skipped++;
    } catch (e) { console.error('[DC] Row:', e.message); skipped++; }
  }
  return { inserted, skipped };
}

// ── Get CITY page number dynamically from thumbnail strip ──────────────────
async function getCityPageNum(page) {
  const pgNum = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const t = el.textContent.trim().toUpperCase();
      // Match labels like CITY(5), CITY (6), CITY-7, CITY:8 — take the first one
      const match = t.match(/^CITY\s*[\(\-:]?\s*(\d{1,2})\s*\)?$/);
      if (match) return parseInt(match[1]);
    }
    return null;
  });
  console.log(`[DC] CITY page detected: ${pgNum}`);
  return pgNum;
}
async function getPageImageFromViewer(page, pgNum, outPath) {
  console.log(`[DC] Clicking page ${pgNum} in viewer...`);
  await page.evaluate((n) => {
    // Try clicking by page number label first (most reliable)
    const all = [...document.querySelectorAll('*')];

    // Look for thumbnail labels like "CITY(5)", "POLITICS(2)", "MAIN(1)" etc.
    for (const el of all) {
      const t = el.textContent.trim().toUpperCase();
      const match = t.match(/^[A-Z]+\((\d+)\)$/);
      if (match && parseInt(match[1]) === n) {
        (el.closest('a,td,div,li') || el).click(); return;
      }
    }

    // Fallback: try __doPostBack
    if (typeof __doPostBack === 'function') {
      for (const [t, a] of [['lnk_page_'+n,''],['lnkPage'+n,''],['GridView1','Page$'+n]]) {
        try { __doPostBack(t, a); return; } catch (_) {}
      }
    }
  }, pgNum);
  await delay(8000); // wait longer for page image to fully render

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
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
      delay(20000),
    ]);
    await delay(5000); // extra wait for image to fully load after date change
  } else {
    console.log('[DC] Date not in dropdown — viewer may already be on correct date');
    await delay(3000);
  }

  await page.evaluate(() => {
    const t = [...document.querySelectorAll('a,button,li,span,td')]
      .find(e => /^thumbnails?$/i.test(e.textContent.trim()));
    if (t) { t.click(); return; }
    if (typeof __doPostBack === 'function') try { __doPostBack('btn_thumbnails', ''); } catch (_) {}
  });
  await delay(3000);

  // ── Find CITY/CLASSIFIED pages from thumbnail strip, then scan only those ─
  // Some editions label the classifieds thumbnail directly (e.g. "CLASSIFIED(7)")
  // instead of / in addition to "CITY(n)", and separators vary (parens, dash,
  // colon, or just a space) — so the regex tolerates all of those and we union
  // both label families rather than only trusting "CITY".
  const allPageLabels = await page.evaluate(() => {
    const seen = new Set();
    const pages = [];
    for (const el of document.querySelectorAll('*')) {
      const t = el.textContent.trim().toUpperCase();
      const match = t.match(/^([A-Z]+)\s*[\(\-:]?\s*(\d{1,2})\s*\)?$/);
      if (match && !seen.has(`${match[1]}-${match[2]}`)) {
        seen.add(`${match[1]}-${match[2]}`);
        pages.push({ label: match[1], num: parseInt(match[2]) });
      }
    }
    return pages;
  });
  console.log(`[DC] All thumbnail labels found: ${JSON.stringify(allPageLabels)}`);

  const cityNums = allPageLabels
    .filter(p => p.label === 'CITY' || p.label.startsWith('CLASSIFIED'))
    .map(p => p.num);
  const uniqueSorted = [...new Set(cityNums)].sort((a, b) => a - b);
  // Fallback to pages 2,5,8 if no CITY/CLASSIFIED pages detected at all
  const pagesToScan = uniqueSorted.length > 0 ? uniqueSorted : [2, 5, 8];
  console.log(`[DC] Scanning pages: ${pagesToScan.join(', ')}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_'));
  const allAds = [];

  for (let pgNum of pagesToScan) {
    const imgPath = path.join(tmpDir, `page_${pgNum}.jpg`);

    const gotImage = await getPageImageFromViewer(page, pgNum, imgPath);
    if (!gotImage || !fs.existsSync(imgPath) || fs.statSync(imgPath).size < 5000) {
      console.log(`[DC] Page ${pgNum}: no image — skipping`);
      try { fs.unlinkSync(imgPath); } catch (_) {}
      continue;
    }
    console.log(`[DC] Page ${pgNum}: image ${(fs.statSync(imgPath).size/1024).toFixed(0)}KB — checking for classifieds section...`);

    try {
      const { ready, imagePath: classifiedsImgPath, diagnostic } = await prepareClassifiedsImage(imgPath, tmpDir, pgNum);
      if (!ready) {
        console.log(`[DC] Page ${pgNum}: no classifieds section detected — skipping extraction`);
      } else {
        console.log(`[DC] Page ${pgNum}: classifieds detected (coverage="${diagnostic.coverage}", sample="${diagnostic.sampleText}") — extracting from ${classifiedsImgPath === imgPath ? 'full page' : 'cropped+zoomed'} image...`);
        const rawAds = await extractAdsWithVision(classifiedsImgPath, diagnostic, imgPath);
        console.log(`[DC] Page ${pgNum}: ${rawAds.length} raw ads extracted`);
        if (rawAds.length > 0) {
          console.log(`[DC] Page ${pgNum} sample: ${JSON.stringify(rawAds[0]).slice(0, 150)}`);
          const verifiedAds = await crossVerifyAds(rawAds, dateStr, classifiedsImgPath);
          const ads = buildAds(verifiedAds, targetDate);
          console.log(`[DC] Page ${pgNum}: ${ads.length} verified classified ads`);
          allAds.push(...ads);
        }
        if (classifiedsImgPath !== imgPath) {
          try { fs.unlinkSync(classifiedsImgPath); } catch (_) {}
        }
      }
    } catch (e) {
      console.error(`[DC] Page ${pgNum} failed: ${e.message}`);
    }
    try { fs.unlinkSync(imgPath); } catch (_) {}
    await delay(5000); // pause between Groq calls
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1920,1080'],
  });
  const summary = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
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
