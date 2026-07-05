/* =========================================================================
   MAPPING AREA — PLANNING ANALYZERS (SMART PLANNING ENGINE — PHASE 1)
   Implementation 02 / Phase 1 — ANALISA AREA.
   =========================================================================
   TUJUAN
     Mengisi LOGIKA NYATA untuk tahap ANALISA AREA di atas fondasi
     planning-engine.js (Implementation 01.5). Yang diaktifkan Phase ini:
       - Boundary Analyzer
       - Building Analyzer  (via provider yang mudah diganti + mock provider)
       - Road Analyzer
       - Coverage Analyzer
     BELUM diaktifkan (tetap stub): ODP/ODC/Backbone/Distribution/Pole/BOQ/
     Proposal (fase generate berikutnya) dan AI.

   SIFAT
     - Additive murni. File BARU, dimuat lewat <script> setelah
       planning-engine.js. TIDAK mengubah planning-engine.js, app.js DB, dsb.
     - Meng-"upgrade" service stub di window.PlanningEngine.services (boundary/
       building/road/coverage) menjadi implementasi nyata, dan menambah:
         PlanningEngine.providers   → registry provider yang bisa diganti
         PlanningEngine.analysis    → analyzer terpisah (dapat dipakai langsung)
         PlanningEngine.analyze()   → orchestrator pipeline analisa (async)
     - Vanilla JS, tanpa build. Memakai Turf.js (window.turf) yang sudah dimuat
       di index.html. Tidak menambah dependency baru.

   CATATAN GEOMETRI
     Input/-output GeoJSON memakai EPSG:4326 (WGS84). Panjang & luas dihitung
     dengan Turf (haversine). Coverage % pada tahap analisa didefinisikan
     sebagai "homepass ratio" = rumah / total bangunan × 100 (rasio bangunan
     layak layanan) — BUKAN coverage radius ODP (itu tahap generate/Phase 2).
   ========================================================================= */
