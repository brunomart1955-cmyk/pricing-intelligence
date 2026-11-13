-- Shopping Radar · Controle de acesso (aprovação pelo admin) + dados da Magalu
-- Rode DEPOIS do supabase.sql: SQL Editor → New query → cole tudo → Run.
-- Pode rodar de novo sem problema (é idempotente).
--
-- Como funciona:
--  • Toda conta nova entra como "pendente" e não acessa nada.
--  • Um admin aprova, bloqueia ou promove usuários pela aba "Usuários" do painel.
--  • Os dados da Magalu ficam no bucket PRIVADO "magalu": só aprovados leem,
--    só admins enviam arquivos.
--
-- Para se tornar o primeiro admin, rode à parte (trocando o e-mail):
--   update public.acessos set status = 'aprovado', admin = true where email = 'seu@email.com';

-- ---------- Tabela de acessos ----------
create table if not exists public.acessos (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email         text,
  status        text not null default 'pendente' check (status in ('pendente', 'aprovado', 'bloqueado')),
  admin         boolean not null default false,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.acessos enable row level security;

-- Funções usadas nas regras (security definer: leem a tabela sem cair no próprio RLS).
create or replace function public.sou_aprovado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.acessos where user_id = auth.uid() and status = 'aprovado');
$$;

create or replace function public.sou_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.acessos where user_id = auth.uid() and status = 'aprovado' and admin);
$$;

-- Conta nova → registro "pendente" automático.
create or replace function public.registrar_novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.acessos (user_id, email) values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.registrar_novo_usuario();

-- Contas que já existiam antes deste script.
insert into public.acessos (user_id, email)
  select id, email from auth.users
  on conflict (user_id) do nothing;

-- Mantém a data de alteração e impede que um admin tire o próprio acesso por engano.
create or replace function public.acessos_antes_de_alterar() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.user_id = auth.uid() and (new.status <> 'aprovado' or not new.admin) and old.admin then
    raise exception 'Você não pode remover o seu próprio acesso de admin.';
  end if;
  new.atualizado_em := now();
  return new;
end;
$$;
drop trigger if exists acessos_alteracao on public.acessos;
create trigger acessos_alteracao before update on public.acessos
  for each row execute function public.acessos_antes_de_alterar();

drop policy if exists "ver o próprio acesso ou todos se admin" on public.acessos;
drop policy if exists "admin altera acessos" on public.acessos;
drop policy if exists "admin remove acessos" on public.acessos;

create policy "ver o próprio acesso ou todos se admin" on public.acessos
  for select to authenticated using (user_id = auth.uid() or public.sou_admin());
create policy "admin altera acessos" on public.acessos
  for update to authenticated using (public.sou_admin()) with check (public.sou_admin());
create policy "admin remove acessos" on public.acessos
  for delete to authenticated using (public.sou_admin() and user_id <> auth.uid());

-- ---------- Snapshots do Shopping Radar: agora exigem conta aprovada ----------
drop policy if exists "ler os próprios snapshots"    on public.snapshots;
drop policy if exists "criar os próprios snapshots"  on public.snapshots;
drop policy if exists "editar os próprios snapshots" on public.snapshots;
drop policy if exists "apagar os próprios snapshots" on public.snapshots;

create policy "ler os próprios snapshots" on public.snapshots
  for select to authenticated using (auth.uid() = user_id and public.sou_aprovado());
create policy "criar os próprios snapshots" on public.snapshots
  for insert to authenticated with check (auth.uid() = user_id and public.sou_aprovado());
create policy "editar os próprios snapshots" on public.snapshots
  for update to authenticated using (auth.uid() = user_id and public.sou_aprovado())
  with check (auth.uid() = user_id and public.sou_aprovado());
create policy "apagar os próprios snapshots" on public.snapshots
  for delete to authenticated using (auth.uid() = user_id and public.sou_aprovado());

-- ---------- Magalu Sales Intelligence: bucket privado ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('magalu', 'magalu', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists "magalu: aprovados leem"    on storage.objects;
drop policy if exists "magalu: admin envia"       on storage.objects;
drop policy if exists "magalu: admin substitui"   on storage.objects;
drop policy if exists "magalu: admin apaga"       on storage.objects;

create policy "magalu: aprovados leem" on storage.objects
  for select to authenticated using (bucket_id = 'magalu' and public.sou_aprovado());
create policy "magalu: admin envia" on storage.objects
  for insert to authenticated with check (bucket_id = 'magalu' and public.sou_admin());
create policy "magalu: admin substitui" on storage.objects
  for update to authenticated using (bucket_id = 'magalu' and public.sou_admin())
  with check (bucket_id = 'magalu' and public.sou_admin());
create policy "magalu: admin apaga" on storage.objects
  for delete to authenticated using (bucket_id = 'magalu' and public.sou_admin());
