// POST /api/claim
// Redeems a single-use token and returns the card data.

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "Missing token" });

  const key = `exchange:${token.trim().toUpperCase()}`;
  const raw = await kv.get(key);
  if (!raw) return res.status(404).json({ error: "Token not found or already used" });

  let payload;
  try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return res.status(500).json({ error: "Invalid token data" }); }

  if (Date.now() > payload.expiresAt) {
    await kv.del(key);
    return res.status(410).json({ error: "Token expired" });
  }

  // Single-use: delete immediately
  await kv.del(key);

  return res.status(200).json({ cardData: payload.cardData });
}
