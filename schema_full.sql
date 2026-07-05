-- ============================================================
-- Mapping Area (Web) — SKEMA DATABASE TERKONSOLIDASI
-- File tunggal gabungan migration 002 + 003 + 004 + 005.
-- Dibuat: 2026-07-04.
--
-- TUJUAN
--   Menyatukan seluruh migration agar tidak tercecer. Cukup jalankan
--   SATU file ini di Supabase SQL Editor.
--
-- SIFAT
--   ADDITIVE & IDEMPOTENT. Aman dijalankan berkali-kali:
--     - create table/extension/index IF NOT EXISTS
--     - add column IF NOT EXISTS
--     - drop policy/trigger IF EXISTS sebelum create
--     - publication realtime dibungkus penanganan error (tidak menggagalkan skrip)
--   TIDAK menghapus tabel/kolom/data apa pun.
--
-- PRASYARAT
--   Jalankan 001_init.sql (profiles/roles) LEBIH DULU. File ini memakai helper
--   public.current_role_of() dan public.is_admin() yang dibuat di 001_init.sql.
--   (001 tidak ikut digabung karena tidak tersedia saat konsolidasi.)
--
-- ISI (urut aman):
--   [A] 002 — Tabel Aset & Jaringan (projects, areas, pops, odc, odp, homes,
--             poles, backbones, distributions, kabels, closures, handholes,
--             jointboxes) + trigger updated_at + RLS + realtime.
--   [B] 003 — Project Scope (kolom project_id pada tabel aset + index).
--   [C] 004 — Smart Planning staging (planning_sessions/runs/boundaries/
--             buildings/roads/coverage/outputs/boq_drafts/proposals).
--   [D] 005 — Analisa Area (planning_analysis, building_analysis,
--             road_analysis, coverage_analysis).
--   [E] 006 — Auto Network Planning draft (planning_home, planning_odp,
--             planning_odc, planning_backbone, planning_distribution,
--             planning_boq).
-- ============================================================


-- ############################################################
-- ## [A] MIGRATION 002 — TABEL ASET & JARINGAN
-- ############################################################

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
do $$
begin
  -- Idempotent: abaikan bila tabel sudah terdaftar di publication.
  begin
    alter publication supabase_realtime add table public.homes, public.odc, public.odp, public.poles;
  exception
    when duplicate_object then null;
    when others then null;
  end;
end $$;


-- ############################################################
-- ## [B] MIGRATION 003 — PROJECT SCOPE (project_id)
-- ############################################################

-- ============================================================
-- Mapping Area (Web) — Migration 003: Project Scope
-- Jalankan di Supabase SQL Editor SETELAH 002_assets.sql.
--
-- Sifat perubahan: ADDITIVE ONLY.
--   - Tidak menghapus tabel/kolom/data apa pun.
--   - Hanya menambahkan kolom project_id (nullable) ke tabel aset yang
--     sebelumnya belum tertaut ke project (areas sudah punya project_id
--     sejak 002_assets.sql, jadi tidak disentuh di sini).
--   - Data lama tetap valid (project_id = NULL, artinya "belum ditautkan
--     ke project manapun"), tidak ada baris yang rusak/hilang.
--
-- Tujuan: mendukung modul "Project Detail" (Implementasi 01) yang
-- menampilkan ringkasan jumlah aset per project.
-- ============================================================

alter table public.pops        add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.odc         add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.odp         add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.homes       add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.poles       add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.backbones   add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.distributions add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.kabels      add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.closures    add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.handholes   add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.jointboxes  add column if not exists project_id uuid references public.projects(id) on delete set null;

-- Index untuk mempercepat query "aset dalam project X" (dipakai kartu
-- ringkasan di halaman Project Detail).
do $$
declare t text;
begin
  foreach t in array array['pops','odc','odp','homes','poles','backbones',
                            'distributions','kabels','closures','handholes','jointboxes']
  loop
    execute format('create index if not exists %I_project_id_idx on public.%I (project_id);', t, t);
  end loop;
end $$;

-- Tidak ada perubahan RLS/policy — policy existing dari 002_assets.sql
-- (select untuk semua yang login, write untuk non-viewer) tetap berlaku
-- apa adanya karena tidak bergantung pada kolom baru ini.


-- ############################################################
-- ## [C] MIGRATION 004 — SMART PLANNING (STAGING FASE GENERATE)
-- ############################################################

-- ============================================================
-- Mapping Area (Web) — Migration 004: Smart Planning (FONDASI)
-- Implementation 01.5.
-- Jalankan di Supabase SQL Editor SETELAH 003_project_scope.sql.
--
-- SIFAT PERUBAHAN: ADDITIVE ONLY & IDEMPOTENT.
--   - HANYA MENAMBAH tabel baru berprefix "planning_" untuk menampung
--     hasil Smart Planning nanti (staging). TIDAK menyentuh tabel aset
--     lama (homes/odp/odc/poles/backbones/distributions/dll).
--   - TIDAK menghapus tabel/kolom/data apa pun.
--   - Aman dijalankan berkali-kali (create table if not exists,
--     drop policy if exists sebelum create).
--   - BELUM mengisi data. BELUM ada logika. Murni pondasi skema.
--
-- Reuse helper dari migration sebelumnya:
--   public.set_updated_at()   (dibuat di 002_assets.sql)
--   public.current_role_of()  (dibuat di 001_init.sql)
--   extension postgis         (diaktifkan di 002_assets.sql)
--
-- CATATAN DESAIN
--   Tabel "planning_outputs" sengaja dibuat generik (feature_type + geometry
--   + props jsonb) agar TIDAK menduplikasi 11 tabel aset yang sudah ada.
--   Pada Implementation 02, hasil generate yang sudah di-APPROVE dapat
--   dipromosikan (disalin) ke tabel aset asli (odp/odc/poles/...) dengan
--   project_id terisi. Dengan begitu tidak ada tabel duplikat.
-- ============================================================

-- ---------- 1) PLANNING SESSIONS (satu project bisa punya banyak skenario) ----------
create table if not exists public.planning_sessions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete cascade,
  name        text not null default 'Skenario Planning',
  mode        text not null default 'smart',      -- 'manual' | 'smart'
  status      text not null default 'draft',       -- draft | review | approved | archived
  notes       text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists planning_sessions_project_idx on public.planning_sessions (project_id);

