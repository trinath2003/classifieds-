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
    const q = "SELECT `Category`, `Sub-Category`, `Title/Property Type`, `Location`, `Price/Details`, `Additional Details` FROM classified_ads WHERE LOWER(`Category`) IN ('property','automotive') AND (LOWER(`Sub-Category`) LIKE '%sale%' OR LOWER(`Sub-Category`) LIKE '%rent%' OR LOWER(`Title/Property Type`) LIKE '%car%' OR LOWER(`Title/Property Type`) LIKE '%bike%' OR LOWER(`Additional Details`) LIKE '%car%' OR LOWER(`Additional Details`) LIKE '%bike%') ORDER BY `Category`, `Sub-Category` LIMIT 100";
    const [rows] = await db.query(q);
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
