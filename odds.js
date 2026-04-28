// api/odds.js — Proxy para The Odds API (resolve CORS no Vercel)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ODDS_KEY = '2e66c3bee064120d35190a7d0a4f4209';
  const sport = req.query.sport || 'soccer_epl';
  const market = req.query.market || 'h2h,totals';
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=${market}&oddsFormat=decimal&dateFormat=iso`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=60'); // cache 60s
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