-- ---------- 2) PLANNING RUNS (satu eksekusi Planning Engine) ----------
create table if not exists public.planning_runs (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid references public.planning_sessions(id) on delete cascade,
  engine_version text,
  status         text not null default 'pending',  -- pending | running | done | failed | stub
  params         jsonb not null default '{}'::jsonb,
  summary        jsonb not null default '{}'::jsonb,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists planning_runs_session_idx on public.planning_runs (session_id);

-- ---------- 3) BOUNDARY SERVICE OUTPUT ----------
create table if not exists public.planning_boundaries (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.planning_runs(id) on delete cascade,
  name        text,
  area_sqm    numeric,
  geometry    geometry(Geometry, 4326),
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists planning_boundaries_run_idx  on public.planning_boundaries (run_id);
create index if not exists planning_boundaries_geom_idx on public.planning_boundaries using gist (geometry);

-- ---------- 4) BUILDING SERVICE OUTPUT ----------
create table if not exists public.planning_buildings (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references public.planning_runs(id) on delete cascade,
  estimated_homes integer default 0,
  geometry       geometry(Geometry, 4326),
  props          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists planning_buildings_run_idx  on public.planning_buildings (run_id);
create index if not exists planning_buildings_geom_idx on public.planning_buildings using gist (geometry);

-- ---------- 5) ROAD SERVICE OUTPUT ----------
create table if not exists public.planning_roads (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.planning_runs(id) on delete cascade,
  name        text,
  length_m    numeric,
  geometry    geometry(Geometry, 4326),
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists planning_roads_run_idx  on public.planning_roads (run_id);
create index if not exists planning_roads_geom_idx on public.planning_roads using gist (geometry);

-- ---------- 6) COVERAGE SERVICE OUTPUT ----------
create table if not exists public.planning_coverage (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid references public.planning_runs(id) on delete cascade,
  covered_count    integer default 0,
  uncovered_count  integer default 0,
  radius_m         numeric,
  geometry         geometry(Geometry, 4326),
  props            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists planning_coverage_run_idx  on public.planning_coverage (run_id);
create index if not exists planning_coverage_geom_idx on public.planning_coverage using gist (geometry);

-- ---------- 7) GENERATED FEATURES (staging generik: ODP/ODC/backbone/distribution/pole) ----------
-- feature_type: 'odp' | 'odc' | 'backbone' | 'distribution' | 'pole' | ...
-- Dipromosikan ke tabel aset asli setelah approval (Implementation 02).
create table if not exists public.planning_outputs (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references public.planning_runs(id) on delete cascade,
  feature_type  text not null,
  label         text,
  geometry      geometry(Geometry, 4326),
  props         jsonb not null default '{}'::jsonb,
  promoted      boolean not null default false,   -- true bila sudah disalin ke tabel aset asli
  promoted_ref  uuid,                              -- id baris di tabel aset asli (nanti)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists planning_outputs_run_idx   on public.planning_outputs (run_id);
create index if not exists planning_outputs_type_idx  on public.planning_outputs (feature_type);
create index if not exists planning_outputs_geom_idx  on public.planning_outputs using gist (geometry);

-- ---------- 8) BOQ DRAFT (TANPA HARGA) ----------
create table if not exists public.planning_boq_drafts (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.planning_runs(id) on delete cascade,
  item        text not null,
  unit        text,
  quantity    numeric not null default 0,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists planning_boq_drafts_run_idx on public.planning_boq_drafts (run_id);

-- ---------- 9) PROPOSAL ----------
create table if not exists public.planning_proposals (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.planning_runs(id) on delete cascade,
  title       text,
  content     jsonb not null default '{}'::jsonb,
  status      text not null default 'draft',       -- draft | review | approved
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists planning_proposals_run_idx on public.planning_proposals (run_id);

-- ============================================================
-- Trigger updated_at untuk seluruh tabel planning_* di atas
-- (reuse public.set_updated_at()).
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_sessions','planning_runs','planning_boundaries',
                            'planning_buildings','planning_roads','planning_coverage',
                            'planning_outputs','planning_boq_drafts','planning_proposals']
  loop
    execute format('drop trigger if exists %I_updated_at on public.%I;', t, t);
    execute format('create trigger %I_updated_at before update on public.%I
                     for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ============================================================
-- Row Level Security — pola SAMA seperti 002_assets.sql:
--   SELECT untuk semua yang login; write untuk non-viewer.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_sessions','planning_runs','planning_boundaries',
                            'planning_buildings','planning_roads','planning_coverage',
                            'planning_outputs','planning_boq_drafts','planning_proposals']
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

