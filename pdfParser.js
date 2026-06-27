require('dotenv').config();
const pdfParse = require('pdf-parse');
const mysql    = require('mysql2/promise');

// ── DB pool — respects MYSQL_URL (Railway) OR individual env vars (local) ──
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

function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}

function normalizeCategory(raw) {
  const t = String(raw || '').toUpperCase();
  if (/(AUTOMOTIVE|CAR|BIKE|VEHICLE|SCOOTER|MOTORCYCLE)/.test(t)) return 'Automotive';
  if (/(MATRIMONIAL|BRIDE|GROOM|ALLIANCE)/.test(t))               return 'Matrimonial';
  if (/(JOB|JOBS|VACANCY|HIRING|RECRUIT|CAREER|WANTED)/.test(t)) return 'Jobs';
  if (/(PROPERTY|RENT|PLOT|FLAT|HOUSE|LAND|VILLA|BHK|PG)/.test(t)) return 'Property';
  return 'Other';
}

function normalizeSubCategory(category, raw) {
  const lower = String(raw || '').toLowerCase();
  if (category === 'Property') {
    if (lower.includes('rent') || lower.includes('lease')) return 'For Rent';
    if (lower.includes('pg') || lower.includes('hostel')) return 'PG / Hostel';
    return 'For Sale';
  }
  if (category === 'Automotive') return 'Used vehicle';
  if (category === 'Jobs')       return lower.includes('part') ? 'Part-time' : 'Full-time';
  return raw || 'General';
}

async function parsePdfAndSave(pdfBuffer) {
  try {
    console.log('[PDF] Reading PDF…');
    const { text } = await pdfParse(pdfBuffer);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const today  = new Date().toISOString().slice(0, 10);
    const dayPub = dayName(new Date());
    const ads    = [];

    for (const line of lines) {
      if (/^(PROPERTY|MATRIMONIAL|JOBS|AUTOMOTIVE)/i.test(line)) {
        const parts = line.split('\t');
        if (parts.length >= 4) {
          const rawCat  = parts[0]?.trim() || 'Other';
          const rawSub  = parts[1]?.trim() || '';
          const title   = parts[2]?.trim() || '';
          const location= parts[3]?.trim() || '';
          const price   = parts[4]?.trim() || 'Not mentioned';
          const size    = parts[5]?.trim() || 'Not mentioned';
          const phone   = parts[6]?.trim() || '';
          const desc    = parts[7]?.trim() || '';

          const category    = normalizeCategory(rawCat);
          const sub_category = normalizeSubCategory(category, rawSub);

          if (title && phone) {
            ads.push({
              date_published: today,
              day_published:  dayPub,
              category,
              sub_category,
              title,
              description:    desc,
              location,
              price,
              size_area:      size,
              phone,
              whatsapp:       '',
              email:          '',
              source:         'pdf',
              status:         'active',
              newspaper_name: 'Deccan Chronicle',
            });
          }
        }
      }
    }

    if (!ads.length) {
      console.log('[PDF] No structured ads found — trying free-text parse');
      // Fallback: treat the whole PDF as free text and extract any phone numbers
      const phoneRe = /[6-9]\d{9}/g;
      let match;
      let blockStart = 0;
      const fullText = text;
      while ((match = phoneRe.exec(fullText)) !== null) {
        const phone   = match[0];
        const snippet = fullText.slice(Math.max(0, match.index - 120), match.index + 20).replace(/\n/g, ' ').trim();
        const title   = snippet.slice(0, 80).trim() || 'Ad from PDF';
        ads.push({
          date_published: today,
          day_published:  dayPub,
          category:       'Other',
          sub_category:   'General',
          title,
          description:    snippet,
          location:       '',
          price:          'Not mentioned',
          size_area:      'Not mentioned',
          phone,
          whatsapp:       '',
          email:          '',
          source:         'pdf',
          status:         'active',
          newspaper_name: 'Deccan Chronicle',
        });
      }
    }

    if (!ads.length) {
      return { success: false, message: 'No ads found in PDF. Make sure it contains tab-separated classifieds or phone numbers.' };
    }

    // Insert using correct lowercase column names
    let saved = 0;
    for (const ad of ads) {
      try {
        const [r] = await db.query(`
          INSERT IGNORE INTO classified_ads
            (date_published, day_published, category, sub_category,
             title, description, location, price, size_area,
             phone, whatsapp, email, source, status, newspaper_name, scraped_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          ad.date_published, ad.day_published,
          ad.category, ad.sub_category,
          ad.title, ad.description,
          ad.location, ad.price, ad.size_area,
          ad.phone, ad.whatsapp, ad.email,
          ad.source, ad.status, ad.newspaper_name,
        ]);
        if (r.affectedRows > 0) saved++;
      } catch (e) {
        console.error('[PDF] Row error:', e.message);
      }
    }

    console.log(`[PDF] Done — ${saved}/${ads.length} ads saved`);
    return { success: true, total: ads.length, saved };

  } catch (err) {
    console.error('[PDF] Error:', err.message);
    return { success: false, message: err.message };
  }
}

module.exports = parsePdfAndSave;
