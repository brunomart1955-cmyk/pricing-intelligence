-- Shopping Radar · Configurações (aba "Configurações" do painel)
-- Rode DEPOIS do supabase.sql e do acessos.sql: SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem problema (é idempotente e não apaga o que já foi configurado).
--
-- O que cria:
--  • configuracoes: ajustes gerais, editados só por admins.
--      assistente      → IA ligada/desligada, modelo, instruções da loja, limite diário (lido pela Edge Function)
--      acesso          → domínios de e-mail aprovados automaticamente (só admin lê)
--      acesso_publico  → "Criar conta" aberto/fechado e mensagem da tela de espera (lido antes do login)
--      extensao        → modo de leitura, marketplaces ativos, nome da loja, preço padrão (lido pela extensão)
--  • preferencias: preferências pessoais de cada usuário (tema, preço de referência…).
--  • uso_assistente: contador de perguntas por usuário por dia (limite diário da IA).

-- ---------- Configurações gerais ----------
create table if not exists public.configuracoes (
  chave          text primary key check (chave in ('assistente', 'acesso', 'acesso_publico', 'extensao')),
  valor          jsonb not null default '{}'::jsonb,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid default auth.uid()
);
alter table public.configuracoes enable row level security;

insert into public.configuracoes (chave, valor) values
  ('assistente',     '{"ativo": true, "modelo": "", "instrucoes": "", "temperatura": 0.4, "limiteDiario": 50}'),
  ('acesso',         '{"dominiosAuto": []}'),
  ('acesso_publico', '{"cadastroAberto": true, "mensagemEspera": ""}'),
  ('extensao',       '{"modoLeitura": "usuario", "marketplacesAtivos": [], "nomesLoja": ["Levanti Máquinas"], "precoPadrao": null}')
on conflict (chave) do nothing;

create or replace function public.configuracoes_antes_de_salvar() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end;
$$;
drop trigger if exists configuracoes_alteracao on public.configuracoes;
create trigger configuracoes_alteracao before insert or update on public.configuracoes
  for each row execute function public.configuracoes_antes_de_salvar();

drop policy if exists "config: público lê o básico" on public.configuracoes;
drop policy if exists "config: aprovados leem"      on public.configuracoes;
drop policy if exists "config: admin lê tudo"       on public.configuracoes;
drop policy if exists "config: admin cria"          on public.configuracoes;
drop policy if exists "config: admin altera"        on public.configuracoes;

create policy "config: público lê o básico" on public.configuracoes
  for select to anon, authenticated using (chave = 'acesso_publico');
create policy "config: aprovados leem" on public.configuracoes
  for select to authenticated using (chave in ('assistente', 'extensao') and public.sou_aprovado());
create policy "config: admin lê tudo" on public.configuracoes
  for select to authenticated using (public.sou_admin());
create policy "config: admin cria" on public.configuracoes
  for insert to authenticated with check (public.sou_admin());
create policy "config: admin altera" on public.configuracoes
  for update to authenticated using (public.sou_admin()) with check (public.sou_admin());

-- Conta nova: "pendente", ou "aprovado" direto se o e-mail for de um domínio liberado
-- (ex.: @suaempresa.com.br). O login continua exigindo a confirmação do e-mail.
create or replace function public.registrar_novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  dominios jsonb;
  dominio  text := lower(split_part(coalesce(new.email, ''), '@', 2));
  liberado boolean := false;
begin
  begin
    select valor -> 'dominiosAuto' into dominios from public.configuracoes where chave = 'acesso';
    liberado := dominio <> '' and jsonb_typeof(dominios) = 'array' and exists (
      select 1 from jsonb_array_elements_text(dominios) d
      where lower(trim(leading '@' from trim(d))) = dominio
    );
  exception when others then liberado := false; -- nunca impede o cadastro
  end;
  insert into public.acessos (user_id, email, status)
  values (new.id, new.email, case when liberado then 'aprovado' else 'pendente' end)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------- Preferências pessoais ----------
create table if not exists public.preferencias (
  user_id       uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  dados         jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
alter table public.preferencias enable row level security;

drop policy if exists "preferências: só as minhas" on public.preferencias;
create policy "preferências: só as minhas" on public.preferencias
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Uso do assistente (limite diário) ----------
create table if not exists public.uso_assistente (
  user_id   uuid not null references auth.users (id) on delete cascade,
  dia       date not null default current_date,
  perguntas integer not null default 0,
  primary key (user_id, dia)
);
alter table public.uso_assistente enable row level security;

drop policy if exists "uso: o meu ou todos se admin" on public.uso_assistente;
create policy "uso: o meu ou todos se admin" on public.uso_assistente
  for select to authenticated using (user_id = auth.uid() or public.sou_admin());

-- Chamada pela Edge Function antes de cada pergunta: conta e diz se ainda pode.
-- Admins não têm limite. limiteDiario = 0 → sem limite.
create or replace function public.registrar_pergunta() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  limite integer;
  usadas integer;
begin
  if not public.sou_aprovado() then
    return jsonb_build_object('ok', false, 'motivo', 'nao_aprovado');
  end if;
  select coalesce((valor ->> 'limiteDiario')::integer, 0) into limite
    from public.configuracoes where chave = 'assistente';
  limite := coalesce(limite, 0);

  insert into public.uso_assistente (user_id, dia) values (auth.uid(), current_date)
  on conflict (user_id, dia) do nothing;
  select perguntas into usadas from public.uso_assistente
    where user_id = auth.uid() and dia = current_date for update;

  if limite > 0 and usadas >= limite and not public.sou_admin() then
    return jsonb_build_object('ok', false, 'usadas', usadas, 'limite', limite);
  end if;
  update public.uso_assistente set perguntas = perguntas + 1
    where user_id = auth.uid() and dia = current_date;
  return jsonb_build_object('ok', true, 'usadas', usadas + 1, 'limite', case when public.sou_admin() then 0 else limite end);
end;
$$;