-- Tidak ada perubahan pada tabel/policy lama. Tidak ada data yang diisi.
-- Selesai — skema fondasi Smart Planning siap untuk Implementation 02.


-- ############################################################
-- ## [D] MIGRATION 005 — ANALISA AREA (PHASE 1)
-- ############################################################

-- ============================================================
-- Mapping Area (Web) — Migration 005: Smart Planning ANALYSIS (Phase 1)
-- Implementation 02 / Phase 1 — Analisa Area.
-- Jalankan di Supabase SQL Editor SETELAH 004_smart_planning.sql.
--
-- SIFAT PERUBAHAN: ADDITIVE ONLY & IDEMPOTENT.
--   - HANYA MENAMBAH 4 tabel baru untuk menyimpan HASIL ANALISA AREA:
--       planning_analysis  (header/ringkasan)
--       building_analysis  (detail bangunan + geojson)
--       road_analysis      (detail jalan + geojson)
--       coverage_analysis  (detail coverage)
--   - TIDAK menghapus/mengubah tabel lama (termasuk tabel planning_* dari 004).
--   - Aman dijalankan berkali-kali (create table if not exists,
--     drop policy if exists sebelum create).
--
-- CATATAN
--   Tabel ini BERBEDA dari planning_* pada migration 004:
--     * 004 (planning_sessions/runs/outputs/...) = staging untuk fase GENERATE
--       (ODP/ODC/backbone/dst) — belum dipakai, disiapkan untuk Phase 2+.
--     * 005 (*_analysis) = hasil fase ANALISA AREA (Phase 1) — dipakai sekarang.
--   Geometri disimpan sebagai GeoJSON dalam kolom jsonb (bukan PostGIS geometry)
--   agar mudah dirender ulang di client (Leaflet) tanpa konversi WKB.
--   Reuse helper public.set_updated_at() (002) & public.current_role_of() (001).
-- ============================================================

