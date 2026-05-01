// POST /api/transfer
// Generates a single-use token for a card trade.
// Stores { cardData, expiresAt } in Vercel KV (or falls back to a simple in-memory map
// for local dev). In production, uses Vercel KV via @vercel/kv.

import { kv } from "@vercel/kv";

function randomToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let t = "";
  for (let i = 0; i < 8; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { cardId, cardData } = req.body || {};
  if (!cardId || !cardData) return res.status(400).json({ error: "Missing cardId or cardData" });

  const token = randomToken();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

  await kv.set(`exchange:${token}`, JSON.stringify({ cardData, expiresAt }), { ex: 7 * 24 * 3600 });

  return res.status(200).json({ token });
}
