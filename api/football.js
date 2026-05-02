// api/football.js — OnlyBet v2 — Proxy com cache melhorado
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || 'eaad211e17510f381a6c81d376509476';

  // Paths permitidos (whitelist de segurança)
  const allowedPaths = [
    'fixtures', 'leagues', 'teams', 'standings', 'players',
    'fixtures/statistics', 'fixtures/events', 'fixtures/lineups'
  ];

  const rawPath = req.query.path || 'fixtures?live=all';
  const basePath = rawPath.split('?')[0];

  if (!allowedPaths.some(p => basePath.startsWith(p))) {
    return res.status(400).json({ error: 'Path não permitido.' });
  }

  const url = `https://v3.football.api-sports.io/${rawPath}`;

  try {
    const r = await fetch(url, {
      headers: {
        'x-apisports-key': FOOTBALL_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `API-Football: ${r.statusText}` });
    }

    const data = await r.json();

    // Cache: 30s para jogos ao vivo, 5min para outros
    const isLive = rawPath.includes('live=all');
    res.setHeader('Cache-Control', `s-maxage=${isLive ? 30 : 300}, stale-while-revalidate=60`);
    return res.status(200).json(data);
  } catch (e) {
    console.error('Football API error:', e.message);
    return res.status(500).json({ error: 'Erro ao contactar API de futebol.' });
  }
};