-- ---------- 1) PLANNING ANALYSIS (header) ----------
create table if not exists public.planning_analysis (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid references public.projects(id) on delete set null,
  planner            text,
  created_by         uuid references auth.users(id),
  status             text not null default 'done',
  engine_version     text,
  area_sqm           numeric,
  perimeter_m        numeric,
  bbox               jsonb,
  coordinate_system  text,
  boundary_type      text,
  boundary_geojson   jsonb,
  building_count     integer default 0,
  home_count         integer default 0,
  non_home_count     integer default 0,
  road_count         integer default 0,
  road_segment_count integer default 0,
  road_length_m      numeric default 0,
  intersection_count integer default 0,
  density_per_km2    numeric,
  coverage_percent   numeric,
  provider_building  text,
  provider_road      text,
  analyzed_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists planning_analysis_project_idx on public.planning_analysis (project_id);
create index if not exists planning_analysis_analyzed_idx on public.planning_analysis (analyzed_at desc);

-- ---------- 2) BUILDING ANALYSIS ----------
create table if not exists public.building_analysis (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid references public.planning_analysis(id) on delete cascade,
  provider        text,
  total           integer default 0,
  homes           integer default 0,
  non_homes       integer default 0,
  density_per_km2 numeric,
  geojson         jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists building_analysis_analysis_idx on public.building_analysis (analysis_id);

-- ---------- 3) ROAD ANALYSIS ----------
create table if not exists public.road_analysis (
  id                 uuid primary key default gen_random_uuid(),
  analysis_id        uuid references public.planning_analysis(id) on delete cascade,
  provider           text,
  road_count         integer default 0,
  total_segments     integer default 0,
  total_length_m     numeric default 0,
  intersection_count integer default 0,
  road_types         jsonb,
  geojson            jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists road_analysis_analysis_idx on public.road_analysis (analysis_id);

-- ---------- 4) COVERAGE ANALYSIS ----------
create table if not exists public.coverage_analysis (
  id               uuid primary key default gen_random_uuid(),
  analysis_id      uuid references public.planning_analysis(id) on delete cascade,
  building_count   integer default 0,
  home_count       integer default 0,
  non_home_count   integer default 0,
  area_sqm         numeric,
  road_length_m    numeric,
  density_per_km2  numeric,
  coverage_percent numeric,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists coverage_analysis_analysis_idx on public.coverage_analysis (analysis_id);

-- ============================================================
-- Trigger updated_at (reuse public.set_updated_at()).
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_analysis','building_analysis','road_analysis','coverage_analysis']
  loop
    execute format('drop trigger if exists %I_updated_at on public.%I;', t, t);
    execute format('create trigger %I_updated_at before update on public.%I
                     for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ============================================================
-- Row Level Security — pola SAMA seperti 002_assets.sql:
--   SELECT untuk semua yang login; write untuk non-viewer.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_analysis','building_analysis','road_analysis','coverage_analysis']
  loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %I_select_all on public.%I;', t, t);
    execute format('create policy %I_select_all on public.%I for select using (auth.uid() is not null);', t, t);

    execute format('drop policy if exists %I_write_non_viewer on public.%I;', t, t);
    execute format(
      'create policy %I_write_non_viewer on public.%I for all
       using (public.current_role_of() is distinct from ''viewer'')
       with check (public.current_role_of() is distinct from ''viewe-- ############################################################
-- ## [E] MIGRATION 006 — AUTO NETWORK PLANNING (PHASE 2 DRAFT)
-- ############################################################

-- ============================================================
-- Mapping Area (Web) — Migration 006: Smart Planning GENERATE (Phase 2)
-- Implementation 03 / Phase 2 — Auto Network Planning.
-- Jalankan di Supabase SQL Editor SETELAH 005_smart_planning_analysis.sql.
--
-- SIFAT: ADDITIVE ONLY & IDEMPOTENT.
--   - Menambah 6 tabel DRAFT hasil generate:
--       planning_home, planning_odp, planning_odc,
--       planning_backbone, planning_distribution, planning_boq
--   - TIDAK menghapus/mengubah tabel lama.
--   - Aman dijalankan berkali-kali (create if not exists, drop policy if exists).
--
-- MODEL DATA
--   Tiap generate menghasilkan `generation_id` (append-only, tanpa DELETE).
--   Draft terbaru = generation_id dengan generated_at paling akhir untuk sebuah
--   analysis_id. Geometri disimpan sebagai GeoJSON (jsonb) agar mudah dirender
--   ulang di Leaflet (Review Mode). Reuse set_updated_at() (002) &
--   current_role_of() (001). BOQ tanpa harga.
-- ============================================================

-- ---------- 1) HOME PASSED (ringkasan bangunan per generate) ----------
create table if not exists public.planning_home (
  id               uuid primary key default gen_random_uuid(),
  analysis_id      uuid references public.planning_analysis(id) on delete cascade,
  generation_id    uuid not null,
  planner          text,
  generated_at     timestamptz not null default now(),
  building_count   integer default 0,
  home_count       integer default 0,
  non_home_count   integer default 0,
  apartment_count  integer default 0,
  ruko_count       integer default 0,
  gedung_count     integer default 0,
  other_count      integer default 0,
  home_passed      integer default 0,
  coverage_percent numeric,
  density_per_km2  numeric,
  geojson          jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists planning_home_analysis_idx on public.planning_home (analysis_id);
create index if not exists planning_home_gen_idx      on public.planning_home (generation_id);

-- ---------- 2) PLANNING ODP (1 baris per ODP) ----------
create table if not exists public.planning_odp (
  id                uuid primary key default gen_random_uuid(),
  analysis_id       uuid references public.planning_analysis(id) on delete cascade,
  generation_id     uuid not null,
  odp_id            text,
  lat               numeric,
  lng               numeric,
  home_count        integer default 0,
  home_ids          jsonb,
  coverage_radius_m numeric,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists planning_odp_analysis_idx on public.planning_odp (analysis_id);
create index if not exists planning_odp_gen_idx      on public.planning_odp (generation_id);

-- ---------- 3) PLANNING ODC (1 baris per ODC) ----------
create table if not exists public.planning_odc (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid references public.planning_analysis(id) on delete cascade,
  generation_id uuid not null,
  odc_id        text,
  lat           numeric,
  lng           numeric,
  odp_count     integer default 0,
  odp_ids       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists planning_odc_analysis_idx on public.planning_odc (analysis_id);
create index if not exists planning_odc_gen_idx      on public.planning_odc (generation_id);

-- ---------- 4) BACKBONE DRAFT (1 baris per generate) ----------
create table if not exists public.planning_backbone (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid references public.planning_analysis(id) on delete cascade,
  generation_id uuid not null,
  length_m      numeric default 0,
  segment_count integer default 0,
  geojson       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists planning_backbone_analysis_idx on public.planning_backbone (analysis_id);
create index if not exists planning_backbone_gen_idx      on public.planning_backbone (generation_id);

-- ---------- 5) DISTRIBUTION DRAFT (1 baris per generate) ----------
create table if not exists public.planning_distribution (
  id            uuid primary key default gen_random_uuid(),
  analysis_id   uuid references public.planning_analysis(id) on delete cascade,
  generation_id uuid not null,
  length_m      numeric default 0,
  segment_count integer default 0,
  geojson       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists planning_distribution_analysis_idx on public.planning_distribution (analysis_id);
create index if not exists planning_distribution_gen_idx      on public.planning_distribution (generation_id);

-- ---------- 6) BOQ DRAFT (tanpa harga) ----------
create table if not exists public.planning_boq (
  id                    uuid primary key default gen_random_uuid(),
  analysis_id           uuid references public.planning_analysis(id) on delete cascade,
  generation_id         uuid not null,
  status                text not null default 'draft',   -- draft | approved
  odp_count             integer default 0,
  odc_count             integer default 0,
  pole_count            integer default 0,
  pole_span_m           numeric,
  backbone_length_m     numeric default 0,
  distribution_length_m numeric default 0,
  closure_count         integer default 0,
  handhole_count        integer default 0,
  jointbox_count        integer default 0,
  cable_backbone_m      numeric default 0,
  cable_distribution_m  numeric default 0,
  items                 jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists planning_boq_analysis_idx on public.planning_boq (analysis_id);
create index if not exists planning_boq_gen_idx      on public.planning_boq (generation_id);

-- ============================================================
-- Trigger updated_at (reuse public.set_updated_at()).
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_home','planning_odp','planning_odc',
                            'planning_backbone','planning_distribution','planning_boq']
  loop
    execute format('drop trigger if exists %I_updated_at on public.%I;', t, t);
    execute format('create trigger %I_updated_at before update on public.%I
                     for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ============================================================
-- RLS — pola SAMA seperti 002: SELECT untuk yang login; write untuk non-viewer.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['planning_home','planning_odp','planning_odc',
                            'planning_backbone','planning_distribution','planning_boq']
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

-- Selesai — skema draft Auto Network Planning (Phase 2) siap dipakai.


r'');', t, t);
  end loop;
end $$;

-- Selesai — skema hasil Analisa Area (Phase 1) siap dipakai.
-- Tidak ada perubahan pada tabel/policy lama & tidak ada data yang diisi.

-- ============================================================
-- SELESAI — seluruh skema (002–005) sudah diterapkan dari satu file.
-- ============================================================
