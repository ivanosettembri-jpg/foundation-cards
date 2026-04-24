// Vercel serverless function — IPFS image proxy
// Browser requests /api/ipfs/{cid}, Vercel fetches from IPFS server-side.
// Benefits: no CORS, no browser rate limits, immutable caching.

const GATEWAYS = [
  (cid) => `https://gateway.pinata.cloud/ipfs/${cid}`,
  (cid) => `https://w3s.link/ipfs/${cid}`,
  (cid) => `https://nftstorage.link/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
  (cid) => `https://ipfs.io/ipfs/${cid}`,
];

export default async function handler(req, res) {
  const { cid } = req.query;

  if (!cid || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid CID' });
  }

  for (const gateway of GATEWAYS) {
    try {
      const url = gateway(cid);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) continue;

      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || 'image/jpeg';

      // Cache forever — IPFS content is immutable by design
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).send(Buffer.from(buffer));
      return;

    } catch {
      // Try next gateway
      continue;
    }
  }

  res.status(404).json({ error: 'Content not found on any IPFS gateway' });
}

export const config = {
  maxDuration: 15,
};
