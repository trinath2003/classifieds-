// routes/adminAds.js
//
// Admin-only delete for classified_ads. Since you already have admin
// auth in your app, this file does NOT try to guess how it works — it
// takes your existing admin-check middleware as a parameter and applies
// it to these routes. Wire it in from your server.js like:
//
//   const createAdminAdsRouter = require('./routes/adminAds');
//   const { requireAdmin } = require('./middleware/yourExistingAuth'); // <- your real one
//   app.use('/api/admin', createAdminAdsRouter(db, requireAdmin));
//
// `db` is your existing mysql2/promise pool (the same one dc_scraper.js
// uses) — pass that in too so this shares one connection pool with the
// rest of the app instead of opening a second one.
//
// DELETE is a SOFT delete: sets status='deleted' + deleted_at/deleted_by
// rather than removing the row, so it's reversible (see the restore
// route below) and nothing downstream that references an ad by id breaks.
//
// IMPORTANT — action needed on your side: any existing "list ads" /
// "get ad by id" queries elsewhere in your app need a
// `WHERE status != 'deleted'` (or `= 'active'`) clause added, or a
// deleted ad will still show up to normal users. This file only adds the
// admin delete/restore endpoints — it doesn't know about your other
// read routes, so that filter has to be added wherever those live.

const express = require('express');

function createAdminAdsRouter(db, requireAdmin) {
  const router = express.Router();

  // Every route below requires admin — nothing here is reachable by a
  // normal user even if they guess the URL.
  router.use(requireAdmin);

  // GET /api/admin/ads?status=deleted  (default: all, including deleted —
  // this is the admin view, so it should see everything)
  router.get('/ads', async (req, res) => {
    try {
      const { status, category, page = 1, limit = 50 } = req.query;
      const offset = (Number(page) - 1) * Number(limit);
      const params = [];
      let where = '1=1';

      if (status) { where += ' AND status = ?'; params.push(status); }
      if (category) { where += ' AND category = ?'; params.push(category); }

      params.push(Number(limit), offset);
      const [rows] = await db.query(
        `SELECT * FROM classified_ads WHERE ${where}
         ORDER BY date_published DESC, id DESC LIMIT ? OFFSET ?`,
        params
      );
      res.json(rows);
    } catch (e) {
      console.error('[Admin] List ads failed:', e.message);
      res.status(500).json({ error: 'Failed to list ads' });
    }
  });

  // DELETE /api/admin/ads/:id — soft delete
  router.delete('/ads/:id', async (req, res) => {
    try {
      const adminIdentity = req.admin?.email || req.user?.email || req.user?.username || 'unknown-admin';

      // Capture whatever status the ad actually had (active/pending/
      // rejected) into status_before_delete, so restore can put it back
      // where it belongs instead of always resetting to 'active'.
      const [result] = await db.query(
        `UPDATE classified_ads
         SET status_before_delete = status,
             status = 'deleted', deleted_at = NOW(), deleted_by = ?
         WHERE id = ? AND status != 'deleted'`,
        [adminIdentity, req.params.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Ad not found or already deleted' });
      }

      console.log(`[Admin] Ad #${req.params.id} deleted by ${adminIdentity}`);
      res.json({ deleted: true, id: Number(req.params.id), deletedBy: adminIdentity });
    } catch (e) {
      console.error('[Admin] Delete failed:', e.message);
      res.status(500).json({ error: 'Failed to delete ad' });
    }
  });

  // POST /api/admin/ads/:id/restore — undo a soft delete, restoring the
  // ad's actual prior status (active/pending/rejected) rather than
  // forcing it back to 'active' regardless of what it was.
  router.post('/ads/:id/restore', async (req, res) => {
    try {
      const [result] = await db.query(
        `UPDATE classified_ads
         SET status = COALESCE(status_before_delete, 'active'),
             status_before_delete = NULL, deleted_at = NULL, deleted_by = NULL
         WHERE id = ? AND status = 'deleted'`,
        [req.params.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Ad not found or not deleted' });
      }

      res.json({ restored: true, id: Number(req.params.id) });
    } catch (e) {
      console.error('[Admin] Restore failed:', e.message);
      res.status(500).json({ error: 'Failed to restore ad' });
    }
  });

  // DELETE /api/admin/ads/:id/permanent — actually remove the row.
  // Only use this for genuine cleanup (e.g. test data) — prefer the soft
  // delete above for normal moderation since it's reversible and keeps
  // an audit trail.
  router.delete('/ads/:id/permanent', async (req, res) => {
    try {
      const [result] = await db.query('DELETE FROM classified_ads WHERE id = ?', [req.params.id]);
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Ad not found' });
      }
      console.log(`[Admin] Ad #${req.params.id} PERMANENTLY deleted by ${req.admin?.email || req.user?.email || 'unknown-admin'}`);
      res.json({ permanentlyDeleted: true, id: Number(req.params.id) });
    } catch (e) {
      console.error('[Admin] Permanent delete failed:', e.message);
      res.status(500).json({ error: 'Failed to permanently delete ad' });
    }
  });

  return router;
}

module.exports = createAdminAdsRouter;
