// api/football.js — Proxy para API-Football (resolve CORS no Vercel)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const FOOTBALL_KEY = 'eaad211e17510f381a6c81d376509476';
  const path = req.query.path || 'fixtures?live=all';
  const url = `https://v3.football.api-sports.io/${path}`;

  try {
    const r = await fetch(url, {
      headers: { 'x-apisports-key': FOOTBALL_KEY }
    });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=30'); // cache 30s
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
