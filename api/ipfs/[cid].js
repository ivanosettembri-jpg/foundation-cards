// Vercel IPFS proxy — races multiple sources, streams raw bytes through.
// No native binaries (no sharp) = no platform compatibility issues.
// Vercel CDN caches immutably after first fetch.

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);

  try {
    const result = await Promise.any(
      SOURCES.map(url => fetch(url(cid), {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(async r => {
        if (!r.ok) throw new Error(r.status);
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('text/html') || ct.includes('application/json')) throw new Error('not-image');
        const buf = Buffer.from(await r.arrayBuffer());
        return { buf, ct };
      }))
    );

    clearTimeout(timer);
    res.setHeader('Content-Type', result.ct || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(result.buf);

  } catch {
    clearTimeout(timer);
    return res.status(404).json({ error: 'Not found' });
  }
}

export const config = { maxDuration: 10 };
