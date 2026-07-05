/* =========================================================================
   MAPPING AREA — PLANNING GENERATORS (SMART PLANNING ENGINE — PHASE 2)
   Implementation 03 / Phase 2 — AUTO NETWORK PLANNING.
   =========================================================================
   TUJUAN
     Mengubah hasil Analisa Area (Phase 1) menjadi DRAFT perencanaan FTTH:
       Deteksi & Klasifikasi Bangunan -> Home Passed -> ODP (1:8) -> ODC (1:4)
       -> Backbone Draft -> Distribution Draft -> Estimasi Tiang -> BOQ Draft.
     TANPA AI / ML / optimasi biaya (itu Implementation 04). Semua heuristik
     deterministik dan transparan. Planner tetap dapat mereview & mengoreksi.

   SIFAT
     - Additive murni. File BARU, dimuat setelah planning-analyzers.js.
     - Meng-upgrade service stub generate (odp/odc/backbone/distribution/boq)
       di window.PlanningEngine dan menambah:
         PlanningEngine.generators.*   (sub-fungsi, dipakai juga oleh Review Mode)
         PlanningEngine.generate(...)  (orchestrator draft, sinkron)
     - Vanilla JS, memakai Turf.js (window.turf). Tanpa dependency baru.

   ATURAN FTTH (MASTER PROMPT)
     ODP 1:8, ODC 1:4, backbone mengikuti jalan, distribution mengikuti ODP,
     tiang mengikuti jalur kabel (parameter jarak dapat diubah), BOQ tanpa harga.
   ========================================================================= */
