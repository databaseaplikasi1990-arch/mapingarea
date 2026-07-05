/* =========================================================================
   MAPPING AREA — PLANNING ENGINE (FONDASI SMART FTTH PLANNING)
   Implementation 01.5 — PONDASI SAJA (STUB / PLACEHOLDER).
   =========================================================================
   TUJUAN FILE INI
     Menyediakan kerangka (skeleton) "Planning Engine" untuk Smart FTTH
     Planning tanpa mengubah aplikasi yang sudah berjalan. File ini HANYA
     mendefinisikan interface dan stub setiap service. BELUM ADA LOGIKA,
     BELUM ADA AI, BELUM ADA AUTO-GENERATE. Semua itu dikerjakan pada
     IMPLEMENTATION 02.

   SIFAT
     - Additive murni. Tidak menyentuh app.js, config.js, atau modul lain.
     - Mengekspos satu namespace global: window.PlanningEngine.
     - Setiap service adalah objek dengan method ber-signature jelas yang
       untuk sekarang mengembalikan hasil STUB (tidak melempar error), agar
       aman bila dipanggil lebih awal oleh kode di masa depan.
     - Tidak ada dependency build (vanilla JS), aman dimuat lewat <script>
       biasa sebelum app.js.

   ATURAN FTTH YANG AKAN DIPATUHI SAAT LOGIKA DIISI (IMPLEMENTATION 02)
     - ODP  : splitter 1:8   (CFG.SPLITTER)
     - ODC  : splitter 1:4
     - Backbone   : mengikuti jalur jalan (Road Service)
     - Distribution : mengikuti posisi ODP
     - Tiang (Pole) : mengikuti jalur kabel
     - Coverage : dihitung otomatis
     - BOQ    : TANPA HARGA

   ALUR PIPELINE (urutan yang direncanakan, lihat run() di bawah):
     Boundary -> Building -> Road -> Coverage
              -> ODP -> ODC -> Backbone -> Distribution -> Pole
              -> BOQ -> Proposal -> (Planner Review -> Approval, di UI)
   ========================================================================= */