(function () {
  'use strict';

  var PHASE1_VERSION = '0.2.0-phase1-analysis';

  function turf() {
    if (!window.turf) throw new Error('Turf.js belum termuat — analisa area tidak dapat berjalan.');
    return window.turf;
  }

  /* PRNG deterministik (mulberry32) supaya hasil mock stabil antar-run untuk
     boundary yang sama. */
  function makePrng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFromBbox(bbox) {
    var s = 0;
    bbox.forEach(function (v) { s = (s * 31 + Math.round((v + 200) * 1000)) | 0; });
    return Math.abs(s) || 12345;
  }

  /* =====================================================================
     PROVIDER REGISTRY (mudah diganti — TIDAK hardcode)
     Kontrak provider:
       Building: async getBuildings(boundaryFeature, options) -> FeatureCollection
                 (Point/Polygon dengan properties.building | properties.type)
       Road:     async getRoads(boundaryFeature, options) -> FeatureCollection
                 (LineString dengan properties.highway | properties.type)
     ===================================================================== */
  function providerRegistry(kind, defaultName) {
    var impls = {};
    var currentName = defaultName;
    return {
      kind: kind,
      register: function (name, impl) { impls[name] = impl; return this; },
      use: function (name) {
        if (!impls[name]) { console.warn('[Analyzers] provider "' + name + '" (' + kind + ') tidak ada; memakai "' + currentName + '".'); return this; }
        currentName = name; return this;
      },
      current: function () { return impls[currentName]; },
      currentName: function () { return currentName; },
      has: function (name) { return !!impls[name]; },
      list: function () { return Object.keys(impls); },
    };
  }

  /* --------------------------------------------------------------------
     MOCK BUILDING PROVIDER (default, jalan offline)
     Menyebar titik bangunan pada grid di dalam bbox, disaring ke dalam
     polygon, dengan tipe (home/non-home) yang deterministik.
     -------------------------------------------------------------------- */
  var MockBuildingProvider = {
    id: 'mock',
    title: 'Mock Building Provider',
    async getBuildings(boundary, options) {
      var t = turf();
      options = options || {};
      var bbox = t.bbox(boundary); // [minX,minY,maxX,maxY]
      var areaKm2 = Math.max(t.area(boundary) / 1e6, 0.0001);
      var densityPerKm2 = options.mockDensityPerKm2 || 700;
      var target = Math.min(Math.max(Math.round(areaKm2 * densityPerKm2), 12), options.maxBuildings || 1500);

      var rand = makePrng(seedFromBbox(bbox) + 7);
      var aspect = (bbox[2] - bbox[0]) / Math.max(bbox[3] - bbox[1], 1e-9);
      var cols = Math.max(2, Math.round(Math.sqrt(target * aspect)));
      var rows = Math.max(2, Math.round(target / cols));
      var homeRatio = options.mockHomeRatio || 0.75;
      var features = [];
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          if (features.length >= target) break;
          var jx = (rand() - 0.5) * 0.6;
          var jy = (rand() - 0.5) * 0.6;
          var lng = bbox[0] + ((c + 0.5 + jx) / cols) * (bbox[2] - bbox[0]);
          var lat = bbox[1] + ((r + 0.5 + jy) / rows) * (bbox[3] - bbox[1]);
          var pt = t.point([lng, lat]);
          if (!t.booleanPointInPolygon(pt, boundary)) continue;
          var isHome = rand() < homeRatio;
          pt.properties = { building: isHome ? 'house' : 'commercial', type: isHome ? 'home' : 'non_home', source: 'mock' };
          features.push(pt);
        }
      }
      return t.featureCollection(features);
    },
  };

  /* --------------------------------------------------------------------
     MOCK ROAD PROVIDER (default, jalan offline)
     Membuat grid jalan (beberapa garis vertikal + horizontal) melintasi bbox.
     Pemotongan ke polygon dilakukan di RoadAnalyzer (bukan di provider).
     -------------------------------------------------------------------- */
  var MockRoadProvider = {
    id: 'mock',
    title: 'Mock Road Provider',
    async getRoads(boundary, options) {
      var t = turf();
      options = options || {};
      var bbox = t.bbox(boundary);
      var areaKm2 = Math.max(t.area(boundary) / 1e6, 0.0001);
      var n = Math.min(Math.max(Math.round(Math.sqrt(areaKm2) * 4) + 2, 3), options.maxRoadLines || 14);
      var types = ['residential', 'tertiary', 'secondary', 'service'];
      var rand = makePrng(seedFromBbox(bbox) + 13);
      var feats = [];
      var i, frac, lng, lat;
      for (i = 1; i <= n; i++) { // vertikal
        frac = i / (n + 1);
        lng = bbox[0] + frac * (bbox[2] - bbox[0]);
        feats.push(t.lineString([[lng, bbox[1]], [lng, bbox[3]]], { highway: types[Math.floor(rand() * types.length)], type: 'road', source: 'mock' }));
      }
      for (i = 1; i <= n; i++) { // horizontal
        frac = i / (n + 1);
        lat = bbox[1] + frac * (bbox[3] - bbox[1]);
        feats.push(t.lineString([[bbox[0], lat], [bbox[2], lat]], { highway: types[Math.floor(rand() * types.length)], type: 'road', source: 'mock' }));
      }
      return t.featureCollection(feats);
    },
  };

  /* --------------------------------------------------------------------
     OVERPASS PROVIDERS (opsional, real — BUKAN default)
     Mengambil bangunan/jalan dari OpenStreetMap via Overpass API dalam bbox,
     lalu difilter/dipotong ke polygon oleh analyzer. Dibungkus try/catch;
     bila gagal (offline/limit), analyzer otomatis fallback ke mock.
     -------------------------------------------------------------------- */
  var OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

  async function overpassFetch(query, timeoutMs) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
    try {
      var res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(to); }
  }

  // Konversi elemen Overpass (way) -> koordinat [lng,lat][] memakai peta node.
  function overpassWaysToGeoJSON(json, asPolygon) {
    var t = turf();
    var nodes = {};
    (json.elements || []).forEach(function (e) { if (e.type === 'node') nodes[e.id] = [e.lon, e.lat]; });
    var feats = [];
    (json.elements || []).forEach(function (e) {
      if (e.type !== 'way' || !e.nodes) return;
      var coords = e.nodes.map(function (id) { return nodes[id]; }).filter(Boolean);
      if (coords.length < 2) return;
      var props = e.tags || {};
      if (asPolygon) {
        if (coords.length < 4) return;
        if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) coords.push(coords[0]);
        try { feats.push(t.polygon([coords], props)); } catch (err) {}
      } else {
        try { feats.push(t.lineString(coords, props)); } catch (err) {}
      }
    });
    return t.featureCollection(feats);
  }

  var OverpassBuildingProvider = {
    id: 'overpass',
    title: 'Overpass (OSM) Building Provider',
    async getBuildings(boundary, options) {
      var t = turf();
      var b = t.bbox(boundary); // minX,minY,maxX,maxY -> Overpass: south,west,north,east
      var bboxStr = b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];
      var q = '[out:json][timeout:25];(way["building"](' + bboxStr + '););out body;>;out skel qt;';
      var json = await overpassFetch(q, options && options.timeoutMs);
      return overpassWaysToGeoJSON(json, true);
    },
  };

  var OverpassRoadProvider = {
    id: 'overpass',
    title: 'Overpass (OSM) Road Provider',
    async getRoads(boundary, options) {
      var t = turf();
      var b = t.bbox(boundary);
      var bboxStr = b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];
      var q = '[out:json][timeout:25];(way["highway"](' + bboxStr + '););out body;>;out skel qt;';
      var json = await overpassFetch(q, options && options.timeoutMs);
      return overpassWaysToGeoJSON(json, false);
    },
  };

  var buildingProviders = providerRegistry('building', 'mock')
    .register('mock', MockBuildingProvider)
    .register('overpass', OverpassBuildingProvider);
  var roadProviders = providerRegistry('road', 'mock')
    .register('mock', MockRoadProvider)
    .register('overpass', OverpassRoadProvider);

  /* =====================================================================
     UTIL GEOMETRI
     ===================================================================== */
  // Normalisasi input boundary (FeatureCollection | Feature | Geometry) ->
  // satu Feature Polygon/MultiPolygon. Bila banyak polygon, gabung jadi
  // MultiPolygon (tanpa union, agar ringan & stabil).
  function normalizeBoundary(input) {
    var t = turf();
    if (!input) return null;
    var polys = [];
    function pushGeom(g) {
      if (!g) return;
      if (g.type === 'Polygon') polys.push(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(function (c) { polys.push(c); });
    }
    if (input.type === 'FeatureCollection') input.features.forEach(function (f) { pushGeom(f.geometry); });
    else if (input.type === 'Feature') pushGeom(input.geometry);
    else pushGeom(input); // raw geometry
    if (!polys.length) return null;
    if (polys.length === 1) return t.polygon(polys[0]);
    return t.multiPolygon(polys);
  }

  function detectCoordinateSystem(boundary) {
    var bad = false;
    try {
      var bbox = turf().bbox(boundary);
      if (Math.abs(bbox[0]) > 180 || Math.abs(bbox[2]) > 180 || Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90) bad = true;
    } catch (e) { bad = true; }
    return bad ? 'Non-geografis / terproyeksi (bukan EPSG:4326)' : 'EPSG:4326 (WGS84)';
  }

  function countVertices(boundary) {
    var g = boundary.geometry || boundary;
    var n = 0;
    function ring(rings) { rings.forEach(function (r) { n += r.length; }); }
    if (g.type === 'Polygon') ring(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(ring);
    return n;
  }

  // Potong sebuah LineString ke dalam polygon; kembalikan segmen-segmen yang
  // berada di dalam boundary.
  function clipLineToPolygon(line, boundary) {
    var t = turf();
    try {
      var split = t.lineSplit(line, boundary); // FeatureCollection LineString
      var segs = [];
      var feats = (split && split.features) ? split.features : [line];
      feats.forEach(function (seg) {
        try {
          var len = t.length(seg, { units: 'kilometers' });
          if (len <= 0) return;
          var mid = t.along(seg, len / 2, { units: 'kilometers' });
          if (t.booleanPointInPolygon(mid, boundary)) segs.push(seg);
        } catch (e) {}
      });
      if (!segs.length) {
        try {
          var l2 = t.length(line, { units: 'kilometers' });
          var m2 = t.along(line, l2 / 2, { units: 'kilometers' });
          if (t.booleanPointInPolygon(m2, boundary)) segs.push(line);
        } catch (e) {}
      }
      return segs;
    } catch (e) { return [line]; }
  }

  /* =====================================================================
     1) BOUNDARY ANALYZER
     ===================================================================== */
  function analyzeBoundary(input) {
    var t = turf();
    var boundary = normalizeBoundary(input);
    if (!boundary) throw new Error('Tidak ada polygon boundary yang bisa dianalisa. Import KMZ/KML polygon terlebih dahulu.');
    var areaSqm = t.area(boundary);
    var perimeterM = 0;
    try { perimeterM = t.length(t.polygonToLine(boundary), { units: 'kilometers' }) * 1000; } catch (e) { perimeterM = 0; }
    var bbox = t.bbox(boundary);
    return {
      feature: boundary,
      type: boundary.geometry.type,
      area_sqm: areaSqm,
      perimeter_m: perimeterM,
      bbox: bbox,
      coordinate_system: detectCoordinateSystem(boundary),
      vertices: countVertices(boundary),
    };
  }

  /* =====================================================================
     2) BUILDING ANALYZER
     ===================================================================== */
  function classifyHome(props) {
    props = props || {};
    var v = String(props.type || props.building || '').toLowerCase();
    var homeTypes = ['home', 'yes', 'house', 'residential', 'apartments', 'detached', 'terrace', 'semidetached_house', 'bungalow', 'dormitory'];
    return homeTypes.indexOf(v) !== -1;
  }
  function featureCentroid(f) {
    var t = turf();
    try { return t.centroid(f); } catch (e) {
      if (f.geometry && f.geometry.type === 'Point') return f;
      return null;
    }
  }
  async function analyzeBuildings(boundary, options) {
    var t = turf();
    options = options || {};
    var registry = (window.PlanningEngine && window.PlanningEngine.providers) ? window.PlanningEngine.providers.building : buildingProviders;
    var providerName = registry.currentName();
    var provider = registry.current();
    var fc;
    try {
      fc = await provider.getBuildings(boundary, options);
    } catch (err) {
      // Fallback aman ke mock bila provider real gagal (mis. offline).
      console.warn('[Analyzers] provider bangunan "' + providerName + '" gagal (' + err.message + '), fallback ke mock.');
      providerName = 'mock';
      fc = await MockBuildingProvider.getBuildings(boundary, options);
    }
    var inside = [];
    (fc.features || []).forEach(function (f) {
      var c = featureCentroid(f);
      if (c && t.booleanPointInPolygon(c, boundary)) inside.push(f);
    });
    var homes = 0, nonHomes = 0;
    inside.forEach(function (f) { if (classifyHome(f.properties)) homes++; else nonHomes++; });
    var areaKm2 = Math.max(t.area(boundary) / 1e6, 1e-6);
    return {
      provider: providerName,
      featureCollection: t.featureCollection(inside),
      total: inside.length,
      homes: homes,
      nonHomes: nonHomes,
      density_per_km2: Math.round((inside.length / areaKm2) * 100) / 100,
    };
  }

  /* =====================================================================
     3) ROAD ANALYZER
     ===================================================================== */
  async function analyzeRoads(boundary, options) {
    var t = turf();
    options = options || {};
    var registry = (window.PlanningEngine && window.PlanningEngine.providers) ? window.PlanningEngine.providers.road : roadProviders;
    var providerName = registry.currentName();
    var provider = registry.current();
    var fc;
    try {
      fc = await provider.getRoads(boundary, options);
    } catch (err) {
      console.warn('[Analyzers] provider jalan "' + providerName + '" gagal (' + err.message + '), fallback ke mock.');
      providerName = 'mock';
      fc = await MockRoadProvider.getRoads(boundary, options);
    }
    var clipped = [];
    var roadCount = 0;
    (fc.features || []).forEach(function (line) {
      if (!line.geometry || line.geometry.type !== 'LineString') return;
      var segs = clipLineToPolygon(line, boundary);
      if (segs.length) {
        roadCount++;
        segs.forEach(function (s) { s.properties = Object.assign({}, line.properties, s.properties); clipped.push(s); });
      }
    });

    var totalLengthM = 0;
    clipped.forEach(function (s) { try { totalLengthM += t.length(s, { units: 'kilometers' }) * 1000; } catch (e) {} });

    var typeSet = {};
    clipped.forEach(function (s) { var ty = (s.properties && (s.properties.highway || s.properties.type)) || 'unknown'; typeSet[ty] = (typeSet[ty] || 0) + 1; });

    // Intersections: hitung titik potong antar-segmen (dibatasi untuk performa).
    var cap = Math.min(clipped.length, 220);
    var interKeys = {};
    for (var i = 0; i < cap; i++) {
      for (var j = i + 1; j < cap; j++) {
        try {
          var ix = t.lineIntersect(clipped[i], clipped[j]);
          (ix.features || []).forEach(function (p) {
            var co = p.geometry.coordinates;
            interKeys[co[0].toFixed(6) + ',' + co[1].toFixed(6)] = true;
          });
        } catch (e) {}
      }
    }

    return {
      provider: providerName,
      featureCollection: t.featureCollection(clipped),
      road_count: roadCount,
      total_segments: clipped.length,
      total_length_m: Math.round(totalLengthM),
      road_types: typeSet,
      intersection_count: Object.keys(interKeys).length,
    };
  }

  /* =====================================================================
     4) COVERAGE ANALYZER
     ===================================================================== */
  function analyzeCoverage(boundaryResult, buildingResult, roadResult) {
    var areaSqm = boundaryResult.area_sqm;
    var areaKm2 = Math.max(areaSqm / 1e6, 1e-6);
    var buildingCount = buildingResult.total;
    var homeCount = buildingResult.homes;
    var nonHomeCount = buildingResult.nonHomes;
    var density = Math.round((buildingCount / areaKm2) * 100) / 100;
    // Coverage % (tahap analisa) = homepass ratio = rumah / total bangunan.
    var coveragePercent = buildingCount > 0 ? Math.round((homeCount / buildingCount) * 10000) / 100 : 0;
    return {
      building_count: buildingCount,
      home_count: homeCount,
      non_home_count: nonHomeCount,
      area_sqm: Math.round(areaSqm),
      road_length_m: roadResult.total_length_m,
      density_per_km2: density,
      coverage_percent: coveragePercent,
      coverage_definition: 'homepass ratio (rumah / total bangunan)',
    };
  }

  /* =====================================================================
     ORCHESTRATOR PIPELINE ANALISA
     ===================================================================== */
  async function analyze(boundaryInput, options) {
    options = options || {};
    var boundary = analyzeBoundary(boundaryInput);
    var buildings = await analyzeBuildings(boundary.feature, options);
    var roads = await analyzeRoads(boundary.feature, options);
    var coverage = analyzeCoverage(boundary, buildings, roads);
    return {
      ok: true,
      status: 'ok',
      engineVersion: PHASE1_VERSION,
      analyzedAt: new Date().toISOString(),
      providers: { building: buildings.provider, road: roads.provider },
      boundary: boundary,
      buildings: buildings,
      roads: roads,
      coverage: coverage,
    };
  }

  /* =====================================================================
     PASANG KE window.PlanningEngine (upgrade stub -> nyata)
     ===================================================================== */
  var PE = window.PlanningEngine;
  if (!PE) {
    // Defensif: bila planning-engine.js belum termuat, sediakan namespace minimal.
    PE = window.PlanningEngine = { version: PHASE1_VERSION, services: {}, list: [], run: function () { return { status: 'stub' }; }, describe: function () { return { services: [] }; } };
  }

  PE.providers = { building: buildingProviders, road: roadProviders };
  PE.analysis = {
    version: PHASE1_VERSION,
    analyzeBoundary: analyzeBoundary,
    analyzeBuildings: analyzeBuildings,
    analyzeRoads: analyzeRoads,
    analyzeCoverage: analyzeCoverage,
    normalizeBoundary: normalizeBoundary,
  };
  PE.analyze = analyze;

  // Upgrade 4 service stub agar konsisten memanggil implementasi nyata.
  if (PE.services) {
    if (PE.services.boundary) {
      PE.services.boundary.resolveBoundary = function (input) {
        try { return { ok: true, status: 'ok', service: 'BoundaryService', method: 'resolveBoundary', data: analyzeBoundary(input.geojson || input.boundary || input) }; }
        catch (e) { return { ok: false, status: 'error', service: 'BoundaryService', method: 'resolveBoundary', message: e.message }; }
      };
    }
    if (PE.services.building) PE.services.building.detectBuildings = function (ctx) { return analyzeBuildings((ctx && (ctx.boundary || ctx.feature)) || ctx, ctx && ctx.options); };
    if (PE.services.road) PE.services.road.extractRoads = function (ctx) { return analyzeRoads((ctx && (ctx.boundary || ctx.feature)) || ctx, ctx && ctx.options); };
    if (PE.services.coverage) PE.services.coverage.computeCoverage = function (ctx) { return analyzeCoverage(ctx.boundary, ctx.buildings, ctx.roads); };
    // Tandai status Phase 1 aktif untuk 4 service ini (dipakai UI).
    ['boundary', 'building', 'road', 'coverage'].forEach(function (k) { if (PE.services[k]) PE.services[k].phase1 = 'active'; });
  }

  PE.version = PHASE1_VERSION;
})();
