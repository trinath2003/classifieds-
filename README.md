# ClassifiedsDesk — Deccan Chronicle Classifieds Scraper

## What this does
- Scrapes the DC e-paper classified section using **Puppeteer** (headless Chrome)
- OCR-reads each classifieds page with **Tesseract.js**
- Parses and saves ads to your MySQL `classified_ads` table
- Serves a dark-themed web UI where you can filter by **day, category, source**
- Day pills in sidebar show real dates (Mon–Sun this week) with live ad counts

---

## Setup (one time)

```bash
# 1. Copy these 4 files into your project folder:
#    dc_scraper.js  server.js  index.html  package.json

# 2. Install dependencies (~5 min, Puppeteer downloads Chromium)
npm install

# 3. Make sure your .env file exists:
cat .env
# DB_HOST=localhost
# DB_USER=root
# DB_PASSWORD=yourpassword
# DB_NAME=newspaper_db
# PORT=3001
```

---

## Run

```bash
# Start the server (runs on port 3001)
node server.js

# Open in browser
open http://localhost:3001
```

---

## Scraping

### Option A — Click buttons in the UI
- **"⟳ Scrape today"** — scrapes today's DC e-paper classified pages
- **"⟳ Scrape full week"** — scrapes Mon to today (fills the whole week sidebar)

### Option B — Command line

```bash
# Scrape today
node dc_scraper.js

# Scrape a specific date
node dc_scraper.js 2026-06-22

# Scrape a full week (Mon to Sun)
node dc_scraper.js 2026-06-18 2026-06-24
```

### Option C — HTTP API (from browser/curl)

```bash
# Scrape today
curl http://localhost:3001/scrape

# Scrape specific date
curl http://localhost:3001/scrape?date=2026-06-22

# Scrape full current week
curl http://localhost:3001/scrape/week
```

### Auto cron (built into server.js)
| Time                | Action               |
|---------------------|----------------------|
| Every day at 6 AM   | Scrape today's paper |
| Every day at 12 PM  | Re-scrape today      |
| Every Sunday midnight | Scrape full Mon–Sun week |

---

## Day filtering in the UI

The **"This week's papers"** sidebar shows each day of the last 7 days as a pill with:
- Day name (Sunday, Monday, …)
- Date (e.g. "Wed, 24 Jun")
- Ad count for that day

Clicking a day pill shows **only that day's classified ads**.

---

## How the scraper works

```
epaper.deccanchronicle.com
        │
        ▼
Puppeteer (headless Chrome)
  • Selects Hyderabad edition
  • Picks the target date from dropdown
  • Walks through all pages (typically 12–20)
        │
        ▼
Tesseract.js (OCR)
  • Screenshots each page image
  • Converts image → raw text
  • Detects classifieds pages by keyword density
        │
        ▼
Parser
  • Splits text into individual ads by section headers + blank lines
  • Extracts: category, sub-category, price, size, phone, location
        │
        ▼
MySQL classified_ads table
  • DELETE old scraper rows for that date (idempotent)
  • INSERT IGNORE new rows (safe to re-run)
```

---

## API reference

| Endpoint | Description |
|----------|-------------|
| `GET /ads` | List ads with filters |
| `GET /ads?day=Sunday` | All Sunday ads |
| `GET /ads?date=2026-06-22` | Ads for a specific date |
| `GET /ads?category=Property` | Filter by category |
| `GET /ads?search=flat` | Full-text search |
| `GET /ads/:id` | Single ad detail |
| `POST /ads` | Submit a seller ad |
| `GET /days` | Last 7 days with ad counts |
| `GET /stats` | Overall counts by category/source |
| `GET /scrape?date=YYYY-MM-DD` | Trigger scrape for a date |
| `GET /scrape/week` | Trigger full week scrape |
| `POST /upload-pdf` | Import ads from PDF |

---

## Troubleshooting

**"No ads found" for a day**
→ Click "Scrape now" or run `node dc_scraper.js YYYY-MM-DD` for that date.

**OCR accuracy is low**
→ Tesseract is good enough for printed classified text (it's not handwriting).
  If accuracy is poor, increase Puppeteer viewport or try `--dpi 300` screenshot.

**Puppeteer can't navigate pages**
→ DC e-paper uses ASP.NET `__doPostBack` for navigation. If the site changes layout, 
  update the selectors in `scrapeDate()` in dc_scraper.js.

**Server port already in use**
→ server.js auto-increments port up to 3010. Or set `PORT=3002` in .env.
