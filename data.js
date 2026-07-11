// api/data.js
// Vercel Serverless Function.
//
// GET  -> public, returns { bookings: [...], specialDates: [...] } so anyone can view the calendar.
//
// POST with { mode: 'addBookings', password, entries: [...] } -> requires BOOKING_PASSWORD.
//   This is how "新增活动" works. It can only ADD new booking entries (never modify/delete
//   existing ones). The server assigns each entry its own id (client-supplied ids are ignored).
//
// POST with { mode: 'admin', password, key, value } -> requires BOOKING_PASSWORD when
//   key === 'bookings' (editing/deleting activities), or HOLIDAY_PASSWORD when
//   key === 'specialDates' (marking/editing/deleting holidays, public-holiday-with-class,
//   and school-wide events). The client sends the full replacement array for that key.

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
    return (rows && rows[0] && rows[0].value) ? rows[0].value : [];
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

  if (req.method === 'GET') {
    try {
      const [bookings, specialDates] = await Promise.all([fetchKey('bookings'), fetchKey('specialDates')]);
      res.status(200).json({ bookings: bookings, specialDates: specialDates });
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
        const current = await fetchKey('bookings');
        const withIds = entries.map(function (e, i) {
          const clean = Object.assign({}, e);
          delete clean.id;
          clean.id = Date.now() + Math.floor(Math.random() * 1000000) + i;
          if (!Array.isArray(clean.attendees)) clean.attendees = [];
          return clean;
        });
        const updated = current.concat(withIds);
        await writeKey('bookings', updated);
        res.status(200).json({ ok: true, ids: withIds.map(function (e) { return e.id; }) });
      } catch (err) {
        res.status(500).json({ error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    if (body.mode === 'admin') {
      const { password, key, value } = body;
      if (key !== 'bookings' && key !== 'specialDates') { res.status(400).json({ error: 'invalid_key' }); return; }
      const requiredPassword = key === 'bookings' ? BOOKING_PASSWORD : HOLIDAY_PASSWORD;
      if (password !== requiredPassword) { res.status(401).json({ error: 'wrong_password' }); return; }
      if (value === undefined) { res.status(400).json({ error: 'missing_value' }); return; }
      try {
        await writeKey(key, value);
        res.status(200).json({ ok: true });
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


