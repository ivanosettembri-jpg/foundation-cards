// Vercel serverless function — IPFS image proxy with resize
// Fetches from IPFS server-side (faster than browser), resizes to 400px WebP.
// Cached immutably — each CID is fetched once, then served from Vercel's CDN.

import sharp from 'sharp';

const SOURCES = [
  (cid) => `https://w3s.link/ipfs/${cid}/nft.png`,
  (cid) => `https://w3s.link/ipfs/${cid}`,
  (cid) => `https://nftstorage.link/ipfs/${cid}/nft.png`,
  (cid) => `https://nftstorage.link/ipfs/${cid}`,
  (cid) => `https://ipfs.io/ipfs/${cid}/nft.png`,
  (cid) => `https://ipfs.io/ipfs/${cid}`,
];

export default async function handler(req, res) {
  const { cid } = req.query;

  if (!cid || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid CID' });
  }

  for (const source of SOURCES) {
    const url = source(cid);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) continue;

      const buffer = Buffer.from(await response.arrayBuffer());

      const resized = await sharp(buffer)
        .resize(400, null, { withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();

      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send(resized);

    } catch {
      continue;
    }
  }

  return res.status(404).json({ error: 'Image not found' });
}

export const config = { maxDuration: 60 };