(function () {
  'use strict';

  var ENGINE_VERSION = '0.1.0-foundation';

  /* Status baku yang dikembalikan semua stub. Dibuat konsisten supaya UI /
     kode pemanggil bisa mengecek `result.status === 'stub'` dengan mudah. */
  var STATUS = {
    STUB: 'stub',            // belum diimplementasi (kondisi saat ini)
    OK: 'ok',                // sukses (nanti)
    ERROR: 'error',          // gagal (nanti)
    SKIPPED: 'skipped',      // dilewati karena prasyarat belum ada (nanti)
  };

  /* Helper pembentuk hasil stub yang seragam. Sengaja TIDAK melempar error
     agar pemanggilan dini tidak merusak aplikasi. */
  function stubResult(service, method, extra) {
    var base = {
      ok: false,
      status: STATUS.STUB,
      service: service,
      method: method,
      message: '[PlanningEngine] "' + service + '.' + method + '" belum diimplementasi (fondasi Implementation 01.5). ' +
               'Logika sebenarnya akan ditambahkan pada Implementation 02.',
      data: null,
      engineVersion: ENGINE_VERSION,
    };
    if (extra) { Object.keys(extra).forEach(function (k) { base[k] = extra[k]; }); }
    return base;
  }

  /* ---------------------------------------------------------------------
     1) BOUNDARY SERVICE
     Membaca/normalisasi batas area (polygon) dari hasil Import KMZ/KML/
     GeoJSON milik modul Mapping yang sudah ada, menjadi boundary standar
     yang dipakai service lain.
     --------------------------------------------------------------------- */
  var BoundaryService = {
    id: 'boundary',
    title: 'Boundary Service',
    description: 'Normalisasi batas area (polygon) sumber perencanaan dari hasil import KMZ/KML/GeoJSON.',
    /**
     * @param {Object} input  { projectId, geojson|kmz|areaId }
     * @returns {Object} stubResult -> (nanti) { boundary: GeoJSON Polygon/MultiPolygon, areaSqm }
     */
    resolveBoundary: function (input) { return stubResult('BoundaryService', 'resolveBoundary'); },
    /** Validasi geometri boundary (self-intersect, arah ring, dsb). */
    validate: function (boundary) { return stubResult('BoundaryService', 'validate'); },
  };

  /* ---------------------------------------------------------------------
     2) BUILDING SERVICE
     Deteksi/registrasi bangunan di dalam boundary. Pada Implementation 02
     dapat memakai sumber data bangunan (mis. OSM building footprints) —
     BUKAN bagian dari fondasi ini.
     --------------------------------------------------------------------- */
  var BuildingService = {
    id: 'building',
    title: 'Building Service',
    description: 'Deteksi bangunan dalam boundary sebagai dasar perhitungan rumah/homepass.',
    /** @returns stubResult -> (nanti) { buildings: Feature[], count } */
    detectBuildings: function (context) { return stubResult('BuildingService', 'detectBuildings'); },
    /** Estimasi jumlah rumah/homepass dari bangunan terdeteksi. */
    estimateHomes: function (buildings) { return stubResult('BuildingService', 'estimateHomes'); },
  };

  /* ---------------------------------------------------------------------
     3) ROAD SERVICE
     Ekstraksi jaringan jalan di dalam boundary; dipakai Backbone Planner
     (backbone mengikuti jalur jalan) dan Pole Planner.
     --------------------------------------------------------------------- */
  var RoadService = {
    id: 'road',
    title: 'Road Service',
    description: 'Ekstraksi jaringan jalan sebagai jalur acuan backbone dan penempatan tiang.',
    /** @returns stubResult -> (nanti) { roads: LineString[] , graph } */
    extractRoads: function (context) { return stubResult('RoadService', 'extractRoads'); },
    /** Bangun graph jalan untuk pencarian rute (nanti). */
    buildGraph: function (roads) { return stubResult('RoadService', 'buildGraph'); },
  };

  /* ---------------------------------------------------------------------
     4) COVERAGE SERVICE
     Perhitungan cakupan layanan (radius layanan ODP vs rumah). Selaras
     dengan modul 'coverage' yang sudah ada (CFG.COVERAGE.ODP_SERVICE_RADIUS_M).
     --------------------------------------------------------------------- */
  var CoverageService = {
    id: 'coverage',
    title: 'Coverage Service',
    description: 'Perhitungan cakupan otomatis (radius layanan ODP terhadap rumah).',
    /** @returns stubResult -> (nanti) { coveredCount, uncoveredCount, cells } */
    computeCoverage: function (context) { return stubResult('CoverageService', 'computeCoverage'); },
  };

  /* ---------------------------------------------------------------------
     5) ODP PLANNER  (splitter 1:8)
     Menentukan lokasi ODP berdasarkan sebaran rumah & aturan 1:8.
     --------------------------------------------------------------------- */
  var OdpPlanner = {
    id: 'odp',
    title: 'ODP Planner',
    description: 'Penempatan ODP mengikuti sebaran rumah dengan aturan splitter 1:8.',
    splitterRule: '1:8',
    /** @returns stubResult -> (nanti) { odp: Point[] } menuju staging planning_outputs */
    plan: function (context) { return stubResult('OdpPlanner', 'plan'); },
  };

  /* ---------------------------------------------------------------------
     6) ODC PLANNER  (splitter 1:4)
     Menentukan lokasi ODC yang melayani kumpulan ODP dengan aturan 1:4.
     --------------------------------------------------------------------- */
  var OdcPlanner = {
    id: 'odc',
    title: 'ODC Planner',
    description: 'Penempatan ODC yang melayani ODP dengan aturan splitter 1:4.',
    splitterRule: '1:4',
    plan: function (context) { return stubResult('OdcPlanner', 'plan'); },
  };

  /* ---------------------------------------------------------------------
     7) BACKBONE PLANNER  (mengikuti jalur jalan)
     Membuat jalur backbone POP -> ODC mengikuti Road Service.
     --------------------------------------------------------------------- */
  var BackbonePlanner = {
    id: 'backbone',
    title: 'Backbone Planner',
    description: 'Perutean backbone (POP → ODC) mengikuti jalur jalan.',
    plan: function (context) { return stubResult('BackbonePlanner', 'plan'); },
  };

  /* ---------------------------------------------------------------------
     8) DISTRIBUTION PLANNER  (mengikuti posisi ODP)
     Membuat jalur distribusi ODC -> ODP.
     --------------------------------------------------------------------- */
  var DistributionPlanner = {
    id: 'distribution',
    title: 'Distribution Planner',
    description: 'Perutean distribusi (ODC → ODP) mengikuti posisi ODP.',
    plan: function (context) { return stubResult('DistributionPlanner', 'plan'); },
  };

  /* ---------------------------------------------------------------------
     9) POLE PLANNER  (mengikuti jalur kabel)
     Menempatkan tiang di sepanjang jalur kabel/jalan pada interval tertentu.
     --------------------------------------------------------------------- */
  var PolePlanner = {
    id: 'pole',
    title: 'Pole Planner',
    description: 'Penempatan tiang mengikuti jalur kabel pada interval standar.',
    plan: function (context) { return stubResult('PolePlanner', 'plan'); },
  };

  /* ---------------------------------------------------------------------
     10) BOQ PLANNER  (TANPA HARGA)
     Menyusun Bill of Quantity dari seluruh hasil generate. Tanpa harga,
     sesuai aturan MASTER PROMPT.
     --------------------------------------------------------------------- */
  var BoqPlanner = {
    id: 'boq',
    title: 'BOQ Planner',
    description: 'Menyusun Bill of Quantity (BOQ) dari hasil generate — TANPA harga.',
    withPrice: false,
    compile: function (context) { return stubResult('BoqPlanner', 'compile'); },
  };

  /* ---------------------------------------------------------------------
     11) PROPOSAL PLANNER
     Menyusun proposal/ringkasan perencanaan untuk direview planner.
     --------------------------------------------------------------------- */
  var ProposalPlanner = {
    id: 'proposal',
    title: 'Proposal Planner',
    description: 'Menyusun proposal ringkas hasil perencanaan untuk review planner.',
    compile: function (context) { return stubResult('ProposalPlanner', 'compile'); },
  };

  /* Daftar service terurut sesuai pipeline. Dipakai UI Smart Planning untuk
     menampilkan status masing-masing service. */
  var SERVICES = [
    BoundaryService, BuildingService, RoadService, CoverageService,
    OdpPlanner, OdcPlanner, BackbonePlanner, DistributionPlanner,
    PolePlanner, BoqPlanner, ProposalPlanner,
  ];

  /* ---------------------------------------------------------------------
     ORCHESTRATOR (STUB)
     Mendefinisikan URUTAN pipeline saja. Belum menjalankan apa pun — setiap
     langkah hanya mengembalikan stubResult. Ada untuk mengunci kontrak alur
     sehingga Implementation 02 tinggal mengisi logika tiap service tanpa
     mengubah urutan/kontrak.
     --------------------------------------------------------------------- */
  function run(context) {
    context = context || {};
    var pipeline = [
      ['boundary', function () { return BoundaryService.resolveBoundary(context); }],
      ['building', function () { return BuildingService.detectBuildings(context); }],
      ['road', function () { return RoadService.extractRoads(context); }],
      ['coverage', function () { return CoverageService.computeCoverage(context); }],
      ['odp', function () { return OdpPlanner.plan(context); }],
      ['odc', function () { return OdcPlanner.plan(context); }],
      ['backbone', function () { return BackbonePlanner.plan(context); }],
      ['distribution', function () { return DistributionPlanner.plan(context); }],
      ['pole', function () { return PolePlanner.plan(context); }],
      ['boq', function () { return BoqPlanner.compile(context); }],
      ['proposal', function () { return ProposalPlanner.compile(context); }],
    ];
    var steps = pipeline.map(function (p) { return { step: p[0], result: p[1]() }; });
    return {
      ok: false,
      status: STATUS.STUB,
      engineVersion: ENGINE_VERSION,
      message: '[PlanningEngine] run() masih fondasi (semua langkah stub). ' +
               'Belum ada data yang dihasilkan. Implementation 02 akan mengisi logika.',
      steps: steps,
    };
  }

  /* Ringkasan meta untuk ditampilkan di UI (read-only). */
  function describe() {
    return {
      version: ENGINE_VERSION,
      status: STATUS.STUB,
      services: SERVICES.map(function (s) {
        return { id: s.id, title: s.title, description: s.description, status: STATUS.STUB };
      }),
    };
  }

  /* ---------------------------------------------------------------------
     EKSPOR NAMESPACE GLOBAL
     --------------------------------------------------------------------- */
  window.PlanningEngine = {
    version: ENGINE_VERSION,
    STATUS: STATUS,
    services: {
      boundary: BoundaryService,
      building: BuildingService,
      road: RoadService,
      coverage: CoverageService,
      odp: OdpPlanner,
      odc: OdcPlanner,
      backbone: BackbonePlanner,
      distribution: DistributionPlanner,
      pole: PolePlanner,
      boq: BoqPlanner,
      proposal: ProposalPlanner,
    },
    list: SERVICES,
    run: run,
    describe: describe,
  };
})();
