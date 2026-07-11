// api/cron-backup.js
// Triggered automatically once a day by Vercel Cron (see vercel.json).
// Saves a snapshot of bookings + specialDates as a new row (key = "autobackup_YYYY-MM-DD"),
// and deletes snapshots older than 14 days so the table doesn't grow forever.

module.exports = async function handler(req, res) {
  const ua = req.headers['user-agent'] || '';
  if (ua.indexOf('vercel-cron') === -1) {
    res.status(401).json({ error: 'not_authorized' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'missing_env' });
    return;
  }

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=in.(bookings,specialDates)&select=key,value', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    const rows = await r.json();
    const snapshot = { bookings: [], specialDates: [], savedAt: new Date().toISOString() };
    rows.forEach(function (row) {
      if (row.key === 'bookings') snapshot.bookings = row.value || [];
      if (row.key === 'specialDates') snapshot.specialDates = row.value || [];
    });

    const today = new Date().toISOString().slice(0, 10);
    const backupKey = 'autobackup_' + today;

    const patchRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(backupKey), {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ value: snapshot })
    });
    const patched = await patchRes.json();
    if (!patched || patched.length === 0) {
      await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ key: backupKey, value: snapshot })
      });
    }

    // Prune snapshots older than 14 days.
    const listRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=like.autobackup_*&select=key', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const allBackups = listRes.ok ? await listRes.json() : [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    for (const b of allBackups) {
      const dateStr = b.key.replace('autobackup_', '');
      const d = new Date(dateStr + 'T00:00:00Z');
      if (!isNaN(d.getTime()) && d < cutoff) {
        await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(b.key), {
          method: 'DELETE',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
        });
      }
    }

    res.status(200).json({ ok: true, backupKey: backupKey });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
