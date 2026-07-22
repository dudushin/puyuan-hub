// api/verify-password.js
// Vercel Serverless Function. Verifies a password against one of the three configured
// passwords WITHOUT reading or writing any booking data. Used for read-only admin actions
// (e.g. copying a registrant list) where a full admin write isn't appropriate.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const password = body.password;
  const kind = body.kind;

  const map = {
    booking: process.env.BOOKING_PASSWORD,
    holiday: process.env.HOLIDAY_PASSWORD,
    backup: process.env.BACKUP_PASSWORD
  };
  const expected = map[kind];
  if (!expected) {
    res.status(400).json({ error: 'invalid_kind' });
    return;
  }
  if (password === expected) {
    res.status(200).json({ ok: true });
  } else {
    res.status(401).json({ error: 'wrong_password' });
  }
};
