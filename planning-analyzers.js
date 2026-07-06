/* =========================================================================
   MAPPING AREA — PLANNING ANALYZERS (SMART PLANNING ENGINE — PHASE 1)
   Implementation 02 / Phase 1 — ANALISA AREA.
   REWRITE v0.3.0 — akurasi bangunan/rumah.
   =========================================================================
   TUJUAN
     Mengisi LOGIKA NYATA untuk tahap ANALISA AREA di atas fondasi
     planning-engine.js (Implementation 01.5). Yang diaktifkan Phase ini:
       - Boundary Analyzer
       - Building Analyzer  (provider bisa diganti + mock provider fallback)
       - Road Analyzer
       - Coverage Analyzer
     BELUM diaktifkan (tetap stub): ODP/ODC/Backbone/Distribution/Pole/BOQ/
     Proposal (fase generate berikutnya) dan AI.

   PERUBAHAN UTAMA DI REWRITE INI (v0.3.0) — lihat juga CHANGELOG
     1. PROVIDER DEFAULT diganti dari 'mock' (angka acak) -> 'overpass'
        (data bangunan & jalan ASLI dari OpenStreetMap). Mock tetap ada
        HANYA sebagai fallback otomatis bila Overpass gagal total
        (offline / semua mirror down / timeout).
     2. Overpass fetch sekarang mencoba BEBERAPA mirror server bergantian
        (bukan 1 URL saja) dan pakai `out geom;` supaya lebih tahan
        banting & tidak perlu proses ulang node index secara manual.
     3. Query building juga menyertakan relation multipolygon (bukan cuma
        way), supaya kompleks bangunan besar yang dipetakan sebagai
        relasi di OSM tetap terhitung.
     4. Klasifikasi rumah/non-rumah diperluas & diselaraskan dengan
        planning-generators.js (classifyByTag), TERMASUK estimasi jumlah
        unit hunian untuk bangunan bertingkat/apartemen (building:flats /
        building:levels) — supaya 1 gedung apartemen tidak dihitung
        sebagai "1 rumah" saja.
     5. Menambahkan `data_confidence` pada hasil analisa bangunan: bila
        kepadatan bangunan hasil OSM jauh di bawah kepadatan wajar utk
        area terbangun, hasil analisa ditandai "rendah" + catatan supaya
        planner tahu perlu verifikasi/lengkapi data lapangan — BUKAN
        mengarang angka supaya "kelihatan" mendekati kondisi lapangan.

     CATATAN JUJUR SOAL AKURASI: tanpa deteksi bangunan berbasis citra
     satelit (computer vision) yang memang belum ada di codebase ini,
     akurasi analisa akan selalu bergantung pada KELENGKAPAN data
     OpenStreetMap di area tersebut. Rewrite ini memaksimalkan apa yang
     bisa digali dari OSM + memberi sinyal kepercayaan yang jujur,
     bukan menjamin angka otomatis sama dengan hasil survei lapangan.

   SIFAT
     - Additive murni terhadap file lain. File ini sendiri DITULIS ULANG
       total (bukan tempel-tempel patch) atas permintaan pemilik produk,
       supaya tidak ada patch yang menumpuk. Dimuat lewat <script> setelah
       planning-engine.js. TIDAK mengubah planning-engine.js / app.js /
       skema DB.
     - Vanilla JS, tanpa build. Memakai Turf.js (window.turf) yang sudah
       dimuat di index.html. Tidak menambah dependency baru.

   CATATAN GEOMETRI
     Input/-output GeoJSON memakai EPSG:4326 (WGS84). Panjang & luas
     dihitung dengan Turf (haversine). Coverage % pada tahap analisa
     didefinisikan sebagai "homepass ratio" = rumah / total bangunan × 100
     — BUKAN coverage radius ODP (itu tahap generate/Phase 2).
   ========================================================================= */
