-- ============================================================
-- Mapping Area (Web) — Fase 2: Tabel Aset & Jaringan
-- Jalankan di Supabase SQL Editor SETELAH 001_init.sql (profiles/roles).
-- Menggunakan helper public.current_role_of() / public.is_admin()
-- yang sudah dibuat di 001_init.sql.
-- ============================================================

create extension if not exists postgis;

-- ---------- Fungsi bantu updated_at (jika belum ada) ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- 1) PROJECTS ----------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text default 'Perencanaan',
  description text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 2) AREAS (polygon) ----------
create table if not exists public.areas (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete set null,
  name        text not null,
  category    text,
  notes       text,
  geometry    geometry(Polygon, 4326),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists areas_geom_idx on public.areas using gist (geometry);

-- ---------- 3) POPS (point) ----------
create table if not exists public.pops (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  capacity_port integer,
  lat           double precision not null,
  lng           double precision not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------- 4) ODC (point, splitter 1:4 ke ODP) ----------
create table if not exists public.odc (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  pop_id      uuid references public.pops(id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 5) ODP (point, splitter 1:8 ke Rumah) ----------
create table if not exists public.odp (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  odc_id      uuid references public.odc(id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 6) HOMES / RUMAH (point) ----------
create table if not exists public.homes (
  id          uuid primary key default gen_random_uuid(),
  owner_name  text not null,
  address     text,
  status      text default 'Prospek',
  odp_id      uuid references public.odp(id) on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 7) POLES / TIANG (point) ----------
create table if not exists public.poles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  height_m    numeric,
  material    text,
  condition   text,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 8) BACKBONES (line: POP -> ODC) ----------
create table if not exists public.backbones (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  pop_id      uuid references public.pops(id) on delete set null,
  odc_id      uuid references public.odc(id) on delete set null,
  length_m    numeric,
  core_count  integer,
  path        geometry(LineString, 4326),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 9) DISTRIBUTIONS (line: ODC -> ODP) ----------
create table if not exists public.distributions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  odc_id      uuid references public.odc(id) on delete set null,
  odp_id      uuid references public.odp(id) on delete set null,
  length_m    numeric,
  core_count  integer,
  path        geometry(LineString, 4326),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 10) KABELS (line generik) ----------
create table if not exists public.kabels (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  cable_type  text,
  length_m    numeric,
  path        geometry(LineString, 4326),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 11) CLOSURES (point) ----------
create table if not exists public.closures (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  core_count  integer,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 12) HANDHOLES (point) ----------
create table if not exists public.handholes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  condition   text,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- 13) JOINTBOXES (point) ----------
create table if not exists public.jointboxes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  condition   text,
  lat         double precision not null,
  lng         double precision not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- Trigger updated_at untuk semua tabel di atas
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['projects','areas','pops','odc','odp','homes','poles',
                            'backbones','distributions','kabels','closures','handholes','jointboxes']
  loop
    execute format('drop trigger if exists %I_updated_at on public.%I;', t, t);
    execute format('create trigger %I_updated_at before update on public.%I
                     for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ============================================================
-- Row Level Security — semua role login (kecuali viewer) boleh CRUD;
-- viewer hanya boleh SELECT. Sesuaikan lagi per kebutuhan Anda.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['projects','areas','pops','odc','odp','homes','poles',
                            'backbones','distributions','kabels','closures','handholes','jointboxes']
  loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %I_select_all on public.%I;', t, t);
    execute format('create policy %I_select_all on public.%I for select using (auth.uid() is not null);', t, t);

    execute format('drop policy if exists %I_write_non_viewer on public.%I;', t, t);
    execute format(
      'create policy %I_write_non_viewer on public.%I for all
       using (public.current_role_of() is distinct from ''viewer'')
       with check (public.current_role_of() is distinct from ''viewer'');', t, t);
  end loop;
end $$;

-- ============================================================
-- Realtime: aktifkan replication untuk tabel yang perlu update live
-- (dijalankan sekali; abaikan error jika publication sudah berisi tabel ini)
-- ============================================================
alter publication supabase_realtime add table public.homes, public.odc, public.odp, public.poles;
