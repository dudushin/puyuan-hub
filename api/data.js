// api/data.js
// Vercel Serverless Function.
//
// GET  -> public, returns { bookings, specialDates, bookingsVersion, specialDatesVersion }.
//
// POST { mode:'addBookings', password, entries } -> requires BOOKING_PASSWORD. Appends new bookings
//   (soft-delete aware: never touches deleted flags). Bumps bookingsVersion.
//
// POST { mode:'admin', password, key, value, baseVersion } -> requires BOOKING_PASSWORD (key=bookings)
//   or HOLIDAY_PASSWORD (key=specialDates). baseVersion must match the current stored version or the
//   write is rejected with 409 (someone else saved in between) so nobody silently overwrites another
//   admin's concurrent edit.

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const BOOKING_PASSWORD = process.env.BOOKING_PASSWORD;
  const HOLIDAY_PASSWORD = process.env.HOLIDAY_PASSWORD;

  if (!SUPABASE_URL || !SERVICE_KEY || !BOOKING_PASSWORD || !HOLIDAY_PASSWORD) {
    res.status(500).json({ error: 'Server is missing required environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / BOOKING_PASSWORD / HOLIDAY_PASSWORD).' });
    return;
  }

  async function fetchKey(key) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key) + '&select=value', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    const rows = await r.json();
    return (rows && rows[0] && rows[0].value) ? rows[0].value : null;
  }

  async function writeKey(key, value) {
    const patchRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.' + encodeURIComponent(key), {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ value: value })
    });
    const patched = await patchRes.json();
    if (!patched || patched.length === 0) {
      const postRes = await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ key: key, value: value })
      });
      if (!postRes.ok) throw new Error('Supabase insert HTTP ' + postRes.status);
    }
  }

  async function getVersion(key) {
    const v = await fetchKey(key + '_v');
    return (typeof v === 'number') ? v : 0;
  }
  async function bumpVersion(key) {
    const cur = await getVersion(key);
    const next = cur + 1;
    await writeKey(key + '_v', next);
    return next;
  }

  if (req.method === 'GET') {
    try {
      const [bookings, specialDates, bookingsVersion, specialDatesVersion] = await Promise.all([
        fetchKey('bookings'), fetchKey('specialDates'), getVersion('bookings'), getVersion('specialDates')
      ]);
      res.status(200).json({
        bookings: bookings || [], specialDates: specialDates || [],
        bookingsVersion: bookingsVersion, specialDatesVersion: specialDatesVersion
      });
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (body.mode === 'addBookings') {
      if (body.password !== BOOKING_PASSWORD) { res.status(401).json({ error: 'wrong_password' }); return; }
      const entries = Array.isArray(body.entries) ? body.entries : [];
      if (entries.length === 0) { res.status(400).json({ error: 'no_entries' }); return; }
      try {
        const current = (await fetchKey('bookings')) || [];
        const withIds = entries.map(function (e, i) {
          const clean = Object.assign({}, e);
          delete clean.id;
          clean.id = Date.now() + Math.floor(Math.random() * 1000000) + i;
          if (!Array.isArray(clean.attendees)) clean.attendees = [];
          clean.deleted = false;
          return clean;
        });
        const updated = current.concat(withIds);
        await writeKey('bookings', updated);
        const newVersion = await bumpVersion('bookings');
        res.status(200).json({ ok: true, ids: withIds.map(function (e) { return e.id; }), bookingsVersion: newVersion });
      } catch (err) {
        res.status(500).json({ error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    if (body.mode === 'admin') {
      const { password, key, value, baseVersion } = body;
      if (key !== 'bookings' && key !== 'specialDates') { res.status(400).json({ error: 'invalid_key' }); return; }
      const requiredPassword = key === 'bookings' ? BOOKING_PASSWORD : HOLIDAY_PASSWORD;
      if (password !== requiredPassword) { res.status(401).json({ error: 'wrong_password' }); return; }
      if (value === undefined) { res.status(400).json({ error: 'missing_value' }); return; }
      try {
        const currentVersion = await getVersion(key);
        if (typeof baseVersion === 'number' && baseVersion !== currentVersion) {
          const latest = await fetchKey(key);
          res.status(409).json({ error: 'conflict', currentVersion: currentVersion, latest: latest });
          return;
        }
        await writeKey(key, value);
        const newVersion = await bumpVersion(key);
        res.status(200).json({ ok: true, version: newVersion });
      } catch (err) {
        res.status(500).json({ error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    res.status(400).json({ error: 'invalid_mode' });
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
};



