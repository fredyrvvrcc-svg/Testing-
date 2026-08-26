module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    siteKey: process.env.TURNSTILE_SITE_KEY || ''
  });
};
