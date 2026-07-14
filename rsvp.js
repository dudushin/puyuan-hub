// api/rsvp.js
// Vercel Serverless Function — intentionally PUBLIC (no password), because RSVP is meant to be
// open to every community member. To keep this safe even without a password, this endpoint does
// NOT accept arbitrary data: it only ever adds/updates one attendee entry on one existing booking,
// identified by bookingId. It cannot delete bookings, change event details, or touch anything else.

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'Server is missing required environment variables.' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const bookingId = body.bookingId;
  const name = (body.name || '').toString().trim().slice(0, 60);
  const phone = (body.phone || '').toString().trim().slice(0, 30);
  const remark = (body.remark || '').toString().trim().slice(0, 200);
  const response = body.response;
  const paidRaw = body.paid;
  const paid = (paidRaw === '是' || paidRaw === '否') ? paidRaw : null;

  if (!bookingId || !name || (response !== '去' && response !== '不去')) {
    res.status(400).json({ error: 'invalid_input' });
    return;
  }

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings&select=value,id&order=id.desc&limit=1', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    const rows = await r.json();
    const bookings = (rows && rows[0] && rows[0].value !== undefined) ? rows[0].value : [];

    const idx = bookings.findIndex(function (b) { return String(b.id) === String(bookingId); });
    if (idx === -1) { res.status(404).json({ error: 'booking_not_found' }); return; }
    if (!bookings[idx].needRsvp) { res.status(403).json({ error: 'rsvp_not_open' }); return; }

    if (!bookings[idx].attendees) bookings[idx].attendees = [];
    const entry = { name: name, phone: phone, remark: remark, response: response, paid: paid };
    bookings[idx].attendees = bookings[idx].attendees.filter(function (a) { return a.name !== name; });
    bookings[idx].attendees.push(entry);

    async function writeBookingsOnce(bookingsData) {
      const patchRes2 = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings', {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ value: bookingsData })
      });
      if (!patchRes2.ok) throw new Error('Supabase update HTTP ' + patchRes2.status);
      const patched2 = await patchRes2.json();
      if (!patched2 || patched2.length === 0) {
        const postRes2 = await fetch(SUPABASE_URL + '/rest/v1/app_data', {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ key: 'bookings', value: bookingsData })
        });
        if (!postRes2.ok) throw new Error('Supabase insert HTTP ' + postRes2.status);
      }
    }

    await writeBookingsOnce(bookings);

    // Verify: re-fetch fresh from Supabase and confirm the intended change actually stuck.
    // If not, retry once. If it still doesn't stick, report a real error instead of a
    // false "ok: true" — this is the key diagnostic
