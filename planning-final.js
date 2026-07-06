/* =========================================================================
   MAPPING AREA — PLANNING FINAL (SMART PLANNING ENGINE — IMPLEMENTATION 04)
   REVISION 03 — AI PLANNER & APPROVAL ENGINE.
   =========================================================================
   CATATAN PENTING
     File ini SEMPAT HILANG dari upload sebelumnya (index-1.html sudah
     memuat <script src="planning-final.js">, tapi filenya sendiri tidak
     ada) — persis pola yang sama dengan hilangnya 001_init.sql
     sebelumnya. Akibatnya SELURUH fitur yang bergantung pada
     window.PlanningFinal (Planning Validation, Bandingkan Versi, export
     Detected Buildings) gagal total (error "Cannot read properties of
     undefined"). File ini ditulis ulang dari nol, DAN SEKALIGUS menjadi
     tempat implementasi REVISION 03 (AI Planner & Approval Engine) sesuai
     permintaan, karena inilah lapisan "Final Planning" yang memang
     dirancang untuk validation/approval/quality-score/report.

   ATURAN YANG DIPATUHI (REVISION 03)
     - Tidak membuat project baru, tidak mengubah Single HTML Application
       (index-1.html TIDAK disentuh — script tag untuk file ini sudah ada
       sejak awal), tidak menghapus fitur yang sudah ada.
     - ADDITIVE: file baru + penambahan kecil di app.js (lihat
       REVISION_03_REPORT.md untuk daftar lengkap perubahan).

   KEJUJURAN SOAL "AI"
     Tidak ada model machine-learning yang dipanggil di sini (tidak ada
     API key/model eksternal yang tersedia untuk itu). "AI Recommendation"
     di bawah ini adalah RULE-BASED / HEURISTIC ENGINE: setiap rekomendasi
     diturunkan langsung dari hasil Validasi Otomatis dengan aturan
     eksplisit (jarak, kapasitas, konektivitas, dsb.), bukan prediksi
     statistik/ML. Ini didokumentasikan apa adanya supaya planner tidak
     salah menilai tingkat kepercayaan sistem.

   KONTRAK PUBLIK — window.PlanningFinal
     computeValidation(snap, opts?)  -> lihat VALIDATION_RESULT_SHAPE
     versionDiff(snapA, snapB)       -> [{metric, from, to, delta}]
     downloadBlob(filename, mime, content)
     reportsToXLS(reportsObj)        -> ArrayBuffer siap-unduh (.xls)
   ========================================================================= */
