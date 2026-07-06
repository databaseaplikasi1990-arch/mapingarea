/* =========================================================================
   MAPPING AREA — CONFIG.JS
   =========================================================================
   CATATAN PENTING (WAJIB DIBACA):
   File ini TIDAK PERNAH diupload/diberikan sepanjang seluruh percakapan
   proyek ini, padahal direferensikan luas oleh app.js (CFG.SUPABASE_URL,
   CFG.NAV_GROUPS, CFG.ASSET_DEFS, dst). File ini DITULIS ULANG DARI NOL
   dengan menelusuri SETIAP pemakaian `CFG.xxx` di app.js/planning-*.js,
   supaya aplikasi bisa berjalan lengkap. Lihat FINAL_AUDIT_REPORT.md §0.

   WAJIB ANDA ISI SEBELUM DEPLOY:
     - SUPABASE_URL dan SUPABASE_ANON_KEY (baris di bawah, isi placeholder
       "GANTI_DENGAN_..." dengan nilai project Supabase Anda sendiri).
       PENTING: pakai ANON key, JANGAN PERNAH service_role key di sini
       (file ini dikirim ke browser publik).

   Jika Anda punya config.js versi asli yang berbeda (mis. NAV_GROUPS dengan
   urutan/label lain), SILAKAN timpa file ini dengan versi asli Anda —
   selama seluruh key yang dipakai app.js (lihat daftar di bawah) tetap ada,
   aplikasi akan tetap berjalan normal.
   ========================================================================= */
