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
