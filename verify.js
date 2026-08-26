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
  const botUsername = process.env.BOT_USERNAME;

  if (!cfToken || !token) {
    res.status(400).json({ success: false, error: 'missing_fields' });
    return;
  }

  if (!secret || !botUsername) {
    res.status(500).json({ success: false, error: 'server_not_configured' });
    return;
  }

  // Token ka format bot ke MongoDB token se match hona chahiye (16-char hex).
  // Ye sirf ek cheap safety net hai — asli verification bot ki DB pe hoti hai
  // jab user Telegram deep-link pe pahuchta hai (ek-baar-use token).
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

    const redirect = `https://t.me/${botUsername}?start=verify_${token}`;
    res.status(200).json({ success: true, redirect });
  } catch (err) {
    res.status(500).json({ success: false, error: 'server_error' });
  }
};
