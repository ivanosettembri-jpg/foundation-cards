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

  const { url, token: redisToken } = getEnv();
  if (!url || !redisToken) return res.status(500).json({ error:"Redis not configured" });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error:"Missing token" });

  const key = "transfer:" + token.toUpperCase();
  const gr = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers:{ Authorization:`Bearer ${redisToken}` }
  });
  const gj = await gr.json();
  if (!gj.result) return res.status(404).json({ error:"Token not found or expired" });

  const data = JSON.parse(gj.result);
  if (data.used) return res.status(410).json({ error:"Token already used" });

  data.used = true;
  data.claimedAt = Date.now();
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(data))}/EX/86400`, {
    headers:{ Authorization:`Bearer ${redisToken}` }
  });

  return res.status(200).json({ cardData: data.cardData });
}
