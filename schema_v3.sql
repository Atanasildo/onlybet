-- ═══════════════════════════════════════════════════════════════
-- OnlyBet — Schema Supabase v3
-- Executar no SQL Editor do Supabase
-- ═══════════════════════════════════════════════════════════════

-- Extensões
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── UTILIZADORES (actualizar tabela existente) ────────────────
alter table if exists utilizadores
  add column if not exists kyc_verificado boolean default false,
  add column if not exists auto_exclusao_ate timestamptz,
  add column if not exists referido_por uuid references utilizadores(id) on delete set null;

-- ── SESSÕES ───────────────────────────────────────────────────
create table if not exists sessoes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete cascade,
  token_hash text not null unique,
  ip text,
  user_agent text,
  activa boolean not null default true,
  criado_em timestamptz not null default now(),
  last_seen timestamptz default now(),
  expires_at timestamptz not null
);
create index if not exists idx_sessoes_token_hash on sessoes(token_hash) where activa = true;
create index if not exists idx_sessoes_user_id on sessoes(user_id) where activa = true;
-- Limpar sessões expiradas automaticamente (cron externo ou trigger)

-- ── LEDGER — registo financeiro imutável ─────────────────────
create table if not exists ledger (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete restrict,
  tipo text not null check (tipo in (
    'deposito','levantamento','levantamento_aprovado','aposta','ganho',
    'bonus','ajuste','estorno','cancelamento','transferencia'
  )),
  valor numeric(12,2) not null,   -- positivo = entrada, negativo = saída
  referencia text,
  descricao text,
  meta jsonb default '{}',
  criado_em timestamptz not null default now()
);
-- Ledger é append-only — sem UPDATE/DELETE para utilizadores
create index if not exists idx_ledger_user_id on ledger(user_id);
create index if not exists idx_ledger_tipo on ledger(tipo);
create index if not exists idx_ledger_criado_em on ledger(criado_em desc);

-- RLS — utilizador só lê o próprio ledger; admin lê tudo
alter table ledger enable row level security;
create policy if not exists "ledger_user_read" on ledger for select
  using (auth.uid()::text = user_id::text);

-- Função para registar ledger de forma atómica
create or replace function registar_ledger(
  p_user_id uuid, p_tipo text, p_valor numeric,
  p_referencia text default null, p_descricao text default null, p_meta jsonb default '{}'
) returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  insert into ledger (user_id, tipo, valor, referencia, descricao, meta)
  values (p_user_id, p_tipo, p_valor, p_referencia, p_descricao, p_meta)
  returning id into v_id;
  return v_id;
end;
$$;

-- ── LIGAS ─────────────────────────────────────────────────────
create table if not exists ligas (
  id uuid primary key default uuid_generate_v4(),
  nome text not null,
  pais text,
  icone text,
  activa boolean not null default true,
  ordem int default 0,
  external_id text unique   -- ID da API-Football
);

-- ── EVENTOS (jogos) ───────────────────────────────────────────
create table if not exists eventos (
  id uuid primary key default uuid_generate_v4(),
  liga_id uuid references ligas(id) on delete set null,
  equipa_casa text not null,
  equipa_fora text not null,
  data_inicio timestamptz not null,
  estado text not null default 'upcoming' check (estado in ('upcoming','live','finished','cancelled','postponed')),
  golos_casa int default 0,
  golos_fora int default 0,
  minuto_atual int,
  temporada text,
  fixture_id text unique,   -- ID externo da API-Football
  meta jsonb default '{}',
  criado_em timestamptz not null default now()
);
create index if not exists idx_eventos_estado on eventos(estado);
create index if not exists idx_eventos_data on eventos(data_inicio);
create index if not exists idx_eventos_fixture_id on eventos(fixture_id);

-- ── MERCADOS ──────────────────────────────────────────────────
create table if not exists mercados (
  id uuid primary key default uuid_generate_v4(),
  evento_id uuid not null references eventos(id) on delete cascade,
  nome text not null,
  tipo text not null check (tipo in ('1x2','totals','btts','handicap','correto','dupla_hipotese','custom')),
  activo boolean not null default true,
  ordem int default 0,
  criado_em timestamptz not null default now()
);
create index if not exists idx_mercados_evento_id on mercados(evento_id);

-- ── SELECÇÕES (opções dentro de cada mercado) ─────────────────
create table if not exists seleccoes (
  id uuid primary key default uuid_generate_v4(),
  mercado_id uuid not null references mercados(id) on delete cascade,
  evento_id uuid not null references eventos(id) on delete cascade,
  nome text not null,
  abrev text,
  odd numeric(6,2) not null default 1.00 check (odd >= 1.00),
  activa boolean not null default true,
  resultado text check (resultado in ('ganhou','perdeu','void',null)),
  ordem int default 0,
  criado_em timestamptz not null default now()
);
create index if not exists idx_seleccoes_mercado_id on seleccoes(mercado_id);
create index if not exists idx_seleccoes_evento_id on seleccoes(evento_id);

