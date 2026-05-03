// api/resolver.js — OnlyBet v3 — Resolução automática via mercados + ledger atómico
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

async function ledger(userId, tipo, valor, ref, descricao, meta = {}) {
  await sb('ledger', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId, tipo, valor: parseFloat(valor),
      referencia: ref || null, descricao,
      meta: JSON.stringify(meta),
      criado_em: new Date().toISOString()
    })
  }).catch(e => console.error('Ledger error:', e.message));
}

async function getResultadoJogo(fixtureId) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
      headers: { 'x-apisports-key': FOOTBALL_KEY }
    });
    const d = await r.json();
    const fixture = d?.response?.[0];
    if (!fixture) return null;

    const status = fixture.fixture?.status?.short;
    const terminados = ['FT', 'AET', 'PEN', 'WO', 'AWD'];
    if (!terminados.includes(status)) return null;

    return {
      terminado: true,
      homeGoals: fixture.goals?.home ?? 0,
      awayGoals: fixture.goals?.away ?? 0,
      home: fixture.teams?.home?.name,
      away: fixture.teams?.away?.name,
      winner: fixture.teams?.home?.winner ? 'home' : fixture.teams?.away?.winner ? 'away' : 'draw',
      minuto: fixture.fixture?.status?.elapsed || 90
    };
  } catch (e) {
    console.error('Erro ao buscar fixture:', fixtureId, e.message);
    return null;
  }
}

// Resolver com base em selecção_id se disponível (mais preciso)
async function resolverPorSeleccao(seleccaoId, resultado) {
  const sr = await sb(`seleccoes?id=eq.${seleccaoId}&select=abrev,nome,mercado_id&limit=1`);
  const sel = (await sr.json())[0];
  if (!sel) return null;

  const mr = await sb(`mercados?id=eq.${sel.mercado_id}&select=tipo&limit=1`);
  const mercado = (await mr.json())[0];
  if (!mercado) return null;

  const { winner, homeGoals, awayGoals } = resultado;
  const totalGolos = homeGoals + awayGoals;
  const abrev = (sel.abrev || '').toLowerCase();

  switch (mercado.tipo) {
    case '1x2':
      if (abrev === '1') return winner === 'home';
      if (abrev === 'x') return winner === 'draw';
      if (abrev === '2') return winner === 'away';
      break;
    case 'totals':
      if (abrev.includes('over 2.5')) return totalGolos > 2.5;
      if (abrev.includes('under 2.5')) return totalGolos < 2.5;
      if (abrev.includes('over 1.5')) return totalGolos > 1.5;
      if (abrev.includes('under 1.5')) return totalGolos < 1.5;
      if (abrev.includes('over 3.5')) return totalGolos > 3.5;
      if (abrev.includes('under 3.5')) return totalGolos < 3.5;
      break;
    case 'btts':
      if (abrev === 'sim') return homeGoals > 0 && awayGoals > 0;
      if (abrev === 'não' || abrev === 'nao') return !(homeGoals > 0 && awayGoals > 0);
      break;
  }
  return null;
}

function verificarSeleccaoTexto(pick, resultado) {
  const p = (pick || '').toLowerCase();
  const { winner, homeGoals, awayGoals } = resultado;
  const totalGolos = homeGoals + awayGoals;

  if (p.includes('vitória') && p.includes('casa') || p === '1' || p.includes('home win')) return winner === 'home';
  if (p.includes('empate') || p === 'x' || p.includes('draw')) return winner === 'draw';
  if (p.includes('vitória') && p.includes('fora') || p === '2' || p.includes('away win')) return winner === 'away';
  if (p.includes('over 2.5') || p.includes('mais de 2.5')) return totalGolos > 2.5;
  if (p.includes('under 2.5') || p.includes('menos de 2.5')) return totalGolos < 2.5;
  if (p.includes('over 1.5')) return totalGolos > 1.5;
  if (p.includes('under 1.5')) return totalGolos < 1.5;
  if (p.includes('over 3.5')) return totalGolos > 3.5;
  if (p.includes('under 3.5')) return totalGolos < 3.5;
  if (p.includes('ambas marcam') || p.includes('btts')) return homeGoals > 0 && awayGoals > 0;
  return null;
}

