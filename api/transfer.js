const TTL = 60 * 60 * 24 * 7;

function genToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length:8},()=>chars[Math.floor(Math.random()*chars.length)]).join("");
}

function getEnv() {
  const url   = process.env.thecabal_swap_KV_REST_API_URL
             || process.env.KV_REST_API_URL
             || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.thecabal_swap_KV_REST_API_TOKEN
             || process.env.KV_REST_API_TOKEN
             || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error:"Method not allowed" });

  const { url, token } = getEnv();
  if (!url || !token) return res.status(500).json({ error:"Redis not configured" });

  const { cardId, cardData } = req.body || {};
  if (!cardId || !cardData) return res.status(400).json({ error:"Missing fields" });

  const t = genToken();
  const payload = JSON.stringify({ cardId, cardData, createdAt:Date.now(), used:false });
  await fetch(`${url}/set/${encodeURIComponent("transfer:"+t)}/${encodeURIComponent(payload)}/EX/${TTL}`, {
    headers:{ Authorization:`Bearer ${token}` }
  });

  return res.status(200).json({ token: t });
}