-- ── ODDS HISTÓRICO ────────────────────────────────────────────
create table if not exists odds_historico (
  id uuid primary key default uuid_generate_v4(),
  seleccao_id uuid not null references seleccoes(id) on delete cascade,
  mercado_id uuid references mercados(id) on delete cascade,
  evento_id uuid references eventos(id) on delete cascade,
  odd_anterior numeric(6,2) not null,
  odd_nova numeric(6,2) not null,
  motivo text,
  alterado_por text default 'sistema',
  criado_em timestamptz not null default now()
);

-- ── APOSTAS (actualizar tabela existente) ─────────────────────
alter table if exists apostas
  add column if not exists seleccao_id uuid references seleccoes(id) on delete set null,
  add column if not exists mercado_id uuid references mercados(id) on delete set null,
  add column if not exists referencia text;
create index if not exists idx_apostas_seleccao_id on apostas(seleccao_id);

-- ── KYC ───────────────────────────────────────────────────────
create table if not exists kyc (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references utilizadores(id) on delete cascade,
  tipo_documento text not null check (tipo_documento in ('bi','passaporte','carta_conducao')),
  numero_documento text not null,
  documento_frente_url text,
  documento_verso_url text,
  selfie_url text,
  estado text not null default 'pendente' check (estado in ('pendente','aprovado','rejeitado')),
  motivo_rejeicao text,
  submetido_em timestamptz not null default now(),
  verificado_em timestamptz,
  verificado_por text
);
create index if not exists idx_kyc_estado on kyc(estado);

-- ── RISCO — LIMITES PERSONALIZADOS ───────────────────────────
create table if not exists risco_limites (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete cascade,
  tipo text not null check (tipo in ('deposito_diario','aposta_diaria','sessao_diaria','perda_diaria')),
  valor numeric(12,2) not null,
  activo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (user_id, tipo)
);