async function resolverAposta(aposta, resultado) {
  // Tentar resolver por selecção_id primeiro (mais preciso)
  let ganhou = null;
  if (aposta.seleccao_id) {
    ganhou = await resolverPorSeleccao(aposta.seleccao_id, resultado);
  }
  // Fallback para texto
  if (ganhou === null) {
    ganhou = verificarSeleccaoTexto(aposta.detalhe, resultado);
  }

  if (ganhou === null) {
    console.log(`Aposta ${aposta.id} — não conseguiu verificar automaticamente`);
    return false;
  }

  const ganhoReal = ganhou ? Math.round(parseFloat(aposta.ganho_potencial || 0)) : 0;

  await sb(`apostas?id=eq.${aposta.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resultado: ganhou ? 'ganhou' : 'perdeu', ganho_real: ganhoReal })
  });

  if (ganhou) {
    const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
    const u = (await ur.json())[0];
    const novoSaldo = parseFloat(u?.saldo || 0) + ganhoReal;
    await sb(`utilizadores?id=eq.${aposta.user_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ saldo: novoSaldo })
    });

    // Ledger — creditar ganho
    await ledger(aposta.user_id, 'ganho', ganhoReal, aposta.referencia,
      `Aposta ganha: ${aposta.jogo} (auto-resolver)`,
      { fixture_id: aposta.fixture_id, odd: aposta.odd_total }
    );

    // Actualizar rollover do bónus se activo
    const bonusR = await sb(`bonus?user_id=eq.${aposta.user_id}&estado=eq.activo&limit=1`);
    const bonus = (await bonusR.json())[0];
    if (bonus) {
      const novoRollover = parseFloat(bonus.rollover_completado || 0) + parseFloat(aposta.valor_apostado || 0);
      const rolloverTarget = parseFloat(bonus.valor || 0) * parseFloat(bonus.rollover || 1);
      if (novoRollover >= rolloverTarget) {
        await sb(`bonus?id=eq.${bonus.id}`, { method: 'PATCH', body: JSON.stringify({ rollover_completado: novoRollover, estado: 'completado' }) });
        await sb('notificacoes', {
          method: 'POST',
          body: JSON.stringify({ user_id: aposta.user_id, titulo: '🎁 Rollover Completo!', mensagem: 'Parabéns! Completaste o rollover do teu bónus. O valor está disponível para levantamento.', tipo: 'sucesso' })
        }).catch(() => {});
      } else {
        await sb(`bonus?id=eq.${bonus.id}`, { method: 'PATCH', body: JSON.stringify({ rollover_completado: novoRollover }) });
      }
    }
  }

  const titulo = ganhou ? '🎉 Aposta Ganha!' : '❌ Aposta Perdida';
  const mensagem = ganhou
    ? `Parabéns! A tua aposta em "${aposta.jogo}" ganhou ${ganhoReal.toLocaleString('pt-AO')} Kz!`
    : `A tua aposta em "${aposta.jogo}" não foi bem sucedida. Boa sorte na próxima!`;

  await sb('notificacoes', {
    method: 'POST',
    body: JSON.stringify({ user_id: aposta.user_id, titulo, mensagem, tipo: ganhou ? 'sucesso' : 'erro' })
  }).catch(() => {});

  console.log(`Aposta ${aposta.id} resolvida: ${ganhou ? 'GANHOU' : 'PERDEU'}`);
  return true;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const secret = req.headers['x-cron-secret'];
  if (secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  try {
    const r = await sb('apostas?resultado=eq.pendente&select=*&limit=100');
    const apostas = await r.json();

    if (!Array.isArray(apostas) || !apostas.length) {
      return res.json({ ok: true, msg: 'Sem apostas pendentes.', resolvidas: 0 });
    }

    console.log(`${apostas.length} apostas pendentes encontradas`);

    const jogosUnicos = [...new Set(apostas.map(a => a.fixture_id).filter(Boolean))];
    let resolvidas = 0;
    const resultados = {};

    for (const fixtureId of jogosUnicos) {
      resultados[fixtureId] = await getResultadoJogo(fixtureId);
      await new Promise(r => setTimeout(r, 200));
    }

    for (const aposta of apostas) {
      const resultado = resultados[aposta.fixture_id];
      if (!resultado?.terminado) continue;

      try {
        const resolvida = await resolverAposta(aposta, resultado);
        if (resolvida) resolvidas++;
      } catch (e) {
        console.error(`Erro ao resolver aposta ${aposta.id}:`, e.message);
      }
    }

    // Apostas sem fixture_id — cancelar após 5 dias
    const semFixture = apostas.filter(a => !a.fixture_id);
    let canceladas = 0;
    for (const aposta of semFixture) {
      const criada = new Date(aposta.criado_em);
      const horasPassadas = (Date.now() - criada.getTime()) / 3600000;
      if (horasPassadas > 120) {
        await sb(`apostas?id=eq.${aposta.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ resultado: 'cancelada', ganho_real: 0 })
        });
        const ur = await sb(`utilizadores?id=eq.${aposta.user_id}&select=saldo&limit=1`);
        const u = (await ur.json())[0];
        if (u) {
          await sb(`utilizadores?id=eq.${aposta.user_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ saldo: parseFloat(u.saldo || 0) + parseFloat(aposta.valor_apostado || 0) })
          });
          await ledger(aposta.user_id, 'estorno', parseFloat(aposta.valor_apostado || 0),
            aposta.referencia, `Aposta cancelada automaticamente (sem fixture): ${aposta.jogo}`, {}
          );
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
        canceladas++;
      }
    }

    // Actualizar estado dos eventos na BD local
    for (const fixtureId of Object.keys(resultados)) {
      const r = resultados[fixtureId];
      if (r?.terminado) {
        await sb(`eventos?fixture_id=eq.${fixtureId}`, {
          method: 'PATCH',
          body: JSON.stringify({ estado: 'finished', golos_casa: r.homeGoals, golos_fora: r.awayGoals })
        }).catch(() => {});
      }
    }

    return res.json({
      ok: true,
      apostas_pendentes: apostas.length,
      resolvidas,
      canceladas,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Erro no resolver:', e);
    return res.status(500).json({ error: e.message });
  }
};
