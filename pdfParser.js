require('dotenv').config();
const pdfParse = require('pdf-parse');
const mysql    = require('mysql2/promise');

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'newspaper_db'
});

function dayName(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long' });
}

async function parsePdfAndSave(pdfBuffer) {
  try {
    console.log('[PDF] Reading PDF…');
    const { text } = await pdfParse(pdfBuffer);
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const ads = [];

    for (const line of lines) {
      if (/^(PROPERTY|MATRIMONIAL|JOBS|AUTOMOTIVE)/i.test(line)) {
        const parts = line.split('\t');
        if (parts.length >= 4) {
          const category = parts[0]?.trim() || 'General';
          const sub      = parts[1]?.trim() || 'General';
          const title    = parts[2]?.trim() || '';
          const location = parts[3]?.trim() || '';
          const price    = parts[4]?.trim() || 'Not mentioned';
          const size     = parts[5]?.trim() || 'Not mentioned';
          const phone    = parts[6]?.trim() || 'Not mentioned';
          const desc     = parts[7]?.trim() || '';
          if (title && phone) {
            ads.push([
              category,
              sub,
              title,
              location,
              price,
              size,
              phone,
              desc,
              new Date()
            ]);
          }
        }
      }
    }

    if (!ads.length) return { success: false, message: 'No ads found in PDF' };

    const [result] = await db.query(
      `INSERT INTO classified_ads
         (\`Category\`, \`Sub-Category\`, \`Title/Property Type\`, \`Location\`,
          \`Price/Details\`, \`Size/Area\`, \`Contact\`, \`Additional Details\`, \`scraped_at\`)
       VALUES ?`,
      [ads]
    );
    return { success: true, total: ads.length, saved: result.affectedRows };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

module.exports = parsePdfAndSave;
