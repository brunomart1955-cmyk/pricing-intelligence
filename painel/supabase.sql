-- Shopping Radar · Painel
-- Cole este arquivo inteiro no Supabase: SQL Editor → New query → Run.
-- Cria a tabela de importações (snapshots) com segurança por usuário (RLS):
-- cada pessoa logada só enxerga, cria e apaga os próprios dados.

create table if not exists public.snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome          text,
  exportado_em  timestamptz,
  criado_em     timestamptz not null default now(),
  total_ofertas integer not null default 0,
  dados         jsonb not null
);

create index if not exists snapshots_user_data_idx
  on public.snapshots (user_id, exportado_em);

alter table public.snapshots enable row level security;

drop policy if exists "ler os próprios snapshots"    on public.snapshots;
drop policy if exists "criar os próprios snapshots"  on public.snapshots;
drop policy if exists "editar os próprios snapshots" on public.snapshots;
drop policy if exists "apagar os próprios snapshots" on public.snapshots;

create policy "ler os próprios snapshots" on public.snapshots
  for select to authenticated using (auth.uid() = user_id);

create policy "criar os próprios snapshots" on public.snapshots
  for insert to authenticated with check (auth.uid() = user_id);

create policy "editar os próprios snapshots" on public.snapshots
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "apagar os próprios snapshots" on public.snapshots
  for delete to authenticated using (auth.uid() = user_id);
