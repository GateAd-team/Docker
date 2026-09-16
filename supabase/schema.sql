-- Bao · schéma Supabase pour le partage d'un espace de travail entre plusieurs utilisateurs.
-- À coller dans Supabase → SQL Editor → Run (une seule fois). Idempotent.

-- Profils (miroir minimal de auth.users pour afficher les membres)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Organisations (= un compte partagé, ex. « Wall Up ») et leurs membres
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.org_members (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Espace de travail : toute la base Bao d'une organisation, en JSON, avec un numéro de version
-- (verrouillage optimiste : on n'écrase jamais une version qu'on n'a pas vue).
create table if not exists public.workspaces (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.workspaces enable row level security;

create or replace function public.is_member(p_org uuid) returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.org_members where org_id = p_org and user_id = auth.uid());
$$;

drop policy if exists "profiles: lecture par les membres d'une même organisation" on public.profiles;
create policy "profiles: lecture par les membres d'une même organisation" on public.profiles for select
  using (id = auth.uid() or exists (select 1 from public.org_members a join public.org_members b on a.org_id = b.org_id where a.user_id = auth.uid() and b.user_id = profiles.id));
drop policy if exists "profiles: modifier le sien" on public.profiles;
create policy "profiles: modifier le sien" on public.profiles for update using (id = auth.uid());

drop policy if exists "organizations: lecture membres" on public.organizations;
create policy "organizations: lecture membres" on public.organizations for select using (public.is_member(id));
drop policy if exists "organizations: modification par le propriétaire" on public.organizations;
create policy "organizations: modification par le propriétaire" on public.organizations for update
  using (exists (select 1 from public.org_members where org_id = id and user_id = auth.uid() and role = 'owner'));

drop policy if exists "org_members: lecture membres" on public.org_members;
create policy "org_members: lecture membres" on public.org_members for select using (public.is_member(org_id));
drop policy if exists "org_members: quitter" on public.org_members;
create policy "org_members: quitter" on public.org_members for delete using (user_id = auth.uid() or exists (select 1 from public.org_members m where m.org_id = org_members.org_id and m.user_id = auth.uid() and m.role = 'owner'));

drop policy if exists "workspaces: lecture membres" on public.workspaces;
create policy "workspaces: lecture membres" on public.workspaces for select using (public.is_member(org_id));

-- Créer une organisation : l'appelant devient propriétaire, un espace de travail vide est créé, un code d'invitation est généré.
create or replace function public.create_organization(p_name text) returns table (id uuid, name text, invite_code text) language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
  insert into public.organizations (name, invite_code, created_by) values (p_name, v_code, auth.uid()) returning organizations.id into v_id;
  insert into public.org_members (org_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.workspaces (org_id, data, version, updated_by) values (v_id, '{}'::jsonb, 0, auth.uid());
  return query select v_id, p_name, v_code;
end $$;

-- Rejoindre une organisation avec son code d'invitation.
create or replace function public.join_organization(p_code text) returns table (id uuid, name text) language plpgsql security definer set search_path = public as $$
declare v_org public.organizations;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  select * into v_org from public.organizations o where upper(o.invite_code) = upper(trim(p_code));
  if v_org.id is null then raise exception 'Code d''invitation inconnu'; end if;
  insert into public.org_members (org_id, user_id, role) values (v_org.id, auth.uid(), 'member') on conflict do nothing;
  return query select v_org.id, v_org.name;
end $$;

-- Régénérer le code d'invitation (propriétaire).
create or replace function public.regenerate_invite_code(p_org uuid) returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not exists (select 1 from public.org_members where org_id = p_org and user_id = auth.uid() and role = 'owner') then raise exception 'Réservé au propriétaire'; end if;
  v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
  update public.organizations set invite_code = v_code where id = p_org;
  return v_code;
end $$;

-- Enregistrer l'espace de travail si personne n'a écrit entre-temps (sinon renvoie la version courante pour fusionner).
create or replace function public.save_workspace(p_org uuid, p_data jsonb, p_expected_version integer)
returns table (ok boolean, version integer, data jsonb) language plpgsql security definer set search_path = public as $$
declare v_cur public.workspaces;
begin
  if not public.is_member(p_org) then raise exception 'Accès refusé'; end if;
  select * into v_cur from public.workspaces w where w.org_id = p_org for update;
  if v_cur.version <> p_expected_version then
    return query select false, v_cur.version, v_cur.data; return;
  end if;
  update public.workspaces set data = p_data, version = v_cur.version + 1, updated_at = now(), updated_by = auth.uid() where org_id = p_org;
  return query select true, v_cur.version + 1, null::jsonb;
end $$;

-- Membres d'une organisation (avec email et nom).
create or replace function public.org_members_list(p_org uuid) returns table (user_id uuid, email text, name text, role text, joined_at timestamptz) language sql security definer stable set search_path = public as $$
  select m.user_id, p.email, p.name, m.role, m.joined_at from public.org_members m join public.profiles p on p.id = m.user_id where m.org_id = p_org and public.is_member(p_org) order by m.joined_at;
$$;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.join_organization(text) to authenticated;
grant execute on function public.regenerate_invite_code(uuid) to authenticated;
grant execute on function public.save_workspace(uuid, jsonb, integer) to authenticated;
grant execute on function public.org_members_list(uuid) to authenticated;
grant execute on function public.is_member(uuid) to authenticated;

-- Temps réel : chaque poste est prévenu quand l'espace de travail change.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'workspaces') then
    alter publication supabase_realtime add table public.workspaces;
  end if;
end $$;

-- Fichiers (PDF, images) : bucket privé « files », chemin <org_id>/<document_id>.<ext>
insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;
drop policy if exists "files: membres lecture" on storage.objects;
create policy "files: membres lecture" on storage.objects for select using (bucket_id = 'files' and public.is_member((split_part(name, '/', 1))::uuid));
drop policy if exists "files: membres écriture" on storage.objects;
create policy "files: membres écriture" on storage.objects for insert with check (bucket_id = 'files' and public.is_member((split_part(name, '/', 1))::uuid));
drop policy if exists "files: membres mise à jour" on storage.objects;
create policy "files: membres mise à jour" on storage.objects for update using (bucket_id = 'files' and public.is_member((split_part(name, '/', 1))::uuid));
drop policy if exists "files: membres suppression" on storage.objects;
create policy "files: membres suppression" on storage.objects for delete using (bucket_id = 'files' and public.is_member((split_part(name, '/', 1))::uuid));