(function () {
  'use strict';

  var PHASE1_VERSION = '0.3.0-phase1-analysis-accuracy';

  function turf() {
    if (!window.turf) throw new Error('Turf.js belum termuat — analisa area tidak dapat berjalan.');
    return window.turf;
  }

  /* PRNG deterministik (mulberry32) — dipakai HANYA oleh mock provider
     (fallback offline), supaya hasilnya stabil antar-run untuk boundary
     yang sama. Tidak dipakai sama sekali oleh jalur data asli (overpass). */
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
                 (Polygon/Point dengan properties.building | properties.type)
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
     MOCK BUILDING / ROAD PROVIDER — FALLBACK OFFLINE SAJA.
     Sejak v0.3.0 provider ini BUKAN default lagi. Hanya dipakai otomatis
     bila provider 'overpass' gagal total (offline / semua mirror down).
     -------------------------------------------------------------------- */
  var MockBuildingProvider = {
    id: 'mock',
    title: 'Mock Building Provider (fallback offline)',
    async getBuildings(boundary, options) {
      var t = turf();
      options = options || {};
      var bbox = t.bbox(boundary);
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

  var MockRoadProvider = {
    id: 'mock',
    title: 'Mock Road Provider (fallback offline)',
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
      for (i = 1; i <= n; i++) {
        frac = i / (n + 1);
        lng = bbox[0] + frac * (bbox[2] - bbox[0]);
        feats.push(t.lineString([[lng, bbox[1]], [lng, bbox[3]]], { highway: types[Math.floor(rand() * types.length)], type: 'road', source: 'mock' }));
      }
      for (i = 1; i <= n; i++) {
        frac = i / (n + 1);
        lat = bbox[1] + frac * (bbox[3] - bbox[1]);
        feats.push(t.lineString([[bbox[0], lat], [bbox[2], lat]], { highway: types[Math.floor(rand() * types.length)], type: 'road', source: 'mock' }));
      }
      return t.featureCollection(feats);
    },
  };

  /* --------------------------------------------------------------------
     OVERPASS PROVIDERS (default sejak v0.3.0) — data ASLI dari
     OpenStreetMap. Mencoba beberapa mirror server bergantian supaya
     tahan banting terhadap rate-limit/downtime satu server, dan memakai
     `out geom;` supaya setiap way/relation membawa koordinatnya sendiri
     (tidak perlu index node manual -> lebih ringkas & lebih andal untuk
     relation/multipolygon).
     -------------------------------------------------------------------- */
  var OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];

  async function overpassFetchOnce(url, query, timeoutMs) {
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 35000);
    try {
      var res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctrl.signal });
      if (!res.ok) throw new Error('Overpass HTTP ' + res.status + ' (' + url + ')');
      return await res.json();
    } finally { clearTimeout(to); }
  }

  // Coba tiap mirror satu-persatu; lempar error terakhir bila semua gagal.
  async function overpassFetch(query, timeoutMs) {
    var lastErr = null;
    for (var i = 0; i < OVERPASS_MIRRORS.length; i++) {
      try {
        return await overpassFetchOnce(OVERPASS_MIRRORS[i], query, timeoutMs);
      } catch (err) {
        lastErr = err;
        console.warn('[Analyzers] mirror Overpass gagal (' + OVERPASS_MIRRORS[i] + '): ' + err.message);
      }
    }
    throw lastErr || new Error('Semua mirror Overpass gagal dihubungi.');
  }

  function ringFromGeomArray(geomArr) {
    if (!geomArr || geomArr.length < 3) return null;
    var coords = geomArr.map(function (p) { return [p.lon, p.lat]; });
    var first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return coords.length >= 4 ? coords : null;
  }

  // Parse hasil `out geom;` (way & relation multipolygon) -> FeatureCollection
  // Polygon (bangunan) atau LineString (jalan), sesuai `asPolygon`.
  function overpassGeomToGeoJSON(json, asPolygon) {
    var t = turf();
    var feats = [];
    (json.elements || []).forEach(function (e) {
      var props = e.tags || {};
      if (e.type === 'way' && e.geometry) {
        if (asPolygon) {
          var ring = ringFromGeomArray(e.geometry);
          if (!ring) return;
          try { feats.push(t.polygon([ring], props)); } catch (err) {}
        } else {
          var coords = e.geometry.map(function (p) { return [p.lon, p.lat]; });
          if (coords.length < 2) return;
          try { feats.push(t.lineString(coords, props)); } catch (err) {}
        }
      } else if (e.type === 'relation' && asPolygon && e.members) {
        // Best-effort multipolygon: gabungkan tiap member "outer" yang
        // sudah berbentuk ring tertutup sendiri (kasus paling umum di OSM
        // untuk kompleks bangunan). Member outer yang terpotong jadi
        // beberapa way (butuh penyambungan ring penuh) dilewati saja demi
        // keamanan, ketimbang menghasilkan polygon yang salah bentuk.
        var outerRings = [];
        e.members.forEach(function (m) {
          if (m.role !== 'outer' || !m.geometry) return;
          var r = ringFromGeomArray(m.geometry);
          if (r) outerRings.push(r);
        });
        outerRings.forEach(function (r) {
          try { feats.push(t.polygon([r], props)); } catch (err) {}
        });
      }
    });
    return t.featureCollection(feats);
  }

  var OverpassBuildingProvider = {
    id: 'overpass',
    title: 'Overpass (OpenStreetMap) — Bangunan Asli',
    async getBuildings(boundary, options) {
      var t = turf();
      var b = t.bbox(boundary); // minX,minY,maxX,maxY -> Overpass: south,west,north,east
      var bboxStr = b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];
      var q = '[out:json][timeout:40];(' +
        'way["building"](' + bboxStr + ');' +
        'relation["building"]["type"="multipolygon"](' + bboxStr + ');' +
        ');out geom;';
      var json = await overpassFetch(q, options && options.timeoutMs);
      return overpassGeomToGeoJSON(json, true);
    },
  };

  var OverpassRoadProvider = {
    id: 'overpass',
    title: 'Overpass (OpenStreetMap) — Jalan Asli',
    async getRoads(boundary, options) {
      var t = turf();
      var b = t.bbox(boundary);
      var bboxStr = b[1] + ',' + b[0] + ',' + b[3] + ',' + b[2];
      var q = '[out:json][timeout:40];(way["highway"](' + bboxStr + '););out geom;';
      var json = await overpassFetch(q, options && options.timeoutMs);
      return overpassGeomToGeoJSON(json, false);
    },
  };

  // DEFAULT sejak v0.3.0: 'overpass' (data asli), BUKAN 'mock' lagi.
  // Mock tetap terdaftar sebagai fallback otomatis bila overpass gagal
  // (lihat analyzeBuildings/analyzeRoads).
  var buildingProviders = providerRegistry('building', 'overpass')
    .register('mock', MockBuildingProvider)
    .register('overpass', OverpassBuildingProvider);
  var roadProviders = providerRegistry('road', 'overpass')
    .register('mock', MockRoadProvider)
    .register('overpass', OverpassRoadProvider);

  /* =====================================================================
     UTIL GEOMETRI
     ===================================================================== */
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
    else pushGeom(input);
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

  function clipLineToPolygon(line, boundary) {
    var t = turf();
    try {
      var split = t.lineSplit(line, boundary);
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
  // Tag OSM yang jelas BUKAN rumah tinggal (diselaraskan dengan
  // planning-generators.js classifyByTag, supaya konsisten Fase 1 & 2).
  var NON_HOME_TAGS = [
    'commercial', 'retail', 'shop', 'kiosk', 'supermarket', 'industrial',
    'warehouse', 'office', 'school', 'hospital', 'church', 'mosque',
    'public', 'civic', 'hotel', 'university', 'government', 'garage',
    'garages', 'shed', 'roof', 'hut', 'greenhouse', 'construction',
    'ruins', 'service', 'parking', 'toilets', 'transportation',
  ];
  // Tag yang JELAS rumah tinggal / hunian.
  var HOME_TAGS = [
    'home', 'yes', 'house', 'residential', 'apartments', 'detached',
    'terrace', 'semidetached_house', 'bungalow', 'dormitory',
    'residential_block', 'houseboat', 'static_caravan', 'hut',
  ];
  // 'hut' sengaja tidak dobel — override: kalau ada di kedua daftar,
  // NON_HOME_TAGS diprioritaskan di bawah ini untuk kasus ambigu.

  function classifyHome(props) {
    props = props || {};
    var v = String(props.type || props.building || '').toLowerCase();
    if (NON_HOME_TAGS.indexOf(v) !== -1) return false;
    if (HOME_TAGS.indexOf(v) !== -1) return true;
    // Tag tidak dikenali sama sekali (banyak terjadi utk building=yes
    // tanpa tag lain, atau data OSM yang minim) — asumsikan rumah tinggal
    // HANYA bila tidak ada indikasi komersial/fasilitas dari tag lain
    // (shop/office/amenity), karena mayoritas gedung di area permukiman
    // yang tidak diberi tag khusus memang rumah warga.
    if (!props.shop && !props.office && !props.amenity) return true;
    return false;
  }

  // Estimasi jumlah unit hunian dalam SATU bangunan bertingkat/apartemen,
  // supaya gedung apartemen tidak dihitung "1 rumah" saja. Kembalikan 1
  // untuk rumah tapak biasa (paling umum).
  function estimateDwellingUnits(props) {
    props = props || {};
    var flats = parseInt(props['building:flats'], 10);
    if (flats > 0) return flats;
    var v = String(props.type || props.building || '').toLowerCase();
    if (v === 'apartments' || v === 'residential_block' || v === 'dormitory') {
      var levels = parseInt(props['building:levels'], 10);
      var unitsPerLevel = 4; // asumsi konservatif tanpa data building:flats
      if (levels > 0) return Math.max(1, Math.round(levels * unitsPerLevel));
      return 8; // fallback kasar bila levels juga tidak ada
    }
    return 1;
  }

  function featureCentroid(f) {
    var t = turf();
    try { return t.centroid(f); } catch (e) {
      if (f.geometry && f.geometry.type === 'Point') return f;
      return null;
    }
  }

  // Ambang kepadatan bangunan (per km²) di bawah mana hasil analisa
  // ditandai "confidence rendah" — nilai default dipilih longgar (area
  // permukiman padat Indonesia umumnya jauh di atas ini), bisa dioverride
  // lewat options.minExpectedDensityPerKm2.
  var DEFAULT_MIN_EXPECTED_DENSITY = 400;

  async function analyzeBuildings(boundary, options) {
    var t = turf();
    options = options || {};
    var registry = (window.PlanningEngine && window.PlanningEngine.providers) ? window.PlanningEngine.providers.building : buildingProviders;
    var providerName = registry.currentName();
    var provider = registry.current();
    var fc;
    var usedFallback = false;
    try {
      fc = await provider.getBuildings(boundary, options);
    } catch (err) {
      console.warn('[Analyzers] provider bangunan "' + providerName + '" gagal (' + err.message + '), fallback ke mock.');
      providerName = 'mock';
      usedFallback = true;
      fc = await MockBuildingProvider.getBuildings(boundary, options);
    }
    var inside = [];
    (fc.features || []).forEach(function (f) {
      var c = featureCentroid(f);
      if (c && t.booleanPointInPolygon(c, boundary)) inside.push(f);
    });

    var homes = 0, nonHomes = 0, dwellingUnits = 0;
    inside.forEach(function (f) {
      var isHome = classifyHome(f.properties);
      if (isHome) { homes++; dwellingUnits += estimateDwellingUnits(f.properties); }
      else nonHomes++;
    });

    var areaKm2 = Math.max(t.area(boundary) / 1e6, 1e-6);
    var densityPerKm2 = Math.round((inside.length / areaKm2) * 100) / 100;

    var minExpected = options.minExpectedDensityPerKm2 || DEFAULT_MIN_EXPECTED_DENSITY;
    var confidence = 'baik';
    var confidenceNote = null;
    if (usedFallback) {
      confidence = 'rendah';
      confidenceNote = 'Data sintetis (mock) — semua mirror Overpass gagal dihubungi. Angka HANYA perkiraan kasar, bukan data lapangan asli.';
    } else if (densityPerKm2 < minExpected) {
      confidence = 'rendah';
      confidenceNote = 'Kepadatan bangunan dari OpenStreetMap (' + densityPerKm2 + '/km²) jauh di bawah ambang wajar area terbangun (' + minExpected + '/km²). Kemungkinan data OSM di area ini belum lengkap — disarankan verifikasi manual dari citra satelit atau survei lapangan, jangan jadikan angka ini sebagai acuan tunggal.';
    }

    return {
      provider: providerName,
      featureCollection: t.featureCollection(inside),
      total: inside.length,
      homes: homes,
      nonHomes: nonHomes,
      // Perkiraan unit hunian (memperhitungkan apartemen/bangunan
      // bertingkat) — bisa lebih besar dari `homes` bila ada bangunan
      // multi-unit di area tsb. Dipakai sebagai info tambahan, TIDAK
      // menggantikan `homes` pada field lama supaya kompatibel.
      estimated_dwelling_units: dwellingUnits,
      density_per_km2: densityPerKm2,
      data_confidence: confidence,
      data_confidence_note: confidenceNote,
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
    var coveragePercent = buildingCount > 0 ? Math.round((homeCount / buildingCount) * 10000) / 100 : 0;
    return {
      building_count: buildingCount,
      home_count: homeCount,
      non_home_count: nonHomeCount,
      estimated_dwelling_units: buildingResult.estimated_dwelling_units,
      area_sqm: Math.round(areaSqm),
      road_length_m: roadResult.total_length_m,
      density_per_km2: density,
      coverage_percent: coveragePercent,
      coverage_definition: 'homepass ratio (rumah / total bangunan)',
      data_confidence: buildingResult.data_confidence,
      data_confidence_note: buildingResult.data_confidence_note,
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
    ['boundary', 'building', 'road', 'coverage'].forEach(function (k) { if (PE.services[k]) PE.services[k].phase1 = 'active'; });
  }

  PE.version = PHASE1_VERSION;
})();
