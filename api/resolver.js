// api/resolver.js — Resolução automática de apostas via resultados reais
// Chamado pelo GitHub Actions a cada 5 minutos

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET;
const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || 'eaad211e17510f381a6c81d376509476';
const CRON_SECRET = process.env.CRON_SECRET || 'onlybet_cron_2025';

const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  headers: {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': opts.prefer || 'return=representation',
    ...opts.headers
  },
  ...opts
});

// Buscar resultado real de um jogo via API-Football
async function getResultadoJogo(fixtureId) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
      headers: { 'x-apisports-key': FOOTBALL_KEY }
    });
    const d = await r.json();
    const fixture = d?.response?.[0];
    if (!fixture) return null;

    const status = fixture.fixture?.status?.short;
    // Só resolver se o jogo terminou
    const terminados = ['FT', 'AET', 'PEN', 'WO', 'AWD'];
    if (!terminados.includes(status)) return null;

    return {
      terminado: true,
      homeGoals: fixture.goals?.home ?? 0,
      awayGoals: fixture.goals?.away ?? 0,
      home: fixture.teams?.home?.name,
      away: fixture.teams?.away?.name,
      winner: fixture.teams?.home?.winner ? 'home' : fixture.teams?.away?.winner ? 'away' : 'draw'
    };
  } catch (e) {
    console.error('Erro ao buscar fixture:', fixtureId, e.message);
    return null;
  }
}

// Verificar se a selecção do utilizador foi correcta
function verificarSeleccao(pick, resultado) {
  const p = (pick || '').toLowerCase();
  const { winner, homeGoals, awayGoals } = resultado;

  // 1X2
  if (p.includes('vitória') && p.includes('casa') || p === '1' || p.includes('home win')) return winner === 'home';
  if (p.includes('empate') || p === 'x' || p.includes('draw')) return winner === 'draw';
  if (p.includes('vitória') && p.includes('fora') || p === '2' || p.includes('away win')) return winner === 'away';

  // Over/Under
  const totalGolos = homeGoals + awayGoals;
  if (p.includes('over 2.5') || p.includes('mais de 2.5')) return totalGolos > 2.5;
  if (p.includes('under 2.5') || p.includes('menos de 2.5')) return totalGolos < 2.5;
  if (p.includes('over 1.5')) return totalGolos > 1.5;
  if (p.includes('under 1.5')) return totalGolos < 1.5;
  if (p.includes('over 3.5')) return totalGolos > 3.5;
  if (p.includes('under 3.5')) return totalGolos < 3.5;

  // Ambas marcam
  if (p.includes('ambas marcam') || p.includes('btts')) return homeGoals > 0 && awayGoals > 0;

  // Default — não conseguiu verificar automaticamente, deixar para admin
  return null;
}

// Resolver uma aposta
async function resolverAposta(aposta, resultado) {
  const ganhou = verificarSeleccao(aposta.detalhe, resultado);

  // Null = não conseguiu verificar — deixar pendente
  if (ganhou === null) {
    console.log(`Aposta ${aposta.id} — não conseguiu verificar automaticamente`);
    return;
  }

  const ganhoReal = ganhou ? Math.round(parseFloat(aposta.ganho_potencial || 0)) : 0;

  // Actualizar aposta
  await sb(`apostas?id=eq.${aposta.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      resultado: ganhou ? 'ganhou' : 'perdeu',
      ganho_real: ganhoReal
    })
  });

  // Creditar saldo se ganhou
  if (ganhou) {
    const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo || 0) + ganhoReal;
    await sb(`utilizadores?id=eq.${aposta.user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });
  }

  // Notificar utilizador
  const titulo = ganhou ? '🎉 Aposta Ganha!' : '❌ Aposta Perdida';
  const mensagem = ganhou
    ? `Parabéns! A tua aposta em "${aposta.jogo}" ganhou ${ganhoReal.toLocaleString('pt-AO')} Kz!`
    : `A tua aposta em "${aposta.jogo}" não foi bem sucedida. Boa sorte na próxima!`;

  await sb('notificacoes', {
    method: 'POST',
    body: JSON.stringify({
      user_id: aposta.user_id,
      titulo,
      mensagem,
      tipo: ganhou ? 'sucesso' : 'erro'
    })
  }).catch(() => {});

  console.log(`Aposta ${aposta.id} resolvida: ${ganhou ? 'GANHOU' : 'PERDEU'}`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Verificar segredo do cron
  const secret = req.headers['x-cron-secret'];
  if (secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    // Buscar todas as apostas pendentes
    const r = await sb('apostas?resultado=eq.pendente&select=*&limit=100');
    const apostas = await r.json();

    if (!Array.isArray(apostas) || !apostas.length) {
      return res.json({ ok: true, msg: 'Sem apostas pendentes.', resolvidas: 0 });
    }

    console.log(`${apostas.length} apostas pendentes encontradas`);

    // Agrupar por jogo para minimizar chamadas à API
    const jogosUnicos = [...new Set(apostas.map(a => a.fixture_id).filter(Boolean))];

    let resolvidas = 0;
    const resultados = {};

    // Buscar resultados dos jogos
    for (const fixtureId of jogosUnicos) {
      resultados[fixtureId] = await getResultadoJogo(fixtureId);
      // Pequena pausa para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 200));
    }

    // Resolver apostas com resultados disponíveis
    for (const aposta of apostas) {
      const resultado = resultados[aposta.fixture_id];
      if (!resultado?.terminado) continue;

      try {
        await resolverAposta(aposta, resultado);
        resolvidas++;
      } catch (e) {
        console.error(`Erro ao resolver aposta ${aposta.id}:`, e.message);
      }
    }

    // Apostas sem fixture_id — tentar resolver por tempo (se passaram mais de 3h)
    const semFixture = apostas.filter(a => !a.fixture_id);
    let resolvidasPorTempo = 0;
    for (const aposta of semFixture) {
      const criada = new Date(aposta.criado_em);
      const horasPassadas = (Date.now() - criada.getTime()) / 3600000;
      if (horasPassadas > 120) { // 5 dias — cancelar automaticamente
        await sb(`apostas?id=eq.${aposta.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ resultado: 'cancelada', ganho_real: 0 })
        });
        // Devolver valor apostado
        const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
        const u = (await ur.json())[0];
        if (u) {
          await sb(`utilizadores?id=eq.${aposta.user_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ saldo: parseFloat(u.saldo || 0) + parseFloat(aposta.valor_apostado || 0) })
          });
        }
        await sb('notificacoes', {
          method: 'POST',
          body: JSON.stringify({
            user_id: aposta.user_id,
            titulo: 'ℹ️ Aposta Cancelada',
            mensagem: `A aposta em "${aposta.jogo}" foi cancelada automaticamente. O valor foi devolvido.`,
            tipo: 'info'
          })
        }).catch(() => {});
        resolvidasPorTempo++;
      }
    }

    return res.json({
      ok: true,
      apostas_pendentes: apostas.length,
      resolvidas,
      canceladas_por_tempo: resolvidasPorTempo,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Erro no resolver:', e);
    return res.status(500).json({ error: e.message });
  }
};