(function () {
  'use strict';

  var REVISION_VERSION = '0.6.0-revision05-construction-asbuilt-asset';

  function turf() { return window.turf || null; }

  /* =====================================================================
     UTIL DASAR
     ===================================================================== */
  function havM(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
    var la1 = a[1] * toRad, la2 = b[1] * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingCompass(a, b) {
    // Bearing a->b dalam 8 arah mata angin Bahasa Indonesia (kasar, cukup untuk rekomendasi).
    var toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    var lat1 = a[1] * toRad, lat2 = b[1] * toRad, dLng = (b[0] - a[0]) * toRad;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    var deg = (Math.atan2(y, x) * toDeg + 360) % 360;
    var dirs = ['Utara', 'Timur Laut', 'Timur', 'Tenggara', 'Selatan', 'Barat Daya', 'Barat', 'Barat Laut'];
    return dirs[Math.round(deg / 45) % 8];
  }
  function round1(n) { return Math.round((n || 0) * 10) / 10; }
  function clampScore(n) { return Math.max(0, Math.min(100, Math.round(n))); }
  function gradeOf(total) {
    if (total >= 90) return 'A';
    if (total >= 75) return 'B';
    if (total >= 60) return 'C';
    return 'D';
  }

  /* =====================================================================
     VALIDASI OTOMATIS — 11 pemeriksaan sesuai spesifikasi Revision 03.
     Setiap fungsi check_* mengembalikan array issue:
       { code, severity: 'error'|'warning'|'info', message, recommendation,
         ref_id (opsional, mis. 'ODP-05') }
     Fungsi HANYA membaca data (tidak mengubah snap).
     ===================================================================== */

  // 1) ODP terlalu jauh dari rumah (drop cable > radius coverage ODP).
  function check_odpTooFarFromHome(snap, opts) {
    var out = [];
    var drop = snap.drop && snap.drop.records ? snap.drop.records : null;
    if (!drop) return out; // butuh drop.records; lihat catatan di REVISION_03_REPORT.md
    var maxM = (snap.params && snap.params.odpCoverageRadiusM) || opts.odpCoverageRadiusM || 100;
    var byOdp = {};
    (snap.odps || []).forEach(function (o) { byOdp[o.odp_id] = o; });
    drop.forEach(function (d) {
      if (d.distance_to_odp_m > maxM) {
        var odp = byOdp[d.odp_id];
        var arah = odp ? bearingCompass([odp.lng, odp.lat], [d.lng, d.lat]) : null;
        var saran = odp
          ? ('Pindahkan ' + d.odp_id + ' sekitar ' + Math.round((d.distance_to_odp_m - maxM) / 2) + ' meter ke arah ' + arah + ', atau tambah 1 ODP baru dekat rumah ' + d.building_id + '.')
          : ('Tambah 1 ODP baru di sekitar rumah ' + d.building_id + '.');
        out.push({ code: 'ODP_TOO_FAR', severity: 'warning', ref_id: d.odp_id,
          message: 'Rumah ' + d.building_id + ' berjarak ' + Math.round(d.distance_to_odp_m) + ' m dari ' + d.odp_id + ' (maks ' + maxM + ' m).',
          recommendation: saran });
      }
    });
    return out;
  }

  // 2) ODP melebihi kapasitas (1:8 default).
  function check_odpOverCapacity(snap, opts) {
    var out = [];
    var cap = (snap.params && snap.params.odpCapacity) || opts.odpCapacity || 8;
    (snap.odps || []).forEach(function (o) {
      var n = o.home_count || (o.home_ids ? o.home_ids.length : 0);
      if (n > cap) {
        out.push({ code: 'ODP_OVER_CAPACITY', severity: 'error', ref_id: o.odp_id,
          message: o.odp_id + ' melayani ' + n + ' rumah (kapasitas ' + cap + ').',
          recommendation: 'Tambah 1 ODP baru untuk memindahkan ' + (n - cap) + ' rumah kelebihan dari ' + o.odp_id + '.' });
      }
    });
    return out;
  }

  // 3) ODC melebihi kapasitas (1:4 default).
  function check_odcOverCapacity(snap, opts) {
    var out = [];
    var cap = (snap.params && snap.params.odcCapacity) || opts.odcCapacity || 4;
    (snap.odcs || []).forEach(function (c) {
      var n = (c.odp_ids || []).length;
      if (n > cap) {
        out.push({ code: 'ODC_OVER_CAPACITY', severity: 'error', ref_id: c.odc_id,
          message: c.odc_id + ' melayani ' + n + ' ODP (kapasitas ' + cap + ').',
          recommendation: 'Tambah 1 ODC baru untuk memindahkan ' + (n - cap) + ' ODP kelebihan dari ' + c.odc_id + '.' });
      }
    });
    return out;
  }

  // Bangun graf konektivitas sederhana dari FeatureCollection LineString
  // (endpoint yang berdekatan < tolM dianggap terhubung). Kembalikan jumlah
  // connected-component pada endpoint graph.
  function countComponents(fc, tolM) {
    var feats = (fc && fc.features) || [];
    if (!feats.length) return { components: 0, nodeCount: 0 };
    var nodes = []; // [lng,lat]
    var edges = []; // [i,j]
    function findNode(pt) {
      for (var i = 0; i < nodes.length; i++) { if (havM(nodes[i], pt) < tolM) return i; }
      nodes.push(pt); return nodes.length - 1;
    }
    feats.forEach(function (f) {
      if (!f.geometry || f.geometry.type !== 'LineString') return;
      var c = f.geometry.coordinates;
      if (c.length < 2) return;
      var a = findNode(c[0]), b = findNode(c[c.length - 1]);
      if (a !== b) edges.push([a, b]);
    });
    var parent = nodes.map(function (_, i) { return i; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    edges.forEach(function (e) { union(e[0], e[1]); });
    var roots = {}; nodes.forEach(function (_, i) { roots[find(i)] = true; });
    return { components: Object.keys(roots).length, nodeCount: nodes.length };
  }

  // 4) Backbone terputus.
  function check_backboneDisconnected(snap) {
    var out = [];
    var fc = snap.backbone && snap.backbone.featureCollection;
    if (!fc || !fc.features || !fc.features.length) return out;
    var r = countComponents(fc, 8);
    if (r.components > 1) {
      out.push({ code: 'BACKBONE_DISCONNECTED', severity: 'error',
        message: 'Jalur Backbone terpecah menjadi ' + r.components + ' segmen terpisah (tidak semua ODC/POP terhubung dalam satu jaringan).',
        recommendation: 'Tambah Backbone penghubung antar-segmen yang terputus, atau periksa ulang posisi ODC yang terisolasi.' });
    }
    return out;
  }

  // 5) Distribution terputus (ODP tanpa jalur distribution ke ODC-nya).
  function check_distributionDisconnected(snap) {
    var out = [];
    var fc = snap.distribution && snap.distribution.featureCollection;
    var odps = snap.odps || [];
    if (!odps.length) return out;
    var covered = {};
    ((fc && fc.features) || []).forEach(function (f) {
      var p = f.properties || {}; if (p.odp) covered[p.odp] = true;
    });
    odps.forEach(function (o) {
      if (!covered[o.odp_id]) {
        out.push({ code: 'DISTRIBUTION_DISCONNECTED', severity: 'error', ref_id: o.odp_id,
          message: o.odp_id + ' belum punya jalur Distribution ke ODC manapun.',
          recommendation: 'Tambah Distribution dari ' + o.odp_id + ' ke ODC terdekat.' });
      }
    });
    return out;
  }

  // 6) Drop Cable terlalu panjang.
  function check_dropTooLong(snap, opts) {
    var out = [];
    var drop = snap.drop && snap.drop.records ? snap.drop.records : null;
    if (!drop) return out;
    var maxM = opts.maxDropLengthM || 250;
    drop.forEach(function (d) {
      if (d.drop_length_m > maxM) {
        out.push({ code: 'DROP_TOO_LONG', severity: 'warning', ref_id: d.odp_id,
          message: 'Drop cable ke rumah ' + d.building_id + ' sepanjang ' + d.drop_length_m + ' m (maks disarankan ' + maxM + ' m).',
          recommendation: 'Tambah 1 ODP baru lebih dekat ke rumah ' + d.building_id + ' untuk memperpendek drop cable.' });
      }
    });
    return out;
  }

  // 7 & 8) Tiang terlalu rapat / terlalu jauh.
  function check_poleSpacing(snap, opts) {
    var out = [];
    var poles = snap.poles && snap.poles.points ? snap.poles.points : null;
    var span = (snap.params && snap.params.poleSpanM) || opts.poleSpanM || 40;
    if (!poles || poles.length < 2) return out;
    var minGap = span * 0.5, maxGap = span * 1.5;
    var tooClose = 0, cap = Math.min(poles.length, 300);
    for (var i = 0; i < cap; i++) {
      for (var j = i + 1; j < cap; j++) {
        var d = havM([poles[i].lng, poles[i].lat], [poles[j].lng, poles[j].lat]);
        if (d < minGap) tooClose++;
      }
    }
    if (tooClose > 0) {
      out.push({ code: 'POLE_TOO_CLOSE', severity: 'warning',
        message: 'Ditemukan ' + tooClose + ' pasang tiang berjarak kurang dari ' + Math.round(minGap) + ' m.',
        recommendation: 'Kurangi 1 tiang pada titik yang terlalu rapat untuk efisiensi material.' });
    }
    // Perkiraan kasar rata-rata jarak antar tiang (agregat, bukan per-segmen —
    // lihat catatan keterbatasan di REVISION_03_REPORT.md).
    var avgGap = (snap.poles.cable_total_m || 0) / Math.max(poles.length, 1);
    if (avgGap > maxGap) {
      out.push({ code: 'POLE_TOO_FAR', severity: 'info',
        message: 'Rata-rata jarak antar tiang ≈ ' + Math.round(avgGap) + ' m, lebih jauh dari ambang ' + Math.round(maxGap) + ' m.',
        recommendation: 'Tambah tiang tambahan di sepanjang jalur kabel yang bentangannya panjang.' });
    }
    return out;
  }

  // 9) Jalur kabel tidak mengikuti jalan (butuh roadsFC pada snapshot).
  function check_cableNotFollowingRoad(snap, opts) {
    var out = [];
    var t = turf();
    var roadsFC = snap.roadsFC;
    if (!t || !roadsFC || !roadsFC.features || !roadsFC.features.length) return out; // data jalan tidak tersedia di snapshot ini
    var maxOffsetM = opts.maxRoadOffsetM || 30;
    function nearestRoadDistM(pt) {
      var best = Infinity;
      roadsFC.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString') return;
        try {
          var d = t.pointToLineDistance(t.point(pt), f, { units: 'meters' });
          if (d < best) best = d;
        } catch (e) {}
      });
      return best;
    }
    ['backbone', 'distribution'].forEach(function (kind) {
      var fc = snap[kind] && snap[kind].featureCollection;
      if (!fc || !fc.features) return;
      var offCount = 0;
      fc.features.forEach(function (f) {
        if (!f.geometry || f.geometry.type !== 'LineString') return;
        try {
          var mid = t.along(t.lineString(f.geometry.coordinates), t.length(f, { units: 'kilometers' }) / 2, { units: 'kilometers' });
          var d = nearestRoadDistM(mid.geometry.coordinates);
          if (d > maxOffsetM) offCount++;
        } catch (e) {}
      });
      if (offCount > 0) {
        out.push({ code: 'CABLE_OFF_ROAD', severity: 'warning',
          message: offCount + ' segmen ' + kind + ' menyimpang lebih dari ' + maxOffsetM + ' m dari jalan terdekat.',
          recommendation: 'Periksa ulang rute ' + kind + ' agar mengikuti jalan (kemungkinan data jalan di area ini kurang lengkap).' });
      }
    });
    return out;
  }

  // 10) Rumah belum terhubung + 11) Rumah ganda.
  function check_homeConnectivity(snap) {
    var out = [];
    var odps = snap.odps || [];
    var assigned = {}; // building_id -> jumlah ODP yang mengklaimnya
    odps.forEach(function (o) { (o.home_ids || []).forEach(function (hid) { assigned[hid] = (assigned[hid] || 0) + 1; }); });

    // Rumah ganda: building_id terdaftar di lebih dari 1 ODP.
    Object.keys(assigned).forEach(function (hid) {
      if (assigned[hid] > 1) {
        out.push({ code: 'HOME_DUPLICATE', severity: 'error', ref_id: hid,
          message: 'Rumah ' + hid + ' terdaftar di ' + assigned[hid] + ' ODP sekaligus (duplikat).',
          recommendation: 'Hapus salah satu penugasan ODP untuk rumah ' + hid + ', sisakan yang jaraknya paling dekat.' });
      }
    });

    // Rumah belum terhubung: is_home_passed = true tapi tidak ada di assigned{}.
    var homeFeats = (snap.homePassedFC && snap.homePassedFC.features) || [];
    var missing = [];
    homeFeats.forEach(function (f) {
      var bid = f.properties && f.properties.building_id;
      if (bid && !assigned[bid]) missing.push(bid);
    });
    if (missing.length) {
      out.push({ code: 'HOME_NOT_CONNECTED', severity: 'error',
        message: missing.length + ' rumah hasil deteksi belum terhubung ke ODP manapun (' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : '') + ').',
        recommendation: 'Tambah 1 ODP baru untuk menjangkau ' + missing.length + ' rumah yang belum terhubung, atau perluas radius coverage ODP terdekat.' });
    }
    return out;
  }

  // 12) Bangunan di luar boundary (butuh boundaryFeature pada snapshot).
  function check_buildingOutsideBoundary(snap) {
    var out = [];
    var t = turf();
    var boundary = snap.boundaryFeature;
    if (!t || !boundary) return out; // tidak tersedia di snapshot lama — lihat REVISION_03_REPORT.md
    var feats = (snap.buildingsFC && snap.buildingsFC.features) || [];
    var outside = 0;
    feats.forEach(function (f) {
      try {
        var c = t.centroid(f);
        if (!t.booleanPointInPolygon(c, boundary)) outside++;
      } catch (e) {}
    });
    if (outside > 0) {
      out.push({ code: 'BUILDING_OUTSIDE_BOUNDARY', severity: 'warning',
        message: outside + ' bangunan berada di luar boundary area analisa.',
        recommendation: 'Periksa ulang boundary atau hapus bangunan yang berada di luar area dari hasil planning.' });
    }
    return out;
  }

  var ALL_CHECKS = [
    check_odpTooFarFromHome, check_odpOverCapacity, check_odcOverCapacity,
    check_backboneDisconnected, check_distributionDisconnected, check_dropTooLong,
    check_poleSpacing, check_cableNotFollowingRoad, check_homeConnectivity,
    check_buildingOutsideBoundary,
  ];

  /* =====================================================================
     QUALITY SCORE — Coverage / Network / Construction / Efficiency /
     Planning, masing-masing 0..100, + Total (rata-rata tertimbang) + Grade.
     Bobot: Coverage 25%, Network 25%, Construction 20%, Efficiency 15%,
     Planning 15% (didokumentasikan supaya bisa diaudit/diubah).
     ===================================================================== */
  function computeQualityScore(snap, issues) {
    var byCode = {};
    issues.forEach(function (i) { byCode[i.code] = (byCode[i.code] || 0) + 1; });

    // Coverage Score: homepass ratio, dikurangi penalti rumah belum terhubung.
    var coveragePct = (snap.stats && snap.stats.coverage_percent) || 0;
    var coverage = clampScore(coveragePct - (byCode.HOME_NOT_CONNECTED ? 15 : 0) - (byCode.HOME_DUPLICATE ? 5 : 0));

    // Network Score: kapasitas & konektivitas.
    var network = clampScore(100
      - (byCode.ODP_OVER_CAPACITY || 0) * 8
      - (byCode.ODC_OVER_CAPACITY || 0) * 10
      - (byCode.BACKBONE_DISCONNECTED ? 25 : 0)
      - (byCode.DISTRIBUTION_DISCONNECTED || 0) * 10
      - (byCode.ODP_TOO_FAR || 0) * 4);

    // Construction Score: tiang & kabel.
    var construction = clampScore(100
      - (byCode.POLE_TOO_CLOSE ? 10 : 0)
      - (byCode.POLE_TOO_FAR ? 8 : 0)
      - (byCode.CABLE_OFF_ROAD || 0) * 12
      - (byCode.DROP_TOO_LONG || 0) * 3);

    // Efficiency Score: utilisasi ODP terhadap kapasitas (idealnya 70-100%).
    var odps = snap.odps || [];
    var cap = (snap.params && snap.params.odpCapacity) || 8;
    var util = odps.length ? odps.reduce(function (s, o) { return s + Math.min(1, (o.home_count || 0) / cap); }, 0) / odps.length : 0;
    var efficiency = clampScore(util >= 0.6 ? (85 + (util - 0.6) * 37.5) : (util / 0.6) * 85);

    // Planning Score: kelengkapan artefak + berat isu 'error'.
    var errorCount = issues.filter(function (i) { return i.severity === 'error'; }).length;
    var hasCore = odps.length > 0 && (snap.odcs || []).length > 0 && (snap.backbone && snap.backbone.length_m > 0) && (snap.distribution && snap.distribution.length_m > 0);
    var planning = clampScore((hasCore ? 100 : 40) - errorCount * 6);

    var total = clampScore(coverage * 0.25 + network * 0.25 + construction * 0.20 + efficiency * 0.15 + planning * 0.15);

    return {
      coverage: coverage, network: network, construction: construction,
      efficiency: efficiency, planning: planning, total: total, grade: gradeOf(total),
      weights: { coverage: 0.25, network: 0.25, construction: 0.20, efficiency: 0.15, planning: 0.15 },
    };
  }

  /* =====================================================================
     ORCHESTRATOR — computeValidation(snap, opts)
     Backward-compatible: field lama (home_count, odp_count, dst, status,
     issues[]) TETAP ADA supaya UI lama (planning-validation) tidak rusak,
     ditambah field baru untuk Revision 03 (issues_detail, quality_score,
     recommendations, engine_note).
     ===================================================================== */
  function computeValidation(snap, opts) {
    snap = snap || {};
    opts = opts || {};

    var issues = [];
    ALL_CHECKS.forEach(function (fn) {
      try { issues = issues.concat(fn(snap, opts) || []); } catch (e) { console.warn('[PlanningFinal] check gagal:', fn.name, e.message); }
    });

    var qualityScore = computeQualityScore(snap, issues);
    var recommendations = issues
      .filter(function (i) { return !!i.recommendation; })
      .map(function (i) { return i.recommendation; });

    // Metrik ringkas (kompatibel dengan UI lama).
    var odpCount = (snap.odps || []).length;
    var odcCount = (snap.odcs || []).length;
    var poleCount = (snap.poles && snap.poles.count) || 0;
    var boq = snap.boq || {};

    return {
      // -- field lama (kompatibilitas mundur) --
      home_count: (snap.stats && snap.stats.home_count) || 0,
      building_count: (snap.stats && snap.stats.building_count) || 0,
      odp_count: odpCount,
      odc_count: odcCount,
      pole_count: poleCount,
      backbone_length_m: (snap.backbone && snap.backbone.length_m) || 0,
      distribution_length_m: (snap.distribution && snap.distribution.length_m) || 0,
      closure_count: boq.closure_count || 0,
      jointbox_count: boq.jointbox_count || 0,
      handhole_count: boq.handhole_count || 0,
      connector_count: boq.connector_count || 0,
      coverage_percent: (snap.stats && snap.stats.coverage_percent) || 0,
      status: issues.some(function (i) { return i.severity === 'error'; }) ? 'issues' : (issues.length ? 'issues' : 'ok'),
      issues: issues.map(function (i) { return '[' + i.severity.toUpperCase() + '] ' + i.message; }),

      // -- field baru (Revision 03) --
      engine_version: REVISION_VERSION,
      engine_note: 'AI Recommendation bersifat rule-based/heuristik (bukan model machine-learning) — diturunkan langsung dari hasil Validasi Otomatis.',
      issues_detail: issues,
      quality_score: qualityScore,
      recommendations: recommendations,
    };
  }

  /* =====================================================================
     BANDINGKAN VERSI (Compare Revision) — dipakai modul planning-versions.
     ===================================================================== */
  function metricSet(snap) {
    snap = snap || {};
    var boq = snap.boq || {};
    return {
      'Home Passed': (snap.stats && snap.stats.home_passed) || 0,
      'Jumlah Bangunan': (snap.stats && snap.stats.building_count) || 0,
      'Coverage %': (snap.stats && snap.stats.coverage_percent) || 0,
      'Jumlah ODP': (snap.odps || []).length,
      'Jumlah ODC': (snap.odcs || []).length,
      'Jumlah Tiang': (snap.poles && snap.poles.count) || 0,
      'Backbone (m)': (snap.backbone && snap.backbone.length_m) || 0,
      'Distribution (m)': (snap.distribution && snap.distribution.length_m) || 0,
      'Closure': boq.closure_count || 0,
      'Joint Box': boq.jointbox_count || 0,
      'Handhole': boq.handhole_count || 0,
      'Connector': boq.connector_count || 0,
    };
  }
  function versionDiff(snapA, snapB) {
    var a = metricSet(snapA), b = metricSet(snapB);
    return Object.keys(a).map(function (k) {
      var from = a[k] || 0, to = b[k] || 0;
      return { metric: k, from: from, to: to, delta: round1(to - from) };
    });
  }

  /* =====================================================================
     EXPORT HELPERS
     ===================================================================== */
  function downloadBlob(filename, mime, content) {
    try {
      var blob = (content instanceof Blob) ? content : new Blob([content], { type: mime || 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
    } catch (e) { console.error('[PlanningFinal] downloadBlob gagal:', e); }
  }

  // reportsObj: { sheetKey: { title, columns:[...], rows:[[...],...] } } -> ArrayBuffer .xls
  function reportsToXLS(reportsObj) {
    if (!window.XLSX) { console.warn('[PlanningFinal] SheetJS (XLSX) belum termuat.'); return new ArrayBuffer(0); }
    var wb = XLSX.utils.book_new();
    Object.keys(reportsObj || {}).forEach(function (key) {
      var rep = reportsObj[key];
      var aoa = [rep.columns || []].concat(rep.rows || []);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, (rep.title || key).slice(0, 31));
    });
    return XLSX.write(wb, { bookType: 'xls', type: 'array' });
  }

  /* =====================================================================
     REVISION 04 — PROPOSAL & BOQ FINAL ENGINE
     =====================================================================
     Fungsi di bawah ini MELENGKAPI kontrak window.PlanningFinal yang sudah
     dipanggil oleh app.js sebelumnya (modul planning-reports/export/
     detected-buildings) tapi belum ada implementasinya: buildReports,
     reportToHtmlTable, reportToCSV, openPrintable, snapshotToGeoJSON,
     snapshotToKML, snapshotToKMZ — DITAMBAH fungsi baru Revision 04:
     buildBOQFinal, buildMaterialList, buildProposal.
     ===================================================================== */

  /* ---------- Konversi snapshot -> satu FeatureCollection gabungan ---------- */
  function snapshotFeatures(snap) {
    var feats = [];
    function tag(f, layer, extra) { if (!f) return; f.properties = Object.assign({}, f.properties, { layer: layer }, extra || {}); feats.push(f); }
    ((snap.buildingsFC && snap.buildingsFC.features) || []).forEach(function (f) { tag(f, 'Detected Buildings'); });
    ((snap.homePassedFC && snap.homePassedFC.features) || []).forEach(function (f) { tag(f, 'Home Passed'); });
    (snap.odps || []).forEach(function (o) { tag({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lng, o.lat] }, properties: {} }, 'ODP', { name: o.odp_id, home_count: o.home_count }); });
    (snap.odcs || []).forEach(function (o) { tag({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.lng, o.lat] }, properties: {} }, 'ODC', { name: o.odc_id, odp_count: (o.odp_ids || []).length }); });
    ((snap.poles && snap.poles.points) || []).forEach(function (p) { tag({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: {} }, 'Pole', { name: p.pole_id }); });
    ((snap.backbone && snap.backbone.featureCollection && snap.backbone.featureCollection.features) || []).forEach(function (f) { tag(f, 'Backbone'); });
    ((snap.distribution && snap.distribution.featureCollection && snap.distribution.featureCollection.features) || []).forEach(function (f) { tag(f, 'Distribution'); });
    return feats;
  }
  function snapshotToGeoJSON(snap) {
    return JSON.stringify({ type: 'FeatureCollection', features: snapshotFeatures(snap) }, null, 2);
  }

  /* ---------- KML/KMZ (penulis manual, tanpa dependency tambahan selain JSZip untuk KMZ) ---------- */
  function xmlEscape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function coordsToKmlCoordString(coords, isRing) {
    // coords: [lng,lat] (Point) ATAU [[lng,lat],...] (Line/Ring)
    if (typeof coords[0] === 'number') return coords[0] + ',' + coords[1] + ',0';
    return coords.map(function (c) { return c[0] + ',' + c[1] + ',0'; }).join(' ');
  }
  function geometryToKml(geom) {
    if (!geom) return '';
    if (geom.type === 'Point') return '<Point><coordinates>' + coordsToKmlCoordString(geom.coordinates) + '</coordinates></Point>';
    if (geom.type === 'LineString') return '<LineString><tessellate>1</tessellate><coordinates>' + coordsToKmlCoordString(geom.coordinates) + '</coordinates></LineString>';
    if (geom.type === 'Polygon') {
      var outer = geom.coordinates[0] || [];
      return '<Polygon><outerBoundaryIs><LinearRing><coordinates>' + coordsToKmlCoordString(outer) + '</coordinates></LinearRing></outerBoundaryIs></Polygon>';
    }
    return '';
  }
  function snapshotToKML(snap, name) {
    var feats = snapshotFeatures(snap);
    var byLayer = {};
    feats.forEach(function (f) { var l = (f.properties && f.properties.layer) || 'Lainnya'; (byLayer[l] = byLayer[l] || []).push(f); });
    var folders = Object.keys(byLayer).map(function (layer) {
      var placemarks = byLayer[layer].map(function (f) {
        var p = f.properties || {};
        var pname = p.name || p.building_id || p.odp_id || layer;
        return '<Placemark><name>' + xmlEscape(pname) + '</name>' + geometryToKml(f.geometry) + '</Placemark>';
      }).join('');
      return '<Folder><name>' + xmlEscape(layer) + '</name>' + placemarks + '</Folder>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?>' +
      '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + xmlEscape(name || 'Planning') + '</name>' + folders + '</Document></kml>';
  }
  // Mengembalikan Promise<Blob> (JSZip v3 hanya punya generateAsync, tidak ada versi sync).
  // Pemanggil (app.js) HARUS await hasil ini sebelum diteruskan ke downloadBlob().
  async function snapshotToKMZ(snap, name) {
    var kml = snapshotToKML(snap, name);
    if (!window.JSZip) { console.warn('[PlanningFinal] JSZip belum termuat — KMZ dikembalikan sebagai KML mentah.'); return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }); }
    var zip = new JSZip();
    zip.file('doc.kml', kml);
    return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz' });
  }

  /* ---------- Report generik (HTML table / CSV / cetak) ---------- */
  function reportToHtmlTable(report) {
    var rows = (report.rows && report.rows.length) ? report.rows : [['—']];
    var thead = '<tr>' + (report.columns || []).map(function (c) { return '<th style="border:1px solid #ccc;padding:4px 8px;background:#f2f2f2;text-align:left;">' + xmlEscape(c) + '</th>'; }).join('') + '</tr>';
    var tbody = rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td style="border:1px solid #ddd;padding:4px 8px;">' + xmlEscape(c) + '</td>'; }).join('') + '</tr>'; }).join('');
    return '<h3 style="font-family:sans-serif;margin:18px 0 6px;">' + xmlEscape(report.title || '') + '</h3>' +
      '<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;margin-bottom:12px;">' + thead + tbody + '</table>';
  }
  function csvEscape(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? ('"' + v.replace(/"/g, '""') + '"') : v; }
  function reportToCSV(report) {
    var lines = [(report.columns || []).map(csvEscape).join(',')];
    (report.rows || []).forEach(function (r) { lines.push(r.map(csvEscape).join(',')); });
    return lines.join('\n');
  }
  function openPrintable(html, title) {
    var w = window.open('', '_blank');
    if (!w) { console.warn('[PlanningFinal] popup diblokir browser — izinkan popup untuk cetak PDF.'); return; }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + xmlEscape(title || 'Report') + '</title></head><body>' +
      '<h2 style="font-family:sans-serif;">' + xmlEscape(title || '') + '</h2>' + html +
      '<script>setTimeout(function(){window.print();}, 300);<\/script></body></html>');
    w.document.close();
  }

  /* ---------- BOQ FINAL (Revision 04) ---------- */
  // boq (dari planning-generators.js) SUDAH lengkap (pole/odp/odc/backbone/
  // distribution/drop/closure/handhole/jointbox/connector/core/reserve).
  // Fungsi ini menambahkan field yang DIMINTA Revision 04 tapi belum ada
  // modul generatornya (Feeder) — didokumentasikan apa adanya, bukan
  // mengarang angka.
  function buildBOQFinal(snap) {
    var boq = snap.boq || {};
    return Object.assign({}, boq, {
      feeder_length_m: null,
      feeder_note: 'Belum ada modul Feeder terpisah di generator (planning-generators.js) — jalur POP↔ODC saat ini tergabung dalam Backbone. Tambahkan generator Feeder khusus bila perlu dipisah dari BOQ.',
      home_passed: (snap.stats && snap.stats.home_passed) || 0,
      building_count: (snap.stats && snap.stats.building_count) || 0,
    });
  }

  /* ---------- MATERIAL LIST (Revision 04) ---------- */
  function buildMaterialList(snap) {
    var boq = snap.boq || {};
    var items = (boq.items || []).slice(); // ODP/ODC/Pole/Backbone/Distribution/Drop/Closure/Handhole/JointBox/Connector/Core sudah ada di sini
    // Tambahan supaya sesuai kategori Revision 04: Splitter & Accessories
    // (belum ada baris eksplisit di boq.items lama).
    items.push({ item: 'Splitter 1:8 (di tiap ODP)', unit: 'unit', quantity: boq.odp_count || 0 });
    items.push({ item: 'Splitter 1:4 (di tiap ODC)', unit: 'unit', quantity: boq.odc_count || 0 });
    items.push({ item: 'Accessories (pigtail/adapter/patchcord, dll — estimasi dari Connector)', unit: 'set', quantity: boq.connector_count || 0 });
    return {
      title: 'Material List',
      columns: ['Item', 'Unit', 'Qty'],
      rows: items.map(function (it) { return [it.item, it.unit, it.quantity]; }),
      raw: items,
    };
  }

  /* ---------- 10 REPORT OTOMATIS ---------- */
  function buildReports(ctx) {
    ctx = ctx || {};
    var snap = ctx.snapshot || {};
    var version = ctx.version || {};
    var project = ctx.project || {};
    var approvals = ctx.approvals || [];
    var stats = snap.stats || {};
    var boq = snap.boq || {};

    var planning = {
      title: 'Planning Report', columns: ['Metrik', 'Nilai'],
      rows: [
        ['Project', project.name || '-'], ['Versi', version.version_label || ('V' + (version.version_no || 0))],
        ['Status', version.status || 'draft'], ['Home Passed', stats.home_passed || 0],
        ['Jumlah Bangunan', stats.building_count || 0], ['Coverage %', stats.coverage_percent || 0],
        ['Jumlah ODP', (snap.odps || []).length], ['Jumlah ODC', (snap.odcs || []).length],
        ['Jumlah Tiang', (snap.poles && snap.poles.count) || 0],
        ['Backbone (m)', (snap.backbone && snap.backbone.length_m) || 0],
        ['Distribution (m)', (snap.distribution && snap.distribution.length_m) || 0],
      ],
    };
    var coverage = {
      title: 'Coverage Report', columns: ['Metrik', 'Nilai'],
      rows: [['Luas Area (km²)', stats.area_km2 || '-'], ['Density (/km²)', stats.density_per_km2 || 0],
        ['Home Passed', stats.home_passed || 0], ['Building Count', stats.building_count || 0],
        ['Non-Home', stats.non_home_count || 0], ['Coverage %', stats.coverage_percent || 0]],
    };
    var building = {
      title: 'Building Report', columns: ['Building ID', 'Kategori', 'Home Passed'],
      rows: ((snap.buildingsFC && snap.buildingsFC.features) || []).slice(0, 500).map(function (f) {
        var p = f.properties || {}; return [p.building_id || '-', p.category || p.type || '-', p.is_home_passed ? 'Ya' : 'Tidak'];
      }),
    };
    var odp = { title: 'ODP Report', columns: ['ODP ID', 'Lat', 'Lng', 'Home Count', 'Radius (m)'],
      rows: (snap.odps || []).map(function (o) { return [o.odp_id, o.lat, o.lng, o.home_count || 0, o.coverage_radius_m || '-']; }) };
    var odc = { title: 'ODC Report', columns: ['ODC ID', 'Lat', 'Lng', 'Jumlah ODP'],
      rows: (snap.odcs || []).map(function (o) { return [o.odc_id, o.lat, o.lng, (o.odp_ids || []).length]; }) };
    var backboneR = { title: 'Backbone Report', columns: ['Metrik', 'Nilai'],
      rows: [['Panjang (m)', (snap.backbone && snap.backbone.length_m) || 0], ['Jumlah Segmen', (snap.backbone && snap.backbone.segment_count) || 0]] };
    var distributionR = { title: 'Distribution Report', columns: ['Metrik', 'Nilai'],
      rows: [['Panjang (m)', (snap.distribution && snap.distribution.length_m) || 0], ['Jumlah Segmen', (snap.distribution && snap.distribution.segment_count) || 0]] };
    var boqR = { title: 'BOQ Report', columns: ['Item', 'Unit', 'Qty'], rows: (boq.items || []).map(function (it) { return [it.item, it.unit, it.quantity]; }) };
    var validation = (function () {
      var val = computeValidation(snap);
      return { title: 'Validation Report', columns: ['Tingkat', 'Aturan', 'Keterangan'],
        rows: (val.issues_detail || []).map(function (i) { return [i.severity, i.code, i.message]; }) };
    })();
    var approval = { title: 'Approval Report', columns: ['Aksi', 'Dari', 'Ke', 'Oleh', 'Catatan'],
      rows: approvals.map(function (a) { return [a.action, a.from_status, a.to_status, a.actor_name || a.actor || '-', a.note || '-']; }) };

    return { planning: planning, coverage: coverage, building: building, odp: odp, odc: odc,
      backbone: backboneR, distribution: distributionR, boq: boqR, validation: validation, approval: approval };
  }

  /* ---------- PROPOSAL (Revision 04) ---------- */
  function buildProposal(ctx) {
    ctx = ctx || {};
    var snap = ctx.snapshot || {};
    var project = ctx.project || {};
    var version = ctx.version || {};
    var stats = snap.stats || {};
    var boq = snap.boq || {};
    var proposal = {
      project: project.name || '-',
      client: project.client || project.description || '-',
      planner: ctx.planner || '-',
      tanggal: new Date().toISOString().slice(0, 10),
      boundary_type: (ctx.boundary && ctx.boundary.type) || '-',
      luas_area_km2: stats.area_km2 || (ctx.boundary && ctx.boundary.area_sqm ? round1(ctx.boundary.area_sqm / 1e6) : '-'),
      jumlah_rumah: stats.home_passed || 0,
      jumlah_odp: (snap.odps || []).length,
      jumlah_odc: (snap.odcs || []).length,
      jumlah_tiang: (snap.poles && snap.poles.count) || 0,
      panjang_kabel_m: boq.cable_length_m || 0,
      boq: boq,
      ringkasan_planning: 'Area seluas ' + (stats.area_km2 || '-') + ' km² dengan ' + (stats.building_count || 0) +
        ' bangunan terdeteksi, ' + (stats.home_passed || 0) + ' rumah homepass (' + (stats.coverage_percent || 0) +
        '% coverage), dilayani ' + (snap.odps || []).length + ' ODP dan ' + (snap.odcs || []).length + ' ODC.',
      catatan_planner: ctx.note || '-',
      status: version.status || 'draft',
    };
    var rows = [
      ['Project', proposal.project], ['Client', proposal.client], ['Planner', proposal.planner], ['Tanggal', proposal.tanggal],
      ['Boundary', proposal.boundary_type], ['Luas Area (km²)', proposal.luas_area_km2], ['Jumlah Rumah', proposal.jumlah_rumah],
      ['Jumlah ODP', proposal.jumlah_odp], ['Jumlah ODC', proposal.jumlah_odc], ['Jumlah Tiang', proposal.jumlah_tiang],
      ['Panjang Kabel (m)', proposal.panjang_kabel_m], ['Catatan Planner', proposal.catatan_planner],
    ];
    var html = '<div style="font-family:sans-serif;">' +
      '<h2>Proposal Perencanaan Jaringan FTTH</h2>' +
      '<table style="border-collapse:collapse;">' + rows.map(function (r) {
        return '<tr><td style="padding:4px 12px 4px 0;color:#555;">' + xmlEscape(r[0]) + '</td><td style="padding:4px 0;font-weight:600;">' + xmlEscape(r[1]) + '</td></tr>';
      }).join('') + '</table>' +
      '<h3>Ringkasan Planning</h3><p>' + xmlEscape(proposal.ringkasan_planning) + '</p>' +
      reportToHtmlTable({ title: 'BOQ', columns: ['Item', 'Unit', 'Qty'], rows: (boq.items || []).map(function (it) { return [it.item, it.unit, it.quantity]; }) }) +
      '</div>';
    proposal.html = html;
    return proposal;
  }

  /* =====================================================================
     REVISION 05 — CONSTRUCTION, AS-BUILT & ASSET MANAGEMENT
     =====================================================================
     Fungsi di bawah ini murni pengolah data (tidak memanggil Supabase
     sendiri) — app.js yang mengambil baris dari tabel
     odp/odc/poles/backbones/distributions/kabels/closures/handholes/
     jointboxes/homes + asset_change_log + asset_photo, lalu diteruskan ke
     sini untuk dirangkum/diexport. Konsisten dengan pola computeValidation/
     buildReports yang sudah ada.
     ===================================================================== */

  var ASSET_STATUS_ORDER = ['draft', 'approved', 'installed', 'verified', 'maintenance', 'removed'];

  // assets: array baris gabungan lintas tabel, masing-masing DIHARAPKAN
  // sudah dinormalisasi oleh pemanggil menjadi:
  //   { asset_type, id, name/code, lat, lng, asset_status, project_id }
  function assetsToGeoJSON(assets) {
    var feats = (assets || []).filter(function (a) { return a.lat != null && a.lng != null; }).map(function (a) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
        properties: { asset_type: a.asset_type, name: a.name || a.code || a.id, asset_status: a.asset_status, project_id: a.project_id } };
    });
    return JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 2);
  }
  function assetsToKML(assets, name) {
    var byType = {};
    (assets || []).forEach(function (a) { if (a.lat == null || a.lng == null) return; (byType[a.asset_type] = byType[a.asset_type] || []).push(a); });
    var folders = Object.keys(byType).map(function (ty) {
      var placemarks = byType[ty].map(function (a) {
        return '<Placemark><name>' + xmlEscape(a.name || a.code || a.id) + '</name>' +
          '<description>Status: ' + xmlEscape(a.asset_status || '-') + '</description>' +
          '<Point><coordinates>' + a.lng + ',' + a.lat + ',0</coordinates></Point></Placemark>';
      }).join('');
      return '<Folder><name>' + xmlEscape(ty) + '</name>' + placemarks + '</Folder>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + xmlEscape(name || 'Assets') + '</name>' + folders + '</Document></kml>';
  }
  async function assetsToKMZ(assets, name) {
    var kml = assetsToKML(assets, name);
    if (!window.JSZip) return new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    var zip = new JSZip(); zip.file('doc.kml', kml);
    return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.google-earth.kmz' });
  }

  // ---------- Asset Report — rekap per jenis & status ----------
  function buildAssetReport(assets) {
    var byType = {};
    (assets || []).forEach(function (a) {
      var k = a.asset_type || 'lainnya';
      byType[k] = byType[k] || { total: 0, draft: 0, approved: 0, installed: 0, verified: 0, maintenance: 0, removed: 0 };
      byType[k].total++;
      if (byType[k][a.asset_status] != null) byType[k][a.asset_status]++;
    });
    var rows = Object.keys(byType).map(function (k) {
      var s = byType[k];
      return [k, s.total, s.draft, s.approved, s.installed, s.verified, s.maintenance, s.removed];
    });
    return { title: 'Asset Report', columns: ['Jenis Aset', 'Total', 'Draft', 'Approved', 'Installed', 'Verified', 'Maintenance', 'Removed'], rows: rows };
  }

  // ---------- Construction Report — aset yang sudah/​sedang dipasang ----------
  function buildConstructionReport(assets, changeLog) {
    var installed = (assets || []).filter(function (a) { return ['installed', 'verified', 'maintenance'].indexOf(a.asset_status) !== -1; });
    var installLogs = (changeLog || []).filter(function (c) { return c.change_type === 'status_change' && c.new_value && c.new_value.asset_status === 'installed'; });
    return {
      title: 'Construction Report', columns: ['Jenis Aset', 'Nama/Kode', 'Status', 'Tanggal Instalasi (dari log)', 'Oleh'],
      rows: installed.map(function (a) {
        var log = installLogs.find(function (l) { return l.asset_id === a.id; });
        return [a.asset_type, a.name || a.code || a.id, a.asset_status, log ? new Date(log.created_at).toLocaleDateString('id-ID') : '-', log ? (log.changed_by_name || '-') : '-'];
      }),
    };
  }

  // ---------- QC Report — aset yang sudah diverifikasi + foto QC ----------
  function buildQCReport(assets, photos) {
    var verified = (assets || []).filter(function (a) { return a.asset_status === 'verified'; });
    var photosByAsset = {};
    (photos || []).filter(function (p) { return p.photo_type === 'qc'; }).forEach(function (p) { (photosByAsset[p.asset_id] = photosByAsset[p.asset_id] || []).push(p); });
    return {
      title: 'QC Report', columns: ['Jenis Aset', 'Nama/Kode', 'Status', 'Jumlah Foto QC'],
      rows: verified.map(function (a) { return [a.asset_type, a.name || a.code || a.id, a.asset_status, (photosByAsset[a.id] || []).length]; }),
    };
  }

  // ---------- Maintenance Report ----------
  function buildMaintenanceReport(assets, changeLog, photos) {
    var maint = (assets || []).filter(function (a) { return a.asset_status === 'maintenance'; });
    var photosByAsset = {};
    (photos || []).filter(function (p) { return p.photo_type === 'maintenance' || p.photo_type === 'damage'; }).forEach(function (p) { (photosByAsset[p.asset_id] = photosByAsset[p.asset_id] || []).push(p); });
    return {
      title: 'Maintenance Report', columns: ['Jenis Aset', 'Nama/Kode', 'Catatan Terakhir', 'Jumlah Foto Kerusakan/Maintenance'],
      rows: maint.map(function (a) {
        var lastLog = (changeLog || []).filter(function (c) { return c.asset_id === a.id; }).sort(function (x, y) { return new Date(y.created_at) - new Date(x.created_at); })[0];
        return [a.asset_type, a.name || a.code || a.id, lastLog ? (lastLog.note || '-') : '-', (photosByAsset[a.id] || []).length];
      }),
    };
  }

  // ---------- As Built Report — seluruh perubahan koordinat lapangan ----------
  function buildAsBuiltReport(changeLog) {
    var moves = (changeLog || []).filter(function (c) { return c.change_type === 'move' || c.change_type === 'restore'; });
    return {
      title: 'As Built Report', columns: ['Jenis Aset', 'Tanggal', 'Koordinat Lama', 'Koordinat Baru', 'Oleh', 'Alasan'],
      rows: moves.map(function (c) {
        return [c.asset_type, new Date(c.created_at).toLocaleString('id-ID'),
          (c.old_lat != null ? (round1(c.old_lat) + ',' + round1(c.old_lng)) : '-'),
          (c.new_lat != null ? (round1(c.new_lat) + ',' + round1(c.new_lng)) : '-'),
          c.changed_by_name || '-', c.reason || c.note || '-'];
      }),
    };
  }

  function buildAllAssetReports(ctx) {
    ctx = ctx || {};
    return {
      asset: buildAssetReport(ctx.assets),
      construction: buildConstructionReport(ctx.assets, ctx.changeLog),
      qc: buildQCReport(ctx.assets, ctx.photos),
      maintenance: buildMaintenanceReport(ctx.assets, ctx.changeLog, ctx.photos),
      as_built: buildAsBuiltReport(ctx.changeLog),
    };
  }

  /* =====================================================================
     PASANG KE window.PlanningFinal
     ===================================================================== */
  window.PlanningFinal = {
    version: REVISION_VERSION,
    computeValidation: computeValidation,
    computeQualityScore: computeQualityScore,
    versionDiff: versionDiff,
    downloadBlob: downloadBlob,
    reportsToXLS: reportsToXLS,
    // Revision 04 + kelengkapan kontrak lama:
    buildReports: buildReports,
    reportToHtmlTable: reportToHtmlTable,
    reportToCSV: reportToCSV,
    openPrintable: openPrintable,
    snapshotToGeoJSON: snapshotToGeoJSON,
    snapshotToKML: snapshotToKML,
    snapshotToKMZ: snapshotToKMZ,
    buildBOQFinal: buildBOQFinal,
    buildMaterialList: buildMaterialList,
    buildProposal: buildProposal,
    // Revision 05 — Construction/As-Built/Asset Management:
    ASSET_STATUS_ORDER: ASSET_STATUS_ORDER,
    assetsToGeoJSON: assetsToGeoJSON,
    assetsToKML: assetsToKML,
    assetsToKMZ: assetsToKMZ,
    buildAssetReport: buildAssetReport,
    buildConstructionReport: buildConstructionReport,
    buildQCReport: buildQCReport,
    buildMaintenanceReport: buildMaintenanceReport,
    buildAsBuiltReport: buildAsBuiltReport,
    buildAllAssetReports: buildAllAssetReports,
  };
})();
