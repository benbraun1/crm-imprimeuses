-- CRM revendeurs Les Imprimeuses : schéma initial.
-- À exécuter une fois dans Supabase > SQL Editor (voir README).

------------------------------------------------------------------------------
-- Équipe : seules ces adresses peuvent lire et écrire dans le CRM.
------------------------------------------------------------------------------
create table public.team_members (
  email        text primary key check (email = lower(email)),
  display_name text not null,
  created_at   timestamptz not null default now()
);

create or replace function public.is_team_member()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

------------------------------------------------------------------------------
-- Paramètres du RFM (règle du carnet, 01/09/2026).
------------------------------------------------------------------------------
create table public.settings (
  key   text primary key,
  value numeric not null,
  label text not null
);

insert into public.settings (key, value, label) values
  ('seuil_champion', 566, 'CA HT cumulé minimum pour être Champion (€)'),
  ('jours_recent',    90, 'Commande récente : il y a au plus N jours'),
  ('jours_actif',    365, 'Au-delà de N jours sans commande : Inactif');

------------------------------------------------------------------------------
-- Comptes revendeurs (clients et prospects).
------------------------------------------------------------------------------
create table public.accounts (
  id                 uuid primary key default gen_random_uuid(),
  -- Clé de regroupement : nom normalisé (voir sync/comptes.py:norm).
  key                text not null unique,
  -- Données tenues à jour par la synchro :
  name               text not null,
  address1           text,
  city               text,
  zip                text,
  country            text,
  email              text,
  phone              text,
  shopify_company_ids text[] not null default '{}',
  sources            text[] not null default '{}',
  synced_at          timestamptz,
  -- Données saisies dans le CRM (jamais écrasées par la synchro) :
  display_name       text,
  owner_email        text references public.team_members (email) on update cascade on delete set null,
  tags               text[] not null default '{}',
  next_action_on     date,
  next_action        text,
  memo               text,
  website            text,
  hidden             boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index accounts_company_ids_idx on public.accounts using gin (shopify_company_ids);

-- Quand deux comptes sont fusionnés, l'ancienne clé pointe vers la nouvelle :
-- la synchro range alors les commandes de l'ancienne clé dans le bon compte.
create table public.account_aliases (
  alias_key   text primary key,
  account_key text not null,
  created_at  timestamptz not null default now()
);

------------------------------------------------------------------------------
-- Commandes B2B (copie Shopify, réécrite à chaque synchro).
------------------------------------------------------------------------------
create table public.orders (
  id            text primary key,          -- gid Shopify
  account_id    uuid not null references public.accounts (id) on delete cascade,
  name          text,                      -- n° de commande, ex. #41234
  created_at    timestamptz not null,
  subtotal      numeric(12, 2) not null default 0,  -- HT, hors port
  channel       text not null,             -- Faire, Ankorstore, Direct
  cancelled     boolean not null default false,
  has_keychains boolean not null default false,
  customer_id   text
);
create index orders_account_idx on public.orders (account_id, created_at desc);

-- Corrections de CA (ex. commandes Samaritaine saisies à 0 €).
-- Rattachées à la clé du compte pour pouvoir exister avant la 1re synchro.
create table public.revenue_adjustments (
  id          uuid primary key default gen_random_uuid(),
  account_key text not null,
  amount      numeric(12, 2) not null,
  reason      text not null,
  created_by  text default lower(auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now()
);

insert into public.revenue_adjustments (account_key, amount, reason, created_by) values
  ('samaritaine', 12071,
   'Commandes de mars à juin 2026 saisies à 0 € dans Shopify, valorisées d''après le récapitulatif interne (tarif wholesale - 10 %).',
   'reprise du carnet');

------------------------------------------------------------------------------
-- Contacts.
------------------------------------------------------------------------------
create table public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts (id) on delete cascade,
  shopify_customer_id text unique,
  name                text,
  email               text,
  phone               text,
  role                text,
  notes               text,
  source              text not null default 'manuel',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index contacts_account_idx on public.contacts (account_id);

------------------------------------------------------------------------------
-- Journal des échanges.
------------------------------------------------------------------------------
create table public.interactions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts (id) on delete cascade,
  contact_id   uuid references public.contacts (id) on delete set null,
  kind         text not null check (kind in ('appel', 'email', 'visite', 'salon', 'rendez-vous', 'message', 'note')),
  happened_on  date not null default (now() at time zone 'Europe/Paris')::date,
  author_email text not null default lower(auth.jwt() ->> 'email'),
  body         text not null default '',
  created_at   timestamptz not null default now()
);
create index interactions_account_idx on public.interactions (account_id, happened_on desc);

------------------------------------------------------------------------------
-- Historique des synchronisations.
------------------------------------------------------------------------------
create table public.sync_runs (
  id          bigserial primary key,
  source      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'en cours',
  details     jsonb not null default '{}'
);

------------------------------------------------------------------------------
-- updated_at automatique.
------------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger accounts_touch before update on public.accounts
  for each row execute function public.touch_updated_at();
create trigger contacts_touch before update on public.contacts
  for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- Vue principale : un compte + ses indicateurs + son segment RFM du jour.
-- Le segment est recalculé à chaque lecture : il bouge tout seul avec le
-- temps, même entre deux synchros.
------------------------------------------------------------------------------
create or replace view public.account_overview
with (security_invoker = true) as
with
  params as (
    select
      max(value) filter (where key = 'seuil_champion') as seuil_champion,
      max(value) filter (where key = 'jours_recent')   as jours_recent,
      max(value) filter (where key = 'jours_actif')    as jours_actif,
      (now() at time zone 'Europe/Paris')::date        as today
    from public.settings
  ),
  o as (
    select
      account_id,
      count(*)                                                     as nb_orders,
      sum(subtotal)                                                as ca_orders,
      min(created_at)::date                                        as first_order_on,
      max(created_at)::date                                        as last_order_on,
      (array_agg(created_at::date order by created_at desc))[2]    as prev_order_on,
      bool_or(has_keychains)                                       as has_keychains,
      mode() within group (order by channel)                       as channel,
      (array_agg(channel order by created_at))[1]                  as first_channel
    from public.orders
    where not cancelled
    group by account_id
  ),
  adj as (
    select account_key, sum(amount) as amount
    from public.revenue_adjustments
    group by account_key
  ),
  li as (
    select distinct on (account_id)
      account_id, happened_on, author_email, kind
    from public.interactions
    order by account_id, happened_on desc, created_at desc
  ),
  base as (
    select
      a.*,
      coalesce(nullif(a.display_name, ''), a.name)          as label,
      coalesce(o.nb_orders, 0)                               as nb_orders,
      round(coalesce(o.ca_orders, 0) + coalesce(adj.amount, 0), 2) as ca_ht,
      o.first_order_on,
      o.last_order_on,
      o.prev_order_on,
      coalesce(o.has_keychains, false)                       as has_keychains,
      o.channel,
      (o.first_channel = 'Faire')                            as faire_origin,
      case when a.country = 'FR' and a.zip ~ '^[0-9]{2}' then left(a.zip, 2) end as department,
      li.happened_on                                         as last_contact_on,
      li.author_email                                        as last_contact_by,
      li.kind                                                as last_contact_kind,
      p.today - o.last_order_on                              as days_since_order,
      p.today - li.happened_on                               as days_since_contact,
      p.seuil_champion, p.jours_recent, p.jours_actif
    from public.accounts a
    cross join params p
    left join o   on o.account_id = a.id
    left join adj on adj.account_key = a.key
    left join li  on li.account_id = a.id
  )
select
  base.*,
  case
    when last_order_on is null then 'Prospects'
    when days_since_order <= jours_recent then
      case
        when ca_ht >= seuil_champion then 'Champions'
        when nb_orders >= 2 then 'Fidèles'
        else 'Nouveaux'
      end
    when days_since_order <= jours_actif then
      case when nb_orders >= 2 then 'À relancer' else 'Occasionnels' end
    else 'Inactifs'
  end as segment
from base;

------------------------------------------------------------------------------
-- Fusion de deux comptes (doublons) : tout passe de source à cible.
------------------------------------------------------------------------------
create or replace function public.merge_accounts(source_id uuid, target_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  src public.accounts;
  tgt public.accounts;
begin
  if not public.is_team_member() then
    raise exception 'Accès refusé';
  end if;
  if source_id = target_id then
    raise exception 'Un compte ne peut pas être fusionné avec lui-même';
  end if;
  select * into src from public.accounts where id = source_id for update;
  select * into tgt from public.accounts where id = target_id for update;
  if src.id is null or tgt.id is null then
    raise exception 'Compte introuvable';
  end if;

  -- Les commandes futures de l'ancienne clé iront dans le compte cible.
  update public.account_aliases set account_key = tgt.key where account_key = src.key;
  insert into public.account_aliases (alias_key, account_key) values (src.key, tgt.key)
    on conflict (alias_key) do update set account_key = excluded.account_key;

  update public.orders              set account_id  = tgt.id  where account_id  = src.id;
  update public.contacts            set account_id  = tgt.id  where account_id  = src.id;
  update public.interactions        set account_id  = tgt.id  where account_id  = src.id;
  update public.revenue_adjustments set account_key = tgt.key where account_key = src.key;

  update public.accounts set
    shopify_company_ids = array(select distinct unnest(tgt.shopify_company_ids || src.shopify_company_ids)),
    sources             = array(select distinct unnest(tgt.sources || src.sources)),
    tags                = array(select distinct unnest(tgt.tags || src.tags)),
    owner_email         = coalesce(tgt.owner_email, src.owner_email),
    next_action_on      = coalesce(tgt.next_action_on, src.next_action_on),
    next_action         = coalesce(tgt.next_action, src.next_action),
    website             = coalesce(tgt.website, src.website),
    email               = coalesce(tgt.email, src.email),
    phone               = coalesce(tgt.phone, src.phone),
    memo                = nullif(concat_ws(E'\n\n', tgt.memo, src.memo), '')
  where id = tgt.id;

  delete from public.accounts where id = src.id;
end;
$$;

------------------------------------------------------------------------------
-- Sécurité : tout est fermé, sauf pour les membres de l'équipe connectés.
-- (La synchro se connecte avec le rôle postgres, qui n'est pas concerné.)
------------------------------------------------------------------------------
alter table public.team_members        enable row level security;
alter table public.settings            enable row level security;
alter table public.accounts            enable row level security;
alter table public.account_aliases     enable row level security;
alter table public.orders              enable row level security;
alter table public.revenue_adjustments enable row level security;
alter table public.contacts            enable row level security;
alter table public.interactions        enable row level security;
alter table public.sync_runs           enable row level security;

create policy "équipe : lecture" on public.team_members for select to authenticated using (public.is_team_member());
create policy "équipe : lecture" on public.settings     for select to authenticated using (public.is_team_member());
create policy "équipe : lecture" on public.sync_runs    for select to authenticated using (public.is_team_member());
create policy "équipe : lecture" on public.orders       for select to authenticated using (public.is_team_member());

create policy "équipe : tout" on public.accounts            for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "équipe : tout" on public.account_aliases     for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "équipe : tout" on public.revenue_adjustments for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "équipe : tout" on public.contacts            for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "équipe : tout" on public.interactions        for all to authenticated using (public.is_team_member()) with check (public.is_team_member());
-- La fusion déplace des commandes : autorisé seulement dans ce cadre.
create policy "équipe : rattachement" on public.orders for update to authenticated using (public.is_team_member()) with check (public.is_team_member());

revoke all on all tables in schema public from anon;
revoke execute on function public.merge_accounts(uuid, uuid) from anon, public;
grant execute on function public.merge_accounts(uuid, uuid) to authenticated;