(function () {
  'use strict';

  var PHASE2_VERSION = '0.3.0-phase2-generate';

  function turf() {
    if (!window.turf) throw new Error('Turf.js belum termuat — generate planning tidak dapat berjalan.');
    return window.turf;
  }

  var DEFAULTS = {
    odpCapacity: 8,        // 1 ODP = maksimum 8 Home Passed
    odcCapacity: 4,        // 1 ODC = maksimum 4 ODP
    poleSpanM: 40,         // jarak antar tiang (40/50/60), dapat diubah
    handholeSpanM: 200,    // jarak antar handhole di backbone
    homesPerApartment: 1,  // unit rumah per apartemen (default 1)
  };

  /* ---- util jarak (haversine, meter) ---- */
  function havM(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
    var la1 = a[1] * toRad, la2 = b[1] * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function lineLenM(coords) { var s = 0; for (var i = 1; i < coords.length; i++) s += havM(coords[i - 1], coords[i]); return s; }
  function centroidOf(coordsList) {
    var cx = 0, cy = 0; coordsList.forEach(function (c) { cx += c[0]; cy += c[1]; });
    return [cx / coordsList.length, cy / coordsList.length];
  }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }

  function makePrng(seed) {
    var a = seed >>> 0;
    return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* =====================================================================
     1) KLASIFIKASI BANGUNAN
     Kategori: Rumah, Ruko, Gedung, Apartemen, Lainnya.
     ===================================================================== */
  var HOME_CATEGORIES = ['Rumah', 'Apartemen'];

  function classifyByTag(tag) {
    tag = String(tag || '').toLowerCase();
    if (['house', 'residential', 'detached', 'terrace', 'bungalow', 'semidetached_house', 'yes'].indexOf(tag) !== -1) return 'Rumah';
    if (['apartments', 'dormitory', 'residential_block'].indexOf(tag) !== -1) return 'Apartemen';
    if (['retail', 'commercial', 'shop', 'kiosk', 'supermarket'].indexOf(tag) !== -1) return 'Ruko';
    if (['industrial', 'warehouse', 'office', 'school', 'hospital', 'church', 'mosque', 'public', 'civic', 'hotel', 'university'].indexOf(tag) !== -1) return 'Gedung';
    return null;
  }
  function classifyByChance(rand) {
    var r = rand();
    if (r < 0.70) return 'Rumah';
    if (r < 0.83) return 'Ruko';
    if (r < 0.91) return 'Gedung';
    if (r < 0.95) return 'Apartemen';
    return 'Lainnya';
  }

  function detectAndClassify(buildingsFC, options) {
    var t = turf();
    options = options || {};
    var feats = (buildingsFC && buildingsFC.features) || [];
    var rand = makePrng((feats.length * 2654435761) >>> 0 || 99991);
    var out = [];
    feats.forEach(function (f, i) {
      var g = f.geometry; if (!g) return;
      var coord, area = null;
      if (g.type === 'Point') { coord = g.coordinates; }
      else { try { coord = t.centroid(f).geometry.coordinates; area = Math.round(t.area(f)); } catch (e) { return; } }
      if (!coord) return;
      var p = f.properties || {};
      var cat;
      if (p.source === 'mock') cat = classifyByChance(rand);      // data sintetis: sebar 5 kategori
      else cat = classifyByTag(p.building || p.type) || classifyByChance(rand); // data nyata: pakai tag OSM
      var isHome = HOME_CATEGORIES.indexOf(cat) !== -1;
      out.push({
        building_id: 'BLD-' + pad(i + 1, 6),
        category: cat,
        lng: coord[0], lat: coord[1],
        area_sqm: area,
        is_home_passed: isHome,
      });
    });
    return out;
  }

  /* =====================================================================
     2) HOME PASSED
     ===================================================================== */
  function computeHomePassed(buildings, areaSqm) {
    var counts = { building_count: buildings.length, Rumah: 0, Ruko: 0, Gedung: 0, Apartemen: 0, Lainnya: 0 };
    buildings.forEach(function (b) { counts[b.category] = (counts[b.category] || 0) + 1; });
    var homePassed = counts.Rumah + counts.Apartemen;
    var nonHome = counts.building_count - homePassed;
    var areaKm2 = Math.max((areaSqm || 0) / 1e6, 1e-6);
    return {
      building_count: counts.building_count,
      home_count: counts.Rumah,
      apartment_count: counts.Apartemen,
      ruko_count: counts.Ruko,
      gedung_count: counts.Gedung,
      other_count: counts.Lainnya,
      non_home_count: nonHome,
      home_passed: homePassed,
      coverage_percent: counts.building_count > 0 ? Math.round((homePassed / counts.building_count) * 10000) / 100 : 0,
      density_per_km2: Math.round((counts.building_count / areaKm2) * 100) / 100,
    };
  }

  /* =====================================================================
     Greedy capacitated clustering (tanpa AI)
     ===================================================================== */
  function greedyCluster(points, cap) {
    var n = points.length, used = new Array(n).fill(false), clusters = [];
    for (var s = 0; s < n; s++) {
      if (used[s]) continue;
      var cand = [];
      for (var k = 0; k < n; k++) { if (!used[k] && k !== s) cand.push([k, havM([points[s].lng, points[s].lat], [points[k].lng, points[k].lat])]); }
      cand.sort(function (a, b) { return a[1] - b[1]; });
      var members = [s]; used[s] = true;
      for (var c = 0; c < cand.length && members.length < cap; c++) { var idx = cand[c][0]; if (!used[idx]) { members.push(idx); used[idx] = true; } }
      var coords = members.map(function (m) { return [points[m].lng, points[m].lat]; });
      var center = centroidOf(coords);
      var radius = 0; coords.forEach(function (co) { radius = Math.max(radius, havM(center, co)); });
      clusters.push({ members: members, center: center, radius: Math.round(radius) });
    }
    return clusters;
  }

  /* =====================================================================
     3) ODP PLANNER (1:8)
     ===================================================================== */
  function planOdp(buildings, options) {
    options = options || {};
    var cap = options.odpCapacity || DEFAULTS.odpCapacity;
    var homes = buildings.filter(function (b) { return b.is_home_passed; });
    var clusters = greedyCluster(homes, cap);
    return clusters.map(function (cl, i) {
      return {
        odp_id: 'ODP-' + pad(i + 1, 3),
        lng: cl.center[0], lat: cl.center[1],
        home_count: cl.members.length,
        home_ids: cl.members.map(function (m) { return homes[m].building_id; }),
        coverage_radius_m: Math.max(cl.radius, options.minOdpRadiusM || 30),
      };
    });
  }

  /* =====================================================================
     4) ODC PLANNER (1:4)
     ===================================================================== */
  function planOdc(odps, options) {
    options = options || {};
    var cap = options.odcCapacity || DEFAULTS.odcCapacity;
    var pts = odps.map(function (o) { return { lng: o.lng, lat: o.lat, odp_id: o.odp_id }; });
    var clusters = greedyCluster(pts, cap);
    return clusters.map(function (cl, i) {
      return {
        odc_id: 'ODC-' + pad(i + 1, 3),
        lng: cl.center[0], lat: cl.center[1],
        odp_count: cl.members.length,
        odp_ids: cl.members.map(function (m) { return pts[m].odp_id; }),
      };
    });
  }

  /* =====================================================================
     5) BACKBONE DRAFT (MST, referensi jalan)
     ===================================================================== */
  function snapToRoads(pt, roadsFC) {
    if (!roadsFC || !roadsFC.features || !roadsFC.features.length) return pt;
    try {
      var t = turf(), best = null, bd = Infinity, tp = t.point(pt);
      roadsFC.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString') return;
        var sn = t.nearestPointOnLine(f, tp);
        var d = sn.properties.dist; // km
        if (d < bd) { bd = d; best = sn.geometry.coordinates; }
      });
      return best || pt;
    } catch (e) { return pt; }
  }
  function mstEdges(coords) {
    var n = coords.length; if (n < 2) return [];
    var used = new Array(n).fill(false); used[0] = true; var inTree = [0], edges = [];
    for (var e = 0; e < n - 1; e++) {
      var best = null;
      inTree.forEach(function (i) {
        for (var j = 0; j < n; j++) {
          if (used[j]) continue;
          var d = havM(coords[i], coords[j]);
          if (!best || d < best.d) best = { i: i, j: j, d: d };
        }
      });
      if (!best) break; used[best.j] = true; inTree.push(best.j); edges.push([best.i, best.j]);
    }
    return edges;
  }
  function planBackbone(odcs, roadsFC, options) {
    var t = turf();
    var coords = odcs.map(function (o) { return snapToRoads([o.lng, o.lat], roadsFC); });
    var feats = [], length = 0;
    if (coords.length >= 2) {
      mstEdges(coords).forEach(function (e) {
        var seg = [coords[e[0]], coords[e[1]]];
        length += lineLenM(seg);
        feats.push(t.lineString(seg, { kind: 'backbone' }));
      });
    }
    return { featureCollection: t.featureCollection(feats), length_m: Math.round(length), segment_count: feats.length };
  }

  /* =====================================================================
     6) DISTRIBUTION DRAFT (ODC -> ODP)
     ===================================================================== */
  function planDistribution(odcs, odps, options) {
    var t = turf();
    var byId = {}; odps.forEach(function (o) { byId[o.odp_id] = o; });
    var feats = [], length = 0;
    odcs.forEach(function (odc) {
      (odc.odp_ids || []).forEach(function (oid) {
        var o = byId[oid]; if (!o) return;
        var seg = [[odc.lng, odc.lat], [o.lng, o.lat]];
        length += lineLenM(seg);
        feats.push(t.lineString(seg, { kind: 'distribution', odc: odc.odc_id, odp: oid }));
      });
    });
    return { featureCollection: t.featureCollection(feats), length_m: Math.round(length), segment_count: feats.length };
  }

  /* =====================================================================
     7) ESTIMASI TIANG
     ===================================================================== */
  function estimatePoles(backboneLenM, distributionLenM, options) {
    options = options || {};
    var span = options.poleSpanM || DEFAULTS.poleSpanM;
    var total = (backboneLenM || 0) + (distributionLenM || 0);
    return { count: span > 0 ? Math.ceil(total / span) : 0, span_m: span, cable_total_m: Math.round(total) };
  }

  /* =====================================================================
     8) BOQ DRAFT (tanpa harga)
     ===================================================================== */
  function generateBoq(ctx, options) {
    options = options || {};
    var handholeSpan = options.handholeSpanM || DEFAULTS.handholeSpanM;
    var odpCount = ctx.odps.length, odcCount = ctx.odcs.length;
    var bbLen = ctx.backbone.length_m, distLen = ctx.distribution.length_m;
    var boq = {
      odp_count: odpCount,
      odc_count: odcCount,
      pole_count: ctx.poles.count,
      pole_span_m: ctx.poles.span_m,
      backbone_length_m: bbLen,
      distribution_length_m: distLen,
      closure_count: odcCount,                                   // splice di tiap ODC
      handhole_count: handholeSpan > 0 ? Math.ceil(bbLen / handholeSpan) : 0,
      jointbox_count: odpCount,                                  // 1 per area ODP
      cable_backbone_m: bbLen,
      cable_distribution_m: distLen,
    };
    boq.items = [
      { item: 'ODP (splitter 1:8)', unit: 'unit', quantity: boq.odp_count },
      { item: 'ODC (splitter 1:4)', unit: 'unit', quantity: boq.odc_count },
      { item: 'Tiang (span ' + boq.pole_span_m + ' m)', unit: 'batang', quantity: boq.pole_count },
      { item: 'Backbone', unit: 'meter', quantity: boq.backbone_length_m },
      { item: 'Distribution', unit: 'meter', quantity: boq.distribution_length_m },
      { item: 'Closure', unit: 'unit', quantity: boq.closure_count },
      { item: 'Handhole', unit: 'unit', quantity: boq.handhole_count },
      { item: 'Joint Box', unit: 'unit', quantity: boq.jointbox_count },
      { item: 'Kabel Backbone', unit: 'meter', quantity: boq.cable_backbone_m },
      { item: 'Kabel Distribusi', unit: 'meter', quantity: boq.cable_distribution_m },
    ];
    return boq;
  }

  /* =====================================================================
     GEOJSON builder untuk peta
     ===================================================================== */
  function buildingsToFC(buildings) {
    var t = turf();
    return t.featureCollection(buildings.map(function (b) {
      return t.point([b.lng, b.lat], { building_id: b.building_id, category: b.category, is_home_passed: b.is_home_passed, area_sqm: b.area_sqm });
    }));
  }
  function homePassedFC(buildings) {
    var t = turf();
    return t.featureCollection(buildings.filter(function (b) { return b.is_home_passed; }).map(function (b) {
      return t.point([b.lng, b.lat], { building_id: b.building_id, category: b.category });
    }));
  }
  function pointsToFC(items, idKey) {
    var t = turf();
    return t.featureCollection(items.map(function (o) { return t.point([o.lng, o.lat], Object.assign({}, o, { id: o[idKey] })); }));
  }

  /* =====================================================================
     ORCHESTRATOR — GENERATE DRAFT
     input: { boundary(Feature), buildings(FC), roads(FC), areaSqm } atau hasil
            PlanningEngine.analyze(). options: parameter planning.
     ===================================================================== */
  function generate(input, options) {
    options = Object.assign({}, DEFAULTS, options || {});
    // Terima hasil analyze() maupun objek mentah.
    var buildingsFC = input.buildings && input.buildings.featureCollection ? input.buildings.featureCollection : (input.buildings || input.buildingsFC);
    var roadsFC = input.roads && input.roads.featureCollection ? input.roads.featureCollection : (input.roads || input.roadsFC);
    var areaSqm = input.boundary && input.boundary.area_sqm != null ? input.boundary.area_sqm : (input.areaSqm || 0);

    var buildings = detectAndClassify(buildingsFC, options);
    var homeStats = computeHomePassed(buildings, areaSqm);
    var odps = planOdp(buildings, options);
    var odcs = planOdc(odps, options);
    var backbone = planBackbone(odcs, roadsFC, options);
    var distribution = planDistribution(odcs, odps, options);
    var poles = estimatePoles(backbone.length_m, distribution.length_m, options);
    var boq = generateBoq({ odps: odps, odcs: odcs, backbone: backbone, distribution: distribution, poles: poles }, options);

    return {
      ok: true, status: 'ok', engineVersion: PHASE2_VERSION,
      generation_id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('gen-' + Date.now()),
      generated_at: new Date().toISOString(),
      params: { odpCapacity: options.odpCapacity, odcCapacity: options.odcCapacity, poleSpanM: options.poleSpanM, handholeSpanM: options.handholeSpanM },
      buildings: buildings,
      buildingsFC: buildingsToFC(buildings),
      homePassedFC: homePassedFC(buildings),
      stats: homeStats,
      odps: odps, odpFC: pointsToFC(odps, 'odp_id'),
      odcs: odcs, odcFC: pointsToFC(odcs, 'odc_id'),
      backbone: backbone,
      distribution: distribution,
      poles: poles,
      boq: boq,
    };
  }

  // Regenerate hanya jalur & BOQ dari ODP/ODC terkini (dipakai Review Mode
  // setelah planner memindah/menambah/menghapus ODP/ODC).
  function regenerateLines(odps, odcs, roadsFC, options) {
    options = Object.assign({}, DEFAULTS, options || {});
    var backbone = planBackbone(odcs, roadsFC, options);
    var distribution = planDistribution(odcs, odps, options);
    var poles = estimatePoles(backbone.length_m, distribution.length_m, options);
    var boq = generateBoq({ odps: odps, odcs: odcs, backbone: backbone, distribution: distribution, poles: poles }, options);
    return { backbone: backbone, distribution: distribution, poles: poles, boq: boq };
  }

  /* =====================================================================
     PASANG KE window.PlanningEngine
     ===================================================================== */
  var PE = window.PlanningEngine;
  if (!PE) PE = window.PlanningEngine = { services: {} };

  PE.generators = {
    version: PHASE2_VERSION,
    DEFAULTS: DEFAULTS,
    detectAndClassify: detectAndClassify,
    computeHomePassed: computeHomePassed,
    planOdp: planOdp,
    planOdc: planOdc,
    planBackbone: planBackbone,
    planDistribution: planDistribution,
    estimatePoles: estimatePoles,
    generateBoq: generateBoq,
    regenerateLines: regenerateLines,
    buildingsToFC: buildingsToFC,
    homePassedFC: homePassedFC,
    pointsToFC: pointsToFC,
  };
  PE.generate = generate;

  if (PE.services) {
    if (PE.services.odp) PE.services.odp.plan = function (ctx) { return planOdp(detectAndClassify((ctx && (ctx.buildings || ctx.buildingsFC)) || { features: [] }, ctx), ctx); };
    if (PE.services.odc) PE.services.odc.plan = function (ctx) { return planOdc((ctx && ctx.odps) || [], ctx); };
    if (PE.services.backbone) PE.services.backbone.plan = function (ctx) { return planBackbone((ctx && ctx.odcs) || [], ctx && ctx.roads, ctx); };
    if (PE.services.distribution) PE.services.distribution.plan = function (ctx) { return planDistribution((ctx && ctx.odcs) || [], (ctx && ctx.odps) || [], ctx); };
    if (PE.services.boq) PE.services.boq.compile = function (ctx) { return generateBoq(ctx, ctx); };
    ['odp', 'odc', 'backbone', 'distribution', 'boq'].forEach(function (k) { if (PE.services[k]) PE.services[k].phase2 = 'active'; });
  }

  PE.version = PHASE2_VERSION;
})();
