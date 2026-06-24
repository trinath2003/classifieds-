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
    const [totalRows] = await db.query('SELECT COUNT(*) AS total FROM classified_ads');
    const [categoryRows] = await db.query('SELECT `Category` AS category, COUNT(*) AS count FROM classified_ads GROUP BY `Category` ORDER BY count DESC');
    const [sourceRows] = await db.query('SELECT CASE WHEN `scraped_at` IS NULL THEN "seller" ELSE "scraper" END AS source, COUNT(*) AS count FROM classified_ads GROUP BY source');
    const [recentRows] = await db.query('SELECT `Category`, `Sub-Category`, `Title/Property Type`, `Contact`, `scraped_at` FROM classified_ads ORDER BY `scraped_at` DESC LIMIT 15');

    console.log('TOTAL=' + totalRows[0].total);
    console.log('CATEGORY_COUNTS=' + JSON.stringify(categoryRows));
    console.log('SOURCE_COUNTS=' + JSON.stringify(sourceRows));
    console.log('RECENT=' + JSON.stringify(recentRows));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
