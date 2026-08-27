const { MongoClient } = require('mongodb');

// Serverless function ke warm invocations ke beech connection reuse karo —
// har request pe naya MongoDB connection banana slow + wasteful hota hai.
let cachedClient = null;
async function getDb() {
  if (cachedClient) return cachedClient.db(process.env.DATABASE_NAME);
  const client = new MongoClient(process.env.DATABASE_URL);
  await client.connect();
  cachedClient = client;
  return client.db(process.env.DATABASE_NAME);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'method_not_allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch (e) {
      body = {};
    }
  }

  const { cfToken, token } = body || {};
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!cfToken || !token) {
    res.status(400).json({ success: false, error: 'missing_fields' });
    return;
  }

  if (!secret || !process.env.DATABASE_URL || !process.env.DATABASE_NAME) {
    res.status(500).json({ success: false, error: 'server_not_configured' });
    return;
  }

  // gate_token format check (16-char hex — bot ke secrets.token_hex(8) se match)
  if (!/^[a-f0-9]{16}$/i.test(token)) {
    res.status(400).json({ success: false, error: 'bad_token' });
    return;
  }

  try {
    const remoteip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();

    const cfResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret,
        response: cfToken,
        ...(remoteip ? { remoteip } : {})
      })
    });

    const cfData = await cfResponse.json();

    if (!cfData.success) {
      res.status(200).json({ success: false, error: 'turnstile_failed' });
      return;
    }

    // Turnstile genuinely pass hua hai — SIRF ab gate_token ko MongoDB se
    // ATOMICALLY consume (find-and-delete) karo. Ye 'gate_tokens' collection
    // hai — Telegram-unlocking 'verify_tokens' se PURI TARAH ALAG. Isliye
    // gate_token akela kabhi Telegram file unlock nahi kar sakta, aur
    // ek baar consume hone ke baad dobara bhi kaam nahi karega (replay-safe).
    const db = await getDb();
    const rawResult = await db.collection('gate_tokens').findOneAndDelete({ _id: token });
    // MongoDB driver versions differ: some return the doc directly, some
    // wrap it as { value: doc }. Handle both safely.
    const doc = (rawResult && Object.prototype.hasOwnProperty.call(rawResult, 'value'))
      ? rawResult.value
      : rawResult;

    if (!doc || !doc.redirect_url) {
      res.status(200).json({ success: false, error: 'token_expired_or_used' });
      return;
    }

    const expiry = doc.expiry ? new Date(doc.expiry) : null;
    if (expiry && expiry.getTime() < Date.now()) {
      res.status(200).json({ success: false, error: 'token_expired_or_used' });
      return;
    }

    res.status(200).json({ success: true, redirect: doc.redirect_url });
  } catch (err) {
    res.status(500).json({ success: false, error: 'server_error' });
  }
};
