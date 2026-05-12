create table if not exists public.user_sessions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sessions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.user_sessions enable row level security;

drop policy if exists "Users can read their own sessions" on public.user_sessions;
create policy "Users can read their own sessions"
on public.user_sessions
for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can insert their own sessions" on public.user_sessions;
create policy "Users can insert their own sessions"
on public.user_sessions
for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can update their own sessions" on public.user_sessions;
create policy "Users can update their own sessions"
on public.user_sessions
for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can delete their own sessions" on public.user_sessions;
create policy "Users can delete their own sessions"
on public.user_sessions
for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

create table if not exists public.user_paper_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_name text not null,
  pnl_sol numeric not null default 0,
  pnl_percentage numeric not null default 0,
  entry_market_cap numeric not null default 0,
  exit_market_cap numeric not null default 0,
  notes text not null default '',
  trade_timestamp timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists user_paper_trades_user_id_trade_timestamp_idx
on public.user_paper_trades (user_id, trade_timestamp desc);

alter table public.user_paper_trades enable row level security;

drop policy if exists "Users can read their own paper trades" on public.user_paper_trades;
create policy "Users can read their own paper trades"
on public.user_paper_trades
for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can insert their own paper trades" on public.user_paper_trades;
create policy "Users can insert their own paper trades"
on public.user_paper_trades
for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can update their own paper trades" on public.user_paper_trades;
create policy "Users can update their own paper trades"
on public.user_paper_trades
for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can delete their own paper trades" on public.user_paper_trades;
create policy "Users can delete their own paper trades"
on public.user_paper_trades
for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Admin overview: readable only via service_role key (bypasses RLS).
-- Run: select * from public.admin_user_overview; in the Supabase SQL editor.
create or replace view public.admin_user_overview
with (security_invoker = false)
as
select
  u.id                                                                as user_id,
  u.email,
  u.created_at,
  u.last_sign_in_at,
  count(pt.id) filter (where pt.notes not like '__TD_OPEN__%')        as closed_trades,
  count(pt.id) filter (where pt.notes like '__TD_OPEN__%')            as open_positions,
  coalesce(
    sum(pt.pnl_sol) filter (where pt.notes not like '__TD_OPEN__%'),
    0
  )                                                                   as total_pnl_sol,
  max(pt.trade_timestamp) filter (where pt.notes not like '__TD_OPEN__%')
                                                                      as last_trade_at,
  exists (select 1 from public.user_sessions s where s.user_id = u.id)
                                                                      as has_dashboard_sessions
from auth.users u
left join public.user_paper_trades pt on pt.user_id = u.id
group by u.id, u.email, u.created_at, u.last_sign_in_at;

-- Block direct access from the app; only the Supabase dashboard / service_role can query it.
alter view public.admin_user_overview owner to postgres;
revoke all on public.admin_user_overview from anon, authenticated;

create table if not exists public.user_live_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_name text not null,
  entry_market_cap numeric not null default 0,
  position_size_sol numeric not null default 0,
  opened_at timestamptz not null default timezone('utc', now()),
  page_url text not null default '',
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists user_live_positions_user_token_idx
on public.user_live_positions (user_id, token_name);

alter table public.user_live_positions enable row level security;

drop policy if exists "Users can read their own live positions" on public.user_live_positions;
create policy "Users can read their own live positions"
on public.user_live_positions
for select
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can insert their own live positions" on public.user_live_positions;
create policy "Users can insert their own live positions"
on public.user_live_positions
for insert
to authenticated
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can update their own live positions" on public.user_live_positions;
create policy "Users can update their own live positions"
on public.user_live_positions
for update
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id)
with check ((select auth.uid()) is not null and (select auth.uid()) = user_id);

drop policy if exists "Users can delete their own live positions" on public.user_live_positions;
create policy "Users can delete their own live positions"
on public.user_live_positions
for delete
to authenticated
using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- ── Invites ────────────────────────────────────────────────────────────────
create table if not exists public.invites (
  code       text        primary key,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  used_by    uuid        references auth.users(id)
);

alter table public.invites enable row level security;

-- Anyone (including anon) may check whether an unused code exists — no other data exposed.
drop policy if exists "Read unused invites" on public.invites;
create policy "Read unused invites" on public.invites
  for select to anon, authenticated
  using (used_at is null);

-- No direct insert/update/delete from clients — only via the RPCs below.

-- Admin: generate a new random invite code.
create or replace function public.generate_invite()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if (select email from auth.users where id = auth.uid()) != 'lukas@rathsach.com' then
    raise exception 'Not authorized';
  end if;
  v_code := upper(substring(encode(gen_random_bytes(4), 'hex') for 8));
  insert into public.invites (code) values (v_code);
  return v_code;
end;
$$;
grant execute on function public.generate_invite to authenticated;

-- After signup: atomically mark an invite as used.
create or replace function public.claim_invite(p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.invites
  set used_at = now(), used_by = auth.uid()
  where code = p_code and used_at is null;
  return found;
end;
$$;
grant execute on function public.claim_invite to authenticated;

-- Admin: list all invites (used and unused).
create or replace function public.list_invites()
returns table(code text, created_at timestamptz, used_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select email from auth.users where id = auth.uid()) != 'lukas@rathsach.com' then
    raise exception 'Not authorized';
  end if;
  return query
    select i.code, i.created_at, i.used_at
    from public.invites i
    order by i.created_at desc;
end;
$$;
grant execute on function public.list_invites to authenticated;
