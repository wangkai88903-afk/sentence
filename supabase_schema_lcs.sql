-- =====================================================================
-- 初中英语长难句打卡 · Supabase 侧最小表结构（口味 A）
-- ---------------------------------------------------------------------
-- 架构不变量：
--   * 家庭业务数据（accounts / checkins / extra / removed，含打卡照片 base64）
--     100% 仍存放在 Cloudflare R2 的 families/{familyId}.json，本库一个字节都不存。
--   * Supabase 只负责两件事：① 全局账号认证（auth.users）② user -> familyId 映射。
--   * 与词根应用共用同一 Supabase 项目，所有对象以 lcs_ 前缀隔离，
--     不触碰词根的 user_data 表。
--
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴全文 → Run
-- 可重复执行（幂等）。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) 用户资料表：Supabase user  ->  显示用的中文用户名
--    登录邮箱是合成值（见 migration plan），真正给人看的名字存这里。
-- ---------------------------------------------------------------------
create table if not exists public.lcs_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text not null,
  created_at timestamptz not null default now()
);

-- 全局用户名唯一（大小写不敏感）——这就是"用户名全局唯一"的落点
create unique index if not exists lcs_profiles_username_uidx
  on public.lcs_profiles (lower(username));


-- ---------------------------------------------------------------------
-- 2) 家庭成员映射表：user -> R2 里的 familyId
--    family_id 是 R2 对象名的一部分（families/{family_id}.json），
--    故为 text，不设外键（数据本体不在本库）。
-- ---------------------------------------------------------------------
create table if not exists public.lcs_family_members (
  user_id   uuid not null references auth.users(id) on delete cascade,
  family_id text not null,
  role      text not null default 'child',   -- 'parent' | 'child'
  joined_at timestamptz not null default now(),
  primary key (user_id, family_id)
);

create index if not exists lcs_family_members_family_idx
  on public.lcs_family_members (family_id);


-- ---------------------------------------------------------------------
-- 3) 家庭邀请码表：替代原 familyKey 的"加入家庭"用途
--    表本身不对客户端开放 select（防枚举），只能通过下方 RPC 兑换。
-- ---------------------------------------------------------------------
create table if not exists public.lcs_family_invites (
  code       text primary key,
  family_id  text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  used_by    uuid references auth.users(id) on delete set null,
  used_at    timestamptz
);


-- ---------------------------------------------------------------------
-- 4) 辅助函数：返回当前用户所属的 family_id 集合
--    security definer 绕过 RLS，避免 lcs_family_members 策略自引用导致
--    "infinite recursion detected in policy" 错误。
-- ---------------------------------------------------------------------
create or replace function public.lcs_my_families()
returns setof text
language sql
security definer
set search_path = public
stable
as $$
  select family_id
    from public.lcs_family_members
   where user_id = auth.uid()
$$;

revoke all on function public.lcs_my_families() from public;
grant execute on function public.lcs_my_families() to authenticated;


-- ---------------------------------------------------------------------
-- 5) RPC：创建家庭（把调用者登记为 parent）
--    family_id 由客户端从 Worker 的 /api/family/create 拿到后传入。
-- ---------------------------------------------------------------------
create or replace function public.lcs_claim_family(p_family_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_family_id is null or length(trim(p_family_id)) = 0 then
    raise exception 'invalid family_id';
  end if;

  -- 已被别人占用的 family 不允许再 claim（防止猜 familyId 蹭进别人家庭）
  if exists (
    select 1 from public.lcs_family_members
     where family_id = p_family_id
       and user_id <> auth.uid()
  ) then
    raise exception 'family already claimed';
  end if;

  insert into public.lcs_family_members (user_id, family_id, role)
  values (auth.uid(), p_family_id, 'parent')
  on conflict (user_id, family_id) do nothing;
end;
$$;

revoke all on function public.lcs_claim_family(text) from public;
grant execute on function public.lcs_claim_family(text) to authenticated;


-- ---------------------------------------------------------------------
-- 6) RPC：签发邀请码（仅家庭内 parent 可用）
-- ---------------------------------------------------------------------
create or replace function public.lcs_create_invite(
  p_family_id text,
  p_ttl_hours int default 72
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1 from public.lcs_family_members
     where user_id = auth.uid()
       and family_id = p_family_id
       and role = 'parent'
  ) then
    raise exception 'only a parent of this family can invite';
  end if;

  -- 8 位大写去混淆字符集
  v_code := upper(
    translate(
      substr(encode(gen_random_bytes(8), 'base64'), 1, 10),
      '+/=OoIil01', 'ABCDEFGHJK'
    )
  );
  v_code := substr(v_code, 1, 8);

  insert into public.lcs_family_invites (code, family_id, created_by, expires_at)
  values (v_code, p_family_id, auth.uid(), now() + make_interval(hours => p_ttl_hours));

  return v_code;
end;
$$;

revoke all on function public.lcs_create_invite(text, int) from public;
grant execute on function public.lcs_create_invite(text, int) to authenticated;


-- ---------------------------------------------------------------------
-- 7) RPC：兑换邀请码加入家庭
--    返回 family_id；无效码统一报同一个错误，不区分"不存在/已用/过期"。
-- ---------------------------------------------------------------------
create or replace function public.lcs_redeem_invite(p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select family_id into v_family
    from public.lcs_family_invites
   where code = upper(trim(p_code))
     and used_by is null
     and (expires_at is null or expires_at > now())
   for update;

  if v_family is null then
    raise exception 'invalid or expired invite code';
  end if;

  update public.lcs_family_invites
     set used_by = auth.uid(), used_at = now()
   where code = upper(trim(p_code));

  insert into public.lcs_family_members (user_id, family_id, role)
  values (auth.uid(), v_family, 'child')
  on conflict (user_id, family_id) do nothing;

  return v_family;
end;
$$;

revoke all on function public.lcs_redeem_invite(text) from public;
grant execute on function public.lcs_redeem_invite(text) to authenticated;


-- ---------------------------------------------------------------------
-- 8) RLS 策略
-- ---------------------------------------------------------------------
alter table public.lcs_profiles        enable row level security;
alter table public.lcs_family_members  enable row level security;
alter table public.lcs_family_invites  enable row level security;

-- lcs_profiles：本人可读写自己；同家庭成员可读（用于显示成员列表）
drop policy if exists lcs_profiles_self_rw on public.lcs_profiles;
create policy lcs_profiles_self_rw on public.lcs_profiles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists lcs_profiles_family_read on public.lcs_profiles;
create policy lcs_profiles_family_read on public.lcs_profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.lcs_family_members m
       where m.user_id = lcs_profiles.user_id
         and m.family_id in (select public.lcs_my_families())
    )
  );

-- lcs_family_members：可读自己所属家庭的全部成员行；写入只走上面的 RPC
drop policy if exists lcs_family_members_read on public.lcs_family_members;
create policy lcs_family_members_read on public.lcs_family_members
  for select to authenticated
  using (family_id in (select public.lcs_my_families()));

-- lcs_family_invites：客户端一律不可直接读写（只能通过 RPC）
--   —— 不建任何 policy，RLS 开启后默认全部拒绝。


-- ---------------------------------------------------------------------
-- 9) 自检
-- ---------------------------------------------------------------------
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name like 'lcs_%')        as lcs_tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lcs_%')            as lcs_functions;
