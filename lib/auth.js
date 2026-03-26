const crypto = require("crypto");
const store = require("./store");

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Compare against self to keep constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.query.token;

  if (!timingSafeEqual(token, store.getApiToken())) {
    return res.status(401).json({ error: "Invalid or missing API token" });
  }
  next();
}

module.exports = { requireToken, timingSafeEqual };
