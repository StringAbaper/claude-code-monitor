const store = require("./store");

function requireToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.query.token;

  if (!token || token !== store.getApiToken()) {
    return res.status(401).json({ error: "Invalid or missing API token" });
  }
  next();
}

module.exports = { requireToken };
