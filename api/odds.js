// api/odds.js — OnlyBet v2 — Proxy odds com whitelist e cache
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ODDS_KEY = process.env.ODDS_API_KEY || '2e66c3bee064120d35190a7d0a4f4209';

  // Desportos permitidos
  const allowedSports = [
    'soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga',
    'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one',
    'soccer_portugal_primeira_liga', 'soccer_brazil_campeonato',
    'basketball_nba', 'americanfootball_nfl', 'tennis_atp',
    'basketball_euroleague', 'mma_mixed_martial_arts'
  ];

  const sport = req.query.sport || 'soccer_epl';

  if (!allowedSports.includes(sport))
    return res.status(400).json({ error: 'Desporto não suportado.' });

  const markets = req.query.markets || 'h2h,totals';
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=${markets}&oddsFormat=decimal&dateFormat=iso`;

  try {
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(r.status).json({ error: `Odds API: ${r.statusText}` });
    }
    const data = await r.json();
    // Cache 60s
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);
  } catch (e) {
    console.error('Odds API error:', e.message);
    return res.status(500).json({ error: 'Erro ao contactar API de odds.' });
  }
};
