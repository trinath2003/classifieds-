require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'newspaper_db'
  });

  try {
    const q = `
      SELECT ad_title, ad_content, category, newspaper_name, contact_info
      FROM newspaper_ads_filled
      WHERE LOWER(ad_title) LIKE '%matr%' OR LOWER(ad_content) LIKE '%matr%'
         OR LOWER(ad_title) LIKE '%bride%' OR LOWER(ad_content) LIKE '%bride%'
         OR LOWER(ad_title) LIKE '%groom%' OR LOWER(ad_content) LIKE '%groom%'
      ORDER BY ad_title
    `;
    const [rows] = await db.query(q);
    console.log('MATRIMONIAL_ROWS=' + JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
