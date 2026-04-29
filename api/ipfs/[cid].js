// Vercel IPFS proxy — races multiple gateways in parallel, takes fastest.
// Vercel Hobby: 10s max. Racing wins over sequential retries.

import sharp from 'sharp';

// Race these URLs simultaneously — first valid image response wins
function buildUrls(cid) {
  return [
    `https://w3s.link/ipfs/${cid}/nft.png`,
    `https://w3s.link/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}/nft.png`,
    `https://nftstorage.link/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}/nft.png`,
    `https://ipfs.io/ipfs/${cid}`,
  ];
}

async function fetchFirst(urls, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const attempts = urls.map(url =>
    fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then(async res => {
      if (!res.ok) throw new Error(`${res.status}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html') || ct.includes('application/json')) throw new Error('not-image');
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    })
  );

  try {
    return await Promise.any(attempts);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const { cid } = req.query;

  if (!cid || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return res.status(400).json({ error: 'Invalid CID' });
  }

  try {
    const buffer = await fetchFirst(buildUrls(cid), 8500);

    // Detect if it's a video/gif — extract first frame with sharp
    let output;
    try {
      output = await sharp(buffer, { animated: false })
        .resize(400, null, { withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
    } catch {
      // If sharp fails (unsupported format), return original
      output = buffer;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(output);
    }

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(output);

  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
}

export const config = { maxDuration: 10 };
