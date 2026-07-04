/* =========================================================================
   MAPPING AREA — CONFIG.JS
   Konfigurasi global aplikasi. Ubah file ini untuk mengganti koneksi
   Supabase, tema default, bahasa, provider peta, dsb.
   Tidak ada logika bisnis di file ini.
   ========================================================================= */

window.APP_CONFIG = {
  APP_NAME: 'Mapping Area',
  VERSION: '1.0.0-web',
  COMPANY: 'Mapping Area Enterprise',

  // ---- Supabase ----
  // Ganti dengan project Supabase Anda sendiri.
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',

  // ---- Peta ----
  // 'osm'       -> OpenStreetMap raster (Leaflet, tanpa API key)
  // 'satellite' -> Esri World Imagery (Leaflet, tanpa API key)
  // 'maplibre'  -> MapLibre GL (vector, butuh style URL sendiri jika ada)
  MAP_PROVIDER: 'osm',
  MAPLIBRE_STYLE_URL: '', // isi jika MAP_PROVIDER = 'maplibre'
  DEFAULT_ZOOM: 13,
  DEFAULT_CENTER: [-6.200000, 106.816666], // [lat, lng] — Jakarta

  // ---- Tampilan ----
  THEME: 'light',      // 'light' | 'dark' (default awal, user bisa toggle)
  LANGUAGE: 'id',       // 'id' | 'en'

  // ---- Aturan Jaringan FTTH ----
  SPLITTER: {
    ODC_RATIO: 4,   // 1:4 -> ODC ke Distribution
    ODP_RATIO: 8,   // 1:8 -> ODP ke Rumah
  },

  // ---- Performa ----
  PERFORMANCE: {
    MARKER_CLUSTER_THRESHOLD: 200,   // di atas ini, marker di-cluster
    PAGE_SIZE: 50,                   // default pagination tabel
    MAP_PAGE_SIZE: 2000,             // fetch per-batch untuk viewport rendering
    VIEWPORT_PADDING: 0.15,          // padding bbox saat query by-viewport
    AUTOSAVE_INTERVAL_MS: 15000,     // auto-save draft form setiap 15 detik
  },

  // ---- Coverage ----
  COVERAGE: {
    ODP_SERVICE_RADIUS_M: 250, // radius layanan 1 ODP ke rumah sekitar
  },

  // ---- Role & Permission ----
  ROLES: ['super_admin', 'admin', 'planner', 'supervisor', 'surveyor', 'viewer'],

  // ---- Definisi Modul Aset (Fase 2) ----
  // Setiap entri menghasilkan modul CRUD lengkap (tabel, pagination, form,
  // pencarian) secara otomatis lewat createAssetModule() di app.js.
  // geometryType: 'point' | 'line' | 'polygon' | 'none'
  ASSET_DEFS: {
    project: {
      table: 'projects', title: 'Project', geometryType: 'none',
      fields: [
        { key: 'name', label: 'Nama Project', type: 'text', required: true },
        { key: 'status', label: 'Status', type: 'select', options: ['Perencanaan', 'Berjalan', 'Selesai', 'Ditunda'] },
        { key: 'description', label: 'Deskripsi', type: 'textarea' },
      ],
    },
    area: {
      table: 'areas', title: 'Area', geometryType: 'polygon', geometryColumn: 'geometry_geojson',
      fields: [
        { key: 'name', label: 'Nama Area', type: 'text', required: true },
        { key: 'category', label: 'Kategori', type: 'select', options: ['Residensial', 'Komersial', 'Industri'] },
        { key: 'notes', label: 'Catatan', type: 'textarea' },
      ],
    },
    rumah: {
      table: 'homes', title: 'Rumah', geometryType: 'point',
      fields: [
        { key: 'owner_name', label: 'Nama Pemilik', type: 'text', required: true },
        { key: 'address', label: 'Alamat', type: 'text' },
        { key: 'status', label: 'Status', type: 'select', options: ['Prospek', 'Survey', 'Pelanggan'] },
        { key: 'odp_id', label: 'ODP Terhubung', type: 'relation', relationTable: 'odp', relationLabel: 'name' },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
    tiang: {
      table: 'poles', title: 'Tiang Besi', geometryType: 'point',
      fields: [
        { key: 'code', label: 'Kode Tiang', type: 'text', required: true },
        { key: 'height_m', label: 'Tinggi (m)', type: 'number' },
        { key: 'material', label: 'Material', type: 'select', options: ['Besi', 'Beton', 'Kayu'] },
        { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
    pop: {
      table: 'pops', title: 'POP', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama POP', type: 'text', required: true },
        { key: 'address', label: 'Alamat', type: 'text' },
        { key: 'capacity_port', label: 'Kapasitas Port', type: 'number' },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
    odc: {
      table: 'odc', title: 'ODC', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama ODC', type: 'text', required: true },
        { key: 'pop_id', label: 'POP Induk', type: 'relation', relationTable: 'pops', relationLabel: 'name' },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
      splitter: { childTable: 'odp', parentKey: 'odc_id', ratioKey: 'ODC_RATIO', childLabel: 'ODP' },
    },
    odp: {
      table: 'odp', title: 'ODP', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama ODP', type: 'text', required: true },
        { key: 'odc_id', label: 'ODC Induk', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
      splitter: { childTable: 'homes', parentKey: 'odp_id', ratioKey: 'ODP_RATIO', childLabel: 'Rumah' },
    },
    backbone: {
      table: 'backbones', title: 'Backbone', geometryType: 'line', geometryColumn: 'path_geojson',
      fields: [
        { key: 'name', label: 'Nama Kabel', type: 'text', required: true },
        { key: 'pop_id', label: 'Dari POP', type: 'relation', relationTable: 'pops', relationLabel: 'name' },
        { key: 'odc_id', label: 'Ke ODC', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
        { key: 'length_m', label: 'Panjang (m)', type: 'number' },
        { key: 'core_count', label: 'Jumlah Core', type: 'number' },
      ],
    },
    distribution: {
      table: 'distributions', title: 'Distribution', geometryType: 'line', geometryColumn: 'path_geojson',
      fields: [
        { key: 'name', label: 'Nama Kabel', type: 'text', required: true },
        { key: 'odc_id', label: 'Dari ODC', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
        { key: 'odp_id', label: 'Ke ODP', type: 'relation', relationTable: 'odp', relationLabel: 'name' },
        { key: 'length_m', label: 'Panjang (m)', type: 'number' },
        { key: 'core_count', label: 'Jumlah Core', type: 'number' },
      ],
    },
    kabel: {
      table: 'kabels', title: 'Kabel', geometryType: 'line', geometryColumn: 'path_geojson',
      fields: [
        { key: 'name', label: 'Nama Kabel', type: 'text', required: true },
        { key: 'cable_type', label: 'Jenis Kabel', type: 'select', options: ['Feeder', 'Distribusi', 'Drop Core'] },
        { key: 'length_m', label: 'Panjang (m)', type: 'number' },
      ],
    },
    closure: {
      table: 'closures', title: 'Closure', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama Closure', type: 'text', required: true },
        { key: 'core_count', label: 'Kapasitas Core', type: 'number' },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
    handhole: {
      table: 'handholes', title: 'Handhole', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama Handhole', type: 'text', required: true },
        { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
    jointbox: {
      table: 'jointboxes', title: 'Joint Box', geometryType: 'point',
      fields: [
        { key: 'name', label: 'Nama Joint Box', type: 'text', required: true },
        { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
        { key: 'lat', label: 'Latitude', type: 'number', required: true },
        { key: 'lng', label: 'Longitude', type: 'number', required: true },
      ],
    },
  },

  // ---- Struktur menu sidebar ----
  NAV_GROUPS: [
    {
      title: 'Utama',
      items: [
        { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high' },
        { key: 'project', label: 'Project', icon: 'fa-folder' },
      ],
    },
    {
      title: 'GIS',
      items: [
        { key: 'mapping', label: 'Mapping', icon: 'fa-map' },
        { key: 'import', label: 'Import Data', icon: 'fa-file-import' },
        { key: 'area', label: 'Area', icon: 'fa-draw-polygon' },
      ],
    },
    {
      title: 'Inventaris Aset',
      items: [
        { key: 'rumah', label: 'Rumah', icon: 'fa-house' },
        { key: 'tiang', label: 'Tiang Besi', icon: 'fa-tower-cell' },
        { key: 'odc', label: 'ODC', icon: 'fa-server' },
        { key: 'odp', label: 'ODP', icon: 'fa-diagram-project' },
      ],
    },
    {
      title: 'Jaringan',
      items: [
        { key: 'pop', label: 'POP', icon: 'fa-database' },
        { key: 'backbone', label: 'Backbone', icon: 'fa-timeline' },
        { key: 'distribution', label: 'Distribution', icon: 'fa-share-nodes' },
        { key: 'kabel', label: 'Kabel', icon: 'fa-diagram-project' },
        { key: 'closure', label: 'Closure', icon: 'fa-box-archive' },
        { key: 'handhole', label: 'Handhole', icon: 'fa-inbox' },
        { key: 'jointbox', label: 'Joint Box', icon: 'fa-cubes' },
      ],
    },
    {
      title: 'Analisis',
      items: [
        { key: 'coverage', label: 'Coverage', icon: 'fa-wifi' },
        { key: 'validation', label: 'Validation', icon: 'fa-check-double' },
        { key: 'heatmap', label: 'Heatmap', icon: 'fa-fire' },
      ],
    },
    {
      title: 'Planning',
      items: [
        { key: 'scenario', label: 'Scenario & Version', icon: 'fa-layer-group' },
        { key: 'approval', label: 'Approval', icon: 'fa-stamp' },
        { key: 'summary', label: 'Planning Summary', icon: 'fa-chart-column' },
        { key: 'boq', label: 'BOQ', icon: 'fa-list-check' },
      ],
    },
    {
      title: 'Operasional',
      items: [
        { key: 'export', label: 'Export', icon: 'fa-file-export' },
        { key: 'notification', label: 'Notifikasi', icon: 'fa-bell' },
        { key: 'setting', label: 'Pengaturan', icon: 'fa-gear' },
      ],
    },
  ],
};