-- ── RISCO — EVENTOS SUSPEITOS ─────────────────────────────────
create table if not exists risco_eventos (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete cascade,
  tipo text not null,   -- velocidade_apostas | multi_conta | valor_suspeito | etc
  detalhe text,
  severidade text not null default 'baixa' check (severidade in ('baixa','media','alta','critica')),
  estado text not null default 'pendente' check (estado in ('pendente','resolvido','ignorado')),
  accao_tomada text,
  notas text,
  resolvido_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists idx_risco_eventos_estado on risco_eventos(estado);
create index if not exists idx_risco_eventos_user_id on risco_eventos(user_id);

-- Função antifraude — velocidade de apostas no banco
create or replace function verificar_velocidade_aposta(
  p_user_id uuid, p_valor numeric
) returns boolean language plpgsql security definer as $$
declare v_total numeric;
begin
  select coalesce(sum(valor_apostado), 0) into v_total
  from apostas
  where user_id = p_user_id
    and criado_em > now() - interval '5 minutes';
  return (v_total + p_valor) <= 200000;
end;
$$;

-- ── BÓNUS ─────────────────────────────────────────────────────
create table if not exists bonus (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete cascade,
  tipo text not null check (tipo in ('boas_vindas','cashback','referral','manual','torneio','promocao')),
  valor numeric(12,2) not null,
  rollover numeric(5,2) not null default 1,
  rollover_completado numeric(12,2) not null default 0,
  estado text not null default 'activo' check (estado in ('activo','completado','expirado','cancelado')),
  notas text,
  criado_em timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists idx_bonus_user_id on bonus(user_id);
create index if not exists idx_bonus_estado on bonus(estado);

-- ── AFILIADOS ─────────────────────────────────────────────────
create table if not exists afiliados (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null unique references utilizadores(id) on delete cascade,
  codigo text not null unique default substr(md5(random()::text), 0, 9),
  comissao_pct numeric(5,2) not null default 5.00,   -- % sobre depósitos dos referidos
  total_ganho numeric(12,2) not null default 0,
  activo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table if not exists referidos (
  id uuid primary key default uuid_generate_v4(),
  afiliado_id uuid not null references utilizadores(id) on delete cascade,
  novo_user_id uuid not null unique references utilizadores(id) on delete cascade,
  estado text not null default 'pendente' check (estado in ('pendente','activo','invalido')),
  comissao_ganha numeric(12,2) default 0,
  criado_em timestamptz not null default now()
);
create index if not exists idx_referidos_afiliado_id on referidos(afiliado_id);

-- ── CONFIGURAÇÕES DO SISTEMA ──────────────────────────────────
create table if not exists config_sistema (
  id uuid primary key default uuid_generate_v4(),
  chave text not null unique,
  valor text not null,
  descricao text,
  editavel boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz default now()
);

-- Inserir configurações padrão
insert into config_sistema (chave, valor, descricao) values
  ('deposito_min', '500', 'Valor mínimo de depósito em Kz'),
  ('deposito_max', '1000000', 'Valor máximo de depósito por transacção em Kz'),
  ('levantamento_min', '1000', 'Valor mínimo de levantamento em Kz'),
  ('levantamento_max', '500000', 'Valor máximo de levantamento por transacção em Kz'),
  ('aposta_min', '100', 'Valor mínimo de aposta em Kz'),
  ('aposta_max', '100000', 'Valor máximo de aposta em Kz'),
  ('bonus_boas_vindas_pct', '100', 'Percentagem do bónus de boas-vindas'),
  ('bonus_boas_vindas_max', '50000', 'Valor máximo do bónus de boas-vindas em Kz'),
  ('rollover_padrao', '5', 'Rollover padrão para bónus'),
  ('odd_min', '1.01', 'Odd mínima aceite'),
  ('odd_max', '1000', 'Odd máxima aceite'),
  ('manutencao', 'false', 'Modo de manutenção (true/false)'),
  ('conta_unitel', '976 036 278', 'Número Unitel Money para depósitos'),
  ('conta_paypay', '976 036 278', 'Número PayPay para depósitos'),
  ('nome_site', 'OnlyBet', 'Nome do site'),
  ('comissao_afiliado_pct', '5', 'Percentagem de comissão para afiliados')
on conflict (chave) do nothing;

-- ── ADMIN LOGS (garantir que existe) ─────────────────────────
create table if not exists admin_logs (
  id uuid primary key default uuid_generate_v4(),
  admin text not null,
  accao text not null,
  detalhe text,
  criado_em timestamptz not null default now()
);
create index if not exists idx_admin_logs_criado_em on admin_logs(criado_em desc);

-- ── NOTIFICAÇÕES (garantir que existe) ───────────────────────
create table if not exists notificacoes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references utilizadores(id) on delete cascade,
  titulo text not null,
  mensagem text not null,
  tipo text not null default 'info' check (tipo in ('info','sucesso','erro','alerta')),
  lida boolean not null default false,
  criado_em timestamptz not null default now()
);
create index if not exists idx_notificacoes_user_id on notificacoes(user_id, lida);

-- ── ÍNDICES ADICIONAIS ────────────────────────────────────────
create index if not exists idx_depositos_user_estado on depositos_pendentes(user_id, estado);
create index if not exists idx_apostas_user_resultado on apostas(user_id, resultado);
create index if not exists idx_apostas_fixture_id on apostas(fixture_id);

-- ── VIEWS ÚTEIS ───────────────────────────────────────────────

-- Saldo real calculado do ledger
create or replace view v_saldo_ledger as
select user_id, sum(valor) as saldo_ledger
from ledger
group by user_id;

-- Sumário financeiro por utilizador
create or replace view v_resumo_utilizador as
select
  u.id, u.nome, u.email, u.telefone,
  u.saldo, u.nivel, u.suspenso,
  coalesce(a_total.count, 0) as total_apostas,
  coalesce(a_total.volume, 0) as volume_apostado,
  coalesce(a_ganhou.count, 0) as apostas_ganhas,
  coalesce(a_ganhou.ganho, 0) as total_ganho,
  u.criado_em, u.ultimo_login
from utilizadores u
left join (
  select user_id, count(*) as count, sum(valor_apostado) as volume from apostas group by user_id
) a_total on a_total.user_id = u.id
left join (
  select user_id, count(*) as count, sum(ganho_real) as ganho from apostas where resultado = 'ganhou' group by user_id
) a_ganhou on a_ganhou.user_id = u.id;

-- GGR diário
create or replace view v_ggr_diario as
select
  date_trunc('day', criado_em) as dia,
  sum(case when resultado = 'pendente' or resultado is null then 0 else valor_apostado end) as volume,
  sum(case when resultado = 'ganhou' then ganho_real else 0 end) as ganho_pago,
  sum(case when resultado != 'ganhou' and resultado != 'pendente' and resultado != 'cancelada'
      then valor_apostado else 0 end) -
  sum(case when resultado = 'ganhou' then ganho_real else 0 end) as ggr
from apostas
where resultado != 'pendente'
group by date_trunc('day', criado_em)
order by dia desc;

-- ═══════════════════════════════════════════════════════════════
-- FIM DO SCHEMA v3
-- ═══════════════════════════════════════════════════════════════