(function () {
  'use strict';

  window.CFG = {
    // ---------- Koneksi Supabase (WAJIB DIISI) ----------
    SUPABASE_URL: 'GANTI_DENGAN_URL_SUPABASE_ANDA',       // contoh: 'https://xxxxxxxx.supabase.co'
    SUPABASE_ANON_KEY: 'GANTI_DENGAN_ANON_KEY_SUPABASE_ANDA',

    // ---------- Umum ----------
    VERSION: '1.0.0',
    THEME: 'light',                 // 'light' | 'dark' — default tema saat pertama kali dibuka
    MAP_PROVIDER: 'street',         // 'street' | 'satellite' — basemap default halaman Mapping

    // ---------- Peta ----------
    DEFAULT_CENTER: [-6.5971, 106.8060], // default: area Bogor (sesuaikan ke wilayah kerja Anda)
    DEFAULT_ZOOM: 13,

    // ---------- Splitter (rasio kapasitas, dipakai badge "used/ratio" di tabel aset) ----------
    SPLITTER: {
      ODC_TO_ODP: 4,   // 1 ODC maksimum melayani 4 ODP
      ODP_TO_HOME: 8,  // 1 ODP maksimum melayani 8 Home Passed
    },

    // ---------- Parameter default Smart Planning (override opsional; dipakai
    // sebagai fallback merge di App.planningParams — aman dikosongkan) ----------
    PLANNING: {
      odpCapacity: 8,
      odcCapacity: 4,
      poleSpanM: 40,
      handholeSpanM: 200,
      odpCoverageRadiusM: 100,
      reserveCorePct: 20,
      cableReservePct: 10,
    },

    // ---------- Coverage (dipakai modul 'coverage') ----------
    COVERAGE: {
      ODP_SERVICE_RADIUS_M: 100,
    },

    // ---------- Performa (page size tabel & batas data peta) ----------
    PERFORMANCE: {
      PAGE_SIZE: 20,        // baris per halaman tabel CRUD generik
      MAP_PAGE_SIZE: 2000,  // batas titik yang di-fetch untuk ditampilkan di peta (mis. modul coverage)
    },

    // ---------- Struktur menu sidebar (grup "core" / CRUD generik).
    // Menu Smart Planning (Detected Buildings, Wizard, Validation, Versions,
    // Reports, Proposal, Asset Management, Global Map, Asset Reports) DITAMBAHKAN
    // OTOMATIS terpisah oleh app.js (injectSmartPlanningNav()), TIDAK perlu
    // didaftarkan di sini. ----------
    NAV_GROUPS: [
      {
        title: 'Utama',
        items: [
          { key: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high' },
          { key: 'project', label: 'Project', icon: 'fa-diagram-project' },
          { key: 'mapping', label: 'Mapping', icon: 'fa-map' },
        ],
      },
      {
        title: 'Peta & Analisa',
        items: [
          { key: 'coverage', label: 'Coverage', icon: 'fa-satellite-dish' },
          { key: 'heatmap', label: 'Heatmap', icon: 'fa-fire' },
          { key: 'summary', label: 'Summary', icon: 'fa-chart-area' },
          { key: 'validation', label: 'Data Validation', icon: 'fa-list-check' },
        ],
      },
      {
        title: 'Manajemen Aset (CRUD)',
        items: [
          { key: 'areas', label: 'Area', icon: 'fa-draw-polygon' },
          { key: 'pops', label: 'POP', icon: 'fa-tower-broadcast' },
          { key: 'odc', label: 'ODC', icon: 'fa-diagram-project' },
          { key: 'odp', label: 'ODP', icon: 'fa-diagram-project' },
          { key: 'homes', label: 'Rumah', icon: 'fa-house' },
          { key: 'poles', label: 'Tiang', icon: 'fa-tower-cell' },
          { key: 'backbones', label: 'Backbone', icon: 'fa-timeline' },
          { key: 'distributions', label: 'Distribution', icon: 'fa-share-nodes' },
          { key: 'kabels', label: 'Kabel', icon: 'fa-ethernet' },
          { key: 'closures', label: 'Closure', icon: 'fa-box' },
          { key: 'handholes', label: 'Handhole', icon: 'fa-square' },
          { key: 'jointboxes', label: 'Joint Box', icon: 'fa-boxes-stacked' },
        ],
      },
      {
        title: 'Perencanaan & Approval',
        items: [
          { key: 'smart-planning', label: 'Smart Planning', icon: 'fa-wand-magic-sparkles' },
          { key: 'boq', label: 'BOQ Calculator', icon: 'fa-calculator' },
          { key: 'approval', label: 'Approval', icon: 'fa-circle-check' },
          { key: 'export', label: 'Export', icon: 'fa-file-export' },
          { key: 'notification', label: 'Notifikasi', icon: 'fa-bell' },
        ],
      },
    ],

    // ---------- Definisi CRUD generik per tabel aset.
    // Field `type`: 'text' | 'number' | 'select' | 'textarea' | 'relation'.
    // Field `geometryType`: 'point' | 'polygon' | 'line' (menentukan form &
    // tombol "Lihat di Peta" pada createAssetModule()). ----------
    ASSET_DEFS: {
      areas: {
        title: 'Area', table: 'areas', geometryType: 'polygon',
        geometryColumn: 'geometry', geometryWriteColumn: 'geometry',
        fields: [
          { key: 'name', label: 'Nama Area', type: 'text', required: true },
          { key: 'category', label: 'Kategori', type: 'text' },
          { key: 'notes', label: 'Catatan', type: 'textarea' },
        ],
      },
      pops: {
        title: 'POP', table: 'pops', geometryType: 'point',
        fields: [
          { key: 'name', label: 'Nama POP', type: 'text', required: true },
          { key: 'address', label: 'Alamat', type: 'text' },
          { key: 'capacity_port', label: 'Kapasitas Port', type: 'number' },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      odc: {
        title: 'ODC', table: 'odc', geometryType: 'point',
        splitter: { ratioKey: 'ODC_TO_ODP', childTable: 'odp', parentKey: 'odc_id', childLabel: 'ODP' },
        fields: [
          { key: 'name', label: 'Nama ODC', type: 'text', required: true },
          { key: 'pop_id', label: 'POP', type: 'relation', relationTable: 'pops', relationLabel: 'name' },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      odp: {
        title: 'ODP', table: 'odp', geometryType: 'point',
        splitter: { ratioKey: 'ODP_TO_HOME', childTable: 'homes', parentKey: 'odp_id', childLabel: 'Rumah' },
        fields: [
          { key: 'name', label: 'Nama ODP', type: 'text', required: true },
          { key: 'odc_id', label: 'ODC', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      homes: {
        title: 'Rumah', table: 'homes', geometryType: 'point',
        fields: [
          { key: 'owner_name', label: 'Nama Pemilik', type: 'text', required: true },
          { key: 'address', label: 'Alamat', type: 'text' },
          { key: 'status', label: 'Status', type: 'select', options: ['Prospek', 'Pelanggan', 'Batal'] },
          { key: 'odp_id', label: 'ODP', type: 'relation', relationTable: 'odp', relationLabel: 'name' },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      poles: {
        title: 'Tiang', table: 'poles', geometryType: 'point',
        fields: [
          { key: 'code', label: 'Kode Tiang', type: 'text', required: true },
          { key: 'height_m', label: 'Tinggi (m)', type: 'number' },
          { key: 'material', label: 'Material', type: 'select', options: ['Besi', 'Beton', 'Kayu'] },
          { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      backbones: {
        title: 'Backbone', table: 'backbones', geometryType: 'line',
        geometryColumn: 'path', geometryWriteColumn: 'path',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'pop_id', label: 'POP', type: 'relation', relationTable: 'pops', relationLabel: 'name' },
          { key: 'odc_id', label: 'ODC', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
          { key: 'length_m', label: 'Panjang (m)', type: 'number' },
          { key: 'core_count', label: 'Jumlah Core', type: 'number' },
        ],
      },
      distributions: {
        title: 'Distribution', table: 'distributions', geometryType: 'line',
        geometryColumn: 'path', geometryWriteColumn: 'path',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'odc_id', label: 'ODC', type: 'relation', relationTable: 'odc', relationLabel: 'name' },
          { key: 'odp_id', label: 'ODP', type: 'relation', relationTable: 'odp', relationLabel: 'name' },
          { key: 'length_m', label: 'Panjang (m)', type: 'number' },
          { key: 'core_count', label: 'Jumlah Core', type: 'number' },
        ],
      },
      kabels: {
        title: 'Kabel', table: 'kabels', geometryType: 'line',
        geometryColumn: 'path', geometryWriteColumn: 'path',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'cable_type', label: 'Tipe Kabel', type: 'select', options: ['Drop Cable', 'Feeder', 'Lainnya'] },
          { key: 'length_m', label: 'Panjang (m)', type: 'number' },
        ],
      },
      closures: {
        title: 'Closure', table: 'closures', geometryType: 'point',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'core_count', label: 'Jumlah Core', type: 'number' },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      handholes: {
        title: 'Handhole', table: 'handholes', geometryType: 'point',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
      jointboxes: {
        title: 'Joint Box', table: 'jointboxes', geometryType: 'point',
        fields: [
          { key: 'name', label: 'Nama', type: 'text', required: true },
          { key: 'condition', label: 'Kondisi', type: 'select', options: ['Baik', 'Rusak Ringan', 'Rusak Berat'] },
          { key: 'lat', label: 'Latitude', type: 'number', required: true },
          { key: 'lng', label: 'Longitude', type: 'number', required: true },
        ],
      },
    },
  };
})();
