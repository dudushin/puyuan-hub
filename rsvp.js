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

    const patchRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings', {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ value: bookings })
    });
    if (!patchRes.ok) throw new Error('Supabase update HTTP ' + patchRes.status);
    const patched = await patchRes.json();
    if (!patched || patched.length === 0) {
      const postRes = await fetch(SUPABASE_URL + '/rest/v1/app_data', {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ key: 'bookings', value: bookings })
      });
      if (!postRes.ok) throw new Error('Supabase insert HTTP ' + postRes.status);
    }

    // Self-heal: if duplicate 'bookings' rows ever accumulated (e.g. from a past
    // update-blocked-fell-back-to-insert scenario), keep only the most recent one.
    try {
      const dupCheck = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings&select=id&order=id.desc', {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
      });
      if (dupCheck.ok) {
        const dupRows = await dupCheck.json();
        if (Array.isArray(dupRows) && dupRows.length > 1) {
          const idsToDelete = dupRows.slice(1).map(function (row) { return row.id; });
          for (const staleId of idsToDelete) {
            await fetch(SUPABASE_URL + '/rest/v1/app_data?id=eq.' + staleId, {
              method: 'DELETE',
              headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
            });
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal: the main write already succeeded above.
    }

    // Bump the shared version counter so any admin session holding a stale copy
    // (e.g. an open "manage registrants" table) gets detected as a conflict
    // instead of silently overwriting this RSVP on their next save.
    var newBookingsVersion = null;
    try {
      const vRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings_v&select=value&order=id.desc&limit=1', {
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
      });
      const vRows = vRes.ok ? await vRes.json() : [];
      const currentVersion = (vRows && vRows[0] && typeof vRows[0].value === 'number') ? vRows[0].value : 0;
      const nextVersion = currentVersion + 1;
      const vPatchRes = await fetch(SUPABASE_URL + '/rest/v1/app_data?key=eq.bookings_v', {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ value: nextVersion })
      });
      const vPatched = vPatchRes.ok ? await vPatchRes.json() : [];
      if (!vPatched || vPatched.length === 0) {
        await fetch(SUPABASE_URL + '/rest/v1/app_data', {
          method: 'POST',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ key: 'bookings_v', value: nextVersion })
        });
      }
      newBookingsVersion = nextVersion;
    } catch (vErr) {
      // Non-fatal: the RSVP itself already succeeded above; version bump is a best-effort safety net.
    }

    res.status(200).json({ ok: true, attendees: bookings[idx].attendees, bookingsVersion: newBookingsVersion });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
};
