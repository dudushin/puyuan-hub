// api/backup.js
// Vercel Serverless Function for backup/restore, gated by a separate BACKUP_PASSWORD.
// POST { action: 'export', password } -> returns { bookings, specialDates, exportedAt }
// POST { action: 'import', password, bookings, specialDates } -> overwrites stored data

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BACKUP_PASSWORD = process.env.BACKUP_PASSWORD;

  if (!SUPABASE_URL || !SERVICE_KEY || !BACKUP_PASSWORD) {
    res.status(500).json({ error: 'Server is missing required environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BACKUP_PASSWORD).' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const { action, password } = body;

  if (password !== BACKUP_PASSWORD) {
    res.status(401).json({ error: 'wrong_password' });
    return;
  }

  if (action === 'export') {
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?select=key,value', {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
      });
      if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
      const rows = await r.json();
      const result = { bookings: [], specialDates: [], exportedAt: new Date().toISOString() };
      for (const row of rows) {
        if (row.key === 'bookings') result.bookings = row.value || [];
        if (row.key === 'specialDates') result.specialDates = row.value || [];
      }
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (action === 'import') {
    try {
      const bookings = body.bookings || [];
      const specialDates = body.specialDates || [];
      for (const item of [['bookings', bookings], ['specialDates', specialDates]]) {
        const key = item[0], value = item[1];
        const patchRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key), {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ value: value })
        });
        const patched = await patchRes.json();
        if (!patched || patched.length === 0) {
          await fetch(SUPABASE_URL + '/rest/v1/app_data', {
            method: 'POST',
            headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ key: key, value: value })
          });
        }
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  res.status(400).json({ error: 'invalid_action' });
};
