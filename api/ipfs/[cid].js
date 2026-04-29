// Vercel proxy — uses Alchemy NFT API to get images.
// Alchemy has all Foundation NFTs crawled and cached — fast and reliable.

export default async function handler(req, res) {
  const { cid } = req.query;
  if (!cid) return res.status(400).json({ error: 'Missing cid' });

  const contract = req.query.contract;
  const tokenId  = req.query.tokenId;
  const apiKey   = process.env.ALCHEMY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing API key' });

  // If we have contract+tokenId use Alchemy NFT API
  if (contract && tokenId) {
    try {
      const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${apiKey}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}&refreshCache=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        const imgUrl = data?.image?.cachedUrl || data?.image?.thumbnailUrl || data?.image?.originalUrl;
        if (imgUrl) {
          // Redirect to Alchemy's CDN — browser fetches directly, no proxy needed
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return res.redirect(302, imgUrl);
        }
      }
    } catch {}
  }

  // Fallback: IPFS race
  const SOURCES = [
    `https://w3s.link/ipfs/${cid}/nft.png`,
    `https://w3s.link/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}/nft.png`,
    `https://nftstorage.link/ipfs/${cid}`,
  ];

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 8000);

  try {
    const { buf, ct } = await Promise.any(
      SOURCES.map(url => fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }).then(async r => {
        if (!r.ok) throw new Error(r.status);
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('text/html')) throw new Error('html');
        return { buf: Buffer.from(await r.arrayBuffer()), ct };
      }))
    );
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(buf);
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
}

export const config = { maxDuration: 10 };
