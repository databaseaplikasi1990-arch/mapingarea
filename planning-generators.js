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
    odpCapacity: 8,          // 1 ODP = maksimum 8 Home Passed
    odcCapacity: 4,          // 1 ODC = maksimum 4 ODP
    poleSpanM: 40,           // jarak antar tiang (30/35/40/45/50), dapat diubah
    handholeSpanM: 200,      // jarak antar handhole di backbone
    homesPerApartment: 1,    // unit rumah per apartemen (default 1)
    odpCoverageRadiusM: 100, // radius coverage ODP (default 100 m)
    reserveCorePct: 20,      // cadangan core (%)
    cableReservePct: 10,     // cadangan panjang kabel (%)
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
    var dropLen = ctx.drop ? ctx.drop.length_m : 0;
    var dropCount = ctx.drop ? ctx.drop.count : 0;
    var poleCount = ctx.poles ? ctx.poles.count : 0;
    var coreCount = ctx.homePassed != null ? ctx.homePassed : dropCount;               // 1 core per rumah
    var reserveCore = Math.ceil(coreCount * (options.reserveCorePct != null ? options.reserveCorePct : DEFAULTS.reserveCorePct) / 100);
    var cableTotal = bbLen + distLen + dropLen;
    var cableReserve = Math.ceil(cableTotal * (options.cableReservePct != null ? options.cableReservePct : DEFAULTS.cableReservePct) / 100);
    var boq = {
      pole_count: poleCount,
      odp_count: odpCount,
      odc_count: odcCount,
      pole_span_m: ctx.poles ? ctx.poles.span_m : (options.poleSpanM || DEFAULTS.poleSpanM),
      backbone_length_m: bbLen,
      distribution_length_m: distLen,
      drop_length_m: dropLen,
      drop_count: dropCount,
      closure_count: odcCount,                                   // splice di tiap ODC
      handhole_count: handholeSpan > 0 ? Math.ceil(bbLen / handholeSpan) : 0,
      jointbox_count: odpCount,                                  // 1 per area ODP
      connector_count: (odpCount + odcCount) * 2 + dropCount,    // patchcord + drop
      cable_backbone_m: bbLen,
      cable_distribution_m: distLen,
      cable_drop_m: dropLen,
      cable_length_m: cableTotal,
      core_count: coreCount,
      reserve_core: reserveCore,
      cable_reserve_m: cableReserve,
    };
    boq.items = [
      { item: 'Tiang (span ' + boq.pole_span_m + ' m)', unit: 'batang', quantity: boq.pole_count },
      { item: 'ODP (splitter 1:8)', unit: 'unit', quantity: boq.odp_count },
      { item: 'ODC (splitter 1:4)', unit: 'unit', quantity: boq.odc_count },
      { item: 'Backbone', unit: 'meter', quantity: boq.backbone_length_m },
      { item: 'Distribution', unit: 'meter', quantity: boq.distribution_length_m },
      { item: 'Drop Cable', unit: 'meter', quantity: boq.drop_length_m },
      { item: 'Closure', unit: 'unit', quantity: boq.closure_count },
      { item: 'Handhole', unit: 'unit', quantity: boq.handhole_count },
      { item: 'Joint Box', unit: 'unit', quantity: boq.jointbox_count },
      { item: 'Connector', unit: 'unit', quantity: boq.connector_count },
      { item: 'Kabel Backbone', unit: 'meter', quantity: boq.cable_backbone_m },
      { item: 'Kabel Distribusi', unit: 'meter', quantity: boq.cable_distribution_m },
      { item: 'Kabel Drop', unit: 'meter', quantity: boq.cable_drop_m },
      { item: 'Core (total)', unit: 'core', quantity: boq.core_count },
      { item: 'Reserve Core', unit: 'core', quantity: boq.reserve_core },
      { item: 'Cadangan Kabel', unit: 'meter', quantity: boq.cable_reserve_m },
    ];
    return boq;
  }

  /* =====================================================================
     REVISION 02 — AUTO NETWORK ENGINE (routing jalan, pole, drop, koneksi)
     ===================================================================== */
  var R2_VERSION = '0.5.0-rev02-auto-network';
  var MAX_GRAPH_NODES = 2500;   // guard performa Dijkstra
  var MAX_POLES = 6000;

  function roundKey(c) { return (+c[0]).toFixed(5) + ',' + (+c[1]).toFixed(5); }

  // Bangun graph dari jaringan jalan (node = titik, edge = ruas).
  function buildRoadGraph(roadsFC) {
    var nodes = [], index = {}, adj = [];
    function nodeOf(c) { var k = roundKey(c); if (index[k] == null) { index[k] = nodes.length; nodes.push([+c[0], +c[1]]); adj.push([]); } return index[k]; }
    if (roadsFC && roadsFC.features) {
      roadsFC.features.forEach(function (f) {
        var g = f.geometry; if (!g) return;
        var lines = g.type === 'LineString' ? [g.coordinates] : (g.type === 'MultiLineString' ? g.coordinates : []);
        lines.forEach(function (cs) {
          for (var i = 1; i < cs.length; i++) {
            if (nodes.length > MAX_GRAPH_NODES) return;
            var a = nodeOf(cs[i - 1]), b = nodeOf(cs[i]);
            var w = havM(nodes[a], nodes[b]);
            adj[a].push({ to: b, w: w }); adj[b].push({ to: a, w: w });
          }
        });
      });
    }
    return { nodes: nodes, adj: adj };
  }
  function nearestNode(graph, coord) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < graph.nodes.length; i++) { var d = havM(graph.nodes[i], coord); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  // Jalur mengikuti jalan via Dijkstra; fallback garis lurus bila tak terhubung.
  function routeAlong(graph, a, b) {
    if (!graph || !graph.nodes.length || graph.nodes.length > MAX_GRAPH_NODES) return { coords: [a, b], length_m: lineLenM([a, b]), routed: false };
    var s = nearestNode(graph, a), t = nearestNode(graph, b);
    if (s < 0 || t < 0 || s === t) return { coords: [a, b], length_m: lineLenM([a, b]), routed: false };
    var n = graph.nodes.length, dist = new Array(n).fill(Infinity), prev = new Array(n).fill(-1), done = new Array(n).fill(false);
    dist[s] = 0;
    for (var it = 0; it < n; it++) {
      var u = -1, ud = Infinity;
      for (var k = 0; k < n; k++) { if (!done[k] && dist[k] < ud) { ud = dist[k]; u = k; } }
      if (u < 0 || u === t) break; done[u] = true;
      var au = graph.adj[u];
      for (var j = 0; j < au.length; j++) { var e = au[j], nd = dist[u] + e.w; if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; } }
    }
    if (dist[t] === Infinity) return { coords: [a, b], length_m: lineLenM([a, b]), routed: false };
    var path = [], cur = t; while (cur !== -1) { path.push(graph.nodes[cur]); cur = prev[cur]; } path.reverse();
    var coords = [a].concat(path, [b]);
    return { coords: coords, length_m: lineLenM(coords), routed: true };
  }

  // POP otomatis: centroid ODC di-snap ke jalan.
  function autoPlacePop(odcs, roadsFC) {
    if (!odcs || !odcs.length) return null;
    var cx = 0, cy = 0; odcs.forEach(function (o) { cx += o.lng; cy += o.lat; });
    var c = snapToRoads([cx / odcs.length, cy / odcs.length], roadsFC);
    return { pop_id: 'POP-001', lng: c[0], lat: c[1] };
  }

  // Backbone mengikuti jalan: MST(POP+ODC) lalu tiap ruas dirutekan via jalan.
  function planBackboneRouted(pop, odcs, graph, options) {
    var t = turf();
    var pts = []; if (pop) pts.push([pop.lng, pop.lat]); odcs.forEach(function (o) { pts.push([o.lng, o.lat]); });
    var feats = [], length = 0;
    if (pts.length >= 2) {
      mstEdges(pts).forEach(function (e) {
        var r = routeAlong(graph, pts[e[0]], pts[e[1]]);
        length += r.length_m; feats.push(t.lineString(r.coords, { kind: 'backbone' }));
      });
    }
    return { featureCollection: t.featureCollection(feats), length_m: Math.round(length), segment_count: feats.length };
  }
  // Distribution mengikuti jalan: ODC -> tiap ODP dirutekan via jalan.
  function planDistributionRouted(odcs, odps, graph, options) {
    var t = turf();
    var byId = {}; odps.forEach(function (o) { byId[o.odp_id] = o; });
    var feats = [], length = 0;
    odcs.forEach(function (odc) {
      (odc.odp_ids || []).forEach(function (oid) {
        var o = byId[oid]; if (!o) return;
        var r = routeAlong(graph, [odc.lng, odc.lat], [o.lng, o.lat]);
        length += r.length_m; feats.push(t.lineString(r.coords, { kind: 'distribution', odc: odc.odc_id, odp: oid }));
      });
    });
    return { featureCollection: t.featureCollection(feats), length_m: Math.round(length), segment_count: feats.length };
  }

  // Tiang otomatis sepanjang jalur kabel (mengikuti jalan), tiap span meter.
  function planPolesAlong(lineFCList, options) {
    var t = turf();
    var span = (options && options.poleSpanM) || DEFAULTS.poleSpanM;
    var pts = [], pid = 1, cableTotal = 0;
    lineFCList.forEach(function (fc) {
      if (!fc || !fc.features) return;
      fc.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString') return;
        var ls = t.lineString(f.geometry.coordinates);
        var len = t.length(ls, { units: 'kilometers' }) * 1000; cableTotal += len;
        var n = Math.floor(len / span);
        for (var i = 1; i <= n; i++) {
          if (pts.length >= MAX_POLES) break;
          var p = t.along(ls, (i * span) / 1000, { units: 'kilometers' });
          var c = p.geometry.coordinates;
          pts.push({ pole_id: 'PL-' + pad(pid++, 5), lng: c[0], lat: c[1] });
        }
      });
    });
    return { points: pts, count: pts.length, span_m: span, cable_total_m: Math.round(cableTotal), featureCollection: t.featureCollection(pts.map(function (p) { return t.point([p.lng, p.lat], { id: p.pole_id }); })) };
  }

  // Drop cable ODP -> Rumah + record Home Passed detail.
  function planDrop(odps, homeCoordById, options) {
    var t = turf();
    var feats = [], records = [], total = 0;
    odps.forEach(function (odp) {
      (odp.home_ids || []).forEach(function (hid) {
        var c = homeCoordById[hid]; if (!c) return;
        var seg = [[odp.lng, odp.lat], [c[0], c[1]]];
        var d = lineLenM(seg); var drop = Math.round(d * 1.1 + 2);   // slack + tiang-ke-rumah
        total += drop;
        feats.push(t.lineString(seg, { kind: 'drop', odp: odp.odp_id, home: hid }));
        records.push({ building_id: hid, lat: c[1], lng: c[0], odp_id: odp.odp_id, status: 'passed', distance_to_odp_m: Math.round(d), drop_length_m: drop });
      });
    });
    return { featureCollection: t.featureCollection(feats), length_m: Math.round(total), count: feats.length, records: records };
  }

  // Smart Connection: Rumah -> ODP -> ODC -> POP.
  function buildConnections(homeRecords, odcs, pop, odcCoordById, odpCoordById) {
    var t = turf();
    var edges = [], feats = [];
    homeRecords.forEach(function (h) { edges.push({ from_type: 'home', from_id: h.building_id, to_type: 'odp', to_id: h.odp_id }); });
    odcs.forEach(function (odc) {
      (odc.odp_ids || []).forEach(function (oid) {
        edges.push({ from_type: 'odp', from_id: oid, to_type: 'odc', to_id: odc.odc_id });
      });
      if (pop) {
        edges.push({ from_type: 'odc', from_id: odc.odc_id, to_type: 'pop', to_id: pop.pop_id });
        feats.push(t.lineString([[odc.lng, odc.lat], [pop.lng, pop.lat]], { kind: 'connection', from: odc.odc_id, to: pop.pop_id }));
      }
    });
    return { edges: edges, featureCollection: t.featureCollection(feats) };
  }


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

    // Koordinat rumah (home passed) untuk drop cable.
    var homeCoordById = {};
    buildings.forEach(function (b) { if (b.is_home_passed) homeCoordById[b.building_id] = [b.lng, b.lat]; });

    var graph = buildRoadGraph(roadsFC);
    var pop = autoPlacePop(odcs, roadsFC);
    var backbone = planBackboneRouted(pop, odcs, graph, options);       // mengikuti jalan
    var distribution = planDistributionRouted(odcs, odps, graph, options); // mengikuti jalan
    var drop = planDrop(odps, homeCoordById, options);                  // ODP -> Rumah
    var poles = planPolesAlong([backbone.featureCollection, distribution.featureCollection], options); // objek tiang
    var connections = buildConnections(drop.records, odcs, pop);
    var boq = generateBoq({ odps: odps, odcs: odcs, backbone: backbone, distribution: distribution, drop: drop, poles: poles, homePassed: homeStats.home_passed }, options);

    return {
      ok: true, status: 'ok', engineVersion: R2_VERSION,
      generation_id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('gen-' + Date.now()),
      generated_at: new Date().toISOString(),
      params: {
        odpCapacity: options.odpCapacity, odcCapacity: options.odcCapacity, poleSpanM: options.poleSpanM,
        handholeSpanM: options.handholeSpanM, odpCoverageRadiusM: options.odpCoverageRadiusM,
        reserveCorePct: options.reserveCorePct, cableReservePct: options.cableReservePct,
      },
      buildings: buildings,
      buildingsFC: buildingsToFC(buildings),
      homePassedFC: homePassedFC(buildings),
      stats: homeStats,
      pop: pop,
      odps: odps, odpFC: pointsToFC(odps, 'odp_id'),
      odcs: odcs, odcFC: pointsToFC(odcs, 'odc_id'),
      backbone: backbone,
      distribution: distribution,
      drop: drop, dropFC: drop.featureCollection,
      poles: poles, poleFC: poles.featureCollection,
      homePassedDetail: drop.records,
      connections: connections.edges, connectionFC: connections.featureCollection,
      boq: boq,
    };
  }

  // Regenerate jalur/tiang/drop/koneksi & BOQ dari ODP/ODC terkini (Review Mode).
  // ctx opsional: { buildings, homeCoordById, pop } untuk menghitung ulang drop.
  function regenerateLines(odps, odcs, roadsFC, options, ctx) {
    options = Object.assign({}, DEFAULTS, options || {});
    ctx = ctx || {};
    var graph = buildRoadGraph(roadsFC);
    var pop = ctx.pop || autoPlacePop(odcs, roadsFC);
    var backbone = planBackboneRouted(pop, odcs, graph, options);
    var distribution = planDistributionRouted(odcs, odps, graph, options);
    var homeCoordById = ctx.homeCoordById || {};
    if (!Object.keys(homeCoordById).length && ctx.buildings) ctx.buildings.forEach(function (b) { if (b.is_home_passed) homeCoordById[b.building_id] = [b.lng, b.lat]; });
    var drop = planDrop(odps, homeCoordById, options);
    var poles = planPolesAlong([backbone.featureCollection, distribution.featureCollection], options);
    var connections = buildConnections(drop.records, odcs, pop);
    var boq = generateBoq({ odps: odps, odcs: odcs, backbone: backbone, distribution: distribution, drop: drop, poles: poles, homePassed: ctx.homePassed }, options);
    return { pop: pop, backbone: backbone, distribution: distribution, drop: drop, dropFC: drop.featureCollection, poles: poles, poleFC: poles.featureCollection, connections: connections.edges, connectionFC: connections.featureCollection, boq: boq };
  }

  // Bangun record detail per-bangunan untuk tabel detected_buildings (Revision 01).
  // Setiap bangunan: id, lat/lng, centroid, polygon, geojson, area, perimeter,
  // kategori, confidence, status. Titik (mock) memakai estimasi area/perimeter deterministik.
  function buildDetectedRecords(buildingsFC, options) {
    var t = turf();
    options = options || {};
    var feats = (buildingsFC && buildingsFC.features) || [];
    var rand = makePrng((feats.length * 40503) >>> 0 || 7001);
    var out = [];
    feats.forEach(function (f, i) {
      var g = f.geometry; if (!g) return;
      var centroid = null, area = null, perim = null, polygon = null;
      var isPoly = g.type === 'Polygon' || g.type === 'MultiPolygon';
      if (isPoly) {
        try { centroid = t.centroid(f).geometry.coordinates; } catch (e) {}
        try { area = Math.round(t.area(f)); } catch (e) {}
        try {
          var ring = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
          perim = Math.round(t.length(t.lineString(ring), { units: 'kilometers' }) * 1000);
        } catch (e) {}
        polygon = g;
      } else if (g.type === 'Point') {
        centroid = g.coordinates;
      }
      if (!centroid) return;
      var p = f.properties || {};
      var cat = (p.source === 'mock') ? classifyByChance(rand) : (classifyByTag(p.building || p.type) || classifyByChance(rand));
      var conf = (p.source === 'mock') ? (0.60 + rand() * 0.25) : (classifyByTag(p.building || p.type) ? 0.90 : 0.70);
      if (area == null) area = 40 + Math.floor(rand() * 160);          // estimasi utk titik
      if (perim == null) perim = Math.round(4 * Math.sqrt(area));       // asumsi persegi
      out.push({
        building_id: 'BLD-' + pad(i + 1, 6),
        lat: centroid[1], lng: centroid[0],
        centroid_lat: centroid[1], centroid_lng: centroid[0],
        polygon: polygon, geojson: f,
        area_sqm: area, perimeter_m: perim,
        category: cat, confidence: Math.round(conf * 100) / 100, status: 'detected',
      });
    });
    return out;
  }

  /* =====================================================================
     PASANG KE window.PlanningEngine
     ===================================================================== */
  var PE = window.PlanningEngine;
  if (!PE) PE = window.PlanningEngine = { services: {} };

  PE.generators = {
    version: R2_VERSION,
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
    buildDetectedRecords: buildDetectedRecords,
    buildingsToFC: buildingsToFC,
    homePassedFC: homePassedFC,
    pointsToFC: pointsToFC,
    // Revision 02 — Auto Network Engine
    buildRoadGraph: buildRoadGraph,
    routeAlong: routeAlong,
    autoPlacePop: autoPlacePop,
    planBackboneRouted: planBackboneRouted,
    planDistributionRouted: planDistributionRouted,
    planPolesAlong: planPolesAlong,
    planDrop: planDrop,
    buildConnections: buildConnections,
  };
  PE.generate = generate;

  if (PE.services) {
    if (PE.services.odp) PE.services.odp.plan = function (ctx) { return planOdp(detectAndClassify((ctx && (ctx.buildings || ctx.buildingsFC)) || { features: [] }, ctx), ctx); };
    if (PE.services.odc) PE.services.odc.plan = function (ctx) { return planOdc((ctx && ctx.odps) || [], ctx); };
    if (PE.services.backbone) PE.services.backbone.plan = function (ctx) { return planBackbone((ctx && ctx.odcs) || [], ctx && ctx.roads, ctx); };
    if (PE.services.distribution) PE.services.distribution.plan = function (ctx) { return planDistribution((ctx && ctx.odcs) || [], (ctx && ctx.odps) || [], ctx); };
    if (PE.services.boq) PE.services.boq.compile = function (ctx) { return generateBoq(ctx, ctx); };
    ['odp', 'odc', 'backbone', 'distribution', 'boq'].forEach(function (k) { if (PE.services[k]) PE.services[k].phase2 = 'active'; });
    ['pole', 'drop'].forEach(function (k) { if (PE.services[k]) PE.services[k].rev02 = 'active'; });
  }

  PE.version = R2_VERSION;
})();
