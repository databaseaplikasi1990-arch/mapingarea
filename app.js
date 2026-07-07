/* =========================================================================
   MAPPING AREA — APP.JS
   Seluruh logika aplikasi (SPA, tanpa build step).
   =========================================================================
   STRUKTUR FILE INI (dicari dengan Ctrl+F memakai tag berikut):
     [CORE]        bootstrap, state, util
     [SUPABASE]    client, auth, realtime
     [THEME]       dark/light
     [ROUTER]      hash router + sidebar
     [TOAST/MODAL] notifikasi & dialog generik
     [DASHBOARD]   modul dashboard
     [MAPPING]     peta + import KMZ/KML/SHP/GeoJSON
     [MODULES]     placeholder modul fase berikutnya
   ========================================================================= */

(function () {
  'use strict';

  /* ================= [CORE] STATE GLOBAL ================= */
  const CFG = window.APP_CONFIG;

  const App = {
    supabase: null,
    session: null,
    profile: null,          // { id, full_name, role, avatar_url }
    theme: CFG.THEME,
    sidebarCollapsed: false,
    currentRoute: 'dashboard',
    map: null,
    heatMap: null,
    mapLayers: {},           // key -> L.LayerGroup (layer HASIL IMPORT, folder "Data Import")
    assetLayerGroups: {},    // assetKey -> L.LayerGroup (folder "Aset FTTH", lazy-loaded per tipe aset)
    autosaveTimer: null,
    realtimeChannels: [],
    // FIX #E5 (per-project scoping): project yang sedang aktif dipilih user.
    // null = belum ada project dipilih (tampilan lama/lintas-project).
    currentProjectId: localStorage.getItem('ma_active_project') || null,
    currentProjectName: localStorage.getItem('ma_active_project_name') || null,
  };
  window.App = App; // ekspos untuk debugging di console

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (v === null || v === undefined) return;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => {
      if (c === null || c === undefined || c === false) return; // FIX #E1: cegah crash appendChild(null) dari children kondisional (mis. `cond ? el(...) : null`)
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function fmtNumber(n) {
    if (n === null || n === undefined) return '-';
    return new Intl.NumberFormat('id-ID').format(n);
  }
  function fmtDate(d) {
    if (!d) return '-';
    try { return new Date(d).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return String(d); }
  }
  function debounce(fn, wait) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  }
  // Jarak antar 2 titik lat/lng dalam meter (formula Haversine).
  // FIX #E5 (per-project scoping): daftar tabel aset yang punya kolom project_id
  // (lihat supabase/schema_full.sql migration 003). Dipakai untuk otomatis
  // menyaring query List & mengisi project_id saat Tambah data baru, supaya
  // "ganti project aktif -> semua angka balik ke 0 untuk project itu" beneran jalan.
  const PROJECT_SCOPED_TABLES = [
    'areas', 'pops', 'odc', 'odp', 'homes', 'poles', 'backbones',
    'distributions', 'kabels', 'closures', 'handholes', 'jointboxes',
    'planning_analysis', 'detected_buildings',
  ];
  // Tambahkan .eq('project_id', ...) HANYA bila ada project aktif dan tabelnya memang berelasi ke project.
  function scopeToProject(query, table) {
    if (App.currentProjectId && PROJECT_SCOPED_TABLES.includes(table)) {
      return query.eq('project_id', App.currentProjectId);
    }
    return query;
  }
  App.scopeToProject = scopeToProject;

  // Ganti project aktif: simpan ke localStorage + App, lalu render ulang switcher
  // dan halaman yang sedang dibuka supaya datanya ikut ter-filter ulang.
  function setActiveProject(id, name) {
    App.currentProjectId = id || null;
    App.currentProjectName = name || null;
    if (id) { localStorage.setItem('ma_active_project', id); localStorage.setItem('ma_active_project_name', name || ''); }
    else { localStorage.removeItem('ma_active_project'); localStorage.removeItem('ma_active_project_name'); }
    if (typeof renderProjectSwitcher === 'function') renderProjectSwitcher();
    if (App.currentRoute) navigateTo(App.currentRoute);
  }
  App.setActiveProject = setActiveProject;

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  /* ================= [SUPABASE] CLIENT & AUTH ================= */
  function initSupabase() {
    if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
      console.warn('[Mapping Area] SUPABASE_URL/ANON_KEY belum diisi di config.js.');
    }
    App.supabase = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  async function fetchProfile(userId) {
    const { data, error } = await App.supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url')
      .eq('id', userId)
      .single();
    if (error) { console.error('fetchProfile error:', error.message); return null; }
    return data;
  }

  async function handleLogin(email, password) {
    const btn = $('#login-submit-btn');
    const errEl = $('#login-error');
    errEl.textContent = '';
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = 'Memproses...';
    try {
      const { data, error } = await App.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      App.session = data.session;
      App.profile = await fetchProfile(data.user.id);
      enterApp();
    } catch (err) {
      errEl.textContent = translateAuthError(err.message);
    } finally {
      btn.disabled = false;
      btn.querySelector('.btn-label').textContent = 'Masuk';
    }
  }

  function translateAuthError(msg) {
    if (!msg) return 'Terjadi kesalahan. Coba lagi.';
    if (/invalid login credentials/i.test(msg)) return 'Email atau kata sandi salah.';
    if (/email not confirmed/i.test(msg)) return 'Email belum dikonfirmasi.';
    return msg;
  }

  async function handleLogout() {
    stopRealtime();
    await App.supabase.auth.signOut();
    App.session = null;
    App.profile = null;
    localStorage.removeItem('ma_last_route');
    location.hash = '';
    showAuthScreen();
  }

  async function checkExistingSession() {
    const { data } = await App.supabase.auth.getSession();
    if (data && data.session) {
      App.session = data.session;
      App.profile = await fetchProfile(data.session.user.id);
      return true;
    }
    return false;
  }

  App.supabaseHelpers = { fetchProfile };

  /* ================= [THEME] DARK / LIGHT ================= */
  function applyTheme(theme) {
    App.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const icon = $('#theme-toggle-btn i');
    if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    localStorage.setItem('ma_theme', theme);
  }
  function toggleTheme() { applyTheme(App.theme === 'dark' ? 'light' : 'dark'); }

  /* ================= [TOAST/MODAL] ================= */
  function toast(message, type = 'info', timeout = 3500) {
    const box = el('div', { class: `toast ${type}` }, [message]);
    $('#toast-container').appendChild(box);
    setTimeout(() => box.remove(), timeout);
  }
  App.toast = toast;

  function confirmDialog(message, title = 'Konfirmasi') {
    return new Promise((resolve) => {
      $('#confirm-title').textContent = title;
      $('#confirm-message').textContent = message;
      const dialog = $('#confirm-dialog');
      dialog.classList.remove('hidden');
      const okBtn = $('#confirm-ok-btn');
      const cleanup = (result) => {
        dialog.classList.add('hidden');
        okBtn.removeEventListener('click', onOk);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      okBtn.addEventListener('click', onOk);
      $all('[data-close="confirm-dialog"]').forEach((b) => b.onclick = () => cleanup(false));
    });
  }
  App.confirmDialog = confirmDialog;

  function openModal(contentNode, opts = {}) {
    const overlay = el('div', { class: 'modal-overlay' });
    const box = el('div', { class: `modal-box ${opts.size ? 'modal-' + opts.size : ''}` });
    box.appendChild(contentNode);
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay && opts.dismissible !== false) closeModal(overlay); });
    $('#modal-root').style.pointerEvents = 'auto';
    $('#modal-root').appendChild(overlay);
    return overlay;
  }
  function closeModal(overlay) {
    overlay.remove();
    if (!$('#modal-root').children.length) $('#modal-root').style.pointerEvents = 'none';
  }
  App.openModal = openModal;
  App.closeModal = closeModal;

  function modalHeader(title, overlay) {
    return el('div', { class: 'modal-header' }, [
      el('h3', {}, [title]),
      el('button', { class: 'icon-btn', onclick: () => closeModal(overlay) }, [el('i', { class: 'fa-solid fa-xmark' })]),
    ]);
  }
  App.modalHeader = modalHeader;

  /* ================= [ROUTER] SIDEBAR + HASH ROUTING ================= */
  const ROUTE_TITLES = {}; // key -> label, diisi dari NAV_GROUPS

  function buildSidebar() {
    const nav = $('#sidebar-nav');
    nav.innerHTML = '';
    CFG.NAV_GROUPS.forEach((group) => {
      const groupEl = el('div', { class: 'nav-group' }, [
        el('div', { class: 'nav-group-title' }, [group.title]),
      ]);
      group.items.forEach((item) => {
        ROUTE_TITLES[item.key] = item.label;
        const itemEl = el('div', { class: 'nav-item', 'data-route': item.key }, [
          el('i', { class: `fa-solid ${item.icon}` }),
          el('span', { class: 'nav-item-label' }, [item.label]),
        ]);
        itemEl.addEventListener('click', () => { location.hash = '#/' + item.key; });
        groupEl.appendChild(itemEl);
      });
      nav.appendChild(groupEl);
    });
  }

  function setActiveNav(route) {
    $all('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
    $('#page-title').textContent = ROUTE_TITLES[route] || 'Mapping Area';
  }

  // Registry modul: key -> { render(container), destroy() }
  const MODULES = {};
  function registerModule(key, renderFn, destroyFn) {
    MODULES[key] = { render: renderFn, destroy: destroyFn || (() => {}) };
  }
  App.registerModule = registerModule;

  let activeModule = null;
  async function navigateTo(route) {
    if (!MODULES[route]) route = 'dashboard';
    if (activeModule && activeModule.destroy) { try { activeModule.destroy(); } catch (e) {} }
    App.currentRoute = route;
    setActiveNav(route);
    $('#page-toolbar').innerHTML = '';
    const content = $('#page-content');
    content.innerHTML = '<div class="skeleton" style="height:120px;border-radius:10px;"></div>';
    localStorage.setItem('ma_last_route', route);
    activeModule = MODULES[route];
    try {
      await activeModule.render(content);
    } catch (err) {
      console.error(err);
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['Gagal memuat modul: ' + err.message]),
      ]));
    }
    // Tutup sidebar di mode mobile setelah navigasi
    if (window.innerWidth <= 1024) closeSidebarMobile();
  }

  function handleHashChange() {
    const route = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
    navigateTo(route);
  }

  function openSidebarMobile() {
    $('#app-shell').classList.add('sidebar-open');
    $('#sidebar-backdrop').classList.remove('hidden');
  }
  function closeSidebarMobile() {
    $('#app-shell').classList.remove('sidebar-open');
    $('#sidebar-backdrop').classList.add('hidden');
  }
  function toggleSidebar() {
    if (window.innerWidth <= 1024) {
      $('#app-shell').classList.contains('sidebar-open') ? closeSidebarMobile() : openSidebarMobile();
    } else {
      App.sidebarCollapsed = !App.sidebarCollapsed;
      $('#app-shell').classList.toggle('sidebar-collapsed', App.sidebarCollapsed);
    }
  }

  /* ================= [DASHBOARD] ================= */
  registerModule('dashboard', async function renderDashboard(container) {
    container.innerHTML = '';
    const grid = el('div', { class: 'stat-grid' });
    const statDefs = [
      { key: 'totalProject', label: 'Total Project', icon: 'fa-folder' },
      { key: 'totalArea', label: 'Total Area', icon: 'fa-draw-polygon' },
      { key: 'totalRumah', label: 'Total Rumah', icon: 'fa-house' },
      { key: 'totalTiang', label: 'Total Tiang', icon: 'fa-tower-cell' },
      { key: 'totalOdc', label: 'Total ODC', icon: 'fa-server' },
      { key: 'totalOdp', label: 'Total ODP', icon: 'fa-diagram-project' },
      { key: 'coveragePercent', label: 'Coverage', icon: 'fa-wifi', suffix: '%' },
      { key: 'surveyProgressPercent', label: 'Progress Survey', icon: 'fa-clipboard-check', suffix: '%' },
    ];
    const cardsByKey = {};
    statDefs.forEach((s) => {
      const valueEl = el('div', { class: 'stat-value' }, ['-']);
      const card = el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-icon' }, [el('i', { class: `fa-solid ${s.icon}` })]),
        el('div', {}, [valueEl, el('div', { class: 'stat-label' }, [s.label])]),
      ]);
      if (s.key === 'totalProject') {
        card.style.cursor = 'pointer';
        card.title = 'Buka daftar project';
        card.addEventListener('click', () => { location.hash = '#/project'; });
      }
      cardsByKey[s.key] = { valueEl, suffix: s.suffix || '' };
      grid.appendChild(card);
    });
    container.appendChild(grid);

    const dashGrid = el('div', { class: 'dash-grid' });
    const activityCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Aktivitas Terbaru'])]),
      el('div', { id: 'dash-activity-list' }, [el('p', { class: 'text-muted' }, ['Memuat...'])]),
    ]);
    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Progress Coverage per Area'])]),
      (() => { const c = el('canvas', { id: 'dash-coverage-chart', height: '220' }); return c; })(),
    ]);
    dashGrid.appendChild(activityCard);
    dashGrid.appendChild(chartCard);
    container.appendChild(dashGrid);

    // Ambil statistik dari Supabase. Nama tabel mengikuti skema modul lanjutan
    // (projects, areas, homes/rumah, poles/tiang, odc, odp). Jika tabel belum
    // ada (fase awal), tampilkan 0 tanpa error mengganggu tampilan.
    const stats = await loadDashboardStats();
    Object.entries(stats).forEach(([k, v]) => {
      if (cardsByKey[k]) cardsByKey[k].valueEl.textContent = fmtNumber(v) + cardsByKey[k].suffix;
    });

    renderActivityList();
    renderCoverageChart();
    try { await injectPlanningDashboard(container); } catch (e) { /* aman bila migration 007 belum dijalankan */ }
    try { await injectBuildingCategories(container); } catch (e) { /* aman bila migration 008 belum dijalankan */ }
    try { await injectAssetManagementDashboard(container); } catch (e) { /* aman bila migration 011 belum dijalankan */ }
  });

  async function loadDashboardStats() {
    const tables = {
      totalArea: 'areas', totalRumah: 'homes',
      totalTiang: 'poles', totalOdc: 'odc', totalOdp: 'odp',
    };
    const result = { coveragePercent: 0, surveyProgressPercent: 0 };
    // "Total Project" selalu lintas-project (menghitung semua project yang ada).
    try {
      const { count } = await App.supabase.from('projects').select('*', { count: 'exact', head: true });
      result.totalProject = count || 0;
    } catch (e) { result.totalProject = 0; }
    // FIX #E5: sisanya di-scope ke Project Aktif (kalau ada yang dipilih) supaya
    // ganti project baru -> semua angka balik ke 0 untuk project itu.
    await Promise.all(Object.entries(tables).map(async ([statKey, table]) => {
      try {
        let q = App.supabase.from(table).select('*', { count: 'exact', head: true });
        q = scopeToProject(q, table);
        const { count, error } = await q;
        result[statKey] = error ? 0 : (count || 0);
      } catch (e) { result[statKey] = 0; }
    }));
    if (result.totalRumah) {
      try {
        const cov = await computeCoverage();
        result.coveragePercent = cov.percent;
      } catch (e) {
        // Tabel odp/homes belum tersedia atau error lain — biarkan 0, tidak mengganggu tampilan.
      }
    }
    return result;
  }

  function renderActivityList() {
    const listEl = $('#dash-activity-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    listEl.appendChild(el('div', { class: 'empty-state' }, [
      el('i', { class: 'fa-solid fa-clock-rotate-left' }),
      el('div', {}, ['Log aktivitas akan tersedia pada modul Notifikasi/Audit (Fase 5).']),
    ]));
  }

  function renderCoverageChart() {
    const canvas = $('#dash-coverage-chart');
    if (!canvas || !window.Chart) return;
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: ['Belum ada data area'],
        datasets: [{ label: 'Coverage %', data: [0], backgroundColor: '#1F3A5F' }],
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } },
    });
  }

  /* ================= [MAPPING] PETA + IMPORT ================= */
  registerModule('mapping', async function renderMapping(container) {
    container.innerHTML = '';
    // Toolbar halaman
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => openImportDialog() }, [
        el('i', { class: 'fa-solid fa-file-import' }), ' Import Data',
      ]),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => locateUser() }, [
        el('i', { class: 'fa-solid fa-location-crosshairs' }), ' Lokasi Saya',
      ]),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => drawGeometryOnMap('polygon', (geo) => showDrawnGeometryToast(geo, 'Area')) }, [
        el('i', { class: 'fa-solid fa-draw-polygon' }), ' Gambar Polygon',
      ]),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => drawGeometryOnMap('polyline', (geo) => showDrawnGeometryToast(geo, 'Kabel/Backbone/Distribution')) }, [
        el('i', { class: 'fa-solid fa-slash' }), ' Gambar Garis',
      ]),
      // Smart Planning — Analisa Area (Implementation 02 Phase 1), additive.
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => App.runAreaAnalysis && App.runAreaAnalysis(null) }, [
        el('i', { class: 'fa-solid fa-wand-magic-sparkles' }), ' Analisa Area',
      ]),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => toggleMeasureTool() }, [
        el('i', { class: 'fa-solid fa-ruler' }), ' Ukur Jarak/Area',
      ]),
    ]));

    const layout = el('div', { class: 'map-page-layout' });
    const mapWrap = el('div', { id: 'map-container', style: 'position:relative;' });
    const sidePanel = el('div', { class: 'map-side-panel' }, [
      el('h4', { class: 'section-title' }, ['Layer']),
      el('div', { id: 'layer-list' }, [el('p', { class: 'text-muted' }, ['Belum ada layer. Import data untuk memulai.'])]),
    ]);
    layout.appendChild(mapWrap);
    layout.appendChild(sidePanel);
    container.appendChild(layout);

    initMap(mapWrap);
    refreshLayerList(); // FIX #E6: tampilkan folder Aset FTTH begitu halaman Mapping dibuka (bukan cuma setelah import)
  }, function destroyMapping() {
    if (App.map) { App.map.remove(); App.map = null; }
    App.mapLayers = {};
    App.assetLayerGroups = {}; // FIX #E6: layer aset terikat ke instance peta lama, harus dibuat ulang saat halaman Mapping dibuka lagi
  });

  function initMap(mapWrap) {
    App.map = L.map(mapWrap, { zoomControl: false }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
    L.control.zoom({ position: 'bottomright' }).addTo(App.map);

    const baseLayers = {
      'Jalan (OSM)': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxZoom: 20,
      }),
      'Satelit (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri', maxZoom: 20,
      }),
    };
    const initialBase = CFG.MAP_PROVIDER === 'satellite' ? baseLayers['Satelit (Esri)'] : baseLayers['Jalan (OSM)'];
    initialBase.addTo(App.map);
    L.control.layers(baseLayers, {}, { position: 'topright' }).addTo(App.map);

    // Toolbar float kiri-atas
    const floatBar = el('div', { class: 'map-toolbar-float' }, [
      el('button', { class: 'icon-btn', title: 'Perbesar', onclick: () => App.map.zoomIn() }, [el('i', { class: 'fa-solid fa-plus' })]),
      el('button', { class: 'icon-btn', title: 'Perkecil', onclick: () => App.map.zoomOut() }, [el('i', { class: 'fa-solid fa-minus' })]),
    ]);
    mapWrap.appendChild(floatBar);

    // Context menu (klik kanan) — additive: opsi "Analisa Area".
    const ctxMenu = el('div', { class: 'card', style: 'position:absolute;z-index:1200;display:none;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.18);' });
    const ctxItem = el('button', { class: 'btn btn-ghost btn-sm', style: 'width:100%;justify-content:flex-start;' }, [
      el('i', { class: 'fa-solid fa-wand-magic-sparkles' }), ' Analisa Area',
    ]);
    ctxItem.addEventListener('click', () => { ctxMenu.style.display = 'none'; if (App.runAreaAnalysis) App.runAreaAnalysis(null); });
    ctxMenu.appendChild(ctxItem);
    mapWrap.appendChild(ctxMenu);
    App.map.on('contextmenu', (e) => {
      const p = e.containerPoint;
      ctxMenu.style.left = p.x + 'px'; ctxMenu.style.top = p.y + 'px'; ctxMenu.style.display = 'block';
    });
    App.map.on('click movestart', () => { ctxMenu.style.display = 'none'; });
  }

  function locateUser() {
    if (!navigator.geolocation) { toast('Geolocation tidak didukung browser ini.', 'warning'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        App.map.setView([latitude, longitude], 16);
        L.marker([latitude, longitude]).addTo(App.map).bindPopup('Lokasi Anda').openPopup();
      },
      () => toast('Gagal mendapatkan lokasi. Periksa izin lokasi browser.', 'error')
    );
  }

  // ---- Measurement Tool (jarak & area) — menutup celah FINAL_AUDIT_REPORT.md ----
  // Klik berturut-turut di peta untuk menambah titik; jarak berjalan & (bila
  // ≥3 titik) luas ditampilkan live di tooltip mengambang. Klik tombol lagi
  // atau tombol "Selesai" pada tooltip untuk mengakhiri sesi ukur.
  App._measure = null;
  function toggleMeasureTool() {
    if (App._measure) { stopMeasureTool(); return; }
    if (!App.map) { toast('Buka halaman Mapping dahulu.', 'warning'); return; }
    const t = window.turf;
    if (!t) { toast('Turf.js belum termuat.', 'error'); return; }
    const pts = [];
    const line = L.polyline([], { color: '#B3261E', weight: 3, dashArray: '6,6' }).addTo(App.map);
    const markers = L.layerGroup().addTo(App.map);
    const label = L.control({ position: 'bottomleft' });
    label.onAdd = function () {
      const div = L.DomUtil.create('div', 'card');
      div.id = 'measure-readout';
      div.style.cssText = 'padding:8px 12px;font-size:12px;box-shadow:var(--shadow-md);';
      div.innerHTML = 'Klik di peta untuk mulai mengukur. Klik tombol "Ukur Jarak/Area" lagi untuk selesai.';
      return div;
    };
    label.addTo(App.map);
    function updateReadout() {
      const div = document.getElementById('measure-readout'); if (!div) return;
      if (pts.length < 2) { div.innerHTML = 'Titik: ' + pts.length + ' — klik lagi untuk menambah.'; return; }
      let distM = 0;
      try { distM = t.length(t.lineString(pts), { units: 'kilometers' }) * 1000; } catch (e) {}
      let areaTxt = '';
      if (pts.length >= 3) {
        try { const ring = pts.concat([pts[0]]); const areaM2 = t.area(t.polygon([ring])); areaTxt = ' | Luas ≈ ' + fmtNumber(Math.round(areaM2)) + ' m² (' + (areaM2 / 1e6).toFixed(4) + ' km²)'; } catch (e) {}
      }
      div.innerHTML = 'Jarak ≈ ' + fmtNumber(Math.round(distM)) + ' m' + areaTxt + ' — <b>' + pts.length + ' titik</b>';
    }
    const clickHandler = (e) => {
      pts.push([e.latlng.lng, e.latlng.lat]);
      line.setLatLngs(pts.map((p) => [p[1], p[0]]));
      markers.addLayer(L.circleMarker(e.latlng, { radius: 4, color: '#B3261E', fillOpacity: 1 }));
      updateReadout();
    };
    App.map.on('click', clickHandler);
    App._measure = { line, markers, label, clickHandler };
    toast('Mode ukur aktif. Klik di peta untuk menambah titik.', 'info', 4000);
  }
  function stopMeasureTool() {
    const M = App._measure; if (!M) return;
    try { App.map.off('click', M.clickHandler); App.map.removeLayer(M.line); App.map.removeLayer(M.markers); App.map.removeControl(M.label); } catch (e) {}
    App._measure = null;
    toast('Mode ukur dimatikan.', 'info');
  }

  // ---- Gambar Polygon/Garis di peta (leaflet.draw) --------------------
  // Dipakai oleh: (a) toolbar halaman Mapping (gambar bebas + toast info),
  // (b) form Area/Backbone/Distribution/Kabel (gambar lalu simpan ke DB).
  // shapeType: 'polygon' | 'polyline'
  // onComplete(geojsonGeometry, layer) dipanggil sekali setelah user selesai
  // menggambar (double-click / klik titik awal lagi, sesuai leaflet.draw).
  // FIX #E4: sebelumnya, saat form CRUD (mis. "Tambah Rumah") memanggil
  // pickLocationOnMap/drawGeometryOnMap, modal TIDAK ditutup — overlay modal
  // (fixed, full-screen) tetap menutupi peta sehingga user tidak bisa klik
  // peta sama sekali (atau klik area gelap malah menutup form tanpa memilih
  // lokasi). Helper ini menyembunyikan sementara overlay yang sedang terbuka
  // (tanpa menghapus DOM-nya — semua isian form tetap tersimpan), lalu
  // menampilkannya kembali begitu user selesai memilih lokasi/menggambar.
  function hideOpenModalsForMapPick() {
    const modalRoot = $('#modal-root');
    const overlays = $all('.modal-overlay', modalRoot);
    overlays.forEach((o) => { o.dataset.prevDisplay = o.style.display || ''; o.style.display = 'none'; });
    if (overlays.length) modalRoot.style.pointerEvents = 'none';
    return function restoreModals() {
      overlays.forEach((o) => { o.style.display = o.dataset.prevDisplay || ''; });
      if (overlays.length) modalRoot.style.pointerEvents = 'auto';
    };
  }

  function drawGeometryOnMap(shapeType, onComplete) {
    const restoreModals = hideOpenModalsForMapPick();
    toast('Gambar di peta, lalu klik titik awal lagi (atau double-click) untuk menyelesaikan. Form akan muncul kembali otomatis.', 'info', 4500);
    location.hash = '#/mapping';
    const tryStart = () => {
      if (!App.map) { setTimeout(tryStart, 200); return; }
      const Handler = shapeType === 'polygon' ? L.Draw.Polygon : L.Draw.Polyline;
      const drawer = new Handler(App.map, shapeType === 'polygon'
        ? { shapeOptions: { color: '#1F3A5F', weight: 2 } }
        : { shapeOptions: { color: '#0B6E99', weight: 3 } });
      drawer.enable();
      const onCreated = (e) => {
        App.map.off(L.Draw.Event.CREATED, onCreated);
        const layer = e.layer;
        layer.addTo(App.map);
        const geojson = layer.toGeoJSON();
        restoreModals();
        onComplete(geojson.geometry, layer);
      };
      App.map.on(L.Draw.Event.CREATED, onCreated);
    };
    setTimeout(tryStart, 250);
  }

  function showDrawnGeometryToast(geometry, label) {
    const n = geometry && geometry.coordinates
      ? (geometry.type === 'Polygon' ? geometry.coordinates[0].length : geometry.coordinates.length)
      : 0;
    toast(label + ' berhasil digambar (' + n + ' titik).', 'success');
  }

  // Konversi geometry GeoJSON (Polygon/LineString) -> EWKT untuk kolom PostGIS.
  // PostGIS mendaftarkan cast text->geometry lewat ST_GeomFromText, sehingga
  // string EWKT ini bisa langsung di-insert/update lewat Supabase (PostgREST)
  // tanpa perlu RPC tambahan.
  function geometryToWKT(geometry) {
    if (!geometry || !geometry.coordinates) return null;
    const ring = (coords) => coords.map((c) => c[0] + ' ' + c[1]).join(', ');
    if (geometry.type === 'Polygon') {
      const outer = geometry.coordinates[0];
      return 'SRID=4326;POLYGON((' + ring(outer) + '))';
    }
    if (geometry.type === 'LineString') {
      return 'SRID=4326;LINESTRING(' + ring(geometry.coordinates) + ')';
    }
    return null;
  }

  function openImportDialog() {
    const overlay = openModal(buildImportForm(), { size: 'md' });
  }

  function buildImportForm() {
    const wrap = el('div');
    const fileInput = el('input', { type: 'file', id: 'import-file-input', accept: '.kmz,.kml,.geojson,.json,.zip' });
    const statusEl = el('div', { class: 'text-muted', style: 'margin-top:10px;' }, ['Format didukung: KMZ, KML, GeoJSON, SHP (dalam .zip).']);
    const body = el('div', { class: 'modal-body' }, [
      el('div', { class: 'form-field full' }, [
        el('label', {}, ['Pilih File']),
        fileInput,
      ]),
      statusEl,
    ]);
    const footer = el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn btn-ghost', onclick: (e) => closeModal(overlayRef) }, ['Batal']),
      el('button', { class: 'btn btn-primary', onclick: () => runImport(fileInput, statusEl, () => closeModal(overlayRef)) }, ['Import']),
    ]);
    wrap.appendChild(el('div', { class: 'modal-header' }, [
      el('h3', {}, ['Import Data Spasial']),
      el('button', { class: 'icon-btn', onclick: () => closeModal(overlayRef) }, [el('i', { class: 'fa-solid fa-xmark' })]),
    ]));
    wrap.appendChild(body);
    wrap.appendChild(footer);
    var overlayRef; // di-set setelah openModal memanggil (lihat openImportDialog)
    setTimeout(() => { overlayRef = wrap.closest('.modal-overlay'); }, 0);
    return wrap;
  }

  async function runImport(fileInput, statusEl, onDone) {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { statusEl.textContent = 'Pilih file terlebih dahulu.'; return; }
    statusEl.textContent = 'Memproses "' + file.name + '"...';
    const ext = file.name.split('.').pop().toLowerCase();
    try {
      let geojson = null;
      if (ext === 'geojson' || ext === 'json') {
        geojson = JSON.parse(await file.text());
      } else if (ext === 'kml') {
        const xml = new DOMParser().parseFromString(await file.text(), 'text/xml');
        geojson = toGeoJSON.kml(xml);
      } else if (ext === 'kmz') {
        const zip = await JSZip.loadAsync(file);
        const kmlEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
        if (!kmlEntry) throw new Error('File .kml tidak ditemukan di dalam KMZ.');
        const kmlText = await kmlEntry.async('text');
        const xml = new DOMParser().parseFromString(kmlText, 'text/xml');
        geojson = toGeoJSON.kml(xml);
      } else if (ext === 'zip') {
        // Diasumsikan Shapefile (.shp/.dbf/.shx dalam satu .zip)
        const buffer = await file.arrayBuffer();
        geojson = await shp(buffer);
      } else {
        throw new Error('Format file tidak didukung: .' + ext);
      }
      addGeoJsonLayer(file.name, geojson);
      statusEl.textContent = 'Berhasil mengimpor ' + (geojson.features ? geojson.features.length : 0) + ' fitur.';
      toast('Import "' + file.name + '" berhasil.', 'success');
      setTimeout(onDone, 700);
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Gagal import: ' + err.message;
      toast('Import gagal: ' + err.message, 'error');
    }
  }

  function addGeoJsonLayer(name, geojson) {
    if (!App.map) return;
    const color = randomLayerColor();
    const layer = L.geoJSON(geojson, {
      style: { color, weight: 2, fillOpacity: 0.15 },
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 6, color, fillColor: color, fillOpacity: 0.8 }),
      onEachFeature: (feature, lyr) => {
        if (feature.properties) {
          const rows = Object.entries(feature.properties).slice(0, 12)
            .map(([k, v]) => `<tr><td style="padding:2px 8px 2px 0;color:var(--color-text-secondary)">${k}</td><td>${v}</td></tr>`).join('');
          lyr.bindPopup(`<table>${rows}</table>`);
        }
      },
    });
    const clusterGroup = L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup();
    layer.eachLayer((l) => { if (l instanceof L.CircleMarker || l instanceof L.Marker) clusterGroup.addLayer(l); });
    layer.addTo(App.map);
    App.mapLayers[name + '_' + Date.now()] = layer;
    try { App.map.fitBounds(layer.getBounds(), { maxZoom: 17 }); } catch (e) {}
    refreshLayerList();
  }

  function randomLayerColor() {
    const palette = ['#1F3A5F', '#0B6E99', '#1E7B4D', '#9A6700', '#B3261E', '#6B4FA0'];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  // FIX #E6 (Layer ala Google Earth): metadata folder per tipe aset — icon +
  // "keterangan" singkat yang tampil di bawah nama folder, seperti deskripsi
  // folder di Google Earth ("My Places"). Sumbernya sama dengan CFG.ASSET_DEFS.
  const ASSET_FOLDER_META = {
    areas: { icon: 'fa-draw-polygon', unit: 'polygon', desc: 'Batas area kerja/coverage.' },
    pops: { icon: 'fa-satellite-dish', unit: 'titik', desc: 'Point of Presence — sumber utama jaringan.' },
    odc: { icon: 'fa-server', unit: 'titik', desc: 'Optical Distribution Cabinet — splitter 1:4 dari POP.' },
    odp: { icon: 'fa-diagram-project', unit: 'titik', desc: 'Optical Distribution Point — splitter 1:8 ke rumah.' },
    homes: { icon: 'fa-house', unit: 'titik', desc: 'Rumah pelanggan/prospek homepass.' },
    poles: { icon: 'fa-tower-cell', unit: 'titik', desc: 'Tiang penopang jalur kabel.' },
    backbones: { icon: 'fa-route', unit: 'jalur', desc: 'Jalur backbone (POP ⟷ ODC).' },
    distributions: { icon: 'fa-share-nodes', unit: 'jalur', desc: 'Jalur distribution (ODC ⟷ ODP).' },
    kabels: { icon: 'fa-ethernet', unit: 'jalur', desc: 'Kabel drop / feeder lainnya.' },
    closures: { icon: 'fa-box-archive', unit: 'titik', desc: 'Sambungan/closure kabel fiber.' },
    handholes: { icon: 'fa-vault', unit: 'titik', desc: 'Handhole bawah tanah.' },
    jointboxes: { icon: 'fa-plug-circle-bolt', unit: 'titik', desc: 'Joint box sambungan kabel.' },
  };
  // Status expand/collapse folder (disimpan di memori tab; reset tiap reload — cukup untuk UX, tidak perlu tabel DB baru).
  const layerTreeState = { import: true, ftth: true, sub: {} };

  function toggleFolder(key) {
    if (key === 'import') layerTreeState.import = !layerTreeState.import;
    else if (key === 'ftth') layerTreeState.ftth = !layerTreeState.ftth;
    else layerTreeState.sub[key] = !layerTreeState.sub[key];
    refreshLayerList();
  }

  // Lazy-load 1 tipe aset (scoped ke Project Aktif) jadi layer group di peta, dipanggil
  // saat user centang folder-nya untuk pertama kali. Dipisah dari App.mapLayers (folder Import)
  // supaya "hapus layer import" tidak pernah tidak sengaja menghapus data aset dari DB.
  async function loadAssetTypeLayer(assetKey, def) {
    if (App.assetLayerGroups[assetKey]) return App.assetLayerGroups[assetKey];
    const color = randomLayerColor();
    const lg = window.L.markerClusterGroup && def.geometryType === 'point' ? L.markerClusterGroup() : L.layerGroup();
    try {
      let q = App.supabase.from(def.table).select('*').limit(2000);
      q = scopeToProject(q, def.table);
      const { data, error } = await q;
      if (error) throw error;
      (data || []).forEach((row) => {
        if (def.geometryType === 'point') {
          if (row.lat == null || row.lng == null) return;
          L.circleMarker([row.lat, row.lng], { radius: 6, color, fillColor: color, fillOpacity: 0.8 })
            .bindPopup('<b>' + def.title + '</b><br>' + (row.name || row.owner_name || row.code || row.id))
            .addTo(lg);
        } else {
          const raw = row[def.geometryColumn];
          if (!raw) return;
          try { L.geoJSON(raw, { style: { color, weight: def.geometryType === 'polygon' ? 2 : 3, fillOpacity: 0.12 } }).addTo(lg); } catch (e) {}
        }
      });
    } catch (e) { /* tabel belum ada / belum migrasi — folder tetap tampil tapi kosong */ }
    App.assetLayerGroups[assetKey] = lg;
    return lg;
  }

  // FIX #E8 (rename & custom folder, lanjutan "Layer ala Google Earth"):
  // - importFolders: folder BEBAS buatan user untuk mengelompokkan hasil import
  //   (mis. "Cluster A", "Rumah RW 04"). Hidup selama sesi/tab (hasil import
  //   sendiri memang tidak tersimpan ke DB, jadi wajar folder ini juga per-sesi).
  // - layerLabelOverrides: nama tampilan custom (rename) untuk layer import
  //   MAUPUN folder Aset FTTH — ini DIPERSIST ke localStorage supaya tidak
  //   hilang tiap reload (mis. rename folder "ODP" jadi "ODP Fiberhome").
  const importFolders = [];               // [{ id, name }]
  const importFolderAssign = {};          // layerKey -> folderId
  let layerLabelOverrides = {};
  try { layerLabelOverrides = JSON.parse(localStorage.getItem('ma_layer_label_overrides') || '{}'); } catch (e) { layerLabelOverrides = {}; }
  function saveLabelOverrides() { try { localStorage.setItem('ma_layer_label_overrides', JSON.stringify(layerLabelOverrides)); } catch (e) {} }
  function labelFor(key, fallback) { return layerLabelOverrides[key] || fallback; }
  function renameLabel(key, fallback) {
    const current = labelFor(key, fallback);
    const next = window.prompt('Ganti nama menjadi:', current);
    if (next === null) return; // dibatalkan
    const trimmed = next.trim();
    if (!trimmed) { toast('Nama tidak boleh kosong.', 'warning'); return; }
    layerLabelOverrides[key] = trimmed;
    saveLabelOverrides();
    refreshLayerList();
  }
  function createImportFolder() {
    const name = window.prompt('Nama folder baru (mis. "Cluster A", "Rumah RW 04"):', '');
    if (!name || !name.trim()) return;
    importFolders.push({ id: 'f' + Date.now(), name: name.trim() });
    refreshLayerList();
  }
  function renameImportFolder(folder) {
    const next = window.prompt('Ganti nama folder menjadi:', folder.name);
    if (next === null) return;
    if (!next.trim()) { toast('Nama folder tidak boleh kosong.', 'warning'); return; }
    folder.name = next.trim();
    refreshLayerList();
  }
  function deleteImportFolder(folder) {
    Object.keys(importFolderAssign).forEach((k) => { if (importFolderAssign[k] === folder.id) delete importFolderAssign[k]; });
    const idx = importFolders.findIndex((f) => f.id === folder.id);
    if (idx > -1) importFolders.splice(idx, 1);
    refreshLayerList();
  }

  async function refreshLayerList() {
    const listEl = $('#layer-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const tree = el('div', { class: 'layer-tree' });

    // ---- FOLDER 1: Data Import (KMZ/KML/GeoJSON/SHP) — dengan rename & folder custom ----
    const importKeys = Object.keys(App.mapLayers);
    const importBody = el('div', { class: 'layer-folder-body' + (layerTreeState.import ? '' : ' hidden') });

    function renderImportItem(key) {
      const label = labelFor('import:' + key, key.split('_')[0]);
      const folderOptions = [el('option', { value: '' }, ['Tanpa Folder']), ...importFolders.map((f) => el('option', { value: f.id }, [f.name]))];
      const moveSelect = el('select', { class: 'text-input', style: 'font-size:11px;padding:3px 4px;max-width:110px;', title: 'Pindahkan ke folder' }, folderOptions);
      moveSelect.value = importFolderAssign[key] || '';
      moveSelect.addEventListener('change', () => {
        if (moveSelect.value) importFolderAssign[key] = moveSelect.value; else delete importFolderAssign[key];
        refreshLayerList();
      });
      return el('div', { class: 'layer-item' }, [
        el('input', { type: 'checkbox', checked: 'checked', onchange: (e) => {
          const layer = App.mapLayers[key];
          if (e.target.checked) App.map.addLayer(layer); else App.map.removeLayer(layer);
        } }),
        el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, [label]),
        moveSelect,
        el('button', { class: 'icon-btn btn-icon-only', title: 'Rename', style: 'width:24px;height:24px;', onclick: () => renameLabel('import:' + key, key.split('_')[0]) }, [el('i', { class: 'fa-solid fa-pen', style: 'font-size:10px' })]),
        el('button', { class: 'icon-btn btn-icon-only', title: 'Hapus dari peta', style: 'width:24px;height:24px;', onclick: () => {
          App.map.removeLayer(App.mapLayers[key]);
          delete App.mapLayers[key]; delete importFolderAssign[key];
          refreshLayerList();
        } }, [el('i', { class: 'fa-solid fa-trash', style: 'font-size:11px' })]),
      ]);
    }

    if (!importKeys.length) {
      importBody.appendChild(el('p', { class: 'text-xs text-muted', style: 'padding:4px 8px;' }, ['Belum ada file diimport.']));
    } else {
      // Folder custom dulu (kalau ada), baru item yang belum masuk folder mana pun.
      importFolders.forEach((folder) => {
        const memberKeys = importKeys.filter((k) => importFolderAssign[k] === folder.id);
        const expanded = !!layerTreeState.sub['imp:' + folder.id];
        importBody.appendChild(el('div', { class: 'layer-folder layer-subfolder' }, [
          el('div', { class: 'layer-folder-header' }, [
            el('i', { class: 'fa-solid ' + (expanded ? 'fa-chevron-down' : 'fa-chevron-right'), style: 'width:12px;font-size:10px;cursor:pointer;', onclick: () => toggleFolder('imp:' + folder.id) }),
            el('i', { class: 'fa-solid fa-folder', style: 'color:#C9A227;' }),
            el('span', { style: 'flex:1;' }, [folder.name]),
            el('span', { class: 'text-xs text-muted' }, ['(' + memberKeys.length + ')']),
            el('button', { class: 'icon-btn btn-icon-only', title: 'Rename folder', style: 'width:22px;height:22px;', onclick: () => renameImportFolder(folder) }, [el('i', { class: 'fa-solid fa-pen', style: 'font-size:10px' })]),
            el('button', { class: 'icon-btn btn-icon-only', title: 'Hapus folder (isi kembali ke Tanpa Folder)', style: 'width:22px;height:22px;', onclick: () => deleteImportFolder(folder) }, [el('i', { class: 'fa-solid fa-trash', style: 'font-size:10px' })]),
          ]),
          el('div', { class: 'layer-folder-body' + (expanded ? '' : ' hidden') }, memberKeys.length ? memberKeys.map(renderImportItem) : [el('p', { class: 'text-xs text-muted', style: 'padding:4px 8px;' }, ['Folder kosong — pindahkan layer ke sini lewat dropdown di tiap item.'])]),
        ]));
      });
      const unassigned = importKeys.filter((k) => !importFolderAssign[k]);
      unassigned.forEach((key) => importBody.appendChild(renderImportItem(key)));
    }
    tree.appendChild(el('div', { class: 'layer-folder' }, [
      el('div', { class: 'layer-folder-header' }, [
        el('i', { class: 'fa-solid ' + (layerTreeState.import ? 'fa-chevron-down' : 'fa-chevron-right'), style: 'width:12px;font-size:10px;cursor:pointer;', onclick: () => toggleFolder('import') }),
        el('i', { class: 'fa-solid fa-folder-open', style: 'color:#C9A227;' }),
        el('span', { style: 'font-weight:600;flex:1;' }, ['Data Import']),
        el('span', { class: 'text-xs text-muted' }, ['(' + importKeys.length + ')']),
        el('button', { class: 'icon-btn btn-icon-only', title: 'Buat folder baru', style: 'width:24px;height:24px;', onclick: createImportFolder }, [el('i', { class: 'fa-solid fa-folder-plus', style: 'font-size:11px' })]),
      ]),
      el('p', { class: 'text-xs text-muted layer-folder-desc' }, ['Hasil import KMZ/KML/GeoJSON/SHP — bebas dikelompokkan ke folder sendiri, tidak tersimpan ke database.']),
      importBody,
    ]));

    // ---- FOLDER 2: Aset FTTH (per tipe, scoped ke Project Aktif, keterangan per folder) ----
    const ftthBody = el('div', { class: 'layer-folder-body' + (layerTreeState.ftth ? '' : ' hidden') });
    const scopeNote = App.currentProjectId ? ('Project: ' + (App.currentProjectName || '—')) : 'Semua Project (belum pilih Project Aktif)';
    const metaEntries = Object.entries(CFG.ASSET_DEFS);
    // Ambil jumlah baris tiap tipe sekali jalan (query ringan, head:true) supaya folder punya "keterangan" jumlah data.
    const counts = {};
    await Promise.all(metaEntries.map(async ([key, def]) => {
      try {
        let q = App.supabase.from(def.table).select('*', { count: 'exact', head: true });
        q = scopeToProject(q, def.table);
        const { count } = await q;
        counts[key] = count || 0;
      } catch (e) { counts[key] = 0; }
    }));
    metaEntries.forEach(([key, def]) => {
      const meta = ASSET_FOLDER_META[key] || { icon: 'fa-layer-group', unit: '', desc: '' };
      const displayTitle = labelFor('asset:' + key, def.title);
      const expanded = !!layerTreeState.sub[key];
      const checked = !!(App.assetLayerGroups[key] && App.map && App.map.hasLayer(App.assetLayerGroups[key]));
      const subBody = el('div', { class: 'layer-folder-body' + (expanded ? '' : ' hidden') }, [
        el('p', { class: 'text-xs text-muted layer-folder-desc' }, [meta.desc]),
      ]);
      ftthBody.appendChild(el('div', { class: 'layer-folder layer-subfolder' }, [
        el('div', { class: 'layer-folder-header' }, [
          el('i', { class: 'fa-solid ' + (expanded ? 'fa-chevron-down' : 'fa-chevron-right'), style: 'width:12px;font-size:10px;cursor:pointer;', onclick: () => toggleFolder(key) }),
          el('input', { type: 'checkbox', checked: checked ? 'checked' : null, title: 'Tampilkan/sembunyikan di peta', onchange: async (e) => {
            const lg = await loadAssetTypeLayer(key, def);
            if (e.target.checked) App.map.addLayer(lg); else App.map.removeLayer(lg);
          } }),
          el('i', { class: 'fa-solid ' + meta.icon }),
          el('span', { style: 'flex:1;' }, [displayTitle]),
          el('span', { class: 'text-xs text-muted' }, ['(' + fmtNumber(counts[key]) + ' ' + meta.unit + ')']),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Rename folder', style: 'width:22px;height:22px;', onclick: () => renameLabel('asset:' + key, def.title) }, [el('i', { class: 'fa-solid fa-pen', style: 'font-size:10px' })]),
        ]),
        subBody,
      ]));
    });
    tree.appendChild(el('div', { class: 'layer-folder' }, [
      el('div', { class: 'layer-folder-header', onclick: () => toggleFolder('ftth') }, [
        el('i', { class: 'fa-solid ' + (layerTreeState.ftth ? 'fa-chevron-down' : 'fa-chevron-right'), style: 'width:12px;font-size:10px;' }),
        el('i', { class: 'fa-solid fa-folder-open', style: 'color:#1F3A5F;' }),
        el('span', { style: 'font-weight:600;' }, ['Aset FTTH']),
      ]),
      el('p', { class: 'text-xs text-muted layer-folder-desc' }, [scopeNote + ' — centang folder untuk tampilkan tipe aset di peta.']),
      ftthBody,
    ]));

    listEl.appendChild(tree);
  }

  /* ================= [ASSETS] GENERIC CRUD MODULE FACTORY (FASE 2) ================= */
  // Satu factory dipakai untuk seluruh modul inventaris/jaringan (Area, Rumah,
  // Tiang, POP, ODC, ODP, Backbone, Distribution, Kabel, Closure, Handhole,
  // Joint Box, Project) — definisi field ada di config.js (ASSET_DEFS),
  // sehingga menambah/mengubah kolom tidak perlu menyentuh logika di bawah ini.

  function createAssetModule(assetKey, def) {
    const state = { page: 1, pageSize: CFG.PERFORMANCE.PAGE_SIZE, search: '', total: 0, rows: [] };

    registerModule(assetKey, async function render(container) {
      container.innerHTML = '';
      $('#page-toolbar').innerHTML = '';
      $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
        el('div', { class: 'topbar-search', style: 'max-width:260px;' }, [
          el('i', { class: 'fa-solid fa-magnifying-glass' }),
          el('input', {
            placeholder: 'Cari ' + def.title.toLowerCase() + '...',
            oninput: debounce((e) => { state.search = e.target.value; state.page = 1; loadAndRenderTable(); }, 300),
          }),
        ]),
        el('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:auto;', onclick: () => openAssetForm(null) }, [
          el('i', { class: 'fa-solid fa-plus' }), ' Tambah ' + def.title,
        ]),
      ]));

      const tableWrap = el('div', { class: 'table-wrap', id: assetKey + '-table-wrap' });
      container.appendChild(tableWrap);
      await loadAndRenderTable();
    }, function destroy() { /* tidak ada resource khusus untuk dibersihkan */ });

    async function loadAndRenderTable() {
      const wrap = $('#' + assetKey + '-table-wrap');
      if (!wrap) return;
      wrap.innerHTML = '<div class="skeleton" style="height:160px;"></div>';
      const from = (state.page - 1) * state.pageSize;
      const to = from + state.pageSize - 1;
      let query = App.supabase.from(def.table).select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
      query = scopeToProject(query, def.table);
      const nameField = def.fields.find((f) => f.type === 'text')?.key || 'name';
      if (state.search) query = query.ilike(nameField, `%${state.search}%`);

      const { data, error, count } = await query;
      if (error) {
        wrap.innerHTML = '';
        wrap.appendChild(el('div', { class: 'empty-state' }, [
          el('i', { class: 'fa-solid fa-database' }),
          el('div', {}, ['Tabel "' + def.table + '" belum tersedia di Supabase.']),
          el('div', { class: 'text-xs text-muted' }, ['Jalankan SQL migration Fase 2 terlebih dahulu (lihat file supabase_schema/002_assets.sql).']),
        ]));
        return;
      }
      state.rows = data || [];
      state.total = count || 0;

      // Hitung info splitter (ODC/ODP) bila relevan — dilakukan per-baris agar
      // tidak perlu N+1 query berat pada dataset besar (dibatasi per halaman).
      let childCounts = {};
      if (def.splitter && state.rows.length) {
        const ids = state.rows.map((r) => r.id);
        const { data: childRows } = await App.supabase.from(def.splitter.childTable).select(def.splitter.parentKey).in(def.splitter.parentKey, ids);
        (childRows || []).forEach((c) => {
          const pid = c[def.splitter.parentKey];
          childCounts[pid] = (childCounts[pid] || 0) + 1;
        });
      }

      wrap.innerHTML = '';
      const table = el('table', { class: 'data-table' });
      const headCols = def.fields.filter((f) => f.type !== 'textarea').map((f) => f.label);
      if (def.splitter) headCols.push('Splitter');
      headCols.push('Aksi');
      table.appendChild(el('thead', {}, [el('tr', {}, headCols.map((h) => el('th', {}, [h])))]));

      const tbody = el('tbody');
      if (!state.rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { colspan: String(headCols.length) }, [
          el('div', { class: 'empty-state' }, [el('i', { class: 'fa-solid fa-inbox' }), el('div', {}, ['Belum ada data ' + def.title.toLowerCase() + '.'])]),
        ])]));
      }
      state.rows.forEach((row) => {
        const cells = def.fields.filter((f) => f.type !== 'textarea').map((f) => {
          let val = row[f.key];
          if (f.type === 'relation') val = row['_' + f.key + '_label'] || val || '-';
          return el('td', {}, [val !== null && val !== undefined ? String(val) : '-']);
        });
        if (def.splitter) {
          const used = childCounts[row.id] || 0;
          const ratio = CFG.SPLITTER[def.splitter.ratioKey];
          const over = used > ratio;
          cells.push(el('td', {}, [
            el('span', { class: `badge ${over ? 'badge-danger' : 'badge-success'}` }, [`${used}/${ratio} ${def.splitter.childLabel}`]),
          ]));
        }
        cells.push(el('td', {}, [
          el('button', { class: 'icon-btn btn-icon-only', title: 'Edit', onclick: () => openAssetForm(row) }, [el('i', { class: 'fa-solid fa-pen', style: 'font-size:12px' })]),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Lihat di Peta', onclick: () => showOnMap(row) }, [el('i', { class: 'fa-solid fa-location-dot', style: 'font-size:12px' })]),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Hapus', onclick: () => deleteAsset(row) }, [el('i', { class: 'fa-solid fa-trash', style: 'font-size:12px;color:var(--color-danger)' })]),
        ]));
        tbody.appendChild(el('tr', {}, cells));
      });
      table.appendChild(tbody);
      wrap.appendChild(table);

      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      wrap.appendChild(el('div', { class: 'table-pagination' }, [
        el('span', {}, [`Total ${fmtNumber(state.total)} data — Halaman ${state.page}/${totalPages}`]),
        el('button', { class: 'btn btn-ghost btn-sm', disabled: state.page <= 1 ? 'disabled' : null, onclick: () => { state.page--; loadAndRenderTable(); } }, ['Sebelumnya']),
        el('button', { class: 'btn btn-ghost btn-sm', disabled: state.page >= totalPages ? 'disabled' : null, onclick: () => { state.page++; loadAndRenderTable(); } }, ['Berikutnya']),
      ]));
    }

    async function openAssetForm(existingRow) {
      const isEdit = !!existingRow;
      const formEl = el('form', { class: 'form-grid' });
      const inputRefs = {};

      for (const f of def.fields) {
        const wrap = el('div', { class: `form-field ${f.type === 'textarea' ? 'full' : ''}` });
        wrap.appendChild(el('label', {}, [f.label + (f.required ? ' *' : '')]));
        let input;
        if (f.type === 'select') {
          const options = [el('option', { value: '' }, ['- pilih -'])].concat(
            f.options.map((opt) => el('option', { value: opt }, [opt]))
          );
          input = el('select', { class: 'text-input' }, options);
        } else if (f.type === 'textarea') {
          input = el('textarea', { class: 'text-input', rows: '3' });
        } else if (f.type === 'relation') {
          input = el('select', { class: 'text-input' }, [el('option', { value: '' }, ['- pilih ' + f.relationTable + ' -'])]);
          App.supabase.from(f.relationTable).select('id, ' + f.relationLabel).limit(500).then(({ data }) => {
            (data || []).forEach((opt) => input.appendChild(el('option', { value: opt.id }, [opt[f.relationLabel]])));
            if (existingRow && existingRow[f.key]) input.value = existingRow[f.key];
          });
        } else {
          input = el('input', { class: 'text-input', type: f.type === 'number' ? 'number' : 'text', step: f.type === 'number' ? 'any' : null });
        }
        if (f.required) input.setAttribute('required', 'required');
        if (existingRow && f.type !== 'relation' && existingRow[f.key] !== undefined && existingRow[f.key] !== null) {
          input.value = existingRow[f.key];
        }
        inputRefs[f.key] = input;
        wrap.appendChild(input);
        formEl.appendChild(wrap);
      }

      if (def.geometryType === 'point') {
        const pickBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'grid-column:1/-1;width:fit-content;' }, [
          el('i', { class: 'fa-solid fa-map-location-dot' }), ' Pilih Lokasi di Peta',
        ]);
        pickBtn.addEventListener('click', () => pickLocationOnMap((lat, lng) => {
          inputRefs.lat.value = lat.toFixed(6);
          inputRefs.lng.value = lng.toFixed(6);
        }));
        formEl.appendChild(pickBtn);
      }

      // geomState.value menampung geometry GeoJSON hasil gambar (Polygon/LineString)
      // untuk Area/Backbone/Distribution/Kabel. Jika edit dan tidak digambar ulang,
      // geometry lama di database tetap dipakai (tidak dikirim ulang ke payload).
      const geomState = { value: null };
      if (def.geometryType === 'polygon' || def.geometryType === 'line') {
        const hasExistingGeom = isEdit && existingRow && existingRow[def.geometryColumn];
        const geomStatus = el('span', { class: 'text-xs text-muted', style: 'margin-left:10px;' }, [
          hasExistingGeom ? 'Geometri sudah ada. Gambar ulang untuk mengganti.' : 'Belum digambar.',
        ]);
        const drawBtn = el('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'grid-column:1/-1;width:fit-content;' }, [
          el('i', { class: def.geometryType === 'polygon' ? 'fa-solid fa-draw-polygon' : 'fa-solid fa-slash' }),
          def.geometryType === 'polygon' ? ' Gambar Area di Peta' : ' Gambar Jalur Kabel di Peta',
        ]);
        drawBtn.addEventListener('click', () => {
          drawGeometryOnMap(def.geometryType === 'polygon' ? 'polygon' : 'polyline', (geometry) => {
            geomState.value = geometry;
            const n = geometry.type === 'Polygon' ? geometry.coordinates[0].length : geometry.coordinates.length;
            geomStatus.textContent = 'Digambar baru: ' + n + ' titik. Kembali membuka form untuk simpan.';
            toast(def.title + ': geometri siap disimpan.', 'success');
          });
        });
        const geomWrap = el('div', { class: 'form-field full', style: 'display:flex;align-items:center;flex-wrap:wrap;gap:0;' }, [drawBtn, geomStatus]);
        formEl.appendChild(geomWrap);
      }

      const wrapper = el('div');
      let overlayRef;
      const header = el('div', { class: 'modal-header' }, [
        el('h3', {}, [(isEdit ? 'Edit ' : 'Tambah ') + def.title]),
        el('button', { type: 'button', class: 'icon-btn', onclick: () => closeModal(overlayRef) }, [el('i', { class: 'fa-solid fa-xmark' })]),
      ]);
      const body = el('div', { class: 'modal-body' }, [formEl]);
      const footer = el('div', { class: 'modal-footer' }, [
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => closeModal(overlayRef) }, ['Batal']),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => submitAssetForm(inputRefs, existingRow, geomState, () => closeModal(overlayRef)) }, [isEdit ? 'Simpan Perubahan' : 'Simpan']),
      ]);
      wrapper.appendChild(header); wrapper.appendChild(body); wrapper.appendChild(footer);
      overlayRef = openModal(wrapper, { size: 'md' });
    }

    async function submitAssetForm(inputRefs, existingRow, geomState, onDone) {
      const payload = {};
      for (const f of def.fields) {
        const raw = inputRefs[f.key].value;
        if (f.required && !raw) { toast(f.label + ' wajib diisi.', 'warning'); return; }
        payload[f.key] = f.type === 'number' ? (raw === '' ? null : Number(raw)) : (raw || null);
      }
      if ((def.geometryType === 'polygon' || def.geometryType === 'line')) {
        if (geomState && geomState.value) {
          payload[def.geometryWriteColumn] = geometryToWKT(geomState.value);
        } else if (!existingRow) {
          toast('Silakan gambar ' + (def.geometryType === 'polygon' ? 'area' : 'jalur') + ' di peta terlebih dahulu.', 'warning');
          return;
        }
        // Jika edit tanpa gambar ulang: kolom geometry tidak disertakan di payload,
        // sehingga geometry lama di database tidak berubah.
      }
      try {
        let error;
        if (existingRow) {
          ({ error } = await App.supabase.from(def.table).update(payload).eq('id', existingRow.id));
        } else {
          // FIX #E5: tautkan data baru ke Project Aktif (kalau ada dipilih di topbar),
          // supaya nanti muncul saat project itu difilter dan tidak ikut "nyasar" ke project lain.
          if (App.currentProjectId && PROJECT_SCOPED_TABLES.includes(def.table)) payload.project_id = App.currentProjectId;
          ({ error } = await App.supabase.from(def.table).insert(payload));
        }
        if (error) throw error;
        if (!existingRow && !App.currentProjectId) toast(def.title + ' tersimpan tanpa Project Aktif (belum tertaut ke project manapun).', 'info');
        else toast(def.title + ' berhasil disimpan.', 'success');
        onDone();
        loadAndRenderTable();
      } catch (err) {
        toast('Gagal menyimpan: ' + err.message, 'error');
      }
    }

    async function deleteAsset(row) {
      const ok = await confirmDialog('Hapus data ini? Tindakan tidak dapat dibatalkan.', 'Hapus ' + def.title);
      if (!ok) return;
      const { error } = await App.supabase.from(def.table).delete().eq('id', row.id);
      if (error) { toast('Gagal menghapus: ' + error.message, 'error'); return; }
      toast(def.title + ' dihapus.', 'success');
      loadAndRenderTable();
    }

    function showOnMap(row) {
      if (def.geometryType === 'point') {
        if (row.lat == null || row.lng == null) { toast('Data ini tidak memiliki koordinat titik.', 'info'); return; }
        location.hash = '#/mapping';
        setTimeout(() => {
          if (App.map) {
            App.map.setView([row.lat, row.lng], 17);
            L.marker([row.lat, row.lng]).addTo(App.map).bindPopup(row.name || row.owner_name || def.title).openPopup();
          }
        }, 300);
        return;
      }
      if (def.geometryType === 'polygon' || def.geometryType === 'line') {
        const raw = row[def.geometryColumn];
        if (!raw) { toast('Data ini belum punya geometri. Edit data untuk menggambarnya di peta.', 'info'); return; }
        let geojson;
        try { geojson = typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch (e) { toast('Geometri data tidak valid.', 'error'); return; }
        location.hash = '#/mapping';
        setTimeout(() => {
          if (App.map) {
            const layer = L.geoJSON(geojson, { style: { color: '#1F3A5F', weight: 3 } }).addTo(App.map);
            layer.bindPopup(row.name || def.title);
            try { App.map.fitBounds(layer.getBounds(), { maxZoom: 17 }); } catch (e) {}
          }
        }, 300);
        return;
      }
      toast('Data ini tidak memiliki geometri untuk ditampilkan.', 'info');
    }
  }

  // Mode "pilih lokasi di peta": pindah ke halaman Mapping, klik sekali di
  // peta untuk mengisi lat/lng pada form yang sedang terbuka.
  function pickLocationOnMap(onPick) {
    const restoreModals = hideOpenModalsForMapPick();
    toast('Silakan klik pada peta untuk memilih lokasi. Form akan muncul kembali otomatis.', 'info', 4000);
    location.hash = '#/mapping';
    const tryBind = () => {
      if (!App.map) { setTimeout(tryBind, 200); return; }
      const handler = (e) => {
        onPick(e.latlng.lat, e.latlng.lng);
        App.map.off('click', handler);
        restoreModals();
        toast('Lokasi dipilih. Form muncul kembali.', 'success');
      };
      App.map.on('click', handler);
    };
    setTimeout(tryBind, 250);
  }

  // Registrasi seluruh modul aset dari config.js
  Object.entries(CFG.ASSET_DEFS).forEach(([key, def]) => createAssetModule(key, def));

  /* ================= [COVERAGE] ANALISIS COVERAGE ODP (FASE 3) ================= */
  // Menghitung berapa rumah yang berada dalam radius layanan ODP terdekat
  // (CFG.COVERAGE.ODP_SERVICE_RADIUS_M) vs total rumah. Perhitungan dilakukan
  // di sisi client (vanilla JS, Haversine) — cukup untuk skala menengah;
  // untuk dataset sangat besar sebaiknya dipindah ke RPC/PostGIS di Fase lanjut.
  async function computeCoverage() {
    const radius = CFG.COVERAGE.ODP_SERVICE_RADIUS_M;
    const limit = CFG.PERFORMANCE.MAP_PAGE_SIZE;
    const [{ data: odpRows, error: odpErr }, { data: homeRows, error: homeErr }] = await Promise.all([
      scopeToProject(App.supabase.from('odp').select('id, name, lat, lng'), 'odp').limit(limit),
      scopeToProject(App.supabase.from('homes').select('id, owner_name, address, lat, lng, odp_id'), 'homes').limit(limit),
    ]);
    if (odpErr || homeErr) throw new Error((odpErr || homeErr).message);

    const odpList = odpRows || [];
    const homes = (homeRows || []).map((h) => {
      let nearest = null, nearestDist = Infinity;
      odpList.forEach((o) => {
        if (o.lat == null || o.lng == null || h.lat == null || h.lng == null) return;
        const d = haversineMeters(h.lat, h.lng, o.lat, o.lng);
        if (d < nearestDist) { nearestDist = d; nearest = o; }
      });
      const covered = nearest !== null && nearestDist <= radius;
      return { ...h, nearestOdp: nearest, distanceM: nearest ? Math.round(nearestDist) : null, covered };
    });
    const total = homes.length;
    const covered = homes.filter((h) => h.covered).length;
    const percent = total ? Math.round((covered / total) * 100) : 0;
    return { radius, odpList, homes, total, covered, uncovered: total - covered, percent };
  }
  App.computeCoverage = computeCoverage; // ekspos agar bisa dipakai modul lain (mis. Dashboard, Validation)

  registerModule('coverage', async function renderCoverage(container) {
    container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:10px;"></div>';
    $('#page-toolbar').innerHTML = '';
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => renderCoverage(container) }, [
        el('i', { class: 'fa-solid fa-rotate' }), ' Hitung Ulang',
      ]),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => showCoverageOnMap() }, [
        el('i', { class: 'fa-solid fa-map' }), ' Tampilkan di Peta',
      ]),
    ]));

    let result;
    try {
      result = await computeCoverage();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['Gagal memuat data coverage: ' + err.message]),
        el('div', { class: 'text-xs text-muted' }, ['Pastikan tabel "odp" dan "homes" sudah ada (lihat 002_assets.sql).']),
      ]));
      return;
    }
    App.lastCoverageResult = result; // dipakai showCoverageOnMap()

    container.innerHTML = '';
    const grid = el('div', { class: 'stat-grid' }, [
      statCard('fa-house', fmtNumber(result.total), 'Total Rumah'),
      statCard('fa-wifi', fmtNumber(result.covered), 'Rumah Tercakup ODP'),
      statCard('fa-triangle-exclamation', fmtNumber(result.uncovered), 'Belum Tercakup'),
      statCard('fa-chart-pie', result.percent + '%', 'Persentase Coverage'),
    ]);
    container.appendChild(grid);

    const infoCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Ketentuan'])]),
      el('p', { class: 'text-muted text-sm' }, [
        `Rumah dianggap "tercakup" bila jarak ke ODP terdekat ≤ ${fmtNumber(result.radius)} meter ` +
        `(CFG.COVERAGE.ODP_SERVICE_RADIUS_M di config.js). Total ODP terdata: ${fmtNumber(result.odpList.length)}.`,
      ]),
    ]);
    container.appendChild(infoCard);

    const listCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Rumah Belum Tercakup']), el('span', { class: 'text-xs text-muted' }, [fmtNumber(result.uncovered) + ' rumah'])]),
    ]);
    const uncoveredRows = result.homes.filter((h) => !h.covered).slice(0, 100);
    if (!uncoveredRows.length) {
      listCard.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-circle-check' }),
        el('div', {}, ['Semua rumah sudah tercakup ODP dalam radius layanan. 🎉']),
      ]));
    } else {
      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, ['Nama Pemilik', 'Alamat', 'ODP Terdekat', 'Jarak (m)', 'Aksi'].map((h) => el('th', {}, [h])))]));
      const tbody = el('tbody');
      uncoveredRows.forEach((h) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [h.owner_name || '-']),
          el('td', {}, [h.address || '-']),
          el('td', {}, [h.nearestOdp ? h.nearestOdp.name : '- (belum ada ODP)']),
          el('td', {}, [h.distanceM != null ? fmtNumber(h.distanceM) : '-']),
          el('td', {}, [
            el('button', { class: 'icon-btn btn-icon-only', title: 'Lihat di Peta', onclick: () => {
              location.hash = '#/mapping';
              setTimeout(() => {
                if (App.map && h.lat != null && h.lng != null) {
                  App.map.setView([h.lat, h.lng], 17);
                  L.marker([h.lat, h.lng]).addTo(App.map).bindPopup(h.owner_name || 'Rumah').openPopup();
                }
              }, 300);
            } }, [el('i', { class: 'fa-solid fa-location-dot', style: 'font-size:12px' })]),
          ]),
        ]));
      });
      table.appendChild(tbody);
      listCard.appendChild(table);
      if (result.uncovered > 100) {
        listCard.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin-top:8px;' }, [
          'Menampilkan 100 dari ' + fmtNumber(result.uncovered) + ' rumah belum tercakup.',
        ]));
      }
    }
    container.appendChild(listCard);
  });

  function statCard(icon, value, label) {
    return el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-icon' }, [el('i', { class: `fa-solid ${icon}` })]),
      el('div', {}, [el('div', { class: 'stat-value' }, [value]), el('div', { class: 'stat-label' }, [label])]),
    ]);
  }

  function showCoverageOnMap() {
    const result = App.lastCoverageResult;
    if (!result) { toast('Hitung coverage terlebih dahulu.', 'info'); return; }
    location.hash = '#/mapping';
    setTimeout(() => {
      if (!App.map) return;
      result.odpList.forEach((o) => {
        if (o.lat == null || o.lng == null) return;
        L.circle([o.lat, o.lng], { radius: result.radius, color: '#0B6E99', weight: 1, fillOpacity: 0.08 }).addTo(App.map);
        L.circleMarker([o.lat, o.lng], { radius: 5, color: '#0B6E99', fillColor: '#0B6E99', fillOpacity: 1 }).addTo(App.map).bindPopup('ODP: ' + o.name);
      });
      result.homes.forEach((h) => {
        if (h.lat == null || h.lng == null) return;
        const color = h.covered ? '#1E7B4D' : '#B3261E';
        L.circleMarker([h.lat, h.lng], { radius: 5, color, fillColor: color, fillOpacity: 0.9 })
          .addTo(App.map)
          .bindPopup((h.owner_name || 'Rumah') + (h.covered ? ' — tercakup' : ' — belum tercakup'));
      });
      toast('Peta coverage ditampilkan: hijau = tercakup, merah = belum tercakup.', 'info', 4000);
    }, 300);
  }

  /* ================= [VALIDATION] VALIDASI TOPOLOGI & SPLITTER (FASE 3) ================= */
  // Aturan yang divalidasi (semua dibaca dari config.js, bukan hardcode, supaya
  // menambah modul aset baru di config.js otomatis ikut divalidasi):
  //   1. Field bertipe 'relation' yang masih kosong (mis. Rumah belum punya ODP).
  //   2. Splitter melebihi kapasitas (ODC 1:4, ODP 1:8, dari def.splitter).
  //   3. Geometri (polygon/line) yang belum digambar di peta.
  //   4. Rumah yang terhubung ke ODP tapi jaraknya melebihi radius layanan.
  async function runValidation() {
    const issues = [];

    // 1) Relasi kosong
    for (const [assetKey, def] of Object.entries(CFG.ASSET_DEFS)) {
      const nameKey = def.fields.find((f) => f.type === 'text')?.key || 'name';
      for (const f of def.fields) {
        if (f.type !== 'relation') continue;
        try {
          const { data, error } = await App.supabase.from(def.table).select('id, ' + nameKey + ', ' + f.key).is(f.key, null).limit(200);
          if (!error && data && data.length) {
            issues.push({
              severity: 'warning', category: 'Relasi Belum Terhubung',
              title: def.title + ': "' + f.label + '" belum diisi',
              count: data.length, assetKey, nameKey, items: data,
            });
          }
        } catch (e) { /* tabel belum ada — lewati, bukan error fatal */ }
      }
    }

    // 2) Splitter melebihi kapasitas
    for (const [assetKey, def] of Object.entries(CFG.ASSET_DEFS)) {
      if (!def.splitter) continue;
      try {
        const ratio = CFG.SPLITTER[def.splitter.ratioKey];
        const { data: parents } = await App.supabase.from(def.table).select('id, name');
        const { data: children } = await App.supabase.from(def.splitter.childTable).select(def.splitter.parentKey);
        const counts = {};
        (children || []).forEach((c) => { const pid = c[def.splitter.parentKey]; counts[pid] = (counts[pid] || 0) + 1; });
        const over = (parents || [])
          .filter((p) => (counts[p.id] || 0) > ratio)
          .map((p) => ({ id: p.id, name: p.name + ' (' + (counts[p.id] || 0) + '/' + ratio + ')' }));
        if (over.length) {
          issues.push({
            severity: 'error', category: 'Splitter Melebihi Kapasitas',
            title: def.title + ': melebihi rasio 1:' + ratio + ' ke ' + def.splitter.childLabel,
            count: over.length, assetKey, nameKey: 'name', items: over,
          });
        }
      } catch (e) { /* tabel belum ada — lewati */ }
    }

    // 3) Geometri belum digambar
    for (const [assetKey, def] of Object.entries(CFG.ASSET_DEFS)) {
      if (def.geometryType !== 'polygon' && def.geometryType !== 'line') continue;
      try {
        const { data, error } = await App.supabase.from(def.table).select('id, name, ' + def.geometryColumn).is(def.geometryColumn, null).limit(200);
        if (!error && data && data.length) {
          issues.push({
            severity: 'info', category: 'Geometri Belum Digambar',
            title: def.title + ': belum punya geometri di peta',
            count: data.length, assetKey, nameKey: 'name', items: data,
          });
        }
      } catch (e) { /* tabel/kolom belum ada — lewati */ }
    }

    // 4) Rumah terhubung ODP tapi di luar radius layanan
    try {
      const radius = CFG.COVERAGE.ODP_SERVICE_RADIUS_M;
      const { data: homes } = await App.supabase.from('homes').select('id, owner_name, lat, lng, odp_id').not('odp_id', 'is', null).limit(CFG.PERFORMANCE.MAP_PAGE_SIZE);
      const { data: odpRows } = await App.supabase.from('odp').select('id, name, lat, lng');
      const odpMap = {}; (odpRows || []).forEach((o) => { odpMap[o.id] = o; });
      const mismatched = (homes || [])
        .filter((h) => {
          const o = odpMap[h.odp_id];
          if (!o || o.lat == null || o.lng == null || h.lat == null || h.lng == null) return false;
          return haversineMeters(h.lat, h.lng, o.lat, o.lng) > radius;
        })
        .map((h) => ({ id: h.id, name: (h.owner_name || 'Rumah') + ' → ' + (odpMap[h.odp_id]?.name || '?') }));
      if (mismatched.length) {
        issues.push({
          severity: 'warning', category: 'Penempatan ODP Tidak Sesuai',
          title: 'Rumah terhubung ODP di luar radius layanan (' + fmtNumber(radius) + ' m)',
          count: mismatched.length, assetKey: 'rumah', nameKey: 'name', items: mismatched,
        });
      }
    } catch (e) { /* tabel belum ada — lewati */ }

    return issues;
  }
  App.runValidation = runValidation;

  const SEVERITY_META = {
    error: { label: 'Error', color: 'badge-danger', icon: 'fa-circle-xmark' },
    warning: { label: 'Warning', color: 'badge-warning', icon: 'fa-triangle-exclamation' },
    info: { label: 'Info', color: 'badge-info', icon: 'fa-circle-info' },
  };

  registerModule('validation', async function renderValidation(container) {
    container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:10px;"></div>';
    $('#page-toolbar').innerHTML = '';
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => renderValidation(container) }, [
        el('i', { class: 'fa-solid fa-rotate' }), ' Jalankan Ulang Validasi',
      ]),
    ]));

    let issues;
    try {
      issues = await runValidation();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['Gagal menjalankan validasi: ' + err.message]),
      ]));
      return;
    }

    container.innerHTML = '';
    const counts = { error: 0, warning: 0, info: 0 };
    issues.forEach((i) => { counts[i.severity] += i.count; });
    const grid = el('div', { class: 'stat-grid' }, [
      statCard('fa-circle-xmark', fmtNumber(counts.error), 'Error (wajib diperbaiki)'),
      statCard('fa-triangle-exclamation', fmtNumber(counts.warning), 'Warning'),
      statCard('fa-circle-info', fmtNumber(counts.info), 'Info'),
      statCard('fa-list-check', fmtNumber(issues.length), 'Kategori Ditemukan'),
    ]);
    container.appendChild(grid);

    if (!issues.length) {
      container.appendChild(el('div', { class: 'card empty-state' }, [
        el('i', { class: 'fa-solid fa-circle-check' }),
        el('h3', {}, ['Tidak ada masalah ditemukan']),
        el('p', { class: 'text-muted' }, ['Semua relasi, splitter, dan geometri sudah sesuai aturan.']),
      ]));
      return;
    }

    // Urutkan: error dulu, lalu warning, lalu info
    const order = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);

    issues.forEach((issue) => {
      const meta = SEVERITY_META[issue.severity];
      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('h3', {}, [
            el('i', { class: `fa-solid ${meta.icon}`, style: 'margin-right:8px;' }),
            issue.title,
          ]),
          el('span', { class: `badge ${meta.color}` }, [meta.label + ' · ' + fmtNumber(issue.count)]),
        ]),
      ]);
      const list = el('div', { class: 'validation-item-list' });
      issue.items.slice(0, 20).forEach((row) => {
        list.appendChild(el('div', { class: 'layer-item' }, [
          el('span', {}, [String(row[issue.nameKey] ?? row.name ?? row.id)]),
          el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto;', onclick: () => { location.hash = '#/' + issue.assetKey; } }, [
            'Buka ' + (CFG.ASSET_DEFS[issue.assetKey]?.title || issue.assetKey),
          ]),
        ]));
      });
      card.appendChild(list);
      if (issue.count > 20) {
        card.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin-top:8px;' }, [
          'Menampilkan 20 dari ' + fmtNumber(issue.count) + ' data.',
        ]));
      }
      container.appendChild(card);
    });
  });

  /* ================= [HEATMAP] KEPADATAN RUMAH (FASE 3) ================= */
  // Peta terpisah dari App.map (modul Mapping) supaya tidak saling bertabrakan
  // saat pindah halaman. Memakai plugin leaflet.heat yang sudah dimuat di
  // index.html (L.heatLayer).
  registerModule('heatmap', async function renderHeatmap(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';
    const statusSelect = el('select', { class: 'text-input', style: 'max-width:200px;' }, [
      el('option', { value: '' }, ['Semua Status']),
      el('option', { value: 'Prospek' }, ['Prospek']),
      el('option', { value: 'Survey' }, ['Survey']),
      el('option', { value: 'Pelanggan' }, ['Pelanggan']),
    ]);
    statusSelect.addEventListener('change', () => loadHeat());
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('span', { class: 'text-sm text-muted' }, ['Filter Status:']),
      statusSelect,
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => loadHeat() }, [
        el('i', { class: 'fa-solid fa-rotate' }), ' Refresh',
      ]),
    ]));

    const mapWrap = el('div', { id: 'heatmap-container', style: 'height:calc(100vh - 230px);border-radius:12px;overflow:hidden;' });
    const countLabel = el('p', { class: 'text-xs text-muted', style: 'margin-top:10px;' }, ['Memuat...']);
    const legend = el('div', { class: 'card', style: 'margin-top:12px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Legenda'])]),
      el('p', { class: 'text-muted text-sm' }, ['Warna biru → hijau → kuning → merah menunjukkan kepadatan rumah yang meningkat pada titik tersebut.']),
      countLabel,
    ]);
    container.appendChild(mapWrap);
    container.appendChild(legend);

    App.heatMap = L.map(mapWrap, { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors', maxZoom: 20,
    }).addTo(App.heatMap);
    let heatLayer = null;

    async function loadHeat() {
      countLabel.textContent = 'Memuat...';
      let query = App.supabase.from('homes').select('lat, lng, status').limit(CFG.PERFORMANCE.MAP_PAGE_SIZE);
      if (statusSelect.value) query = query.eq('status', statusSelect.value);
      const { data, error } = await query;
      if (heatLayer) { App.heatMap.removeLayer(heatLayer); heatLayer = null; }
      if (error) {
        countLabel.textContent = 'Gagal memuat data: ' + error.message;
        return;
      }
      const points = (data || []).filter((r) => r.lat != null && r.lng != null).map((r) => [r.lat, r.lng, 0.6]);
      if (points.length) {
        heatLayer = L.heatLayer(points, { radius: 28, blur: 22, maxZoom: 17 }).addTo(App.heatMap);
        try { App.heatMap.fitBounds(L.latLngBounds(points.map((p) => [p[0], p[1]])), { maxZoom: 16 }); } catch (e) {}
      }
      countLabel.textContent = fmtNumber(points.length) + ' rumah ditampilkan' + (statusSelect.value ? ' (status: ' + statusSelect.value + ')' : '') + '.';
    }
    await loadHeat();
  }, function destroyHeatmap() {
    if (App.heatMap) { App.heatMap.remove(); App.heatMap = null; }
  });

  /* ================= [PLANNING] BOQ, APPROVAL, SUMMARY (FASE 4) ================= */
  // Ketiganya memakai tabel scenarios/approvals/boq_snapshots dari migration
  // 004_planning.sql, dan kolom scenario_id (nullable) yang ditambahkan ke
  // semua tabel aset — filter longgar: undefined = semua data, null = data
  // global (belum dikaitkan skenario), string = id skenario tertentu.

  async function computeBOQ(scenarioFilter) {
    const applyFilter = (q) => {
      if (scenarioFilter === undefined) return q;
      if (scenarioFilter === null) return q.is('scenario_id', null);
      return q.eq('scenario_id', scenarioFilter);
    };
    const countTable = async (table) => {
      try {
        let q = App.supabase.from(table).select('*', { count: 'exact', head: true });
        const { count, error } = await applyFilter(q);
        return error ? 0 : (count || 0);
      } catch (e) { return 0; }
    };
    const sumLength = async (table) => {
      try {
        let q = App.supabase.from(table).select('length_m');
        const { data, error } = await applyFilter(q);
        if (error || !data) return 0;
        return data.reduce((s, r) => s + (Number(r.length_m) || 0), 0);
      } catch (e) { return 0; }
    };
    const [totalOdc, totalOdp, totalPop, totalTiang, totalClosure, totalHandhole, totalJointbox, totalRumah] = await Promise.all([
      countTable('odc'), countTable('odp'), countTable('pops'), countTable('poles'),
      countTable('closures'), countTable('handholes'), countTable('jointboxes'), countTable('homes'),
    ]);
    const [panjangBackbone, panjangDistribution, panjangKabel] = await Promise.all([
      sumLength('backbones'), sumLength('distributions'), sumLength('kabels'),
    ]);
    const items = [
      { label: 'ODC', unit: 'unit', qty: totalOdc },
      { label: 'ODP', unit: 'unit', qty: totalOdp },
      { label: 'POP', unit: 'unit', qty: totalPop },
      { label: 'Tiang Besi', unit: 'unit', qty: totalTiang },
      { label: 'Closure', unit: 'unit', qty: totalClosure },
      { label: 'Handhole', unit: 'unit', qty: totalHandhole },
      { label: 'Joint Box', unit: 'unit', qty: totalJointbox },
      { label: 'Rumah Terdata', unit: 'unit', qty: totalRumah },
      { label: 'Kabel Backbone', unit: 'meter', qty: Math.round(panjangBackbone) },
      { label: 'Kabel Distribution', unit: 'meter', qty: Math.round(panjangDistribution) },
      { label: 'Kabel Generik', unit: 'meter', qty: Math.round(panjangKabel) },
    ];
    return { items };
  }
  App.computeBOQ = computeBOQ;

  async function fetchScenarioOptions() {
    try {
      const { data, error } = await App.supabase.from('scenarios').select('id, name, status').order('created_at', { ascending: false });
      return error ? [] : (data || []);
    } catch (e) { return []; }
  }

  /* ---- BOQ ---- */
  registerModule('boq', async function renderBOQ(container) {
    container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:10px;"></div>';
    $('#page-toolbar').innerHTML = '';
    const scenarios = await fetchScenarioOptions();
    const filterSelect = el('select', { class: 'text-input', style: 'max-width:260px;' }, [
      el('option', { value: '__all__' }, ['Semua Data (semua skenario)']),
      el('option', { value: '__null__' }, ['Data Global (belum dikaitkan skenario)']),
      ...scenarios.map((s) => el('option', { value: s.id }, [s.name + ' (' + s.status + ')'])),
    ]);
    filterSelect.addEventListener('change', () => renderTable());
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('span', { class: 'text-sm text-muted' }, ['Skenario:']),
      filterSelect,
      el('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:auto;', onclick: () => saveSnapshot() }, [
        el('i', { class: 'fa-solid fa-floppy-disk' }), ' Simpan Snapshot',
      ]),
    ]));

    const boqCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Bill of Quantity (Tanpa Harga)'])]),
    ]);
    const tableWrap = el('div', { id: 'boq-table-wrap' });
    boqCard.appendChild(tableWrap);

    const historyCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Riwayat Snapshot'])]),
      el('div', { id: 'boq-history-wrap' }, [el('p', { class: 'text-muted' }, ['Memuat...'])]),
    ]);

    container.innerHTML = '';
    container.appendChild(boqCard);
    container.appendChild(historyCard);

    function currentFilter() {
      const v = filterSelect.value;
      if (v === '__all__') return undefined;
      if (v === '__null__') return null;
      return v;
    }

    async function renderTable() {
      tableWrap.innerHTML = '<div class="skeleton" style="height:120px;"></div>';
      const { items } = await computeBOQ(currentFilter());
      tableWrap.innerHTML = '';
      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, [el('tr', {}, ['Item', 'Satuan', 'Jumlah'].map((h) => el('th', {}, [h])))]));
      const tbody = el('tbody');
      items.forEach((it) => {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [it.label]),
          el('td', {}, [it.unit]),
          el('td', {}, [fmtNumber(it.qty)]),
        ]));
      });
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    }

    async function renderHistory() {
      const wrap = $('#boq-history-wrap');
      if (!wrap) return;
      const { data, error } = await App.supabase.from('boq_snapshots').select('id, scenario_id, generated_at, data').order('generated_at', { ascending: false }).limit(10);
      wrap.innerHTML = '';
      if (error || !data || !data.length) {
        wrap.appendChild(el('p', { class: 'text-muted' }, ['Belum ada snapshot tersimpan.']));
        return;
      }
      data.forEach((snap) => {
        const scn = scenarios.find((s) => s.id === snap.scenario_id);
        wrap.appendChild(el('div', { class: 'layer-item' }, [
          el('span', {}, [(scn ? scn.name : 'Data Global') + ' — ' + fmtDate(snap.generated_at)]),
          el('span', { class: 'text-xs text-muted', style: 'margin-left:auto;' }, [(snap.data.items || []).length + ' item']),
        ]));
      });
    }

    async function saveSnapshot() {
      const filter = currentFilter();
      const { items } = await computeBOQ(filter);
      const uid = App.session && App.session.user ? App.session.user.id : null;
      const { error } = await App.supabase.from('boq_snapshots').insert({
        scenario_id: filter === undefined ? null : filter,
        generated_by: uid,
        data: { items },
      });
      if (error) { toast('Gagal menyimpan snapshot: ' + error.message, 'error'); return; }
      toast('Snapshot BOQ tersimpan.', 'success');
      renderHistory();
    }

    await renderTable();
    await renderHistory();
  });

  /* ---- APPROVAL ---- */
  registerModule('approval', async function renderApproval(container) {
    container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:10px;"></div>';
    $('#page-toolbar').innerHTML = '';
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => renderApproval(container) }, [
        el('i', { class: 'fa-solid fa-rotate' }), ' Refresh',
      ]),
    ]));

    const { data: pending, error: pendErr } = await App.supabase
      .from('scenarios').select('*, projects(name)').eq('status', 'Diajukan').order('updated_at', { ascending: false });
    const { data: history } = await App.supabase
      .from('approvals').select('*, scenarios(name)').not('decided_at', 'is', null).order('decided_at', { ascending: false }).limit(20);

    container.innerHTML = '';
    if (pendErr) {
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['Gagal memuat data: ' + pendErr.message]),
        el('div', { class: 'text-xs text-muted' }, ['Pastikan migration 004_planning.sql sudah dijalankan.']),
      ]));
      return;
    }

    const pendingCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Menunggu Persetujuan']), el('span', { class: 'badge badge-warning' }, [fmtNumber((pending || []).length)])]),
    ]);
    if (!pending || !pending.length) {
      pendingCard.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-circle-check' }),
        el('div', {}, ['Tidak ada skenario yang menunggu persetujuan.']),
      ]));
    } else {
      pending.forEach((scn) => {
        pendingCard.appendChild(el('div', { class: 'layer-item', style: 'padding:12px 6px;align-items:flex-start;' }, [
          el('div', { style: 'flex:1;' }, [
            el('div', { style: 'font-weight:600;' }, [scn.name]),
            el('div', { class: 'text-xs text-muted' }, ['Project: ' + (scn.projects?.name || '-') + ' · Diajukan: ' + fmtDate(scn.updated_at)]),
            scn.description ? el('div', { class: 'text-sm', style: 'margin-top:4px;' }, [scn.description]) : null,
          ].filter(Boolean)),
          el('button', { class: 'btn btn-primary btn-sm', onclick: () => openApprovalDecisionModal(scn, 'Disetujui', container) }, ['Setujui']),
          el('button', { class: 'btn btn-danger btn-sm', onclick: () => openApprovalDecisionModal(scn, 'Ditolak', container) }, ['Tolak']),
        ]));
      });
    }
    container.appendChild(pendingCard);

    const historyCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Riwayat Keputusan'])]),
    ]);
    if (!history || !history.length) {
      historyCard.appendChild(el('p', { class: 'text-muted' }, ['Belum ada riwayat keputusan.']));
    } else {
      history.forEach((h) => {
        const badgeClass = h.status === 'Disetujui' ? 'badge-success' : 'badge-danger';
        historyCard.appendChild(el('div', { class: 'layer-item' }, [
          el('span', {}, [(h.scenarios?.name || '-') + (h.notes ? ' — ' + h.notes : '')]),
          el('span', { class: `badge ${badgeClass}`, style: 'margin-left:auto;' }, [h.status]),
          el('span', { class: 'text-xs text-muted', style: 'margin-left:8px;' }, [fmtDate(h.decided_at)]),
        ]));
      });
    }
    container.appendChild(historyCard);
  });

  function openApprovalDecisionModal(scenario, decision, refreshContainer) {
    const notesInput = el('textarea', { class: 'text-input', rows: '3', placeholder: 'Catatan (opsional)' });
    const wrap = el('div');
    let overlayRef;
    wrap.appendChild(el('div', { class: 'modal-header' }, [
      el('h3', {}, [(decision === 'Disetujui' ? 'Setujui' : 'Tolak') + ' Skenario']),
      el('button', { type: 'button', class: 'icon-btn', onclick: () => closeModal(overlayRef) }, [el('i', { class: 'fa-solid fa-xmark' })]),
    ]));
    wrap.appendChild(el('div', { class: 'modal-body' }, [
      el('p', {}, ['Skenario: ' + scenario.name]),
      el('div', { class: 'form-field full' }, [el('label', {}, ['Catatan']), notesInput]),
    ]));
    wrap.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => closeModal(overlayRef) }, ['Batal']),
      el('button', {
        type: 'button', class: `btn ${decision === 'Disetujui' ? 'btn-primary' : 'btn-danger'}`,
        onclick: () => submitApprovalDecision(scenario, decision, notesInput.value, () => closeModal(overlayRef), refreshContainer),
      }, [decision === 'Disetujui' ? 'Ya, Setujui' : 'Ya, Tolak']),
    ]));
    overlayRef = openModal(wrap, { size: 'sm' });
  }

  async function submitApprovalDecision(scenario, decision, notes, onDone, refreshContainer) {
    try {
      const uid = App.session && App.session.user ? App.session.user.id : null;
      const { error: updErr } = await App.supabase.from('scenarios').update({ status: decision }).eq('id', scenario.id);
      if (updErr) throw updErr;
      const { error: apprErr } = await App.supabase.from('approvals').insert({
        scenario_id: scenario.id, status: decision, requested_by: scenario.created_by || null,
        approver_id: uid, notes: notes || null, decided_at: new Date().toISOString(),
      });
      if (apprErr) throw apprErr;
      toast('Skenario "' + scenario.name + '" telah ' + (decision === 'Disetujui' ? 'disetujui.' : 'ditolak.'), 'success');
      onDone();
      if (App.currentRoute === 'approval') navigateTo('approval');
    } catch (err) {
      toast('Gagal memproses keputusan: ' + err.message, 'error');
    }
  }

  /* ---- PLANNING SUMMARY ---- */
  registerModule('summary', async function renderSummary(container) {
    container.innerHTML = '<div class="skeleton" style="height:160px;border-radius:10px;"></div>';
    $('#page-toolbar').innerHTML = '';

    const [coverage, issues, boq, scenarios] = await Promise.all([
      computeCoverage().catch(() => null),
      runValidation().catch(() => []),
      computeBOQ(undefined).catch(() => ({ items: [] })),
      fetchScenarioOptions(),
    ]);

    container.innerHTML = '';
    const errorCount = issues.filter((i) => i.severity === 'error').reduce((s, i) => s + i.count, 0);
    const warningCount = issues.filter((i) => i.severity === 'warning').reduce((s, i) => s + i.count, 0);
    const scenarioCounts = { Draft: 0, Diajukan: 0, Disetujui: 0, Ditolak: 0, Diarsipkan: 0 };
    scenarios.forEach((s) => { if (scenarioCounts[s.status] !== undefined) scenarioCounts[s.status]++; });

    const grid = el('div', { class: 'stat-grid' }, [
      statCard('fa-wifi', coverage ? coverage.percent + '%' : '-', 'Coverage Rumah'),
      statCard('fa-circle-xmark', fmtNumber(errorCount), 'Error Validasi'),
      statCard('fa-triangle-exclamation', fmtNumber(warningCount), 'Warning Validasi'),
      statCard('fa-stamp', fmtNumber(scenarioCounts.Diajukan), 'Menunggu Approval'),
    ]);
    container.appendChild(grid);

    const scnCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Status Skenario'])]),
      el('div', { class: 'stat-grid', style: 'grid-template-columns:repeat(5,1fr);' }, Object.entries(scenarioCounts).map(([status, count]) =>
        el('div', { class: 'stat-card' }, [el('div', {}, [el('div', { class: 'stat-value' }, [fmtNumber(count)]), el('div', { class: 'stat-label' }, [status])])])
      )),
    ]);
    container.appendChild(scnCard);

    const boqCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Ringkasan BOQ (Semua Data)']), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/boq'; } }, ['Buka BOQ »'])]),
    ]);
    const boqTable = el('table', { class: 'data-table' });
    boqTable.appendChild(el('thead', {}, [el('tr', {}, ['Item', 'Satuan', 'Jumlah'].map((h) => el('th', {}, [h])))]));
    const boqBody = el('tbody');
    boq.items.forEach((it) => boqBody.appendChild(el('tr', {}, [el('td', {}, [it.label]), el('td', {}, [it.unit]), el('td', {}, [fmtNumber(it.qty)])])));
    boqTable.appendChild(boqBody);
    boqCard.appendChild(boqTable);
    container.appendChild(boqCard);

    const linksCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Tindak Lanjut'])]),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/coverage'; } }, ['Buka Coverage']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/validation'; } }, ['Buka Validation']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/approval'; } }, ['Buka Approval']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/scenario'; } }, ['Buka Scenario']),
      ]),
    ]);
    container.appendChild(linksCard);
  });

  /* ================= [PROJECT] MASTER PROJECT + DETAIL (IMPLEMENTASI 01) =================
     Modul baru, additive — tidak mengubah modul/route lain yang sudah ada.
     List: table 'projects' (search, pagination, CRUD modal) — pola sama seperti
     createAssetModule() di atas, disalin manual karena project tidak punya
     lat/lng/geometry sehingga tidak cocok memakai createAssetModule apa adanya.
     Detail: route 'project-detail' dibaca lewat query string (?id=...) karena
     router hash saat ini (lihat handleHashChange) belum mendukung path segmen;
     pendekatan query string ini tidak mengubah router, murni pemakaian yang sudah ada. */
  const projectState = { page: 1, pageSize: CFG.PERFORMANCE.PAGE_SIZE, search: '', total: 0, rows: [] };
  const PROJECT_STATUSES = ['Perencanaan', 'Survey', 'Berjalan', 'Selesai', 'Ditunda'];
  const PROJECT_STATUS_BADGE = {
    Perencanaan: 'badge-info', Survey: 'badge-warning', Berjalan: 'badge-success',
    Selesai: 'badge-neutral', Ditunda: 'badge-danger',
  };

  registerModule('project', async function renderProjectList(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('div', { class: 'topbar-search', style: 'max-width:260px;' }, [
        el('i', { class: 'fa-solid fa-magnifying-glass' }),
        el('input', {
          placeholder: 'Cari project...',
          oninput: debounce((e) => { projectState.search = e.target.value; projectState.page = 1; loadAndRenderProjectTable(); }, 300),
        }),
      ]),
      el('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:auto;', onclick: () => openProjectForm(null) }, [
        el('i', { class: 'fa-solid fa-plus' }), ' Tambah Project',
      ]),
    ]));
    const tableWrap = el('div', { class: 'table-wrap', id: 'project-table-wrap' });
    container.appendChild(tableWrap);
    await loadAndRenderProjectTable();
  }, function destroy() { /* tidak ada resource khusus untuk dibersihkan */ });

  async function loadAndRenderProjectTable() {
    const wrap = $('#project-table-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="skeleton" style="height:160px;"></div>';
    const from = (projectState.page - 1) * projectState.pageSize;
    const to = from + projectState.pageSize - 1;
    let query = App.supabase.from('projects').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(from, to);
    if (projectState.search) query = query.ilike('name', `%${projectState.search}%`);
    const { data, error, count } = await query;

    if (error) {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-database' }),
        el('div', {}, ['Tabel "projects" belum tersedia di Supabase.']),
        el('div', { class: 'text-xs text-muted' }, ['Jalankan SQL migration 002_assets.sql terlebih dahulu.']),
      ]));
      return;
    }
    projectState.rows = data || [];
    projectState.total = count || 0;

    wrap.innerHTML = '';
    const table = el('table', { class: 'data-table' });
    table.appendChild(el('thead', {}, [
      el('tr', {}, ['Nama Project', 'Status', 'Deskripsi', 'Dibuat', 'Aksi'].map((h) => el('th', {}, [h]))),
    ]));
    const tbody = el('tbody');
    if (!projectState.rows.length) {
      tbody.appendChild(el('tr', {}, [el('td', { colspan: '5' }, [
        el('div', { class: 'empty-state' }, [
          el('i', { class: 'fa-solid fa-inbox' }),
          el('div', {}, ['Belum ada project. Klik "Tambah Project" untuk membuat yang pertama.']),
        ]),
      ])]));
    }
    projectState.rows.forEach((row) => {
      const badgeClass = PROJECT_STATUS_BADGE[row.status] || 'badge-neutral';
      const shortDesc = row.description ? (row.description.length > 60 ? row.description.slice(0, 60) + '…' : row.description) : '-';
      const isActive = App.currentProjectId === row.id;
      tbody.appendChild(el('tr', {}, [
        el('td', {}, [
          el('a', {
            href: '#/project-detail?id=' + row.id,
            style: 'font-weight:600;color:var(--color-primary);text-decoration:none;cursor:pointer;',
          }, [row.name]),
          isActive ? el('span', { class: 'badge badge-success', style: 'margin-left:8px;font-size:9px;' }, ['Aktif']) : null,
        ]),
        el('td', {}, [el('span', { class: 'badge ' + badgeClass }, [row.status || '-'])]),
        el('td', {}, [shortDesc]),
        el('td', {}, [fmtDate(row.created_at)]),
        el('td', {}, [
          isActive ? null : el('button', { class: 'icon-btn btn-icon-only', title: 'Jadikan Project Aktif', onclick: () => setActiveProject(row.id, row.name) }, [el('i', { class: 'fa-solid fa-toggle-on', style: 'font-size:12px' })]),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Buka Detail', onclick: () => { location.hash = '#/project-detail?id=' + row.id; } }, [el('i', { class: 'fa-solid fa-folder-open', style: 'font-size:12px' })]),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Edit', onclick: () => openProjectForm(row) }, [el('i', { class: 'fa-solid fa-pen', style: 'font-size:12px' })]),
          el('button', { class: 'icon-btn btn-icon-only', title: 'Hapus', onclick: () => deleteProject(row) }, [el('i', { class: 'fa-solid fa-trash', style: 'font-size:12px;color:var(--color-danger)' })]),
        ]),
      ]));
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    const totalPages = Math.max(1, Math.ceil(projectState.total / projectState.pageSize));
    wrap.appendChild(el('div', { class: 'table-pagination' }, [
      el('span', {}, [`Total ${fmtNumber(projectState.total)} project — Halaman ${projectState.page}/${totalPages}`]),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: projectState.page <= 1 ? 'disabled' : null, onclick: () => { projectState.page--; loadAndRenderProjectTable(); } }, ['Sebelumnya']),
      el('button', { class: 'btn btn-ghost btn-sm', disabled: projectState.page >= totalPages ? 'disabled' : null, onclick: () => { projectState.page++; loadAndRenderProjectTable(); } }, ['Berikutnya']),
    ]));
  }

  function openProjectForm(existingRow) {
    const isEdit = !!existingRow;
    const formEl = el('form', { class: 'form-grid' });

    const nameWrap = el('div', { class: 'form-field' }, [el('label', {}, ['Nama Project *'])]);
    const nameInput = el('input', { class: 'text-input', type: 'text', required: 'required' });
    if (existingRow) nameInput.value = existingRow.name || '';
    nameWrap.appendChild(nameInput);

    const statusWrap = el('div', { class: 'form-field' }, [el('label', {}, ['Status'])]);
    const statusInput = el('select', { class: 'text-input' }, PROJECT_STATUSES.map((s) => el('option', { value: s }, [s])));
    if (existingRow) statusInput.value = existingRow.status || 'Perencanaan';
    statusWrap.appendChild(statusInput);

    const descWrap = el('div', { class: 'form-field full' }, [el('label', {}, ['Deskripsi'])]);
    const descInput = el('textarea', { class: 'text-input', rows: '3' });
    if (existingRow) descInput.value = existingRow.description || '';
    descWrap.appendChild(descInput);

    formEl.appendChild(nameWrap);
    formEl.appendChild(statusWrap);
    formEl.appendChild(descWrap);

    const wrapper = el('div');
    let overlayRef;
    const header = el('div', { class: 'modal-header' }, [
      el('h3', {}, [(isEdit ? 'Edit ' : 'Tambah ') + 'Project']),
      el('button', { type: 'button', class: 'icon-btn', onclick: () => closeModal(overlayRef) }, [el('i', { class: 'fa-solid fa-xmark' })]),
    ]);
    const body = el('div', { class: 'modal-body' }, [formEl]);
    const footer = el('div', { class: 'modal-footer' }, [
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => closeModal(overlayRef) }, ['Batal']),
      el('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: () => submitProjectForm(nameInput, statusInput, descInput, existingRow, () => closeModal(overlayRef)),
      }, [isEdit ? 'Simpan Perubahan' : 'Simpan']),
    ]);
    wrapper.appendChild(header); wrapper.appendChild(body); wrapper.appendChild(footer);
    overlayRef = openModal(wrapper, { size: 'md' });
  }

  async function submitProjectForm(nameInput, statusInput, descInput, existingRow, onDone) {
    const name = nameInput.value.trim();
    if (!name) { toast('Nama project wajib diisi.', 'warning'); return; }
    const payload = { name, status: statusInput.value, description: descInput.value.trim() || null };
    try {
      let error, data;
      if (existingRow) {
        ({ error } = await App.supabase.from('projects').update(payload).eq('id', existingRow.id));
      } else {
        payload.created_by = (App.session && App.session.user) ? App.session.user.id : null;
        ({ data, error } = await App.supabase.from('projects').insert(payload).select().single());
      }
      if (error) throw error;
      toast('Project berhasil disimpan.', 'success');
      onDone();
      // FIX #E5: project baru otomatis jadi "Project Aktif" -> semua menu (Dashboard,
      // CRUD, dst.) langsung ter-filter ke project ini dan tampil 0 karena memang belum ada data.
      if (!existingRow && data) setActiveProject(data.id, data.name);
      if (typeof loadAndRenderProjectTable === 'function') loadAndRenderProjectTable();
      if (typeof renderProjectSwitcher === 'function') renderProjectSwitcher();
    } catch (err) {
      toast('Gagal menyimpan project: ' + err.message, 'error');
    }
  }

  async function deleteProject(row) {
    const ok = await confirmDialog(
      'Hapus project "' + row.name + '"? Area/aset yang tertaut hanya akan kehilangan tautan project, tidak ikut terhapus.',
      'Hapus Project'
    );
    if (!ok) return;
    const { error } = await App.supabase.from('projects').delete().eq('id', row.id);
    if (error) { toast('Gagal menghapus project: ' + error.message, 'error'); return; }
    toast('Project dihapus.', 'success');
    if (App.currentProjectId === row.id) setActiveProject(null, null); // aktifnya ikut dihapus -> balik ke belum pilih
    loadAndRenderProjectTable();
    renderProjectSwitcher();
  }

  // FIX #E5: switcher "Project Aktif" di topbar. Menampilkan project yang sedang
  // aktif dan memungkinkan ganti/​buat project baru langsung dari halaman manapun.
  async function renderProjectSwitcher() {
    const host = $('#project-switcher');
    if (!host || !App.supabase) return;
    host.innerHTML = '';
    let rows = [];
    try {
      const { data, error } = await App.supabase.from('projects').select('id,name').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      rows = data || [];
    } catch (e) { return; } // tabel belum ada / belum migrasi — diam saja, tidak mengganggu topbar

    if (!rows.length) {
      host.appendChild(el('button', {
        class: 'btn btn-secondary btn-sm', title: 'Belum ada project — buat yang pertama',
        onclick: () => openProjectForm(null),
      }, [el('i', { class: 'fa-solid fa-plus' }), ' Project Baru']));
      return;
    }

    // Kalau project aktif tersimpan sudah dihapus/tidak ada, reset ke belum-pilih.
    if (App.currentProjectId && !rows.find((r) => r.id === App.currentProjectId)) {
      App.currentProjectId = null; App.currentProjectName = null;
      localStorage.removeItem('ma_active_project'); localStorage.removeItem('ma_active_project_name');
    }

    const select = el('select', { class: 'text-input', title: 'Project Aktif — memfilter Dashboard, CRUD, dan data lain di seluruh app' }, [
      el('option', { value: '' }, ['— Semua Project (lama) —']),
      ...rows.map((r) => el('option', { value: r.id }, [r.name])),
    ]);
    select.value = App.currentProjectId || '';
    select.addEventListener('change', () => {
      const row = rows.find((r) => r.id === select.value);
      setActiveProject(select.value || null, row ? row.name : null);
    });
    const addBtn = el('button', { class: 'icon-btn', title: 'Tambah Project Baru', onclick: () => openProjectForm(null) }, [el('i', { class: 'fa-solid fa-plus' })]);
    host.appendChild(select);
    host.appendChild(addBtn);
  }

  /* ---- PROJECT DETAIL (route: #/project-detail?id=<uuid>) ---- */
  registerModule('project-detail', async function renderProjectDetail(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const projectId = params.get('id');

    if (!projectId) {
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['ID project tidak ditemukan pada URL.']),
        el('button', { class: 'btn btn-secondary btn-sm', style: 'margin-top:10px;', onclick: () => { location.hash = '#/project'; } }, ['Kembali ke Daftar Project']),
      ]));
      return;
    }

    container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'skeleton', style: 'height:100px;' })]));

    let project = null, loadError = null;
    try {
      const { data, error } = await App.supabase.from('projects').select('*').eq('id', projectId).single();
      if (error) throw error;
      project = data;
    } catch (err) { loadError = err; }

    container.innerHTML = '';

    if (loadError || !project) {
      container.appendChild(el('div', { class: 'empty-state' }, [
        el('i', { class: 'fa-solid fa-triangle-exclamation' }),
        el('div', {}, ['Project tidak ditemukan atau sudah dihapus.']),
        el('button', { class: 'btn btn-secondary btn-sm', style: 'margin-top:10px;', onclick: () => { location.hash = '#/project'; } }, ['Kembali ke Daftar Project']),
      ]));
      return;
    }

    $('#page-title').textContent = project.name;
    const badgeClass = PROJECT_STATUS_BADGE[project.status] || 'badge-neutral';

    const headerCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/project'; } }, [
          el('i', { class: 'fa-solid fa-arrow-left' }), ' Kembali',
        ]),
        el('div', { style: 'display:flex;gap:8px;' }, [
          // Smart Planning — Analisa Area (Implementation 02 Phase 1), additive.
          el('button', { class: 'btn btn-primary btn-sm', title: 'Analisa Area untuk project ini', onclick: () => {
            if (App._lastAnalysis) App._lastAnalysis.projectId = project.id; else App._lastAnalysis = { projectId: project.id };
            runAreaAnalysis(project.id);
          } }, [el('i', { class: 'fa-solid fa-wand-magic-sparkles' }), ' Analisa Area']),
          App.currentProjectId === project.id
            ? el('span', { class: 'badge badge-success', style: 'align-self:center;' }, ['Project Aktif'])
            : el('button', { class: 'btn btn-secondary btn-sm', title: 'Jadikan project ini aktif di seluruh app', onclick: () => setActiveProject(project.id, project.name) }, [el('i', { class: 'fa-solid fa-toggle-on' }), ' Jadikan Aktif']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => openProjectForm(project) }, [el('i', { class: 'fa-solid fa-pen' }), ' Edit']),
          el('button', {
            class: 'btn btn-danger btn-sm',
            onclick: async () => {
              const ok = await confirmDialog('Hapus project ini? Tindakan tidak dapat dibatalkan.', 'Hapus Project');
              if (!ok) return;
              const { error } = await App.supabase.from('projects').delete().eq('id', project.id);
              if (error) { toast('Gagal menghapus: ' + error.message, 'error'); return; }
              toast('Project dihapus.', 'success');
              location.hash = '#/project';
            },
          }, [el('i', { class: 'fa-solid fa-trash' }), ' Hapus']),
        ]),
      ]),
      el('h2', { style: 'margin:6px 0;' }, [project.name]),
      el('span', { class: 'badge ' + badgeClass }, [project.status || '-']),
      el('p', { class: 'text-muted', style: 'margin-top:10px;' }, [project.description || 'Tidak ada deskripsi.']),
      el('p', { class: 'text-xs text-muted' }, [
        'Dibuat: ' + fmtDate(project.created_at) + ' • Diperbarui: ' + fmtDate(project.updated_at),
      ]),
    ]);
    container.appendChild(headerCard);

    // Ringkasan jumlah aset yang tertaut ke project ini (kolom project_id,
    // lihat migration 003_project_scope.sql). Jika migration belum dijalankan,
    // query akan gagal dengan aman dan kartu menampilkan '-' (Error State),
    // tanpa mengganggu tampilan detail project di atas.
    const summaryCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [
        el('h3', {}, ['Ringkasan Aset di Project Ini']),
      ]),
    ]);
    const summaryGrid = el('div', { class: 'stat-grid' });
    summaryCard.appendChild(summaryGrid);
    container.appendChild(summaryCard);

    const linkedTables = [
      { key: 'areas', label: 'Area', icon: 'fa-draw-polygon' },
      { key: 'homes', label: 'Rumah', icon: 'fa-house' },
      { key: 'poles', label: 'Tiang', icon: 'fa-tower-cell' },
      { key: 'odc', label: 'ODC', icon: 'fa-server' },
      { key: 'odp', label: 'ODP', icon: 'fa-diagram-project' },
      { key: 'pops', label: 'POP', icon: 'fa-satellite-dish' },
    ];
    linkedTables.forEach((t) => {
      const valueEl = el('div', { class: 'stat-value' }, ['…']);
      const card = el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-icon' }, [el('i', { class: `fa-solid ${t.icon}` })]),
        el('div', {}, [valueEl, el('div', { class: 'stat-label' }, [t.label])]),
      ]);
      summaryGrid.appendChild(card);
      App.supabase.from(t.key).select('*', { count: 'exact', head: true }).eq('project_id', projectId)
        .then(({ count, error }) => { valueEl.textContent = error ? '-' : fmtNumber(count || 0); })
        .catch(() => { valueEl.textContent = '-'; });
    });

    container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('p', { class: 'text-xs text-muted' }, [
        'Catatan: penyaringan otomatis modul Area/Rumah/Tiang/ODC/ODP/POP berdasarkan project ' +
        'ini akan diaktifkan bertahap pada implementasi berikutnya (perlu penyesuaian filter di ' +
        'masing-masing modul aset). Untuk saat ini gunakan tombol import KMZ pada halaman Mapping ' +
        'lalu pilih project ini agar data baru otomatis tertaut.',
      ]),
    ]));
  });

  /* ================= [SMART PLANNING] FONDASI (IMPLEMENTATION 01.5) =================
     Modul BARU, additive. Status: COMING SOON / DISABLED — belum dapat digunakan.
     Tahap ini hanya PONDASI: menampilkan status Planning Engine (window.PlanningEngine
     dari planning-engine.js) dan daftar service stub. BELUM ada AI/Auto Planning
     (itu Implementation 02). Tidak mengubah modul/route/menu yang sudah ada. */
  registerModule('smart-planning', async function renderSmartPlanning(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';

    const engine = window.PlanningEngine || null;
    const meta = engine && typeof engine.describe === 'function' ? engine.describe() : null;

    // Header: status AKTIF (FIX #E3 — sebelumnya "Coming Soon" walau Wizard sudah bekerja).
    container.appendChild(el('div', { class: 'card empty-state' }, [
      el('i', { class: 'fa-solid fa-wand-magic-sparkles' }),
      el('h3', {}, [
        'Smart Planning ',
        el('span', { class: 'badge badge-success', style: 'margin-left:8px;vertical-align:middle;' }, ['Aktif']),
      ]),
      el('p', { class: 'text-muted' }, [
        'Auto Detect Building, Auto ODP/ODC (1:8 / 1:4), Auto Backbone/Distribution/Tiang, dan Auto BOQ & Proposal ' +
        'sudah aktif melalui Smart Planning Wizard (Import → Analisa Area → Generate → Review → Approval).',
      ]),
      el('p', { class: 'text-xs text-muted' }, [
        'Planning Engine (fondasi): ' + (engine ? ('v' + engine.version) : 'belum termuat') +
        ' · Logika auto-analisa & auto-generate berjalan lewat planning-analyzers.js / planning-generators.js.',
      ]),
      el('button', { class: 'btn btn-primary btn-sm', style: 'margin-top:10px;', onclick: () => { location.hash = '#/planning-wizard?step=1'; } }, [el('i', { class: 'fa-solid fa-arrow-right' }), ' Buka Smart Planning Wizard']),
    ]));

    // Daftar service Planning Engine (read-only) — memakai class tabel yang sudah ada.
    if (meta && meta.services && meta.services.length) {
      const wrap = el('div', { class: 'table-wrap', style: 'margin-top:16px;' });
      const table = el('table', { class: 'data-table' });
      table.appendChild(el('thead', {}, [
        el('tr', {}, ['#', 'Service', 'Keterangan', 'Status'].map((h) => el('th', {}, [h]))),
      ]));
      const tbody = el('tbody');
      const svcObjs = (engine && engine.services) || {};
      meta.services.forEach((s, i) => {
        const so = svcObjs[s.id] || {};
        const active = so.phase1 === 'active' || so.phase2 === 'active';
        const label = so.phase2 === 'active' ? 'aktif (Phase 2)' : (so.phase1 === 'active' ? 'aktif (Phase 1)' : 'stub');
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [String(i + 1)]),
          el('td', {}, [el('span', { style: 'font-weight:600;' }, [s.title])]),
          el('td', {}, [el('span', { class: 'text-xs text-muted' }, [s.description])]),
          el('td', {}, [active
            ? el('span', { class: 'badge badge-success' }, [label])
            : el('span', { class: 'badge badge-neutral' }, ['stub'])]),
        ]));
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Struktur Planning Engine'])]),
        wrap,
        el('p', { class: 'text-xs text-muted', style: 'margin-top:10px;' }, [
          'Semua service di atas masih berupa placeholder (stub). Logika sebenarnya ' +
          'akan diisi pada Implementation 02 tanpa membongkar aplikasi ini.',
        ]),
      ]));
    }
  });

  /* Menu "Smart Planning" (Coming Soon / Disabled).
     Ditambahkan secara additive ke sidebar. Idempotent & aman: kalau nanti item
     ini dipindahkan ke CFG.NAV_GROUPS (config.js), injector otomatis melewati
     (tidak menduplikasi). Item tampil sebagai disabled dan TIDAK menavigasi —
     klik hanya memunculkan toast "Coming Soon", sesuai status "belum dapat digunakan". */
  function injectSmartPlanningNav() {
    const nav = $('#sidebar-nav');
    if (!nav) return;
    // Jangan duplikasi bila route ini sudah punya nav-item (mis. dari config.js).
    if (nav.querySelector('[data-route="smart-planning"]')) return;

    const item = el('div', {
      class: 'nav-item',
      'data-route': 'smart-planning',
      title: 'Smart Planning — Auto Analisa & Auto Generate (buka Wizard)',
    }, [
      el('span', { style: 'display:inline-flex;align-items:center;gap:10px;' }, [
        el('i', { class: 'fa-solid fa-wand-magic-sparkles' }),
        el('span', { class: 'nav-item-label' }, ['Smart Planning']),
      ]),
    ]);
    // FIX #E3: engine otomatis (analisa area + auto ODP/ODC/backbone/BOQ) SUDAH aktif
    // lewat Planning Wizard. Item ini dulunya disabled & hanya menampilkan toast
    // "Coming Soon" — sekarang mengarah langsung ke Wizard supaya tidak membingungkan.
    item.addEventListener('click', () => { location.hash = '#/planning-wizard?step=1'; });

    // Menu "Planning Summary" (AKTIF sejak Implementation 02 Phase 1 — Analisa Area).
    const summaryItem = el('div', {
      class: 'nav-item', 'data-route': 'planning-summary',
      title: 'Planning Summary — hasil Analisa Area',
    }, [
      el('i', { class: 'fa-solid fa-chart-area' }),
      el('span', { class: 'nav-item-label' }, ['Planning Summary']),
    ]);
    summaryItem.addEventListener('click', () => { location.hash = '#/planning-summary'; });
    ROUTE_TITLES['planning-summary'] = 'Planning Summary';

    // Menu "Smart Planning Wizard" (AKTIF sejak Implementation 03 Phase 2 — Auto Network Planning).
    const wizardItem = el('div', {
      class: 'nav-item', 'data-route': 'planning-wizard',
      title: 'Smart Planning Wizard — Generate draft jaringan FTTH',
    }, [
      el('i', { class: 'fa-solid fa-diagram-project' }),
      el('span', { class: 'nav-item-label' }, ['Planning Wizard']),
    ]);
    wizardItem.addEventListener('click', () => { location.hash = '#/planning-wizard?step=1'; });

    // Menu tahap FINAL (Implementation 04): Validation, Versi, Reports.
    const mkItem = (route, icon, label, hash) => {
      const it = el('div', { class: 'nav-item', 'data-route': route, title: label }, [el('i', { class: 'fa-solid ' + icon }), el('span', { class: 'nav-item-label' }, [label])]);
      it.addEventListener('click', () => { location.hash = hash; });
      return it;
    };
    const validationItem = mkItem('planning-validation', 'fa-clipboard-check', 'Validation', '#/planning-validation');
    const versionsItem = mkItem('planning-versions', 'fa-layer-group', 'Versi Planning', '#/planning-versions');
    const reportsItem = mkItem('planning-reports', 'fa-file-lines', 'Reports & Export', '#/planning-reports');
    const proposalItem = mkItem('planning-proposal', 'fa-file-contract', 'Proposal & BOQ Final', '#/planning-proposal');
    const assetMgmtItem = mkItem('asset-management', 'fa-toolbox', 'Asset Management', '#/asset-management');
    const globalMapItem = mkItem('global-map', 'fa-earth-asia', 'Global Map', '#/global-map');
    const assetReportsItem = mkItem('asset-reports', 'fa-file-shield', 'Asset & QC Reports', '#/asset-reports');
    const backupItem = mkItem('backup-restore', 'fa-database', 'Backup & Restore', '#/backup-restore');
    const detectedItem = mkItem('detected-buildings', 'fa-buildings', 'Detected Buildings', '#/detected-buildings');

    // Taruh dalam grup tersendiri di paling bawah agar tidak menggeser menu lain.
    const group = el('div', { class: 'nav-group' }, [
      el('div', { class: 'nav-group-title' }, ['Smart FTTH']),
    ]);
    group.appendChild(item);
    if (!nav.querySelector('[data-route="detected-buildings"]')) group.appendChild(detectedItem);
    if (!nav.querySelector('[data-route="planning-wizard"]')) group.appendChild(wizardItem);
    if (!nav.querySelector('[data-route="planning-summary"]')) group.appendChild(summaryItem);
    if (!nav.querySelector('[data-route="planning-validation"]')) group.appendChild(validationItem);
    if (!nav.querySelector('[data-route="planning-versions"]')) group.appendChild(versionsItem);
    if (!nav.querySelector('[data-route="planning-reports"]')) group.appendChild(reportsItem);
    if (!nav.querySelector('[data-route="planning-proposal"]')) group.appendChild(proposalItem);
    if (!nav.querySelector('[data-route="asset-management"]')) group.appendChild(assetMgmtItem);
    if (!nav.querySelector('[data-route="global-map"]')) group.appendChild(globalMapItem);
    if (!nav.querySelector('[data-route="asset-reports"]')) group.appendChild(assetReportsItem);
    if (!nav.querySelector('[data-route="backup-restore"]')) group.appendChild(backupItem);
    nav.appendChild(group);
  }
  App.injectSmartPlanningNav = injectSmartPlanningNav;

  /* ================= [SMART PLANNING] ANALISA AREA + PLANNING SUMMARY (IMPL. 02 PHASE 1) =================
     Additive. Mengimplementasikan tahap ANALISA AREA memakai window.PlanningEngine
     (planning-analyzers.js). Boundary diambil dari polygon yang sedang dimuat di
     peta (hasil Import KMZ/KML atau gambar polygon) — sesuai flow bisnis
     Project → Import → Boundary/Building/Road/Coverage Analyzer → Planning Summary.
     Tidak membuat Auto ODP/ODC/Backbone/Pole/BOQ/Proposal/AI (itu fase berikutnya). */

  // Ambil FeatureCollection polygon dari layer-layer peta yang sedang aktif.
  function getBoundaryFromMap() {
    if (!App.mapLayers) return null;
    const feats = [];
    Object.values(App.mapLayers).forEach((layer) => {
      if (!layer || typeof layer.toGeoJSON !== 'function') return;
      let gj;
      try { gj = layer.toGeoJSON(); } catch (e) { return; }
      const list = gj.type === 'FeatureCollection' ? gj.features : [gj];
      list.forEach((f) => {
        const g = f && (f.geometry || f);
        if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) feats.push(f.type === 'Feature' ? f : { type: 'Feature', properties: {}, geometry: g });
      });
    });
    return feats.length ? { type: 'FeatureCollection', features: feats } : null;
  }

  // Simpan hasil analisa ke Supabase (planning_analysis + child). Mengembalikan
  // id analysis, atau null bila tabel belum ada / gagal (tetap lanjut tampil).
  async function saveAnalysisToDb(projectId, result) {
    try {
      const header = {
        project_id: projectId || null,
        planner: (App.profile && App.profile.full_name) || 'Pengguna',
        created_by: (App.session && App.session.user && App.session.user.id) || null,
        status: 'done',
        engine_version: result.engineVersion,
        area_sqm: Math.round(result.boundary.area_sqm),
        perimeter_m: Math.round(result.boundary.perimeter_m),
        bbox: result.boundary.bbox,
        coordinate_system: result.boundary.coordinate_system,
        boundary_type: result.boundary.type,
        boundary_geojson: result.boundary.feature,
        building_count: result.coverage.building_count,
        home_count: result.coverage.home_count,
        non_home_count: result.coverage.non_home_count,
        road_count: result.roads.road_count,
        road_segment_count: result.roads.total_segments,
        road_length_m: result.roads.total_length_m,
        intersection_count: result.roads.intersection_count,
        density_per_km2: result.coverage.density_per_km2,
        coverage_percent: result.coverage.coverage_percent,
        provider_building: result.providers.building,
        provider_road: result.providers.road,
        analyzed_at: result.analyzedAt,
      };
      const { data, error } = await App.supabase.from('planning_analysis').insert(header).select('id').single();
      if (error) throw error;
      const analysisId = data.id;
      await App.supabase.from('building_analysis').insert({
        analysis_id: analysisId, provider: result.buildings.provider, total: result.buildings.total,
        homes: result.buildings.homes, non_homes: result.buildings.nonHomes,
        density_per_km2: result.buildings.density_per_km2, geojson: result.buildings.featureCollection,
      });
      await App.supabase.from('road_analysis').insert({
        analysis_id: analysisId, provider: result.roads.provider, road_count: result.roads.road_count,
        total_segments: result.roads.total_segments, total_length_m: result.roads.total_length_m,
        intersection_count: result.roads.intersection_count, road_types: result.roads.road_types,
        geojson: result.roads.featureCollection,
      });
      await App.supabase.from('coverage_analysis').insert({
        analysis_id: analysisId, building_count: result.coverage.building_count, home_count: result.coverage.home_count,
        non_home_count: result.coverage.non_home_count, area_sqm: result.coverage.area_sqm,
        road_length_m: result.coverage.road_length_m, density_per_km2: result.coverage.density_per_km2,
        coverage_percent: result.coverage.coverage_percent,
      });
      return analysisId;
    } catch (err) {
      console.warn('[Analisa Area] gagal menyimpan ke DB (tabel belum ada?):', err.message);
      return null;
    }
  }

  // Simpan hasil terakhir di memori sebagai fallback bila DB belum siap.
  App._lastAnalysis = null;

  // Inti analisa (dipakai tombol Analisa Area & Wizard). Return {result, analysisId} atau null.
  async function performBoundaryAnalysis(projectId) {
    const engine = window.PlanningEngine;
    if (!engine || typeof engine.analyze !== 'function') { toast('Planning Engine belum termuat (planning-analyzers.js).', 'error'); return null; }
    const boundary = getBoundaryFromMap();
    if (!boundary) {
      toast('Belum ada polygon di peta. Import KMZ/KML atau gambar polygon dulu di halaman Map.', 'warning', 5000);
      return null;
    }
    toast('Menganalisa area...', 'info');
    let result;
    try { result = await engine.analyze(boundary, {}); }
    catch (err) { console.error(err); toast('Analisa gagal: ' + err.message, 'error'); return null; }
    App._lastAnalysis = { projectId: projectId || null, result };
    const analysisId = await saveAnalysisToDb(projectId, result);
    if (analysisId) { App._lastAnalysis.id = analysisId; toast('Analisa selesai & tersimpan.', 'success'); }
    else { toast('Analisa selesai (belum tersimpan — jalankan migration 005).', 'warning', 5000); }
    // Revision 01: buat record per-bangunan ke detected_buildings (bukan tabel homes).
    if (analysisId) { try { const n = await saveDetectedBuildings(analysisId, projectId, result.buildings.featureCollection); if (n) toast(fmtNumber(n) + ' bangunan tersimpan ke Detected Buildings.', 'info', 4000); } catch (e) { console.warn('[DetectedBuildings]', e && e.message); } }
    return { result, analysisId };
  }
  App.performBoundaryAnalysis = performBoundaryAnalysis;

  // Simpan hasil deteksi bangunan (chunked). Return jumlah tersimpan | 0.
  async function saveDetectedBuildings(analysisId, projectId, buildingsFC) {
    const gen = window.PlanningEngine && window.PlanningEngine.generators;
    if (!gen || typeof gen.buildDetectedRecords !== 'function') return 0;
    const recs = gen.buildDetectedRecords(buildingsFC, {});
    if (!recs.length) return 0;
    const planner = (App.profile && App.profile.full_name) || 'Pengguna';
    const createdBy = (App.session && App.session.user) ? App.session.user.id : null;
    const rows = recs.map((r) => Object.assign({ analysis_id: analysisId, project_id: projectId || null, planner, created_by: createdBy }, r));
    let saved = 0;
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await App.supabase.from('detected_buildings').insert(rows.slice(i, i + 500));
        if (error) throw error;
        saved += Math.min(500, rows.length - i);
      }
    } catch (err) { console.warn('[DetectedBuildings] gagal simpan (migration 008?):', err.message); return 0; }
    return saved;
  }
  App.saveDetectedBuildings = saveDetectedBuildings;

  // Entry point tombol "Analisa Area". projectId opsional.
  async function runAreaAnalysis(projectId) {
    const out = await performBoundaryAnalysis(projectId);
    if (!out) { if (!getBoundaryFromMap()) location.hash = '#/mapping'; return; }
    location.hash = out.analysisId ? ('#/planning-summary?analysis=' + out.analysisId) : '#/planning-summary';
  }
  App.runAreaAnalysis = runAreaAnalysis;

  // ---- Modul Planning Summary (route: #/planning-summary?analysis=<id>|?project=<id>) ----
  registerModule('planning-summary', async function renderPlanningSummary(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';
    $('#page-toolbar').appendChild(el('div', { class: 'table-toolbar' }, [
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => runAreaAnalysis(App._lastAnalysis && App._lastAnalysis.projectId) }, [
        el('i', { class: 'fa-solid fa-wand-magic-sparkles' }), ' Analisa Area',
      ]),
      el('button', { class: 'btn btn-secondary btn-sm', style: 'margin-left:8px;', onclick: () => { location.hash = '#/mapping'; } }, [
        el('i', { class: 'fa-solid fa-map' }), ' Buka Map',
      ]),
    ]));

    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const analysisId = qs.get('analysis');
    const projectId = qs.get('project');

    // 1) Coba muat dari DB; 2) fallback ke hasil di memori; 3) daftar/empty.
    let analysis = null, buildingGeo = null, roadGeo = null;
    try {
      let q = App.supabase.from('planning_analysis').select('*').order('analyzed_at', { ascending: false }).limit(1);
      if (analysisId) q = App.supabase.from('planning_analysis').select('*').eq('id', analysisId).limit(1);
      else if (projectId) q = App.supabase.from('planning_analysis').select('*').eq('project_id', projectId).order('analyzed_at', { ascending: false }).limit(1);
      const { data, error } = await q;
      if (error) throw error;
      analysis = (data && data[0]) || null;
      if (analysis) {
        const [{ data: bd }, { data: rd }] = await Promise.all([
          App.supabase.from('building_analysis').select('geojson').eq('analysis_id', analysis.id).limit(1),
          App.supabase.from('road_analysis').select('geojson').eq('analysis_id', analysis.id).limit(1),
        ]);
        buildingGeo = bd && bd[0] && bd[0].geojson; roadGeo = rd && rd[0] && rd[0].geojson;
      }
    } catch (err) {
      // Tabel belum ada → gunakan hasil memori bila ada.
    }

    if (!analysis && App._lastAnalysis && App._lastAnalysis.result) {
      const r = App._lastAnalysis.result;
      analysis = {
        id: App._lastAnalysis.id || null, project_id: App._lastAnalysis.projectId, planner: (App.profile && App.profile.full_name) || 'Pengguna',
        status: 'done (belum tersimpan)', area_sqm: Math.round(r.boundary.area_sqm), perimeter_m: Math.round(r.boundary.perimeter_m),
        coordinate_system: r.boundary.coordinate_system, boundary_type: r.boundary.type, boundary_geojson: r.boundary.feature,
        building_count: r.coverage.building_count, home_count: r.coverage.home_count, non_home_count: r.coverage.non_home_count,
        road_count: r.roads.road_count, road_segment_count: r.roads.total_segments, road_length_m: r.roads.total_length_m,
        intersection_count: r.roads.intersection_count, density_per_km2: r.coverage.density_per_km2, coverage_percent: r.coverage.coverage_percent,
        provider_building: r.providers.building, provider_road: r.providers.road, analyzed_at: r.analyzedAt,
      };
      buildingGeo = r.buildings.featureCollection; roadGeo = r.roads.featureCollection;
    }

    if (!analysis) {
      container.appendChild(el('div', { class: 'card empty-state' }, [
        el('i', { class: 'fa-solid fa-chart-area' }),
        el('h3', {}, ['Belum ada hasil Analisa Area']),
        el('p', { class: 'text-muted' }, ['Import KMZ/KML polygon di halaman Map, lalu klik "Analisa Area".']),
        el('button', { class: 'btn btn-primary btn-sm', style: 'margin-top:10px;', onclick: () => { location.hash = '#/mapping'; } }, ['Buka Map']),
      ]));
      return;
    }

    // Ambil nama project bila ada.
    let projectName = '-';
    if (analysis.project_id) {
      try { const { data: p } = await App.supabase.from('projects').select('name').eq('id', analysis.project_id).single(); if (p) projectName = p.name; } catch (e) {}
    }

    // ---- Kartu ringkasan ----
    const stat = (label, value, icon) => el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-icon' }, [el('i', { class: 'fa-solid ' + icon })]),
      el('div', {}, [el('div', { class: 'stat-value' }, [value]), el('div', { class: 'stat-label' }, [label])]),
    ]);
    const km2 = (analysis.area_sqm / 1e6).toFixed(3);
    const grid = el('div', { class: 'stat-grid' }, [
      stat('Luas Area (km²)', km2, 'fa-draw-polygon'),
      stat('Jumlah Bangunan', fmtNumber(analysis.building_count), 'fa-building'),
      stat('Jumlah Rumah', fmtNumber(analysis.home_count), 'fa-house'),
      stat('Bangunan Non-Rumah', fmtNumber(analysis.non_home_count), 'fa-store'),
      stat('Jumlah Jalan', fmtNumber(analysis.road_count), 'fa-road'),
      stat('Panjang Jalan (m)', fmtNumber(analysis.road_length_m), 'fa-ruler-horizontal'),
      stat('Coverage (%)', (analysis.coverage_percent != null ? analysis.coverage_percent : '-') + '', 'fa-wifi'),
      stat('Density (/km²)', (analysis.density_per_km2 != null ? analysis.density_per_km2 : '-') + '', 'fa-layer-group'),
    ]);
    container.appendChild(grid);

    // ---- Detail + status ----
    const infoRows = [
      ['Nama Project', projectName],
      ['Planner', analysis.planner || '-'],
      ['Status Analisa', analysis.status || 'done'],
      ['Tanggal Analisa', fmtDate(analysis.analyzed_at)],
      ['Perimeter (m)', fmtNumber(analysis.perimeter_m)],
      ['Tipe Boundary', analysis.boundary_type || '-'],
      ['Coordinate System', analysis.coordinate_system || '-'],
      ['Segmen Jalan', fmtNumber(analysis.road_segment_count)],
      ['Persimpangan', fmtNumber(analysis.intersection_count)],
      ['Provider Bangunan', analysis.provider_building || '-'],
      ['Provider Jalan', analysis.provider_road || '-'],
    ];
    const infoTable = el('table', { class: 'data-table' }, [
      el('tbody', {}, infoRows.map((r) => el('tr', {}, [
        el('td', { style: 'color:var(--color-text-secondary);width:42%;' }, [r[0]]),
        el('td', { style: 'font-weight:600;' }, [String(r[1])]),
      ]))),
    ]);
    container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Detail Analisa'])]),
      el('div', { class: 'table-wrap' }, [infoTable]),
    ]));

    // ---- Peta hasil dengan layer yang dapat diaktif/nonaktifkan ----
    const mapCard = el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Peta Hasil Analisa'])]),
    ]);
    const mapEl = el('div', { id: 'summary-map', style: 'height:420px;border-radius:10px;overflow:hidden;' });
    const layerBar = el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;' });
    mapCard.appendChild(layerBar);
    mapCard.appendChild(mapEl);
    container.appendChild(mapCard);

    // Bangun peta (instance terpisah dari modul Mapping — additive, dibersihkan di destroy).
    setTimeout(() => {
      if (!window.L) return;
      if (App.summaryMap) { try { App.summaryMap.remove(); } catch (e) {} App.summaryMap = null; }
      const map = L.map(mapEl, { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
      App.summaryMap = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 20 }).addTo(map);

      const layers = {};
      // Boundary
      if (analysis.boundary_geojson) {
        layers.Boundary = L.geoJSON(analysis.boundary_geojson, { style: { color: '#1F3A5F', weight: 2, fill: false } });
      }
      // Coverage (boundary diisi warna berdasarkan coverage%)
      if (analysis.boundary_geojson) {
        const cov = analysis.coverage_percent || 0;
        const covColor = cov >= 66 ? '#1E7B4D' : (cov >= 33 ? '#9A6700' : '#B3261E');
        layers.Coverage = L.geoJSON(analysis.boundary_geojson, { style: { color: covColor, weight: 1, fillColor: covColor, fillOpacity: 0.18 } });
      }
      // Buildings
      if (buildingGeo) {
        layers.Building = L.geoJSON(buildingGeo, {
          pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3, weight: 0, fillOpacity: 0.85, fillColor: (f.properties && f.properties.type === 'non_home') ? '#9A6700' : '#0B6E99' }),
          style: (f) => ({ color: (f.properties && f.properties.type === 'non_home') ? '#9A6700' : '#0B6E99', weight: 1, fillOpacity: 0.3 }),
        });
      }
      // Roads
      if (roadGeo) {
        layers.Road = L.geoJSON(roadGeo, { style: { color: '#6B4FA0', weight: 2 } });
      }

      // Tambahkan semua & buat toggle.
      const order = ['Boundary', 'Coverage', 'Road', 'Building'];
      order.forEach((name) => {
        const lyr = layers[name]; if (!lyr) return;
        lyr.addTo(map);
        const cb = el('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;' }, [
          el('input', { type: 'checkbox', checked: 'checked', onchange: (e) => { if (e.target.checked) map.addLayer(lyr); else map.removeLayer(lyr); } }),
          el('span', {}, [name]),
        ]);
        layerBar.appendChild(cb);
      });

      try {
        const b = layers.Boundary || layers.Coverage;
        if (b) map.fitBounds(b.getBounds(), { maxZoom: 17 });
      } catch (e) {}
      setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 200);
    }, 60);

    container.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin-top:12px;' }, [
      'Coverage % pada tahap analisa = homepass ratio (rumah ÷ total bangunan). Coverage berbasis ' +
      'radius layanan ODP dihitung pada tahap generate (fase berikutnya). Provider bangunan/jalan ' +
      'dapat diganti (mock/overpass) tanpa mengubah kode analyzer.',
    ]));
  }, function destroyPlanningSummary() {
    if (App.summaryMap) { try { App.summaryMap.remove(); } catch (e) {} App.summaryMap = null; }
  });

  /* ================= [SMART PLANNING] AUTO NETWORK PLANNING (IMPL. 03 PHASE 2) =================
     Wizard 5 langkah (Import → Analisa → Generate → Review → Approval), generate draft
     jaringan (Home Passed, ODP 1:8, ODC 1:4, Backbone, Distribution, Tiang, BOQ) memakai
     window.PlanningEngine (planning-generators.js), plus Review Mode (geser/tambah/hapus
     ODP & ODC, regenerate jalur & BOQ). Additive; tidak mengubah modul lama. */

  // Parameter planning (dapat diubah planner; default dari CFG.PLANNING bila ada).
  App.planningParams = Object.assign(
    { odpCapacity: 8, odcCapacity: 4, poleSpanM: 40, handholeSpanM: 200 },
    (CFG && CFG.PLANNING) || {}
  );
  App._lastGeneration = null;   // { analysisId, projectId, gen }
  App._review = null;           // state review mode

  // Muat bundle analisa (row + geojson bangunan/jalan/boundary) untuk generate/review.
  async function loadAnalysisBundle(analysisId) {
    try {
      const { data: rows, error } = await App.supabase.from('planning_analysis').select('*').eq('id', analysisId).limit(1);
      if (error) throw error;
      const row = rows && rows[0]; if (!row) return null;
      const [{ data: bd }, { data: rd }] = await Promise.all([
        App.supabase.from('building_analysis').select('geojson').eq('analysis_id', analysisId).limit(1),
        App.supabase.from('road_analysis').select('geojson').eq('analysis_id', analysisId).limit(1),
      ]);
      return {
        row,
        boundaryFC: row.boundary_geojson,
        buildingsFC: (bd && bd[0] && bd[0].geojson) || { type: 'FeatureCollection', features: [] },
        roadsFC: (rd && rd[0] && rd[0].geojson) || { type: 'FeatureCollection', features: [] },
      };
    } catch (e) { return null; }
  }

  // Bangun input generate dari memori (hasil analyze) atau dari DB bundle.
  async function buildGenerateInput(analysisId) {
    if (App._lastAnalysis && App._lastAnalysis.result && (!analysisId || App._lastAnalysis.id === analysisId)) {
      const r = App._lastAnalysis.result;
      return { input: { boundary: { area_sqm: r.boundary.area_sqm, feature: r.boundary.feature }, buildings: { featureCollection: r.buildings.featureCollection }, roads: { featureCollection: r.roads.featureCollection } }, projectId: App._lastAnalysis.projectId, analysisId: App._lastAnalysis.id };
    }
    if (analysisId) {
      const b = await loadAnalysisBundle(analysisId);
      if (b) return { input: { boundary: { area_sqm: b.row.area_sqm, feature: b.boundaryFC }, buildings: { featureCollection: b.buildingsFC }, roads: { featureCollection: b.roadsFC } }, projectId: b.row.project_id, analysisId };
    }
    return null;
  }

  // Simpan hasil generate (append-only, generation_id baru). Return generation_id | null.
  async function saveGenerationToDb(analysisId, projectId, gen, status) {
    if (!analysisId) return null;
    const gid = gen.generation_id;
    const planner = (App.profile && App.profile.full_name) || 'Pengguna';
    try {
      await App.supabase.from('planning_home').insert({
        analysis_id: analysisId, generation_id: gid, planner, generated_at: gen.generated_at,
        building_count: gen.stats.building_count, home_count: gen.stats.home_count, non_home_count: gen.stats.non_home_count,
        apartment_count: gen.stats.apartment_count, ruko_count: gen.stats.ruko_count, gedung_count: gen.stats.gedung_count,
        other_count: gen.stats.other_count, home_passed: gen.stats.home_passed, coverage_percent: gen.stats.coverage_percent,
        density_per_km2: gen.stats.density_per_km2, geojson: gen.buildingsFC,
      });
      if (gen.odps.length) await App.supabase.from('planning_odp').insert(gen.odps.map((o) => ({
        analysis_id: analysisId, generation_id: gid, odp_id: o.odp_id, lat: o.lat, lng: o.lng,
        home_count: o.home_count, home_ids: o.home_ids, coverage_radius_m: o.coverage_radius_m,
      })));
      if (gen.odcs.length) await App.supabase.from('planning_odc').insert(gen.odcs.map((o) => ({
        analysis_id: analysisId, generation_id: gid, odc_id: o.odc_id, lat: o.lat, lng: o.lng,
        odp_count: o.odp_count, odp_ids: o.odp_ids,
      })));
      await App.supabase.from('planning_backbone').insert({ analysis_id: analysisId, generation_id: gid, length_m: gen.backbone.length_m, segment_count: gen.backbone.segment_count, geojson: gen.backbone.featureCollection });
      await App.supabase.from('planning_distribution').insert({ analysis_id: analysisId, generation_id: gid, length_m: gen.distribution.length_m, segment_count: gen.distribution.segment_count, geojson: gen.distribution.featureCollection });
      await App.supabase.from('planning_boq').insert(Object.assign({ analysis_id: analysisId, generation_id: gid, status: status || 'draft' }, gen.boq, { items: gen.boq.items }));
      return gid;
    } catch (err) { console.warn('[Generate] gagal simpan (migration 006?):', err.message); return null; }
  }

  // Jalankan generate untuk sebuah analysisId.
  async function runGenerate(analysisId) {
    const engine = window.PlanningEngine;
    if (!engine || typeof engine.generate !== 'function') { toast('Planning generators belum termuat.', 'error'); return null; }
    const built = await buildGenerateInput(analysisId);
    if (!built) { toast('Analisa belum tersedia. Jalankan Analisa Area dulu.', 'warning'); return null; }
    toast('Membuat draft perencanaan...', 'info');
    let gen;
    try { gen = engine.generate(built.input, App.planningParams); }
    catch (err) { console.error(err); toast('Generate gagal: ' + err.message, 'error'); return null; }
    gen._roadsFC = built.input.roads.featureCollection;
    const gid = await saveGenerationToDb(built.analysisId, built.projectId, gen, 'draft');
    App._lastGeneration = { analysisId: built.analysisId, projectId: built.projectId, gen, savedId: gid };
    toast(gid ? 'Draft perencanaan dibuat & tersimpan.' : 'Draft dibuat (belum tersimpan — jalankan migration 006).', gid ? 'success' : 'warning', 4500);
    return App._lastGeneration;
  }
  App.runGenerate = runGenerate;

  // ---------- WIZARD ----------
  const WIZARD_STEPS = ['Import KMZ', 'Analisa Area', 'Generate Planning', 'Planner Review', 'Approval'];
  ROUTE_TITLES['planning-wizard'] = 'Smart Planning Wizard';

  function wizardHash(step, analysisId) { return '#/planning-wizard?step=' + step + (analysisId ? ('&analysis=' + analysisId) : ''); }

  function renderStepper(current, analysisId) {
    return el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;' }, WIZARD_STEPS.map((label, i) => {
      const n = i + 1; const active = n === current; const done = n < current;
      return el('button', {
        class: 'btn btn-sm ' + (active ? 'btn-primary' : 'btn-secondary'),
        style: 'opacity:' + (done || active ? '1' : '0.7') + ';',
        onclick: () => { location.hash = wizardHash(n, analysisId); },
      }, [el('span', { style: 'font-weight:700;' }, [String(n)]), '  ' + label]);
    }));
  }

  function paramInput(id, label, value, hint) {
    return el('div', { style: 'display:flex;flex-direction:column;gap:4px;min-width:150px;' }, [
      el('label', { class: 'text-xs text-muted', for: id }, [label]),
      el('input', { id, type: 'number', min: '1', value: String(value), class: 'text-input' }),
      hint ? el('span', { class: 'text-xs text-muted' }, [hint]) : null,
    ]);
  }

  registerModule('planning-wizard', async function renderWizard(container) {
    container.innerHTML = '';
    $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    let step = parseInt(qs.get('step') || '1', 10); if (!(step >= 1 && step <= 5)) step = 1;
    let analysisId = qs.get('analysis') || (App._lastAnalysis && App._lastAnalysis.id) || (App._lastGeneration && App._lastGeneration.analysisId) || null;

    container.appendChild(renderStepper(step, analysisId));
    const body = el('div', {});
    container.appendChild(body);

    // ---- STEP 1: IMPORT ----
    if (step === 1) {
      const boundary = getBoundaryFromMap();
      const n = boundary ? boundary.features.length : 0;
      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Step 1 — Import KMZ/KML'])]),
        el('p', { class: 'text-muted' }, ['Import polygon area di halaman Map (KMZ/KML/GeoJSON) atau gambar polygon. Boundary inilah dasar seluruh perencanaan.']),
        el('p', {}, [n ? el('span', { class: 'badge badge-success' }, [n + ' polygon terdeteksi di peta']) : el('span', { class: 'badge badge-warning' }, ['Belum ada polygon di peta'])]),
        el('div', { style: 'display:flex;gap:8px;margin-top:8px;' }, [
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/mapping'; } }, [el('i', { class: 'fa-solid fa-map' }), ' Buka Map & Import']),
          el('button', { class: 'btn btn-primary btn-sm', disabled: n ? null : 'disabled', onclick: () => { location.hash = wizardHash(2, analysisId); } }, ['Lanjut →']),
        ]),
      ]));
    }

    // ---- STEP 2: ANALISA ----
    if (step === 2) {
      const have = App._lastAnalysis && App._lastAnalysis.result;
      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Step 2 — Analisa Area'])]),
        el('p', { class: 'text-muted' }, ['Sistem menghitung boundary, bangunan, jalan, dan coverage sebagai dasar generate.']),
      ]);
      if (have) {
        const r = App._lastAnalysis.result;
        card.appendChild(el('p', {}, [el('span', { class: 'badge badge-success' }, ['Analisa tersedia']),
          '  Bangunan: ' + fmtNumber(r.buildings.total) + ' · Rumah: ' + fmtNumber(r.buildings.homes) + ' · Jalan: ' + fmtNumber(r.roads.total_length_m) + ' m']));
      }
      card.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:8px;' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const out = await performBoundaryAnalysis(App._lastAnalysis && App._lastAnalysis.projectId); if (out) location.hash = wizardHash(2, out.analysisId); } }, [el('i', { class: 'fa-solid fa-rotate' }), have ? ' Analisa Ulang' : ' Jalankan Analisa']),
        el('button', { class: 'btn btn-primary btn-sm', disabled: have ? null : 'disabled', onclick: () => { location.hash = wizardHash(3, analysisId); } }, ['Lanjut →']),
      ]));
      body.appendChild(card);
    }

    // ---- STEP 3: GENERATE ----
    if (step === 3) {
      const p = App.planningParams;
      const resultBox = el('div', { style: 'margin-top:14px;' });
      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Step 3 — Generate Planning'])]),
        el('p', { class: 'text-muted' }, ['Atur parameter lalu buat draft otomatis (ODP 1:8, ODC 1:4, backbone, distribution, tiang, BOQ). Parameter dapat diubah dan digenerate ulang.']),
        el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;' }, [
          paramInput('pp-odp', 'ODP kapasitas (home)', p.odpCapacity, 'aturan 1:8'),
          paramInput('pp-odc', 'ODC kapasitas (ODP)', p.odcCapacity, 'aturan 1:4'),
          paramInput('pp-span', 'Jarak tiang (m)', p.poleSpanM, 'contoh 40 / 50 / 60'),
          paramInput('pp-handhole', 'Jarak handhole (m)', p.handholeSpanM, ''),
        ]),
        el('div', { style: 'display:flex;gap:8px;' }, [
          el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
            App.planningParams.odpCapacity = parseInt($('#pp-odp').value, 10) || 8;
            App.planningParams.odcCapacity = parseInt($('#pp-odc').value, 10) || 4;
            App.planningParams.poleSpanM = parseInt($('#pp-span').value, 10) || 40;
            App.planningParams.handholeSpanM = parseInt($('#pp-handhole').value, 10) || 200;
            const out = await runGenerate(analysisId);
            if (out) renderGenerateResult(resultBox, out.gen, out.analysisId);
          } }, [el('i', { class: 'fa-solid fa-wand-magic-sparkles' }), ' Generate Draft']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = wizardHash(4, analysisId); }, disabled: (App._lastGeneration ? null : 'disabled') }, ['Lanjut ke Review →']),
        ]),
        resultBox,
      ]));
      if (App._lastGeneration && App._lastGeneration.gen) renderGenerateResult(resultBox, App._lastGeneration.gen, App._lastGeneration.analysisId);
    }

    // ---- STEP 4: REVIEW ----
    if (step === 4) {
      if (!App._lastGeneration || !App._lastGeneration.gen) {
        body.appendChild(el('div', { class: 'card empty-state' }, [
          el('i', { class: 'fa-solid fa-diagram-project' }),
          el('h3', {}, ['Belum ada draft untuk direview']),
          el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = wizardHash(3, analysisId); } }, ['Ke Generate']),
        ]));
      } else {
        renderReviewStep(body, analysisId);
      }
    }

    // ---- STEP 5: APPROVAL ----
    if (step === 5) {
      const g = App._lastGeneration && App._lastGeneration.gen;
      if (!g) { body.appendChild(el('div', { class: 'card empty-state' }, [el('h3', {}, ['Belum ada draft']), el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = wizardHash(3, analysisId); } }, ['Ke Generate'])])); }
      else {
        const card = el('div', { class: 'card' }, [
          el('div', { class: 'card-header' }, [el('h3', {}, ['Step 5 — Approval'])]),
          el('p', { class: 'text-muted' }, ['Tinjau ringkasan akhir lalu setujui draft. Setelah approve, hasil siap masuk tahap export (fase berikutnya).']),
        ]);
        card.appendChild(boqTable(g.boq));
        card.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;' }, [
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = wizardHash(4, analysisId); } }, ['← Kembali ke Review']),
          el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { const v = await createPlanningVersion(); if (v) location.hash = '#/planning-validation?version=' + v.id; } }, [el('i', { class: 'fa-solid fa-code-branch' }), ' Simpan sebagai Versi → Validasi']),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/planning-versions' + (analysisId ? ('?analysis=' + analysisId) : ''); } }, [el('i', { class: 'fa-solid fa-layer-group' }), ' Daftar Versi']),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/planning-reports'; } }, [el('i', { class: 'fa-solid fa-file-lines' }), ' Reports & Export']),
        ]));
        card.appendChild(el('p', { class: 'text-xs text-muted', style: 'margin-top:8px;' }, ['Alur final: simpan sebagai Versi → Planner Validation → Supervisor Approval → Final → Report/Export.']));
        body.appendChild(card);
      }
    }
  }, function destroyWizard() {
    if (App.reviewMap) { try { App.reviewMap.remove(); } catch (e) {} App.reviewMap = null; }
    App._reviewLayers = null;
    stopAutosave();
  });

  // Ringkasan hasil generate (kartu + BOQ).
  function renderGenerateResult(box, gen, analysisId) {
    box.innerHTML = '';
    const s = gen.stats;
    const stat = (label, value) => el('div', { class: 'stat-card' }, [el('div', {}, [el('div', { class: 'stat-value' }, [String(value)]), el('div', { class: 'stat-label' }, [label])])]);
    box.appendChild(el('div', { class: 'stat-grid' }, [
      stat('Home Passed', fmtNumber(s.home_passed)),
      stat('Bangunan', fmtNumber(s.building_count)),
      stat('ODP (1:8)', fmtNumber(gen.odps.length)),
      stat('ODC (1:4)', fmtNumber(gen.odcs.length)),
      stat('Backbone (m)', fmtNumber(gen.backbone.length_m)),
      stat('Distribution (m)', fmtNumber(gen.distribution.length_m)),
      stat('Estimasi Tiang', fmtNumber(gen.poles.count)),
      stat('Coverage %', s.coverage_percent),
    ]));
    box.appendChild(el('div', { class: 'text-xs text-muted', style: 'margin:6px 0;' }, [
      'Kategori bangunan — Rumah: ' + fmtNumber(s.home_count) + ' · Ruko: ' + fmtNumber(s.ruko_count) + ' · Gedung: ' + fmtNumber(s.gedung_count) + ' · Apartemen: ' + fmtNumber(s.apartment_count) + ' · Lainnya: ' + fmtNumber(s.other_count),
    ]));
    box.appendChild(boqTable(gen.boq));
  }

  function boqTable(boq) {
    return el('div', { class: 'table-wrap', style: 'margin-top:10px;' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Item', 'Satuan', 'Jumlah'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, (boq.items || []).map((it) => el('tr', {}, [
          el('td', {}, [it.item]), el('td', {}, [it.unit]), el('td', { style: 'font-weight:600;' }, [fmtNumber(it.quantity)]),
        ]))),
      ]),
    ]);
  }

  // ---------- REVIEW MODE ----------
  function renderReviewStep(body, analysisId) {
    const g = App._lastGeneration.gen;
    // Salin state agar bisa diedit tanpa merusak hasil asli.
    App._review = {
      analysisId: App._lastGeneration.analysisId, projectId: App._lastGeneration.projectId,
      roadsFC: g._roadsFC || { type: 'FeatureCollection', features: [] },
      buildingsFC: g.buildingsFC, homePassedFC: g.homePassedFC,
      odps: g.odps.map((o) => Object.assign({}, o)), odcs: g.odcs.map((o) => Object.assign({}, o)),
      backbone: g.backbone, distribution: g.distribution, poles: g.poles, boq: g.boq,
      addMode: null, mode: 'review', locked: false,
    };
    // REVISION 03: riwayat perubahan ODP/ODC di Review Mode (Undo/Redo).
    // Snapshot ringan (hanya odps/odcs — sumber kebenaran sebelum Regenerate).
    App._reviewHistory = { stack: [cloneOdpOdc(App._review)], index: 0 };
    App._reviewDirty = false;
    startAutosave();

    const card = el('div', { class: 'card' }, [el('div', { class: 'card-header' }, [el('h3', {}, ['Step 4 — Planner Review'])])]);
    const layerBar = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;' });
    const toolBar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;' });
    const mapEl = el('div', { id: 'review-map', style: 'height:460px;border-radius:10px;overflow:hidden;' });
    const boqBox = el('div', { style: 'margin-top:12px;' });
    card.appendChild(el('p', { class: 'text-muted' }, ['Geser marker ODP/ODC untuk memindah, klik marker untuk hapus, atau aktifkan mode tambah. Setelah mengubah, klik "Regenerate Jalur & BOQ".']));
    card.appendChild(toolBar); card.appendChild(layerBar); card.appendChild(mapEl); card.appendChild(boqBox);
    body.appendChild(card);

    const btn = (label, icon, cls, cb) => el('button', { class: 'btn ' + cls + ' btn-sm', onclick: cb }, [el('i', { class: 'fa-solid ' + icon }), ' ' + label]);

    // Mode peta (Planning/Review/Approval) + kunci layer.
    const modeSel = el('select', { class: 'text-input', style: 'max-width:170px;', onchange: (e) => { App._review.mode = e.target.value; toast('Mode peta: ' + e.target.value + (App._review.mode === 'approval' ? ' (baca-saja)' : ''), 'info'); if (App._reviewRedraw) { App._reviewRedraw.odp(); App._reviewRedraw.odc(); } } }, [
      el('option', { value: 'planning' }, ['Planning Mode']),
      el('option', { value: 'review', selected: 'selected' }, ['Review Mode']),
      el('option', { value: 'approval' }, ['Approval Mode (kunci)']),
    ]);
    const lockCb = el('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:12px;' }, [
      el('input', { type: 'checkbox', onchange: (e) => { App._review.locked = e.target.checked; (App._reviewLayerInputs || []).forEach((inp) => { inp.disabled = e.target.checked; }); toast(e.target.checked ? 'Layer & edit dikunci.' : 'Kunci dilepas.', 'info'); if (App._reviewRedraw) { App._reviewRedraw.odp(); App._reviewRedraw.odc(); } } }),
      el('span', {}, ['Kunci layer/edit']),
    ]);
    toolBar.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [modeSel, lockCb]));
    toolBar.appendChild(btn('Tambah ODP', 'fa-plus', 'btn-secondary', () => { if (!reviewEditable()) { toast('Mode saat ini baca-saja/dikunci.', 'warning'); return; } App._review.addMode = App._review.addMode === 'odp' ? null : 'odp'; toast(App._review.addMode ? 'Klik peta untuk menaruh ODP.' : 'Mode tambah dimatikan.', 'info'); }));
    toolBar.appendChild(btn('Tambah ODC', 'fa-plus', 'btn-secondary', () => { if (!reviewEditable()) { toast('Mode saat ini baca-saja/dikunci.', 'warning'); return; } App._review.addMode = App._review.addMode === 'odc' ? null : 'odc'; toast(App._review.addMode ? 'Klik peta untuk menaruh ODC.' : 'Mode tambah dimatikan.', 'info'); }));
    toolBar.appendChild(btn('Undo', 'fa-rotate-left', 'btn-ghost', () => undoReview()));
    toolBar.appendChild(btn('Redo', 'fa-rotate-right', 'btn-ghost', () => redoReview()));
    toolBar.appendChild(el('span', { id: 'autosave-indicator', class: 'text-xs text-muted', style: 'margin-left:8px;' }, ['Auto Save aktif']));
    toolBar.appendChild(btn('Regenerate Jalur & BOQ', 'fa-rotate', 'btn-secondary', () => { regenerateReview(boqBox); }));
    toolBar.appendChild(btn('Simpan Revisi', 'fa-floppy-disk', 'btn-primary', () => saveReview()));
    toolBar.appendChild(btn('Lanjut ke Approval →', 'fa-arrow-right', 'btn-secondary', () => { location.hash = wizardHash(5, analysisId); }));

    setTimeout(() => buildReviewMap(mapEl, layerBar, boqBox), 60);
  }

  function reviewEditable() { const R = App._review; return !!R && !R.locked && R.mode !== 'approval'; }

  // ---------- REVISION 03: REVISION HISTORY (Undo/Redo/Restore/Compare) ----------
  // Undo/Redo di sini beroperasi pada state ODP/ODC Review Mode (in-memory,
  // per sesi). "Restore" antar-VERSI TERSIMPAN (planning_version) ada di
  // modul planning-versions (tombol Restore pada tabel versi). "Compare
  // Revision" juga di planning-versions (PlanningFinal.versionDiff).
  function cloneOdpOdc(R) {
    return { odps: (R.odps || []).map((o) => Object.assign({}, o)), odcs: (R.odcs || []).map((o) => Object.assign({}, o)) };
  }
  // Snap manual 1 titik (ODP/ODC) ke titik terdekat pada jalur jalan
  // (R.roadsFC) — menutup celah "Snap to Road" dari FINAL_AUDIT_REPORT.md.
  function snapPointToRoad(point) {
    const R = App._review; const t = window.turf;
    if (!t || !R || !R.roadsFC || !R.roadsFC.features || !R.roadsFC.features.length) { toast('Data jalan tidak tersedia untuk snapping.', 'warning'); return; }
    pushReviewHistory();
    const pt = t.point([point.lng, point.lat]);
    let best = null, bestDist = Infinity;
    R.roadsFC.features.forEach((f) => {
      if (!f.geometry || f.geometry.type !== 'LineString') return;
      try {
        const snapped = t.nearestPointOnLine(f, pt, { units: 'meters' });
        if (snapped.properties.dist < bestDist) { bestDist = snapped.properties.dist; best = snapped; }
      } catch (e) {}
    });
    if (!best) { toast('Tidak ditemukan jalur jalan terdekat.', 'warning'); return; }
    point.lat = best.geometry.coordinates[1];
    point.lng = best.geometry.coordinates[0];
    toast('Titik di-snap ke jalan (bergeser ≈ ' + Math.round(bestDist) + ' m).', 'success');
  }
  function pushReviewHistory() {
    const H = App._reviewHistory; if (!H) return;
    // Buang cabang redo yang sudah usang begitu ada perubahan baru.
    H.stack = H.stack.slice(0, H.index + 1);
    H.stack.push(cloneOdpOdc(App._review));
    H.index = H.stack.length - 1;
    if (H.stack.length > 50) { H.stack.shift(); H.index--; } // batasi memori
    App._reviewDirty = true; // AUTO SAVE: tandai ada perubahan yang belum tersimpan
  }

  // ---------- AUTO SAVE (REVISION FINAL — menutup celah dari FINAL_AUDIT_REPORT.md) ----------
  // Planner tidak boleh kehilangan pekerjaan: selama Review Mode terbuka, tiap
  // 30 detik SEKALI, jika ada perubahan (App._reviewDirty) yang belum tersimpan,
  // sistem otomatis menyimpan draft baru (silent, tidak mengganggu dengan toast
  // besar) dan menampilkan indikator kecil "Tersimpan otomatis HH:MM:SS".
  function startAutosave() {
    stopAutosave();
    App.autosaveTimer = setInterval(async () => {
      if (!App._review || !App._reviewDirty) return;
      try {
        await saveReview(true /* silent */);
        App._reviewDirty = false;
        const ind = document.getElementById('autosave-indicator');
        if (ind) ind.textContent = 'Tersimpan otomatis ' + new Date().toLocaleTimeString('id-ID');
      } catch (e) { /* biarkan, akan dicoba lagi di interval berikutnya */ }
    }, 30000);
  }
  function stopAutosave() {
    if (App.autosaveTimer) { clearInterval(App.autosaveTimer); App.autosaveTimer = null; }
  }
  function undoReview() {
    const H = App._reviewHistory; if (!H || H.index <= 0) { toast('Tidak ada riwayat sebelumnya.', 'info'); return; }
    H.index--;
    const snap = cloneOdpOdc(H.stack[H.index]);
    App._review.odps = snap.odps; App._review.odcs = snap.odcs;
    if (App._reviewRedraw) { App._reviewRedraw.odp(); App._reviewRedraw.odc(); }
    toast('Undo.', 'info');
  }
  function redoReview() {
    const H = App._reviewHistory; if (!H || H.index >= H.stack.length - 1) { toast('Tidak ada riwayat berikutnya.', 'info'); return; }
    H.index++;
    const snap = cloneOdpOdc(H.stack[H.index]);
    App._review.odps = snap.odps; App._review.odcs = snap.odcs;
    if (App._reviewRedraw) { App._reviewRedraw.odp(); App._reviewRedraw.odc(); }
    toast('Redo.', 'info');
  }

  function buildReviewMap(mapEl, layerBar, boqBox) {
    if (!window.L) return;
    if (App.reviewMap) { try { App.reviewMap.remove(); } catch (e) {} }
    const R = App._review;
    const map = L.map(mapEl, { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
    App.reviewMap = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 20 }).addTo(map);

    const groups = {
      'Detected Buildings': L.layerGroup(), 'Home Passed': L.layerGroup(), 'Planning ODP': L.layerGroup(),
      'Planning ODC': L.layerGroup(), 'Planning Backbone': L.layerGroup(), 'Planning Distribution': L.layerGroup(),
      'Coverage Radius': L.layerGroup(),
    };
    App._reviewLayers = groups;

    function redrawStatic() {
      groups['Detected Buildings'].clearLayers();
      L.geoJSON(R.buildingsFC, { pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 2.5, weight: 0, fillOpacity: 0.7, fillColor: f.properties && f.properties.is_home_passed ? '#0B6E99' : '#9A6700' }) }).addTo(groups['Detected Buildings']);
      groups['Home Passed'].clearLayers();
      L.geoJSON(R.homePassedFC, { pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3, weight: 0, fillOpacity: 0.85, fillColor: '#1E7B4D' }) }).addTo(groups['Home Passed']);
    }
    function redrawLines() {
      groups['Planning Backbone'].clearLayers();
      L.geoJSON(R.backbone.featureCollection, { style: { color: '#B3261E', weight: 3 } }).addTo(groups['Planning Backbone']);
      groups['Planning Distribution'].clearLayers();
      L.geoJSON(R.distribution.featureCollection, { style: { color: '#6B4FA0', weight: 1.5, dashArray: '4,3' } }).addTo(groups['Planning Distribution']);
    }
    function redrawOdp() {
      groups['Planning ODP'].clearLayers(); groups['Coverage Radius'].clearLayers();
      R.odps.forEach((o, idx) => {
        const m = L.marker([o.lat, o.lng], { draggable: reviewEditable(), title: o.odp_id });
        m.bindTooltip(o.odp_id + ' (' + (o.home_count || 0) + ')', { permanent: false });
        m.on('dragend', (e) => { pushReviewHistory(); const ll = e.target.getLatLng(); o.lat = ll.lat; o.lng = ll.lng; });
        m.on('click', () => {
          if (!reviewEditable()) { m.bindPopup('<b>' + o.odp_id + '</b><br>Home: ' + (o.home_count || 0) + '<br><span style="color:#888;">baca-saja</span>').openPopup(); return; }
          m.bindPopup('<b>' + o.odp_id + '</b><br>Home: ' + (o.home_count || 0) + '<br><button id="del-odp-' + idx + '" class="btn btn-danger btn-sm" style="margin-top:6px;">Hapus ODP</button> <button id="snap-odp-' + idx + '" class="btn btn-secondary btn-sm" style="margin-top:6px;">Snap ke Jalan</button>').openPopup();
          setTimeout(() => {
            const b = document.getElementById('del-odp-' + idx); if (b) b.onclick = () => { pushReviewHistory(); R.odps.splice(idx, 1); redrawOdp(); map.closePopup(); toast('ODP dihapus. Klik Regenerate.', 'info'); };
            const s = document.getElementById('snap-odp-' + idx); if (s) s.onclick = () => { snapPointToRoad(o); redrawOdp(); map.closePopup(); };
          }, 30);
        });
        m.addTo(groups['Planning ODP']);
        if (o.coverage_radius_m) L.circle([o.lat, o.lng], { radius: o.coverage_radius_m, color: '#0B6E99', weight: 1, fillOpacity: 0.06 }).addTo(groups['Coverage Radius']);
      });
    }
    function redrawOdc() {
      groups['Planning ODC'].clearLayers();
      R.odcs.forEach((o, idx) => {
        const m = L.marker([o.lat, o.lng], { draggable: reviewEditable(), title: o.odc_id });
        m.bindTooltip(o.odc_id + ' (' + (o.odp_count || 0) + ' ODP)', { permanent: false });
        m.on('dragend', (e) => { pushReviewHistory(); const ll = e.target.getLatLng(); o.lat = ll.lat; o.lng = ll.lng; });
        m.on('click', () => {
          if (!reviewEditable()) { m.bindPopup('<b>' + o.odc_id + '</b><br>ODP: ' + (o.odp_count || 0) + '<br><span style="color:#888;">baca-saja</span>').openPopup(); return; }
          m.bindPopup('<b>' + o.odc_id + '</b><br>ODP: ' + (o.odp_count || 0) + '<br><button id="del-odc-' + idx + '" class="btn btn-danger btn-sm" style="margin-top:6px;">Hapus ODC</button> <button id="snap-odc-' + idx + '" class="btn btn-secondary btn-sm" style="margin-top:6px;">Snap ke Jalan</button>').openPopup();
          setTimeout(() => {
            const b = document.getElementById('del-odc-' + idx); if (b) b.onclick = () => { pushReviewHistory(); R.odcs.splice(idx, 1); redrawOdc(); map.closePopup(); toast('ODC dihapus. Klik Regenerate.', 'info'); };
            const s = document.getElementById('snap-odc-' + idx); if (s) s.onclick = () => { snapPointToRoad(o); redrawOdc(); map.closePopup(); };
          }, 30);
        });
        m.addTo(groups['Planning ODC']);
      });
    }
    App._reviewRedraw = { lines: redrawLines, odp: redrawOdp, odc: redrawOdc };

    redrawStatic(); redrawLines(); redrawOdp(); redrawOdc();

    // Klik peta untuk menambah ODP/ODC dalam mode tambah.
    map.on('click', (e) => {
      if (!R.addMode || !reviewEditable()) return;
      const ll = e.latlng;
      pushReviewHistory();
      if (R.addMode === 'odp') { R.odps.push({ odp_id: 'ODP-N' + (R.odps.length + 1), lat: ll.lat, lng: ll.lng, home_count: 0, home_ids: [], coverage_radius_m: 40 }); redrawOdp(); }
      else { R.odcs.push({ odc_id: 'ODC-N' + (R.odcs.length + 1), lat: ll.lat, lng: ll.lng, odp_count: 0, odp_ids: [] }); redrawOdc(); }
      toast('Ditambahkan. Klik Regenerate untuk memperbarui jalur & BOQ.', 'info');
    });

    // Toggle layer.
    App._reviewLayerInputs = [];
    const order = ['Detected Buildings', 'Home Passed', 'Coverage Radius', 'Planning Backbone', 'Planning Distribution', 'Planning ODP', 'Planning ODC'];
    const defaultOn = { 'Planning ODP': 1, 'Planning ODC': 1, 'Planning Backbone': 1, 'Planning Distribution': 1, 'Home Passed': 1 };
    order.forEach((name) => {
      const grp = groups[name]; const on = !!defaultOn[name];
      if (on) grp.addTo(map);
      const input = el('input', { type: 'checkbox', checked: on ? 'checked' : null, onchange: (ev) => { if (App._review.locked) { ev.target.checked = !ev.target.checked; toast('Layer dikunci.', 'warning'); return; } if (ev.target.checked) map.addLayer(grp); else map.removeLayer(grp); } });
      App._reviewLayerInputs.push(input);
      const cb = el('label', { style: 'display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;' }, [input, el('span', {}, [name])]);
      layerBar.appendChild(cb);
    });

    boqBox.innerHTML = ''; boqBox.appendChild(boqTable(R.boq));
    try { const b = L.geoJSON(R.homePassedFC.features.length ? R.homePassedFC : R.buildingsFC); map.fitBounds(b.getBounds(), { maxZoom: 17 }); } catch (e) {}
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 200);
  }

  function regenerateReview(boqBox) {
    const R = App._review; const engine = window.PlanningEngine;
    if (!engine || !engine.generators) { toast('Generators belum termuat.', 'error'); return; }
    const out = engine.generators.regenerateLines(R.odps, R.odcs, R.roadsFC, App.planningParams);
    R.backbone = out.backbone; R.distribution = out.distribution; R.poles = out.poles; R.boq = out.boq;
    if (App._reviewRedraw) App._reviewRedraw.lines();
    boqBox.innerHTML = ''; boqBox.appendChild(boqTable(R.boq));
    toast('Jalur & BOQ diperbarui dari ODP/ODC terkini.', 'success');
  }

  async function saveReview(silent) {
    const R = App._review; if (!R) return;
    // Bangun objek "gen" baru (generation_id baru → append-only) dari state review.
    const gen = {
      generation_id: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('gen-' + Date.now()),
      generated_at: new Date().toISOString(),
      stats: (App._lastGeneration && App._lastGeneration.gen.stats) || {},
      buildingsFC: R.buildingsFC, homePassedFC: R.homePassedFC,
      odps: R.odps, odcs: R.odcs, backbone: R.backbone, distribution: R.distribution, poles: R.poles, boq: R.boq,
    };
    const gid = await saveGenerationToDb(R.analysisId, R.projectId, gen, 'draft');
    if (gid) {
      App._lastGeneration = { analysisId: R.analysisId, projectId: R.projectId, gen: Object.assign(gen, { _roadsFC: R.roadsFC }), savedId: gid };
      if (!silent) toast('Revisi tersimpan (versi baru).', 'success');
    } else if (!silent) {
      toast('Revisi belum tersimpan (migration 006?).', 'warning', 4500);
    }
  }

  /* ================= [MODULES] PLACEHOLDER FASE BERIKUTNYA ================= */
  // Modul di bawah ini akan diisi penuh pada Fase 2-5 sesuai roadmap.
  // Struktur registerModule sudah siap sehingga penambahan tidak mengubah
  // file lain (index.html / style.css tetap sama).
  const PENDING_MODULES = [
    ['import', 'Import Data', 'Gunakan tombol "Import Data" pada halaman Mapping.'],
    ['export', 'Export', 'Ekspor data ke SHP/PDF/Excel. (Fase 5)'],
    ['notification', 'Notifikasi', 'Notifikasi & log aktivitas sistem. (Fase 5)'],
    ['setting', 'Pengaturan', 'Pengaturan aplikasi & profil pengguna. (Fase 5)'],
  ];
  PENDING_MODULES.forEach(([key, label, desc]) => {
    registerModule(key, async function (container) {
      container.innerHTML = '';
      container.appendChild(el('div', { class: 'card empty-state' }, [
        el('i', { class: 'fa-solid fa-hammer' }),
        el('h3', {}, [label]),
        el('p', { class: 'text-muted' }, [desc]),
        el('p', { class: 'text-xs text-muted' }, ['Modul ini akan diaktifkan penuh pada fase pembangunan berikutnya.']),
      ]));
    });
  });

  /* ================= [SMART PLANNING] FINAL · VALIDATION · APPROVAL (IMPL. 04) =================
     Menyelesaikan proses: draft → versi → validasi → approval → final → report → export.
     Additive; meng-override modul placeholder 'export' & 'notification' dengan versi nyata,
     dan menambah modul planning-validation / planning-versions / planning-reports. */

  const PLANNING_STATUS_FLOW = ['draft', 'review', 'revision', 'approved', 'rejected', 'final'];
  function uid() { return (App.session && App.session.user) ? App.session.user.id : null; }
  function pname() { return (App.profile && App.profile.full_name) || 'Pengguna'; }
  function prole() { return (App.profile && App.profile.role) || null; }
  function isApprover() { const r = prole(); return !r || r === 'admin' || r === 'supervisor' || r === 'owner'; }
  function statusBadge(st) {
    const map = { draft: 'neutral', review: 'info', revision: 'warning', approved: 'success', rejected: 'danger', final: 'success' };
    return el('span', { class: 'badge badge-' + (map[st] || 'neutral') }, [st || 'draft']);
  }

  function genSnapshot(gen) {
    return {
      stats: gen.stats, params: gen.params,
      odps: gen.odps, odcs: gen.odcs,
      backbone: gen.backbone, distribution: gen.distribution, poles: gen.poles, boq: gen.boq,
      buildingsFC: gen.buildingsFC, homePassedFC: gen.homePassedFC,
      // REVISION 03: data tambahan (additive, aman diabaikan pembaca lama)
      // supaya PlanningFinal.computeValidation bisa menjalankan seluruh
      // 11 pemeriksaan otomatis (drop cable, jalan, boundary).
      drop: gen.drop,
      roadsFC: gen._roadsFC || (App._lastGeneration && App._lastGeneration.gen && App._lastGeneration.gen._roadsFC) || null,
      boundaryFeature: (App._lastAnalysis && App._lastAnalysis.result && App._lastAnalysis.result.boundary && App._lastAnalysis.result.boundary.feature) || null,
    };
  }

  async function logHistory(e) { try { await App.supabase.from('planning_history').insert(Object.assign({ actor: uid(), actor_name: pname() }, e)); } catch (_) {} }

  async function createPlanningVersion(label) {
    const G = App._lastGeneration;
    if (!G || !G.gen) { toast('Belum ada draft. Generate dulu di Wizard.', 'warning'); return null; }
    const snap = genSnapshot(G.gen);
    let vno = 1;
    try { const { count } = await App.supabase.from('planning_version').select('*', { count: 'exact', head: true }).eq('analysis_id', G.analysisId); vno = (count || 0) + 1; } catch (e) {}
    const row = {
      project_id: G.projectId, analysis_id: G.analysisId, generation_id: G.gen.generation_id,
      version_no: vno, version_label: label || ('Planning V' + vno), status: 'draft',
      home_count: snap.stats.home_count, building_count: snap.stats.building_count, home_passed: snap.stats.home_passed,
      odp_count: snap.odps.length, odc_count: snap.odcs.length, pole_count: snap.poles.count,
      backbone_length_m: snap.backbone.length_m, distribution_length_m: snap.distribution.length_m,
      closure_count: snap.boq.closure_count, handhole_count: snap.boq.handhole_count,
      jointbox_count: snap.boq.jointbox_count, connector_count: snap.boq.connector_count,
      coverage_percent: snap.stats.coverage_percent, snapshot: snap, created_by: uid(),
    };
    try {
      const { data, error } = await App.supabase.from('planning_version').insert(row).select().single();
      if (error) throw error;
      await logHistory({ project_id: G.projectId, version_id: data.id, entity: 'version', action: 'create', description: 'Buat ' + row.version_label });
      toast('Versi tersimpan: ' + row.version_label, 'success');
      return data;
    } catch (err) { console.warn('[Version]', err.message); toast('Gagal simpan versi (jalankan migration 007).', 'warning', 4500); return null; }
  }

  async function loadVersions(analysisId) {
    try { const { data } = await App.supabase.from('planning_version').select('*').eq('analysis_id', analysisId).order('version_no', { ascending: true }); return data || []; }
    catch (e) { return []; }
  }
  async function loadVersionById(id) {
    try { const { data } = await App.supabase.from('planning_version').select('*').eq('id', id).limit(1); return (data && data[0]) || null; }
    catch (e) { return null; }
  }
  async function loadApprovals(versionId) {
    try { const { data } = await App.supabase.from('planning_approval').select('*').eq('version_id', versionId).order('created_at', { ascending: true }); return data || []; }
    catch (e) { return []; }
  }

  async function transitionStatus(version, action, toStatus, note) {
    const from = version.status;
    try { await App.supabase.from('planning_version').update({ status: toStatus }).eq('id', version.id); }
    catch (e) { toast('Update status gagal (migration 007?).', 'warning', 4000); }
    try {
      await App.supabase.from('planning_approval').insert({ version_id: version.id, project_id: version.project_id, action, from_status: from, to_status: toStatus, actor: uid(), actor_name: pname(), actor_role: prole(), note: note || null });
    } catch (_) {}
    await logHistory({ project_id: version.project_id, version_id: version.id, entity: 'approval', action, description: action + ': ' + from + ' → ' + toStatus + (note ? (' — ' + note) : '') });
    version.status = toStatus;
    toast('Status: ' + toStatus, 'success');
    // REVISION 04: begitu status jadi 'approved', otomatis siapkan paket
    // Proposal/BOQ Final/Material List (dokumen aktual dibuat on-demand saat
    // diunduh di halaman Planning Proposal — di sini cukup catat & arahkan
    // planner, supaya tidak menyimpan file besar berulang di DB).
    if (toStatus === 'approved') {
      try { await App.supabase.from('planning_report').insert({ version_id: version.id, project_id: version.project_id, report_type: 'proposal_package', title: 'Auto-generate saat Approve', format: 'ready', created_by: uid() }); } catch (_) {}
      toast('Proposal & BOQ Final siap dibuat. Buka menu Planning Proposal.', 'info', 5000);
    }
  }

  async function saveValidation(version, snap) {
    const val = window.PlanningFinal.computeValidation(snap);
    try { await App.supabase.from('planning_validation').insert({ version_id: version.id, analysis_id: version.analysis_id, validated_by: uid(), validator: pname(), status: val.status, metrics: val, note: (val.issues || []).join(' ') || null }); } catch (_) {}
    await logHistory({ project_id: version.project_id, version_id: version.id, entity: 'validation', action: 'validate', description: 'Validasi: ' + val.status });
    return val;
  }
  App.planningFinalHelpers = { createPlanningVersion, transitionStatus, saveValidation, loadVersions, loadVersionById };

  // FIX #E7 (audit "serba otomatis"): sebelumnya, snapshot hasil Wizard
  // (ODC/ODP/Tiang/Rumah/Backbone/Distribution) hanya tersimpan sebagai JSON
  // di planning_version.snapshot — TIDAK PERNAH otomatis menjadi baris asli
  // di tabel operasional (odc/odp/homes/poles/backbones/distributions) yang
  // dipakai Asset Management/Mapping/Dashboard. Planner harus input ulang
  // manual satu-satu. Fungsi ini menutup gap tsb: sekali klik, seluruh
  // snapshot "dideploy" jadi data asli, lengkap dengan relasi ODC↔ODP↔Rumah
  // dan panjang jalur Backbone/Distribution.
  async function deployVersionToAssets(version) {
    if (version.status !== 'final') { toast('Hanya versi dengan status "final" yang boleh di-deploy ke Implementasi.', 'warning'); return; }
    if (version.deployed_at) {
      const ok = await confirmDialog('Versi ini sudah pernah di-deploy pada ' + fmtDate(version.deployed_at) + '. Deploy ulang akan MENAMBAH data baru (bukan menimpa/replace), berpotensi duplikat. Lanjutkan?', 'Deploy Ulang?');
      if (!ok) return;
    }
    const snap = version.snapshot || {};
    if (!(snap.odcs && snap.odcs.length) && !(snap.odps && snap.odps.length)) { toast('Snapshot versi ini kosong/tidak lengkap, tidak bisa di-deploy.', 'error'); return; }
    const projectId = version.project_id || null;
    const summary = { odc: 0, odp: 0, pole: 0, home: 0, backbone: 0, distribution: 0 };
    const errors = [];
    toast('Deploy ke Implementasi dimulai — mohon tunggu, jangan tutup halaman…', 'info', 5000);
    try {
      // 1) ODC dulu (paling induk).
      const odcIdMap = {};
      for (const o of (snap.odcs || [])) {
        const { data, error } = await App.supabase.from('odc').insert({ name: o.odc_id, lat: o.lat, lng: o.lng, project_id: projectId }).select().single();
        if (error) { errors.push('ODC ' + o.odc_id + ': ' + error.message); continue; }
        odcIdMap[o.odc_id] = data.id; summary.odc++;
      }
      // 2) ODP, ditautkan ke ODC induk lewat odc.odp_ids (hasil clustering Wizard).
      const odpIdMap = {};
      for (const p of (snap.odps || [])) {
        const parentOdc = (snap.odcs || []).find((o) => (o.odp_ids || []).includes(p.odp_id));
        const { data, error } = await App.supabase.from('odp').insert({ name: p.odp_id, odc_id: parentOdc ? (odcIdMap[parentOdc.odc_id] || null) : null, lat: p.lat, lng: p.lng, project_id: projectId }).select().single();
        if (error) { errors.push('ODP ' + p.odp_id + ': ' + error.message); continue; }
        odpIdMap[p.odp_id] = data.id; summary.odp++;
      }
      // 3) Tiang (poles) sepanjang jalur kabel.
      const poleList = (snap.poles && snap.poles.points) || [];
      if (poleList.length) {
        const { error } = await App.supabase.from('poles').insert(poleList.map((pl) => ({ code: pl.pole_id, lat: pl.lat, lng: pl.lng, project_id: projectId })));
        if (error) errors.push('Tiang: ' + error.message); else summary.pole = poleList.length;
      }
      // 4) Rumah (dari hasil drop cable ODP -> Rumah).
      const dropRecords = (snap.drop && snap.drop.records) || [];
      if (dropRecords.length) {
        const { error } = await App.supabase.from('homes').insert(dropRecords.map((r) => ({
          owner_name: 'Homepass ' + r.building_id, address: null, status: 'Prospek',
          odp_id: odpIdMap[r.odp_id] || null, lat: r.lat, lng: r.lng, project_id: projectId,
        })));
        if (error) errors.push('Rumah: ' + error.message); else summary.home = dropRecords.length;
      }
      // 5) Backbone (POP -> ODC).
      const bbFeats = (snap.backbone && snap.backbone.featureCollection && snap.backbone.featureCollection.features) || [];
      for (let i = 0; i < bbFeats.length; i++) {
        let lenM = 0; try { lenM = Math.round(window.turf.length(bbFeats[i], { units: 'kilometers' }) * 1000); } catch (e) {}
        const { error } = await App.supabase.from('backbones').insert({ name: 'Backbone-' + (i + 1), path: geometryToWKT(bbFeats[i].geometry), length_m: lenM, project_id: projectId });
        if (error) errors.push('Backbone-' + (i + 1) + ': ' + error.message); else summary.backbone++;
      }
      // 6) Distribution (ODC -> ODP), ditautkan ke ODC/ODP asli lewat properti kind pada feature.
      const distFeats = (snap.distribution && snap.distribution.featureCollection && snap.distribution.featureCollection.features) || [];
      for (let i = 0; i < distFeats.length; i++) {
        const props = distFeats[i].properties || {};
        let lenM = 0; try { lenM = Math.round(window.turf.length(distFeats[i], { units: 'kilometers' }) * 1000); } catch (e) {}
        const { error } = await App.supabase.from('distributions').insert({
          name: 'Distribution-' + (i + 1), odc_id: odcIdMap[props.odc] || null, odp_id: odpIdMap[props.odp] || null,
          path: geometryToWKT(distFeats[i].geometry), length_m: lenM, project_id: projectId,
        });
        if (error) errors.push('Distribution-' + (i + 1) + ': ' + error.message); else summary.distribution++;
      }
      try { await App.supabase.from('planning_version').update({ deployed_at: new Date().toISOString(), deployed_summary: summary }).eq('id', version.id); } catch (e) {}
      version.deployed_at = new Date().toISOString();
      await logHistory({ project_id: projectId, version_id: version.id, entity: 'deploy', action: 'deploy_to_assets',
        description: 'Deploy ke Implementasi — ODC ' + summary.odc + ', ODP ' + summary.odp + ', Tiang ' + summary.pole + ', Rumah ' + summary.home + ', Backbone ' + summary.backbone + ', Distribution ' + summary.distribution + (errors.length ? (' (' + errors.length + ' error)') : '') });
      if (errors.length) { console.warn('[Deploy ke Implementasi]', errors); toast('Deploy selesai dengan ' + errors.length + ' error — pastikan migration 013 (deployed_at/deployed_summary) sudah dijalankan. Detail di console.', 'warning', 7000); }
      else toast('Deploy sukses! ODC ' + summary.odc + ' · ODP ' + summary.odp + ' · Tiang ' + summary.pole + ' · Rumah ' + summary.home + ' · Backbone ' + summary.backbone + ' · Distribution ' + summary.distribution + '. Cek di menu Asset Management / Mapping.', 'success', 8000);
    } catch (err) {
      toast('Deploy gagal: ' + err.message, 'error');
    }
  }
  App.deployVersionToAssets = deployVersionToAssets;

  // ---------- MODULE: PLANNING VERSIONS ----------
  ROUTE_TITLES['planning-versions'] = 'Planning Versions';
  registerModule('planning-versions', async function renderVersions(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const analysisId = qs.get('analysis') || (App._lastGeneration && App._lastGeneration.analysisId) || (App._lastAnalysis && App._lastAnalysis.id);
    const head = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Manajemen Versi Planning'])]),
      el('p', { class: 'text-muted' }, ['Simpan snapshot rencana sebagai versi (V1, V2, …), bandingkan antar versi, dan buka validasi/approval.']),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
        el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { const v = await createPlanningVersion(); if (v) location.hash = '#/planning-versions' + (analysisId ? ('?analysis=' + analysisId) : ''); } }, [el('i', { class: 'fa-solid fa-code-branch' }), ' Simpan Versi dari Draft']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { location.hash = '#/planning-wizard?step=3' + (analysisId ? ('&analysis=' + analysisId) : ''); } }, ['Ke Generate']),
      ]),
    ]);
    container.appendChild(head);
    if (!analysisId) { container.appendChild(el('div', { class: 'card empty-state' }, [el('h3', {}, ['Belum ada analisa aktif'])])); return; }

    const versions = await loadVersions(analysisId);
    if (!versions.length) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-code-branch' }), el('h3', {}, ['Belum ada versi']), el('p', { class: 'text-muted' }, ['Klik "Simpan Versi dari Draft".'])])); return; }

    const table = el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Versi', 'Status', 'Home Passed', 'ODP', 'ODC', 'Coverage %', 'Dibuat', ''].map((h) => el('th', {}, [h])))]),
      el('tbody', {}, versions.map((v) => el('tr', {}, [
        el('td', { style: 'font-weight:600;' }, [v.version_label || ('V' + v.version_no)]),
        el('td', {}, [statusBadge(v.status)]),
        el('td', {}, [fmtNumber(v.home_passed)]), el('td', {}, [fmtNumber(v.odp_count)]), el('td', {}, [fmtNumber(v.odc_count)]),
        el('td', {}, [String(v.coverage_percent != null ? v.coverage_percent : '-')]),
        el('td', { class: 'text-xs text-muted' }, [fmtDate ? fmtDate(v.created_at) : String(v.created_at || '').slice(0, 10)]),
        el('td', {}, [el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' }, [
          v.status === 'final' ? (
            v.deployed_at
              ? el('span', { class: 'badge badge-success', title: 'Sudah di-deploy: ' + fmtDate(v.deployed_at) }, [el('i', { class: 'fa-solid fa-circle-check' }), ' Ter-deploy'])
              : el('button', { class: 'btn btn-primary btn-sm', title: 'Ubah snapshot planning ini jadi data Asset asli (ODC/ODP/Rumah/Tiang/Backbone/Distribution)', onclick: async (e) => { e.target.disabled = true; await deployVersionToAssets(v); navigateTo('planning-versions'); } }, [el('i', { class: 'fa-solid fa-rocket' }), ' Deploy ke Implementasi'])
          ) : null,
          el('button', { class: 'btn btn-ghost btn-sm', title: 'Validasi/Approval', onclick: () => { location.hash = '#/planning-validation?version=' + v.id; } }, [el('i', { class: 'fa-solid fa-clipboard-check' })]),
          el('button', { class: 'btn btn-ghost btn-sm', title: 'Reports', onclick: () => { location.hash = '#/planning-reports?version=' + v.id; } }, [el('i', { class: 'fa-solid fa-file-lines' })]),
          el('button', { class: 'btn btn-ghost btn-sm', title: 'Restore — buat versi baru dari snapshot ini', onclick: async () => {
            if (!confirm('Restore "' + (v.version_label || ('V' + v.version_no)) + '"? Ini akan membuat VERSI BARU dari snapshot tsb (versi lama tetap ada, tidak ditimpa).')) return;
            const snap = v.snapshot || {};
            let vno = 1;
            try { const { count } = await App.supabase.from('planning_version').select('*', { count: 'exact', head: true }).eq('analysis_id', analysisId); vno = (count || 0) + 1; } catch (e) {}
            const row = { project_id: v.project_id, analysis_id: v.analysis_id, generation_id: v.generation_id,
              version_no: vno, version_label: 'Restore dari ' + (v.version_label || ('V' + v.version_no)), status: 'draft',
              home_count: v.home_count, building_count: v.building_count, home_passed: v.home_passed,
              odp_count: v.odp_count, odc_count: v.odc_count, pole_count: v.pole_count,
              backbone_length_m: v.backbone_length_m, distribution_length_m: v.distribution_length_m,
              closure_count: v.closure_count, handhole_count: v.handhole_count, jointbox_count: v.jointbox_count,
              connector_count: v.connector_count, coverage_percent: v.coverage_percent, snapshot: snap, created_by: uid() };
            try {
              const { data, error } = await App.supabase.from('planning_version').insert(row).select().single();
              if (error) throw error;
              await logHistory({ project_id: v.project_id, version_id: data.id, entity: 'version', action: 'restore', description: 'Restore dari ' + (v.version_label || ('V' + v.version_no)) });
              toast('Berhasil di-restore sebagai versi baru.', 'success');
              location.hash = '#/planning-versions?analysis=' + analysisId;
            } catch (err) { toast('Gagal restore.', 'error'); }
          } }, [el('i', { class: 'fa-solid fa-clock-rotate-left' })]),
        ])]),
      ]))),
    ]);
    container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'table-wrap' }, [table])]));

    // Bandingkan versi.
    if (versions.length >= 2) {
      const selA = el('select', { class: 'text-input', style: 'max-width:180px;' }, versions.map((v) => el('option', { value: v.id }, [v.version_label || ('V' + v.version_no)])));
      const selB = el('select', { class: 'text-input', style: 'max-width:180px;' }, versions.map((v) => el('option', { value: v.id }, [v.version_label || ('V' + v.version_no)])));
      selB.selectedIndex = versions.length - 1;
      const diffBox = el('div', { style: 'margin-top:10px;' });
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Bandingkan Versi'])]),
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;' }, [selA, el('span', {}, ['vs']), selB,
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => {
            const a = versions.find((x) => x.id === selA.value), b = versions.find((x) => x.id === selB.value);
            const diff = window.PlanningFinal.versionDiff(a.snapshot || {}, b.snapshot || {});
            diffBox.innerHTML = '';
            diffBox.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
              el('thead', {}, [el('tr', {}, ['Metrik', 'Dari', 'Ke', 'Δ'].map((h) => el('th', {}, [h])))]),
              el('tbody', {}, diff.map((d) => el('tr', {}, [el('td', {}, [d.metric]), el('td', {}, [fmtNumber(d.from)]), el('td', {}, [fmtNumber(d.to)]), el('td', { style: 'font-weight:600;color:' + (d.delta > 0 ? '#1E7B4D' : (d.delta < 0 ? '#B3261E' : 'inherit')) + ';' }, [(d.delta > 0 ? '+' : '') + fmtNumber(d.delta)])]))),
            ])]));
          } }, ['Bandingkan']),
        ]),
        diffBox,
      ]));
    }
  });

  // ---------- MODULE: PLANNING VALIDATION + APPROVAL ----------
  ROUTE_TITLES['planning-validation'] = 'Planning Validation';
  registerModule('planning-validation', async function renderValidation(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const versionId = qs.get('version');
    const analysisId = qs.get('analysis') || (App._lastGeneration && App._lastGeneration.analysisId);
    let version = versionId ? await loadVersionById(versionId) : null;
    if (!version && analysisId) { const vs = await loadVersions(analysisId); version = vs[vs.length - 1] || null; }

    if (!version) {
      container.appendChild(el('div', { class: 'card empty-state' }, [
        el('i', { class: 'fa-solid fa-clipboard-check' }), el('h3', {}, ['Belum ada versi untuk divalidasi']),
        el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { const v = await createPlanningVersion(); if (v) location.hash = '#/planning-validation?version=' + v.id; } }, ['Simpan Versi dari Draft']),
      ]));
      return;
    }

    const snap = version.snapshot || {};
    const val = window.PlanningFinal.computeValidation(snap);

    const rows = [
      ['Jumlah Rumah', val.home_count], ['Jumlah Bangunan', val.building_count], ['Jumlah ODP', val.odp_count],
      ['Jumlah ODC', val.odc_count], ['Jumlah Tiang', val.pole_count], ['Panjang Backbone (m)', val.backbone_length_m],
      ['Panjang Distribution (m)', val.distribution_length_m], ['Closure', val.closure_count], ['Joint Box', val.jointbox_count],
      ['Handhole', val.handhole_count], ['Connector', val.connector_count], ['Coverage %', val.coverage_percent],
    ];
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Planning Validation — ' + (version.version_label || ('V' + version.version_no))]), statusBadge(version.status)]),
      el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Metrik', 'Nilai'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, rows.map((r) => el('tr', {}, [el('td', {}, [r[0]]), el('td', { style: 'font-weight:600;' }, [fmtNumber(r[1])])]))),
      ])]),
      el('p', { style: 'margin-top:8px;' }, [val.status === 'ok' ? el('span', { class: 'badge badge-success' }, ['Validasi: OK']) : el('span', { class: 'badge badge-warning' }, ['Perlu perhatian: ' + val.issues.length + ' isu'])]),
      (val.issues && val.issues.length) ? el('ul', { class: 'text-xs text-muted' }, val.issues.map((s) => el('li', {}, [s]))) : null,
    ]);
    container.appendChild(card);

    // ---- REVISION 03: Quality Score ----
    if (val.quality_score) {
      const qs = val.quality_score;
      const gradeColor = { A: '#1E7B4D', B: '#0B6E99', C: '#9A6700', D: '#B3261E' }[qs.grade] || '#5B6774';
      const scoreRow = (label, value) => el('div', { style: 'flex:1;min-width:110px;text-align:center;padding:10px;' }, [
        el('div', { style: 'font-size:20px;font-weight:700;' }, [String(value)]),
        el('div', { class: 'text-xs text-muted' }, [label]),
      ]);
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('h3', {}, ['Quality Score']),
          el('span', { class: 'badge', style: 'background:' + gradeColor + '22;color:' + gradeColor + ';font-size:16px;font-weight:800;' }, ['Grade ' + qs.grade]),
        ]),
        el('div', { style: 'display:flex;flex-wrap:wrap;border-top:1px solid var(--color-border);' }, [
          scoreRow('Coverage', qs.coverage), scoreRow('Network', qs.network), scoreRow('Construction', qs.construction),
          scoreRow('Efficiency', qs.efficiency), scoreRow('Planning', qs.planning),
          el('div', { style: 'flex:1;min-width:110px;text-align:center;padding:10px;background:var(--color-bg);border-radius:var(--radius-sm);' }, [
            el('div', { style: 'font-size:22px;font-weight:800;color:' + gradeColor + ';' }, [String(qs.total)]),
            el('div', { class: 'text-xs text-muted' }, ['Total Score']),
          ]),
        ]),
      ]));
    }

    // ---- REVISION 03: AI Recommendation (rule-based, lihat val.engine_note) ----
    if (val.recommendations && val.recommendations.length) {
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['AI Recommendation']), el('span', { class: 'badge badge-info', title: val.engine_note }, ['rule-based'])]),
        el('p', { class: 'text-xs text-muted' }, [val.engine_note]),
        el('ul', {}, val.recommendations.map((r) => el('li', { style: 'margin-bottom:6px;' }, [r]))),
      ]));
    }

    // ---- REVISION 03: rincian isu per aturan (kode + severity + referensi) ----
    if (val.issues_detail && val.issues_detail.length) {
      const sevBadge = (s) => el('span', { class: 'badge badge-' + (s === 'error' ? 'danger' : (s === 'warning' ? 'warning' : 'info')) }, [s]);
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Detail Validasi Otomatis (' + val.issues_detail.length + ' isu)'])]),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Tingkat', 'Aturan', 'Keterangan', 'Referensi'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, val.issues_detail.map((iss) => el('tr', {}, [
            el('td', {}, [sevBadge(iss.severity)]), el('td', { class: 'text-xs' }, [iss.code]),
            el('td', {}, [iss.message]), el('td', { class: 'text-xs text-muted' }, [iss.ref_id || '-']),
          ]))),
        ])]),
      ]));
    }

    // Workflow actions (role-aware).
    const actions = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;' });
    const st = version.status;
    const refresh = () => { renderValidation(container); };
    actions.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const v = await saveValidation(version, snap); toast('Validasi tersimpan: ' + v.status, 'success'); } }, [el('i', { class: 'fa-solid fa-clipboard-check' }), ' Tandai Tervalidasi']));
    if (st === 'draft' || st === 'revision') actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await transitionStatus(version, 'submit_review', 'review'); refresh(); } }, [el('i', { class: 'fa-solid fa-paper-plane' }), ' Ajukan Review']));
    if (st === 'review' && isApprover()) {
      actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await transitionStatus(version, 'approve', 'approved'); refresh(); } }, [el('i', { class: 'fa-solid fa-circle-check' }), ' Approve']));
      actions.appendChild(el('button', { class: 'btn btn-danger btn-sm', onclick: async () => { await transitionStatus(version, 'reject', 'rejected', 'Ditolak supervisor'); refresh(); } }, [el('i', { class: 'fa-solid fa-circle-xmark' }), ' Reject']));
      actions.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { await transitionStatus(version, 'request_revision', 'revision', 'Perlu revisi'); refresh(); } }, [el('i', { class: 'fa-solid fa-rotate-left' }), ' Minta Revisi']));
    }
    if (st === 'approved' && isApprover()) actions.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await transitionStatus(version, 'finalize', 'final'); refresh(); } }, [el('i', { class: 'fa-solid fa-flag-checkered' }), ' Finalkan Project']));
    actions.appendChild(el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { location.hash = '#/planning-reports?version=' + version.id; } }, [el('i', { class: 'fa-solid fa-file-lines' }), ' Reports']));
    container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'card-header' }, [el('h3', {}, ['Approval Workflow'])]), el('p', { class: 'text-xs text-muted' }, ['Alur: ' + PLANNING_STATUS_FLOW.join(' → ')]), actions]));

    // Riwayat approval.
    const approvals = await loadApprovals(version.id);
    if (approvals.length) {
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Riwayat'])]),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, ['Waktu', 'Aksi', 'Status', 'Oleh'].map((h) => el('th', {}, [h])))]),
          el('tbody', {}, approvals.map((a) => el('tr', {}, [
            el('td', { class: 'text-xs' }, [String(a.created_at || '').replace('T', ' ').slice(0, 16)]),
            el('td', {}, [a.action]), el('td', {}, [(a.from_status || '') + ' → ' + (a.to_status || '')]), el('td', {}, [a.actor_name || '-']),
          ]))),
        ])]),
      ]));
    }
  });

  // ---------- MODULE: PLANNING REPORTS + EXPORT ----------
  ROUTE_TITLES['planning-reports'] = 'Planning Reports';
  ROUTE_TITLES['planning-proposal'] = 'Proposal & BOQ Final';
  registerModule('planning-reports', async function renderReports(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const versionId = qs.get('version');
    let version = versionId ? await loadVersionById(versionId) : null;
    let snap, ctxProject = null, approvals = [];
    if (version) { snap = version.snapshot || {}; approvals = await loadApprovals(version.id); }
    else if (App._lastGeneration && App._lastGeneration.gen) { snap = genSnapshot(App._lastGeneration.gen); version = { version_no: 0, version_label: 'Draft (belum diversi)', status: 'draft' }; }

    if (!snap) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-file-lines' }), el('h3', {}, ['Belum ada data untuk report']), el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/planning-wizard?step=3'; } }, ['Ke Generate'])])); return; }

    const PF = window.PlanningFinal;
    const reports = PF.buildReports({ snapshot: snap, version, project: ctxProject, approvals });
    const fname = 'planning_' + (version.version_label || 'draft').replace(/\s+/g, '_');

    // Toolbar export.
    const tb = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { const html = Object.keys(reports).map((k) => PF.reportToHtmlTable(reports[k])).join(''); PF.openPrintable(html, 'Planning Report'); } }, [el('i', { class: 'fa-solid fa-file-pdf' }), ' PDF']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.xls', 'application/vnd.ms-excel', PF.reportsToXLS(reports)); saveReportRecord(version, 'all', 'xls'); } }, [el('i', { class: 'fa-solid fa-file-excel' }), ' Excel']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.geojson', 'application/geo+json', PF.snapshotToGeoJSON(snap)); saveReportRecord(version, 'geometry', 'geojson'); } }, [el('i', { class: 'fa-solid fa-map' }), ' GeoJSON']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.kml', 'application/vnd.google-earth.kml+xml', PF.snapshotToKML(snap, fname)); saveReportRecord(version, 'geometry', 'kml'); } }, [el('i', { class: 'fa-solid fa-earth-asia' }), ' KML']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const blob = await PF.snapshotToKMZ(snap, fname); PF.downloadBlob(fname + '.kmz', 'application/vnd.google-earth.kmz', blob); saveReportRecord(version, 'geometry', 'kmz'); } }, [el('i', { class: 'fa-solid fa-earth-asia' }), ' KMZ']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { const csv = Object.keys(reports).map((k) => '# ' + reports[k].title + '\n' + PF.reportToCSV(reports[k])).join('\n\n'); PF.downloadBlob(fname + '.csv', 'text/csv', csv); saveReportRecord(version, 'all', 'csv'); } }, [el('i', { class: 'fa-solid fa-file-csv' }), ' CSV']),
    ]);
    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Planning Reports — ' + (version.version_label || '')]), statusBadge(version.status)]),
      el('p', { class: 'text-muted' }, ['10 laporan otomatis (tanpa harga). Export ke PDF, Excel, GeoJSON, KML, KMZ, dan CSV.']),
      tb,
    ]));

    // Preview setiap report.
    Object.keys(reports).forEach((k) => {
      const rep = reports[k];
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, [rep.title])]),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, rep.columns.map((c) => el('th', {}, [String(c)])))]),
          el('tbody', {}, (rep.rows.length ? rep.rows : [['—']]).map((r) => el('tr', {}, (r.length ? r : ['—']).map((c) => el('td', {}, [String(c == null ? '' : c)]))))),
        ])]),
      ]));
    });
  });

  async function saveReportRecord(version, type, format) {
    if (!version || !version.id) return;
    try { await App.supabase.from('planning_report').insert({ version_id: version.id, project_id: version.project_id || null, report_type: type, title: 'Export ' + format.toUpperCase(), format, created_by: uid() }); } catch (_) {}
    await logHistory({ project_id: version.project_id, version_id: version.id, entity: 'report', action: 'export', description: 'Export ' + format.toUpperCase() });
  }

  // ---------- REVISION 04: PROPOSAL & BOQ FINAL ENGINE ----------
  // Halaman ini muncul begitu Planner menekan Approve (lihat transitionStatus),
  // tapi juga bisa dibuka kapan pun untuk versi mana pun / draft yang belum
  // diversi. Dokumen (Proposal/BOQ Final/Material List) dibuat on-demand saat
  // tombol export ditekan — tidak disimpan sebagai file besar di DB.
  registerModule('planning-proposal', async function renderProposal(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const versionId = qs.get('version');
    let version = versionId ? await loadVersionById(versionId) : null;
    let snap, ctxProject = null;
    if (version) { snap = version.snapshot || {}; }
    else if (App._lastGeneration && App._lastGeneration.gen) { snap = genSnapshot(App._lastGeneration.gen); version = { version_no: 0, version_label: 'Draft (belum diversi)', status: 'draft' }; }

    if (!snap) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-file-contract' }), el('h3', {}, ['Belum ada data untuk Proposal']), el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/planning-wizard?step=3'; } }, ['Ke Generate'])])); return; }

    const PF = window.PlanningFinal;
    const fname = 'proposal_' + (version.version_label || 'draft').replace(/\s+/g, '_');
    const proposal = PF.buildProposal({ snapshot: snap, version, project: ctxProject, planner: pname(), boundary: snap.boundaryFeature && snap.boundaryFeature.properties, note: null });
    const boqFinal = PF.buildBOQFinal(snap);
    const material = PF.buildMaterialList(snap);

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Proposal — ' + (version.version_label || '')]), statusBadge(version.status)]),
      el('p', { class: 'text-muted text-xs' }, ['Dokumen ini otomatis dihasilkan dari hasil Auto Network Planning yang sudah di-approve. Lengkapi "Catatan Planner" sebelum export bila perlu (lewat halaman Planning Validation/Versions).']),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.openPrintable(proposal.html, 'Proposal — ' + proposal.project); } }, [el('i', { class: 'fa-solid fa-file-pdf' }), ' Proposal PDF']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '_boq_final.xls', 'application/vnd.ms-excel', PF.reportsToXLS({ boq: { title: 'BOQ Final', columns: ['Item', 'Unit', 'Qty'], rows: (boqFinal.items || []).map((it) => [it.item, it.unit, it.quantity]) } })); saveReportRecord(version, 'boq_final', 'xls'); } }, [el('i', { class: 'fa-solid fa-file-excel' }), ' BOQ Final Excel']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '_material.xls', 'application/vnd.ms-excel', PF.reportsToXLS({ material })); saveReportRecord(version, 'material_list', 'xls'); } }, [el('i', { class: 'fa-solid fa-boxes-stacked' }), ' Material List Excel']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.geojson', 'application/geo+json', PF.snapshotToGeoJSON(snap)); saveReportRecord(version, 'geometry', 'geojson'); } }, [el('i', { class: 'fa-solid fa-map' }), ' GeoJSON']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.kml', 'application/vnd.google-earth.kml+xml', PF.snapshotToKML(snap, fname)); saveReportRecord(version, 'geometry', 'kml'); } }, [el('i', { class: 'fa-solid fa-earth-asia' }), ' KML']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const blob = await PF.snapshotToKMZ(snap, fname); PF.downloadBlob(fname + '.kmz', 'application/vnd.google-earth.kmz', blob); saveReportRecord(version, 'geometry', 'kmz'); } }, [el('i', { class: 'fa-solid fa-earth-asia' }), ' KMZ']),
      ]),
      el('div', { class: 'text-xs', style: 'color:var(--color-text-muted);' }, ['Feeder: ' + boqFinal.feeder_note]),
    ]));

    // Preview ringkas Proposal.
    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Ringkasan Proposal'])]),
      el('div', { html: proposal.html }),
    ]));

    // Material List.
    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Material List'])]),
      el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, material.columns.map((c) => el('th', {}, [c])))]),
        el('tbody', {}, material.rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, [String(c)]))))),
      ])]),
    ]));

    // Map Export (PNG/JPEG/PDF) — pakai peta Review/Summary yang terakhir aktif di sesi ini.
    const mapCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Map Export'])]),
      el('p', { class: 'text-xs text-muted' }, ['Mengekspor tampilan peta yang terakhir dibuka (Review Mode / Planning Summary) sebagai gambar/PDF.']),
    ]);
    const mapBtns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' });
    ['png', 'jpeg', 'pdf'].forEach((fmt) => {
      mapBtns.appendChild(el('button', { class: 'btn btn-secondary btn-sm', onclick: () => exportActiveMap(fmt, fname) }, [el('i', { class: 'fa-solid fa-image' }), ' ' + fmt.toUpperCase()]));
    });
    mapCard.appendChild(mapBtns);
    container.appendChild(mapCard);
  });

  // Cari elemen DOM peta Leaflet yang sedang aktif (Review Mode / Summary / Reports),
  // lalu render ke canvas (html2canvas) dan unduh sebagai PNG/JPEG/PDF.
  async function exportActiveMap(format, fname) {
    const mapInstance = App.reviewMap || App.summaryMap || null;
    const target = mapInstance ? mapInstance.getContainer() : document.querySelector('.leaflet-container');
    if (!target || !window.html2canvas) { toast('Peta aktif tidak ditemukan atau html2canvas belum termuat.', 'warning'); return; }
    try {
      const canvas = await html2canvas(target, { useCORS: true, allowTaint: true });
      if (format === 'png' || format === 'jpeg') {
        const mime = format === 'png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => { window.PlanningFinal.downloadBlob(fname + '_map.' + format, mime, blob); }, mime, 0.95);
      } else if (format === 'pdf' && window.jspdf) {
        const { jsPDF } = window.jspdf;
        const img = canvas.toDataURL('image/png');
        const pdf = new jsPDF({ orientation: canvas.width > canvas.height ? 'landscape' : 'portrait', unit: 'px', format: [canvas.width, canvas.height] });
        pdf.addImage(img, 'PNG', 0, 0, canvas.width, canvas.height);
        pdf.save(fname + '_map.pdf');
      } else {
        toast('jsPDF belum termuat untuk export PDF.', 'warning');
      }
    } catch (e) { console.error(e); toast('Gagal export peta: ' + e.message, 'error'); }
  }

  // ---------- OVERRIDE MODULE: EXPORT (hub) ----------
  registerModule('export', async function renderExport(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const PF = window.PlanningFinal;
    const G = App._lastGeneration;
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Export'])]),
      el('p', { class: 'text-muted' }, ['Ekspor rencana ke PDF, Excel, GeoJSON, KML, KMZ, CSV. Untuk report lengkap per versi, gunakan menu Planning Reports.']),
    ]);
    if (G && G.gen) {
      const snap = genSnapshot(G.gen); const fname = 'planning_draft';
      card.appendChild(el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.geojson', 'application/geo+json', PF.snapshotToGeoJSON(snap)); } }, ['GeoJSON']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.kml', 'application/vnd.google-earth.kml+xml', PF.snapshotToKML(snap, fname)); } }, ['KML']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const blob = await PF.snapshotToKMZ(snap, fname); PF.downloadBlob(fname + '.kmz', 'application/vnd.google-earth.kmz', blob); } }, ['KMZ']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { PF.downloadBlob(fname + '.csv', 'text/csv', PF.reportToCSV(PF.buildReports({ snapshot: snap }).boq)); } }, ['CSV BOQ']),
        el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/planning-reports'; } }, ['Report Lengkap →']),
      ]));
    } else {
      card.appendChild(el('p', {}, [el('span', { class: 'badge badge-warning' }, ['Belum ada draft']), '  Generate dulu di Planning Wizard.']));
      card.appendChild(el('button', { class: 'btn btn-primary btn-sm', style: 'margin-top:6px;', onclick: () => { location.hash = '#/planning-wizard?step=1'; } }, ['Buka Wizard']));
    }
    container.appendChild(card);
  });

  // ---------- OVERRIDE MODULE: NOTIFICATION (workflow feed) ----------
  registerModule('notification', async function renderNotif(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const card = el('div', { class: 'card' }, [el('div', { class: 'card-header' }, [el('h3', {}, ['Notifikasi & Aktivitas'])]), el('p', { class: 'text-muted' }, ['Kejadian workflow terbaru: review, revisi, approval, reject, final.'])]);
    container.appendChild(card);
    let rows = [];
    try { const { data } = await App.supabase.from('planning_history').select('*').order('created_at', { ascending: false }).limit(40); rows = data || []; } catch (e) {}
    if (!rows.length) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-bell' }), el('h3', {}, ['Belum ada notifikasi'])])); return; }
    container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Waktu', 'Jenis', 'Aksi', 'Keterangan', 'Oleh'].map((h) => el('th', {}, [h])))]),
      el('tbody', {}, rows.map((r) => el('tr', {}, [
        el('td', { class: 'text-xs' }, [String(r.created_at || '').replace('T', ' ').slice(0, 16)]),
        el('td', {}, [el('span', { class: 'badge badge-info' }, [r.entity || '-'])]),
        el('td', {}, [r.action || '-']), el('td', { class: 'text-xs' }, [r.description || '']), el('td', {}, [r.actor_name || '-']),
      ]))),
    ])])]));
  });

  // ---------- DASHBOARD: seksi Smart Planning (append additive) ----------
  async function injectPlanningDashboard(container) {
    let versions = [];
    try { const { data } = await App.supabase.from('planning_version').select('status, project_id, home_passed, odp_count, odc_count, coverage_percent'); versions = data || []; } catch (e) { return; }
    if (!versions.length) return;
    const byStatus = { draft: 0, review: 0, revision: 0, approved: 0, rejected: 0, final: 0 };
    let hp = 0, odp = 0, odc = 0, covSum = 0; const projects = {};
    versions.forEach((v) => { byStatus[v.status] = (byStatus[v.status] || 0) + 1; hp += (v.home_passed || 0); odp += (v.odp_count || 0); odc += (v.odc_count || 0); covSum += (v.coverage_percent || 0); if (v.project_id) projects[v.project_id] = 1; });
    const avgCov = versions.length ? Math.round((covSum / versions.length) * 10) / 10 : 0;
    const stat = (label, value, icon) => el('div', { class: 'stat-card' }, [el('div', { class: 'stat-icon' }, [el('i', { class: 'fa-solid ' + icon })]), el('div', {}, [el('div', { class: 'stat-value' }, [String(value)]), el('div', { class: 'stat-label' }, [label])])]);
    const grid = el('div', { class: 'stat-grid' }, [
      stat('Project (planning)', Object.keys(projects).length, 'fa-folder-tree'),
      stat('Draft', byStatus.draft, 'fa-pen'),
      stat('Review', byStatus.review, 'fa-magnifying-glass'),
      stat('Approved', byStatus.approved, 'fa-circle-check'),
      stat('Rejected', byStatus.rejected, 'fa-circle-xmark'),
      stat('Final', byStatus.final, 'fa-flag-checkered'),
      stat('Total Home Passed', fmtNumber(hp), 'fa-house-signal'),
      stat('Total ODP', fmtNumber(odp), 'fa-diagram-project'),
      stat('Total ODC', fmtNumber(odc), 'fa-server'),
      stat('Coverage rata²', avgCov + '%', 'fa-wifi'),
    ]);
    container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Smart Planning — Ringkasan'])]),
      grid,
    ]));
  }
  App.injectPlanningDashboard = injectPlanningDashboard;

  /* ================= [REVISION 01] DETECTED BUILDINGS ================= */
  ROUTE_TITLES['detected-buildings'] = 'Detected Buildings';
  const DB_CATEGORIES = ['Rumah', 'Ruko', 'Gedung', 'Apartemen', 'Lainnya'];
  const DB_STATUSES = ['detected', 'verified', 'edited', 'merged', 'removed'];

  function googleMapsUrl(lat, lng) { return 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng; }

  async function loadDetectedBuildings(filter) {
    filter = filter || {};
    try {
      let q = App.supabase.from('detected_buildings').select('*');
      if (filter.analysisId) q = q.eq('analysis_id', filter.analysisId);
      if (filter.projectId) q = q.eq('project_id', filter.projectId);
      const { data, error } = await q.order('building_id', { ascending: true }).limit(5000);
      if (error) throw error;
      return data || [];
    } catch (e) { console.warn('[DetectedBuildings] load', e.message); return null; }
  }
  async function latestAnalysisId() {
    if (App._lastAnalysis && App._lastAnalysis.id) return App._lastAnalysis.id;
    try { const { data } = await App.supabase.from('planning_analysis').select('id').order('created_at', { ascending: false }).limit(1); return (data && data[0] && data[0].id) || null; }
    catch (e) { return null; }
  }

  // Export helpers untuk daftar bangunan.
  function buildingsRowsCSV(rows) {
    const cols = ['building_id', 'lat', 'lng', 'centroid_lat', 'centroid_lng', 'area_sqm', 'perimeter_m', 'category', 'confidence', 'status', 'planner', 'created_at'];
    const esc = (v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\r\n');
  }
  function buildingsRowsGeoJSON(rows) {
    return JSON.stringify({ type: 'FeatureCollection', features: rows.map((r) => (r.geojson && r.geojson.geometry) ? { type: 'Feature', properties: { building_id: r.building_id, category: r.category, status: r.status, confidence: r.confidence, area_sqm: r.area_sqm }, geometry: r.geojson.geometry } : { type: 'Feature', properties: { building_id: r.building_id, category: r.category, status: r.status }, geometry: { type: 'Point', coordinates: [r.lng, r.lat] } }) });
  }
  function buildingsRowsKML(rows) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const pm = rows.map((r) => '<Placemark><name>' + esc(r.building_id) + '</name><description>' + esc(r.category + ' / ' + r.status) + '</description><Point><coordinates>' + r.lng + ',' + r.lat + ',0</coordinates></Point></Placemark>').join('');
    return '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Detected Buildings</name>' + pm + '</Document></kml>';
  }

  registerModule('detected-buildings', async function renderDetected(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const analysisId = qs.get('analysis') || await latestAnalysisId();

    const st = { rows: [], analysisId, search: '', category: qs.get('category') || '', status: qs.get('status') || '', sort: 'building_id', page: 1, pageSize: 20, selected: {}, detail: null };

    const header = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Detected Buildings']), el('span', { class: 'badge badge-info', id: 'db-count' }, ['0'])]),
      el('p', { class: 'text-muted' }, ['Seluruh bangunan hasil analisa (deteksi). Klik baris untuk zoom & highlight, klik bangunan untuk detail. Planner dapat tambah/edit/hapus/pindah/duplikat/merge/split.']),
    ]);
    container.appendChild(header);

    if (!analysisId) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-buildings' }), el('h3', {}, ['Belum ada analisa']), el('p', { class: 'text-muted' }, ['Jalankan Analisa Area dulu.']), el('button', { class: 'btn btn-primary btn-sm', onclick: () => { location.hash = '#/planning-wizard?step=1'; } }, ['Buka Wizard'])])); return; }

    const rows = await loadDetectedBuildings({ analysisId });
    if (rows === null) { container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-triangle-exclamation' }), el('h3', {}, ['Tabel belum tersedia']), el('p', { class: 'text-muted' }, ['Jalankan migration 008_detected_buildings.sql lalu analisa ulang.'])])); return; }
    st.rows = rows;

    // Toolbar.
    const searchIn = el('input', { class: 'text-input', placeholder: 'Cari Building ID / kategori...', style: 'max-width:220px;', oninput: (e) => { st.search = e.target.value.trim().toLowerCase(); st.page = 1; paint(); } });
    if (st.search) searchIn.value = st.search;
    const catSel = el('select', { class: 'text-input', style: 'max-width:150px;', onchange: (e) => { st.category = e.target.value; st.page = 1; paint(); } }, [el('option', { value: '' }, ['Semua kategori'])].concat(DB_CATEGORIES.map((c) => el('option', { value: c, selected: st.category === c ? 'selected' : null }, [c]))));
    const statSel = el('select', { class: 'text-input', style: 'max-width:150px;', onchange: (e) => { st.status = e.target.value; st.page = 1; paint(); } }, [el('option', { value: '' }, ['Semua status'])].concat(DB_STATUSES.map((s) => el('option', { value: s, selected: st.status === s ? 'selected' : null }, [s]))));
    const sortSel = el('select', { class: 'text-input', style: 'max-width:160px;', onchange: (e) => { st.sort = e.target.value; paint(); } }, [['building_id', 'Building ID'], ['area_sqm', 'Area'], ['perimeter_m', 'Perimeter'], ['confidence', 'Confidence'], ['category', 'Kategori'], ['status', 'Status']].map((o) => el('option', { value: o[0] }, [o[1]])));
    const toolbar = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;' }, [searchIn, catSel, statSel, el('span', { class: 'text-xs text-muted' }, ['Urut:']), sortSel]);

    const exportBar = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;' }, [
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { window.PlanningFinal.downloadBlob('detected_buildings.csv', 'text/csv', buildingsRowsCSV(filtered())); } }, [el('i', { class: 'fa-solid fa-file-csv' }), ' CSV']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { const rowsF = filtered(); const rep = { title: 'Detected Buildings', columns: ['Building ID', 'Lat', 'Lng', 'Area', 'Perimeter', 'Kategori', 'Confidence', 'Status'], rows: rowsF.map((r) => [r.building_id, r.lat, r.lng, r.area_sqm, r.perimeter_m, r.category, r.confidence, r.status]) }; window.PlanningFinal.downloadBlob('detected_buildings.xls', 'application/vnd.ms-excel', window.PlanningFinal.reportsToXLS({ b: rep })); } }, [el('i', { class: 'fa-solid fa-file-excel' }), ' Excel']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { window.PlanningFinal.downloadBlob('detected_buildings.geojson', 'application/geo+json', buildingsRowsGeoJSON(filtered())); } }, [el('i', { class: 'fa-solid fa-map' }), ' GeoJSON']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { window.PlanningFinal.downloadBlob('detected_buildings.kml', 'application/vnd.google-earth.kml+xml', buildingsRowsKML(filtered())); } }, [el('i', { class: 'fa-solid fa-earth-asia' }), ' KML']),
    ]);

    // CRUD toolbar.
    const crudBar = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;' }, [
      el('button', { class: 'btn btn-primary btn-sm', onclick: addBuilding }, [el('i', { class: 'fa-solid fa-plus' }), ' Tambah']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: mergeSelected }, [el('i', { class: 'fa-solid fa-object-group' }), ' Merge terpilih']),
      el('button', { class: 'btn btn-secondary btn-sm', onclick: splitSelected }, [el('i', { class: 'fa-solid fa-object-ungroup' }), ' Split terpilih']),
      el('button', { class: 'btn btn-danger btn-sm', onclick: deleteSelected }, [el('i', { class: 'fa-solid fa-trash' }), ' Hapus terpilih']),
    ]);

    const mapEl = el('div', { id: 'db-map', style: 'height:340px;border-radius:10px;overflow:hidden;margin-bottom:10px;' });
    const tableWrap = el('div', { class: 'table-wrap' });
    const pager = el('div', { style: 'display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;' });
    const detailWrap = el('div', { style: 'margin-top:12px;' });

    container.appendChild(el('div', { class: 'card' }, [toolbar, crudBar, exportBar, mapEl, tableWrap, pager]));
    container.appendChild(detailWrap);

    // Peta.
    let map = null, layer = null;
    function ensureMap() {
      if (map || !window.L) return;
      map = L.map(mapEl, { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
      App.detectedMap = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 20 }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    function colorOf(cat) { return { Rumah: '#1E7B4D', Ruko: '#9A6700', Gedung: '#8250DF', Apartemen: '#0B6E99', Lainnya: '#57606A' }[cat] || '#57606A'; }

    function drawMap(pageRows) {
      ensureMap(); if (!map) return;
      layer.clearLayers();
      const pts = [];
      pageRows.forEach((r) => {
        let lyr;
        if (r.polygon && r.polygon.type) {
          lyr = L.geoJSON({ type: 'Feature', geometry: r.polygon, properties: {} }, { style: { color: colorOf(r.category), weight: 1.5, fillOpacity: 0.25 } });
          lyr.on('click', () => { st.detail = r; renderDetail(); });
        } else {
          // Titik: marker draggable agar planner bisa MOVE (Revision 01, Perubahan 7).
          const ic = L.divIcon({ className: 'db-pin', html: '<div style="width:12px;height:12px;border-radius:50%;background:' + colorOf(r.category) + ';border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.5);"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
          lyr = L.marker([r.lat, r.lng], { icon: ic, draggable: true });
          lyr.on('click', () => { st.detail = r; renderDetail(); });
          lyr.on('dragend', async (e) => {
            const ll = e.target.getLatLng();
            await updateBuilding(r, { lat: ll.lat, lng: ll.lng, centroid_lat: ll.lat, centroid_lng: ll.lng, status: r.status === 'detected' ? 'edited' : r.status, geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [ll.lng, ll.lat] }, properties: {} } });
            toast('Posisi ' + r.building_id + ' dipindah.', 'success');
          });
        }
        lyr.addTo(layer); pts.push([r.lat, r.lng]);
        r._layer = lyr;
      });
      if (pts.length) { try { map.fitBounds(pts, { maxZoom: 18, padding: [20, 20] }); } catch (e) {} }
      setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 150);
    }
    function zoomTo(r) { ensureMap(); if (!map) return; map.setView([r.lat, r.lng], 19); if (r._layer && r._layer.openPopup) { /* highlight */ } if (r._layer && r._layer.setStyle) { r._layer.setStyle({ weight: 3, color: '#B3261E' }); } }

    function filtered() {
      let out = st.rows.slice();
      if (st.search) out = out.filter((r) => (String(r.building_id || '').toLowerCase().indexOf(st.search) !== -1) || (String(r.category || '').toLowerCase().indexOf(st.search) !== -1));
      if (st.category) out = out.filter((r) => r.category === st.category);
      if (st.status) out = out.filter((r) => r.status === st.status);
      out.sort((a, b) => { const va = a[st.sort], vb = b[st.sort]; if (typeof va === 'number' && typeof vb === 'number') return vb - va; return String(va).localeCompare(String(vb)); });
      return out;
    }

    function paint() {
      const all = filtered();
      $('#db-count').textContent = fmtNumber(all.length);
      const pages = Math.max(1, Math.ceil(all.length / st.pageSize));
      if (st.page > pages) st.page = pages;
      const start = (st.page - 1) * st.pageSize;
      const pageRows = all.slice(start, start + st.pageSize);

      tableWrap.innerHTML = '';
      const table = el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['', 'No', 'Building ID', 'Lat', 'Lng', 'Area', 'Perimeter', 'Kategori', 'Confidence', 'Status', 'Planner', 'Tanggal'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, pageRows.map((r, i) => {
          const cb = el('input', { type: 'checkbox', onclick: (e) => { e.stopPropagation(); if (e.target.checked) st.selected[r.id] = true; else delete st.selected[r.id]; } });
          if (st.selected[r.id]) cb.setAttribute('checked', 'checked');
          const tr = el('tr', { style: 'cursor:pointer;' }, [
            el('td', {}, [cb]),
            el('td', {}, [String(start + i + 1)]),
            el('td', { style: 'font-weight:600;' }, [r.building_id || '-']),
            el('td', {}, [String(r.lat != null ? Number(r.lat).toFixed(6) : '-')]),
            el('td', {}, [String(r.lng != null ? Number(r.lng).toFixed(6) : '-')]),
            el('td', {}, [fmtNumber(r.area_sqm) + ' m²']),
            el('td', {}, [fmtNumber(r.perimeter_m) + ' m']),
            el('td', {}, [el('span', { class: 'badge badge-neutral' }, [r.category || '-'])]),
            el('td', {}, [String(r.confidence != null ? r.confidence : '-')]),
            el('td', {}, [el('span', { class: 'badge badge-' + (r.status === 'detected' ? 'info' : (r.status === 'removed' ? 'danger' : 'success')) }, [r.status || '-'])]),
            el('td', { class: 'text-xs' }, [r.planner || '-']),
            el('td', { class: 'text-xs text-muted' }, [String(r.created_at || '').slice(0, 10)]),
          ]);
          tr.addEventListener('click', () => { st.detail = r; zoomTo(r); renderDetail(); });
          return tr;
        })),
      ]);
      tableWrap.appendChild(table);

      pager.innerHTML = '';
      pager.appendChild(el('span', { class: 'text-xs text-muted' }, ['Halaman ' + st.page + ' / ' + pages]));
      pager.appendChild(el('button', { class: 'btn btn-ghost btn-sm', disabled: st.page <= 1 ? 'disabled' : null, onclick: () => { st.page--; paint(); } }, ['‹ Prev']));
      pager.appendChild(el('button', { class: 'btn btn-ghost btn-sm', disabled: st.page >= pages ? 'disabled' : null, onclick: () => { st.page++; paint(); } }, ['Next ›']));

      drawMap(pageRows);
    }

    function renderDetail() {
      detailWrap.innerHTML = '';
      const r = st.detail; if (!r) return;
      const catSelD = el('select', { class: 'text-input', style: 'max-width:160px;' }, DB_CATEGORIES.map((c) => el('option', { value: c, selected: r.category === c ? 'selected' : null }, [c])));
      const statSelD = el('select', { class: 'text-input', style: 'max-width:160px;' }, DB_STATUSES.map((s) => el('option', { value: s, selected: r.status === s ? 'selected' : null }, [s])));
      const field = (label, val) => el('div', { style: 'display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #eee;' }, [el('span', { class: 'text-xs text-muted' }, [label]), el('span', { style: 'font-weight:600;word-break:break-all;' }, [String(val)])]);
      detailWrap.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Detail: ' + (r.building_id || '-')]), statusBadge(r.status)]),
        field('Latitude', r.lat), field('Longitude', r.lng), field('Centroid', (r.centroid_lat != null ? r.centroid_lat : r.lat) + ', ' + (r.centroid_lng != null ? r.centroid_lng : r.lng)),
        field('Area', fmtNumber(r.area_sqm) + ' m²'), field('Perimeter', fmtNumber(r.perimeter_m) + ' m'),
        field('Polygon', r.polygon ? 'Ada' : 'Titik'), field('Confidence', r.confidence),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center;' }, [el('span', { class: 'text-xs text-muted' }, ['Kategori']), catSelD, el('span', { class: 'text-xs text-muted' }, ['Status']), statSelD]),
        el('details', {}, [el('summary', { class: 'text-xs text-muted' }, ['GeoJSON']), el('pre', { style: 'max-height:120px;overflow:auto;font-size:11px;background:#f6f8fa;padding:8px;border-radius:6px;' }, [JSON.stringify(r.geojson || { type: 'Point', coordinates: [r.lng, r.lat] })])]),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;' }, [
          el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { await updateBuilding(r, { category: catSelD.value, status: statSelD.value === 'detected' ? 'edited' : statSelD.value }); } }, [el('i', { class: 'fa-solid fa-floppy-disk' }), ' Simpan']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { const ll = (r.lat) + ',' + (r.lng); if (navigator.clipboard) navigator.clipboard.writeText(ll); toast('Koordinat disalin: ' + ll, 'success'); } }, [el('i', { class: 'fa-solid fa-copy' }), ' Copy Coordinate']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { window.open(googleMapsUrl(r.lat, r.lng), '_blank'); } }, [el('i', { class: 'fa-solid fa-map-location-dot' }), ' Google Maps']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { zoomTo(r); } }, [el('i', { class: 'fa-solid fa-magnifying-glass-plus' }), ' Zoom']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => duplicateBuilding(r) }, [el('i', { class: 'fa-solid fa-clone' }), ' Duplicate']),
          el('button', { class: 'btn btn-secondary btn-sm', onclick: () => splitBuilding(r) }, [el('i', { class: 'fa-solid fa-object-ungroup' }), ' Split']),
          el('button', { class: 'btn btn-danger btn-sm', onclick: () => deleteBuilding(r) }, [el('i', { class: 'fa-solid fa-trash' }), ' Hapus']),
        ]),
      ]));
    }

    // ---- CRUD ----
    async function afterChange(msg) { toast(msg + ' — Dashboard/Planning/BOQ akan mengikuti saat regenerate.', 'success', 3500); const fresh = await loadDetectedBuildings({ analysisId: st.analysisId }); if (fresh) { st.rows = fresh; st.selected = {}; paint(); if (st.detail) { st.detail = fresh.find((x) => x.id === st.detail.id) || null; renderDetail(); } } }
    function nextBid() { return 'BLD-' + String(Date.now()).slice(-6); }
    async function insertRow(row) {
      try { const { data, error } = await App.supabase.from('detected_buildings').insert(Object.assign({ analysis_id: st.analysisId, project_id: (App._lastAnalysis && App._lastAnalysis.projectId) || null, planner: pname(), created_by: uid() }, row)).select().single(); if (error) throw error; return data; }
      catch (e) { toast('Gagal simpan (migration 008?).', 'warning', 4000); return null; }
    }
    async function addBuilding() {
      ensureMap(); const c = map ? map.getCenter() : { lat: CFG.DEFAULT_CENTER[0], lng: CFG.DEFAULT_CENTER[1] };
      const row = { building_id: nextBid(), lat: c.lat, lng: c.lng, centroid_lat: c.lat, centroid_lng: c.lng, polygon: null, geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: {} }, area_sqm: 60, perimeter_m: 31, category: 'Rumah', confidence: 1, status: 'edited' };
      const d = await insertRow(row); if (d) afterChange('Bangunan ditambahkan');
    }
    async function updateBuilding(r, patch) {
      try { const { error } = await App.supabase.from('detected_buildings').update(patch).eq('id', r.id); if (error) throw error; afterChange('Perubahan disimpan'); }
      catch (e) { toast('Gagal update.', 'warning'); }
    }
    async function deleteBuilding(r) {
      if (!confirm('Hapus ' + r.building_id + '?')) return;
      try { await App.supabase.from('detected_buildings').delete().eq('id', r.id); st.detail = null; afterChange('Bangunan dihapus'); }
      catch (e) { toast('Gagal hapus.', 'warning'); }
    }
    async function duplicateBuilding(r) {
      const row = Object.assign({}, r); delete row.id; delete row.created_at; delete row.updated_at;
      row.building_id = nextBid(); row.lat = Number(r.lat) + 0.00008; row.lng = Number(r.lng) + 0.00008; row.centroid_lat = row.lat; row.centroid_lng = row.lng; row.status = 'edited'; row.polygon = null;
      row.geojson = { type: 'Feature', geometry: { type: 'Point', coordinates: [row.lng, row.lat] }, properties: {} };
      const d = await insertRow(row); if (d) afterChange('Bangunan diduplikat');
    }
    async function splitBuilding(r) {
      const a = { building_id: nextBid(), lat: Number(r.lat) + 0.00006, lng: Number(r.lng), centroid_lat: Number(r.lat) + 0.00006, centroid_lng: Number(r.lng), area_sqm: Math.round((r.area_sqm || 60) / 2), perimeter_m: r.perimeter_m, category: r.category, confidence: r.confidence, status: 'edited', polygon: null, geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat) + 0.00006] }, properties: {} } };
      const b = Object.assign({}, a, { building_id: nextBid(), lat: Number(r.lat) - 0.00006, centroid_lat: Number(r.lat) - 0.00006, geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat) - 0.00006] }, properties: {} } });
      await insertRow(a); await insertRow(b);
      try { await App.supabase.from('detected_buildings').update({ status: 'merged' }).eq('id', r.id); } catch (e) {}
      afterChange('Bangunan di-split menjadi 2');
    }
    async function deleteSelected() {
      const ids = Object.keys(st.selected); if (!ids.length) { toast('Pilih baris dulu (checkbox).', 'info'); return; }
      if (!confirm('Hapus ' + ids.length + ' bangunan terpilih?')) return;
      try { await App.supabase.from('detected_buildings').delete().in('id', ids); afterChange(ids.length + ' bangunan dihapus'); }
      catch (e) { toast('Gagal hapus massal.', 'warning'); }
    }
    async function mergeSelected() {
      const ids = Object.keys(st.selected); if (ids.length < 2) { toast('Pilih minimal 2 bangunan.', 'info'); return; }
      const sel = st.rows.filter((r) => st.selected[r.id]);
      const lat = sel.reduce((a, r) => a + Number(r.lat), 0) / sel.length;
      const lng = sel.reduce((a, r) => a + Number(r.lng), 0) / sel.length;
      const area = sel.reduce((a, r) => a + Number(r.area_sqm || 0), 0);
      const merged = { building_id: nextBid(), lat, lng, centroid_lat: lat, centroid_lng: lng, area_sqm: area, perimeter_m: Math.round(4 * Math.sqrt(area || 1)), category: sel[0].category, confidence: 1, status: 'merged', polygon: null, geojson: { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} } };
      const d = await insertRow(merged);
      if (d) { try { await App.supabase.from('detected_buildings').delete().in('id', ids); } catch (e) {} afterChange(ids.length + ' bangunan digabung'); }
    }
    async function splitSelected() { const ids = Object.keys(st.selected); if (ids.length !== 1) { toast('Pilih tepat 1 bangunan untuk split.', 'info'); return; } const r = st.rows.find((x) => x.id === ids[0]); if (r) splitBuilding(r); }

    paint();
  }, function destroyDetected() { if (App.detectedMap) { try { App.detectedMap.remove(); } catch (e) {} App.detectedMap = null; } });

  // Kategori bangunan yang dapat diklik di Dashboard (Revision 01, Perubahan 9).
  async function injectBuildingCategories(container) {
    let rows = [];
    try { const { data } = await App.supabase.from('detected_buildings').select('category'); rows = data || []; } catch (e) { return; }
    if (!rows.length) return;
    const counts = { Rumah: 0, Ruko: 0, Gedung: 0, Apartemen: 0, Lainnya: 0 };
    rows.forEach((r) => { counts[r.category] = (counts[r.category] || 0) + 1; });
    const icon = { Rumah: 'fa-house', Ruko: 'fa-store', Gedung: 'fa-building', Apartemen: 'fa-city', Lainnya: 'fa-shapes' };
    const grid = el('div', { class: 'stat-grid' }, DB_CATEGORIES.map((c) => {
      const card = el('div', { class: 'stat-card', style: 'cursor:pointer;', title: 'Lihat daftar ' + c }, [el('div', { class: 'stat-icon' }, [el('i', { class: 'fa-solid ' + icon[c] })]), el('div', {}, [el('div', { class: 'stat-value' }, [fmtNumber(counts[c] || 0)]), el('div', { class: 'stat-label' }, [c])])]);
      card.addEventListener('click', () => { location.hash = '#/detected-buildings?category=' + encodeURIComponent(c); });
      return card;
    }));
    container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [el('div', { class: 'card-header' }, [el('h3', {}, ['Bangunan Terdeteksi (klik untuk daftar)'])]), grid]));
  }
  App.injectBuildingCategories = injectBuildingCategories;

  /* ================= [REALTIME] ================= */
  function stopRealtime() {
    App.realtimeChannels.forEach((ch) => App.supabase.removeChannel(ch));
    App.realtimeChannels = [];
  }

  /* ================= [REVISION 05] CONSTRUCTION, AS-BUILT & ASSET MANAGEMENT ================= */
  ROUTE_TITLES['asset-management'] = 'Asset Management';
  ROUTE_TITLES['global-map'] = 'Global Map';
  ROUTE_TITLES['asset-reports'] = 'Asset & QC Reports';

  // Aset titik (lat/lng langsung) — didukung PENUH: update lokasi (As Built),
  // riwayat versi + restore, foto dokumentasi.
  const ASSET_DEFS = [
    { type: 'pole', table: 'poles', nameCol: 'code', label: 'Tiang' },
    { type: 'odp', table: 'odp', nameCol: 'name', label: 'ODP' },
    { type: 'odc', table: 'odc', nameCol: 'name', label: 'ODC' },
    { type: 'home', table: 'homes', nameCol: 'owner_name', label: 'Rumah' },
    { type: 'closure', table: 'closures', nameCol: 'name', label: 'Closure' },
    { type: 'handhole', table: 'handholes', nameCol: 'name', label: 'Handhole' },
    { type: 'jointbox', table: 'jointboxes', nameCol: 'name', label: 'Joint Box' },
  ];
  // Aset garis (geometry LineString) — status/BOQ/report didukung, TAPI
  // edit geometri lewat form lat/lng TIDAK relevan (butuh editor garis
  // tersendiri, di luar cakupan revisi ini — lihat REVISION_05_REPORT.md).
  const LINE_ASSET_DEFS = [
    { type: 'backbone', table: 'backbones', nameCol: 'name', label: 'Backbone' },
    { type: 'distribution', table: 'distributions', nameCol: 'name', label: 'Distribution' },
    { type: 'drop', table: 'kabels', nameCol: 'name', label: 'Drop Cable / Kabel' },
  ];
  function assetDef(type) { return ASSET_DEFS.find((d) => d.type === type) || LINE_ASSET_DEFS.find((d) => d.type === type); }

  // PRODUCTION HARDENING: batasi jumlah baris per tabel per fetch supaya
  // tidak menggantung/crash di dataset sangat besar (target skala: ratusan
  // ribu bangunan). Ini BUKAN solusi skala-penuh (virtual scroll/pagination
  // sungguhan) — lihat FINAL_PERFORMANCE_REPORT.md untuk keterbatasan jujur
  // & rekomendasi lanjutan bila dataset produksi mendekati 500.000 baris.
  const ASSET_FETCH_LIMIT = 20000;
  async function loadAllPointAssets() {
    const out = []; let truncated = false;
    await Promise.all(ASSET_DEFS.map(async (def) => {
      try {
        let q = App.supabase.from(def.table).select('id,' + def.nameCol + ',lat,lng,asset_status,project_id').limit(ASSET_FETCH_LIMIT);
        q = scopeToProject(q, def.table); // FIX #E9: ikut Project Aktif
        const { data, error } = await q;
        if (error || !data) return;
        if (data.length >= ASSET_FETCH_LIMIT) truncated = true;
        data.forEach((r) => out.push({ asset_type: def.type, id: r.id, name: r[def.nameCol], lat: r.lat, lng: r.lng, asset_status: r.asset_status || 'draft', project_id: r.project_id }));
      } catch (e) { /* migration 011 belum jalan / kolom belum ada — abaikan tabel ini */ }
    }));
    out._truncated = truncated;
    return out;
  }
  async function loadAllLineAssets() {
    const out = []; let truncated = false;
    await Promise.all(LINE_ASSET_DEFS.map(async (def) => {
      try {
        let q = App.supabase.from(def.table).select('id,' + def.nameCol + ',asset_status,project_id,length_m').limit(ASSET_FETCH_LIMIT);
        q = scopeToProject(q, def.table); // FIX #E9: ikut Project Aktif
        const { data, error } = await q;
        if (error || !data) return;
        if (data.length >= ASSET_FETCH_LIMIT) truncated = true;
        data.forEach((r) => out.push({ asset_type: def.type, id: r.id, name: r[def.nameCol], asset_status: r.asset_status || 'draft', project_id: r.project_id, length_m: r.length_m }));
      } catch (e) {}
    }));
    out._truncated = truncated;
    return out;
  }
  async function logAssetChange(entry) {
    try { await App.supabase.from('asset_change_log').insert(Object.assign({ changed_by: uid(), changed_by_name: pname() }, entry)); }
    catch (e) { console.warn('[AssetMgmt] gagal mencatat log:', e.message); }
  }
  async function loadAssetChangeLog(assetType, assetId) {
    try { const { data } = await App.supabase.from('asset_change_log').select('*').eq('asset_type', assetType).eq('asset_id', assetId).order('created_at', { ascending: false }); return data || []; }
    catch (e) { return []; }
  }
  async function loadAssetPhotos(assetType, assetId) {
    try { const { data } = await App.supabase.from('asset_photo').select('*').eq('asset_type', assetType).eq('asset_id', assetId).order('created_at', { ascending: false }); return data || []; }
    catch (e) { return []; }
  }
  async function loadAssetDocuments(assetType, assetId) {
    try { const { data } = await App.supabase.from('asset_document').select('*').eq('asset_type', assetType).eq('asset_id', assetId).order('created_at', { ascending: false }); return data || []; }
    catch (e) { return []; }
  }
  // Duplicate Asset — menutup celah dari FINAL_AUDIT_REPORT.md. Hanya untuk
  // aset titik (lat/lng); aset garis butuh duplikasi geometri yang lebih
  // kompleks dan belum didukung di sini.
  async function duplicateAsset(asset) {
    const def = assetDef(asset.asset_type); if (!def) return;
    if (asset.lat == null) { toast('Duplikasi aset garis belum didukung — duplikasi manual lewat halaman CRUD terkait.', 'warning', 5000); return; }
    const ok = await confirmDialog('Duplikat "' + (asset.name || asset.id) + '"? Salinan baru akan ditempatkan sedikit bergeser dari lokasi asli.', 'Duplikat Aset');
    if (!ok) return;
    const nameCol = def.nameCol;
    const payload = { lat: asset.lat + 0.00005, lng: asset.lng + 0.00005, asset_status: 'draft' };
    payload[nameCol] = (asset.name || '') + ' (copy)';
    if (asset.project_id) payload.project_id = asset.project_id;
    try {
      const { data, error } = await App.supabase.from(def.table).insert(payload).select().single();
      if (error) throw error;
      await logAssetChange({ project_id: asset.project_id, asset_type: asset.asset_type, asset_id: data.id, change_type: 'field_update', new_value: { duplicated_from: asset.id }, note: 'Hasil duplikasi dari ' + (asset.name || asset.id) });
      toast(def.label + ' berhasil diduplikasi.', 'success');
    } catch (e) { toast('Gagal duplikasi: ' + e.message, 'error'); }
  }
  async function updateAssetStatus(asset, newStatus) {
    const def = assetDef(asset.asset_type); if (!def) return;
    const old = asset.asset_status;
    try { await App.supabase.from(def.table).update({ asset_status: newStatus }).eq('id', asset.id); }
    catch (e) { toast('Gagal update status (pastikan Migration 011 sudah dijalankan).', 'error'); return; }
    await logAssetChange({ project_id: asset.project_id, asset_type: asset.asset_type, asset_id: asset.id, change_type: 'status_change', old_value: { asset_status: old }, new_value: { asset_status: newStatus } });
    asset.asset_status = newStatus;
    toast('Status aset diperbarui.', 'success');
    // FIX #E10 (audit "serba otomatis"): sebelumnya status tiap Rumah/ODP harus
    // diubah manual satu-satu meski secara fisik mereka 1 paket pekerjaan
    // (mis. ODP selesai dipasang -> semua Rumah di ODP itu juga logisnya
    // "Terpasang"). Sekarang begitu status ODC/ODP berubah ke status lapangan
    // (installed/verified/maintenance/removed), sistem otomatis tawarkan
    // cascade ke aset turunannya — cukup 1 klik konfirmasi, bukan input ulang.
    if (['installed', 'verified', 'maintenance', 'removed'].includes(newStatus)) {
      if (asset.asset_type === 'odp') await cascadeStatusToChildren('homes', 'odp_id', asset.id, newStatus, 'Rumah');
      else if (asset.asset_type === 'odc') await cascadeStatusToChildren('odp', 'odc_id', asset.id, newStatus, 'ODP');
    }
  }
  async function cascadeStatusToChildren(table, fkCol, parentId, newStatus, label) {
    try {
      const { data, error } = await App.supabase.from(table).select('id').eq(fkCol, parentId);
      if (error || !data || !data.length) return;
      const ok = await confirmDialog('Ada ' + data.length + ' ' + label + ' yang terhubung ke aset ini. Ikut ubah status jadi "' + newStatus + '" juga?', 'Cascade Status Otomatis');
      if (!ok) return;
      const { error: updErr } = await App.supabase.from(table).update({ asset_status: newStatus }).eq(fkCol, parentId);
      if (updErr) { toast('Gagal cascade status: ' + updErr.message, 'error'); return; }
      await logAssetChange({ asset_type: table === 'homes' ? 'home' : 'odp', asset_id: parentId, change_type: 'cascade_status', new_value: { asset_status: newStatus, count: data.length } });
      toast(data.length + ' ' + label + ' ikut diperbarui otomatis ke "' + newStatus + '".', 'success', 5000);
    } catch (e) { /* tabel/kolom belum siap — diamkan, tidak mengganggu update utama */ }
  }
  async function updateAssetLocation(asset, newLat, newLng, note, reason, changeType) {
    const def = assetDef(asset.asset_type); if (!def) return false;
    const oldLat = asset.lat, oldLng = asset.lng;
    try { await App.supabase.from(def.table).update({ lat: newLat, lng: newLng }).eq('id', asset.id); }
    catch (e) { toast('Gagal update lokasi.', 'error'); return false; }
    await logAssetChange({ project_id: asset.project_id, asset_type: asset.asset_type, asset_id: asset.id, change_type: changeType || 'move', old_lat: oldLat, old_lng: oldLng, new_lat: newLat, new_lng: newLng, note: note || null, reason: reason || null });
    asset.lat = newLat; asset.lng = newLng;
    toast('Lokasi diperbarui & tercatat sebagai As Built.', 'success');
    return true;
  }

  registerModule('asset-management', async function renderAssetManagement(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const [points, lines] = await Promise.all([loadAllPointAssets(), loadAllLineAssets()]);
    const all = points.concat(lines);
    if (points._truncated || lines._truncated) toast('Sebagian tabel aset melebihi ' + ASSET_FETCH_LIMIT + ' baris — data yang ditampilkan dibatasi demi performa.', 'warning', 6000);
    if (!all.length) {
      container.appendChild(el('div', { class: 'card empty-state' }, [el('i', { class: 'fa-solid fa-toolbox' }), el('h3', {}, ['Belum ada aset atau Migration 011 belum dijalankan.']), el('p', { class: 'text-muted text-xs' }, ['Jalankan schema_full.sql (bagian [J] MIGRATION 011) di Supabase, lalu buat data aset lewat modul Mapping/Import.'])]));
      return;
    }
    const state = { q: '', type: '', status: '', selected: null };

    // FIX #E10 (audit "serba otomatis"): tool update massal — sebelumnya untuk
    // menandai semua Rumah di 1 ODP jadi "Terpasang" harus buka tiap baris
    // Rumah satu-satu. Sekarang cukup pilih ODP + status tujuan, 1 klik.
    const odpOptions = points.filter((p) => p.asset_type === 'odp');
    if (odpOptions.length) {
      const odpSelect = el('select', { class: 'text-input', style: 'max-width:220px;' }, odpOptions.map((o) => el('option', { value: o.id }, [o.name || o.id])));
      const statusSelect = el('select', { class: 'text-input', style: 'max-width:160px;' }, window.PlanningFinal.ASSET_STATUS_ORDER.map((s) => el('option', { value: s }, [s])));
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, ['Update Massal Status Rumah per ODP'])]),
        el('p', { class: 'text-xs text-muted' }, ['Terapkan 1 status ke SEMUA rumah yang terhubung ke 1 ODP sekaligus — tidak perlu ubah satu-satu.']),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [
          odpSelect, statusSelect,
          el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
            await cascadeStatusToChildren('homes', 'odp_id', odpSelect.value, statusSelect.value, 'Rumah');
            renderList();
          } }, [el('i', { class: 'fa-solid fa-arrows-turn-right' }), ' Terapkan ke Semua Rumah di ODP ini']),
        ]),
      ]));
    }

    const filterCard = el('div', { class: 'card' }, [
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [
        el('input', { type: 'text', placeholder: 'Cari nama/kode/lat/lng/project...', class: 'text-input', style: 'flex:1;min-width:180px;', oninput: (e) => { state.q = e.target.value; renderList(); } }),
        el('select', { class: 'text-input', style: 'width:auto;', onchange: (e) => { state.type = e.target.value; renderList(); } }, [el('option', { value: '' }, ['Semua Jenis'])].concat(ASSET_DEFS.concat(LINE_ASSET_DEFS).map((d) => el('option', { value: d.type }, [d.label])))),
        el('select', { class: 'text-input', style: 'width:auto;', onchange: (e) => { state.status = e.target.value; renderList(); } }, [el('option', { value: '' }, ['Semua Status'])].concat(window.PlanningFinal.ASSET_STATUS_ORDER.map((s) => el('option', { value: s }, [s])))),
      ]),
    ]);
    const listCard = el('div', { class: 'card' });
    const detailCard = el('div', { id: 'asset-detail-card' });
    container.appendChild(filterCard); container.appendChild(listCard); container.appendChild(detailCard);

    function renderList() {
      listCard.innerHTML = '';
      const filtered = all.filter((a) => {
        if (state.type && a.asset_type !== state.type) return false;
        if (state.status && a.asset_status !== state.status) return false;
        if (state.q) { const q = state.q.toLowerCase(); const hay = [a.name, a.asset_type, a.lat, a.lng, a.project_id].join(' ').toLowerCase(); if (!hay.includes(q)) return false; }
        return true;
      });
      listCard.appendChild(el('div', { class: 'card-header' }, [el('h3', {}, ['Daftar Aset (' + filtered.length + ' dari ' + all.length + ')'])]));
      listCard.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Jenis', 'Nama/Kode', 'Lat,Lng', 'Status', 'Aksi'].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, filtered.slice(0, 300).map((a) => el('tr', {}, [
          el('td', {}, [assetDef(a.asset_type).label]),
          el('td', {}, [a.name || '-']),
          el('td', { class: 'text-xs' }, [a.lat != null ? (round1(a.lat) + ', ' + round1(a.lng)) : (a.length_m ? (Math.round(a.length_m) + ' m') : '-')]),
          el('td', {}, [(() => { const sel = el('select', { class: 'text-input', onchange: (e) => updateAssetStatus(a, e.target.value).then(renderList) }, window.PlanningFinal.ASSET_STATUS_ORDER.map((s) => el('option', { value: s }, [s]))); sel.value = a.asset_status; return sel; })()]),
          el('td', {}, [
            el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.selected = a; renderDetail(); } }, [el('i', { class: 'fa-solid fa-eye' }), ' Detail']),
            el('button', { class: 'btn btn-ghost btn-sm', title: 'Duplikat aset ini', onclick: () => duplicateAsset(a).then(renderList) }, [el('i', { class: 'fa-solid fa-clone' })]),
          ]),
        ]))),
      ])]));
    }
    function round1(n) { return Math.round((n || 0) * 100000) / 100000; }

    async function renderDetail() {
      const a = state.selected; detailCard.innerHTML = ''; if (!a) return;
      const def = assetDef(a.asset_type);
      const [history, photos] = await Promise.all([loadAssetChangeLog(a.asset_type, a.id), loadAssetPhotos(a.asset_type, a.id)]);

      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, [def.label + ' — ' + (a.name || a.id)]), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.selected = null; detailCard.innerHTML = ''; } }, ['Tutup'])]),
      ]);

      // ---- Update Lokasi (Field Update / As Built) — hanya utk aset titik ----
      if (a.lat != null) {
        const latInput = el('input', { type: 'number', step: 'any', class: 'text-input', value: a.lat });
        const lngInput = el('input', { type: 'number', step: 'any', class: 'text-input', value: a.lng });
        const noteInput = el('input', { type: 'text', class: 'text-input', placeholder: 'Catatan (opsional)' });
        const reasonInput = el('input', { type: 'text', class: 'text-input', placeholder: 'Alasan perubahan (opsional)' });
        card.appendChild(el('div', { style: 'margin-bottom:14px;' }, [
          el('h4', { class: 'text-sm' }, ['Update Lokasi (Field Update)']),
          el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [latInput, lngInput, noteInput, reasonInput,
            el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
              const ok = await updateAssetLocation(a, parseFloat(latInput.value), parseFloat(lngInput.value), noteInput.value, reasonInput.value, 'move');
              if (ok) renderDetail();
            } }, ['Simpan']),
          ]),
        ]));
      } else {
        card.appendChild(el('p', { class: 'text-xs text-muted' }, ['Aset garis (geometri LineString) — edit lokasi/geometri belum didukung di halaman ini, lihat Mapping/Review Mode untuk mengubah jalurnya.']));
      }

      // ---- Riwayat Versi (Version History) + Restore ----
      card.appendChild(el('h4', { class: 'text-sm' }, ['Riwayat Versi (' + history.length + ')']));
      if (!history.length) card.appendChild(el('p', { class: 'text-xs text-muted' }, ['Belum ada riwayat perubahan.']));
      else card.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Versi', 'Tanggal', 'Tipe', 'Lama', 'Baru', 'Oleh', 'Catatan/Alasan', ''].map((h) => el('th', {}, [h])))]),
        el('tbody', {}, history.map((h, idx) => el('tr', {}, [
          el('td', {}, ['V' + (history.length - idx)]),
          el('td', { class: 'text-xs' }, [new Date(h.created_at).toLocaleString('id-ID')]),
          el('td', {}, [h.change_type]),
          el('td', { class: 'text-xs' }, [h.old_lat != null ? (round1(h.old_lat) + ',' + round1(h.old_lng)) : '-']),
          el('td', { class: 'text-xs' }, [h.new_lat != null ? (round1(h.new_lat) + ',' + round1(h.new_lng)) : '-']),
          el('td', { class: 'text-xs' }, [h.changed_by_name || '-']),
          el('td', { class: 'text-xs' }, [h.note || h.reason || '-']),
          el('td', {}, [h.old_lat != null ? el('button', { class: 'btn btn-ghost btn-sm', title: 'Restore ke koordinat ini', onclick: async () => { const ok = await updateAssetLocation(a, h.old_lat, h.old_lng, 'Restore ke ' + new Date(h.created_at).toLocaleString('id-ID'), 'restore', 'restore'); if (ok) renderDetail(); } }, [el('i', { class: 'fa-solid fa-clock-rotate-left' })]) : null]),
        ]))),
      ])]));

      // ---- Foto Dokumentasi ----
      card.appendChild(el('h4', { class: 'text-sm' }, ['Foto Dokumentasi']));
      const photoTypeSel = el('select', { class: 'text-input' }, ['before', 'after', 'qc', 'maintenance', 'damage'].map((t) => el('option', { value: t }, [t])));
      const fileInput = el('input', { type: 'file', accept: 'image/*' });
      card.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;' }, [
        photoTypeSel, fileInput,
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
          const file = fileInput.files[0]; if (!file) { toast('Pilih file foto dahulu.', 'warning'); return; }
          const path = a.asset_type + '/' + a.id + '/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          try {
            const { error: upErr } = await App.supabase.storage.from('asset-photos').upload(path, file);
            if (upErr) throw upErr;
            const { data: pub } = App.supabase.storage.from('asset-photos').getPublicUrl(path);
            await App.supabase.from('asset_photo').insert({ project_id: a.project_id, asset_type: a.asset_type, asset_id: a.id, photo_type: photoTypeSel.value, url: pub.publicUrl, uploaded_by: uid() });
            toast('Foto diunggah.', 'success'); renderDetail();
          } catch (e) { toast('Gagal unggah foto — pastikan bucket Storage "asset-photos" sudah dibuat di Supabase Dashboard.', 'error'); }
        } }, ['Unggah']),
      ]));
      const photoGrid = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' });
      photos.forEach((p) => photoGrid.appendChild(el('div', { style: 'text-align:center;' }, [
        el('img', { src: p.url, style: 'width:100px;height:100px;object-fit:cover;border-radius:6px;border:1px solid var(--color-border);' }),
        el('div', { class: 'text-xs text-muted' }, [p.photo_type]),
      ])));
      card.appendChild(photoGrid);

      // ---- Upload Dokumen (PDF/Excel/Word/Drawing) — menutup celah FINAL_AUDIT_REPORT.md ----
      const docs = await loadAssetDocuments(a.asset_type, a.id);
      card.appendChild(el('h4', { class: 'text-sm', style: 'margin-top:14px;' }, ['Dokumen']));
      const docTypeSel = el('select', { class: 'text-input' }, ['pdf', 'excel', 'word', 'foto', 'drawing'].map((t) => el('option', { value: t }, [t])));
      const docFileInput = el('input', { type: 'file' });
      card.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap;' }, [
        docTypeSel, docFileInput,
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
          const file = docFileInput.files[0]; if (!file) { toast('Pilih file dokumen dahulu.', 'warning'); return; }
          const path = a.asset_type + '/' + a.id + '/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          try {
            const { error: upErr } = await App.supabase.storage.from('asset-documents').upload(path, file);
            if (upErr) throw upErr;
            const { data: pub } = App.supabase.storage.from('asset-documents').getPublicUrl(path);
            await App.supabase.from('asset_document').insert({ project_id: a.project_id, asset_type: a.asset_type, asset_id: a.id, doc_type: docTypeSel.value, title: file.name, url: pub.publicUrl, uploaded_by: uid() });
            toast('Dokumen diunggah.', 'success'); renderDetail();
          } catch (e) { toast('Gagal unggah dokumen — pastikan bucket Storage "asset-documents" sudah dibuat di Supabase Dashboard.', 'error'); }
        } }, ['Unggah']),
      ]));
      if (!docs.length) card.appendChild(el('p', { class: 'text-xs text-muted' }, ['Belum ada dokumen.']));
      else card.appendChild(el('ul', { class: 'text-xs' }, docs.map((d) => el('li', {}, [
        el('a', { href: d.url, target: '_blank', rel: 'noopener' }, [d.title || d.doc_type]),
        ' — ' + d.doc_type + ' — ' + new Date(d.created_at).toLocaleDateString('id-ID'),
      ]))));

      detailCard.appendChild(card);
    }

    renderList();
  });

  // ---------- GLOBAL MAP ----------
  // FIX #E9: sebelumnya selalu lintas-project (pakai loadAllPointAssets() yang
  // sekarang otomatis ikut Project Aktif). Ditambah toggle eksplisit supaya
  // yang butuh tampilan lintas-project (mis. overview semua project) tetap bisa.
  registerModule('global-map', async function renderGlobalMap(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    if (App.globalMap) { try { App.globalMap.remove(); } catch (e) {} App.globalMap = null; } // PRODUCTION HARDENING: cegah memory leak Leaflet saat pindah halaman
    const state = { crossProject: false };
    const scopeLabel = el('span', { class: 'text-xs text-muted' }, [App.currentProjectId ? ('Project: ' + (App.currentProjectName || '—')) : 'Belum pilih Project Aktif (tampil lintas-project)']);
    const toolbar = el('div', { style: 'display:flex;align-items:center;gap:10px;padding:10px 12px;flex-wrap:wrap;' }, [
      el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;' }, [
        el('input', { type: 'checkbox', onchange: (e) => { state.crossProject = e.target.checked; loadAndRenderGlobalMap(); } }),
        'Tampilkan lintas SEMUA Project',
      ]),
      scopeLabel,
    ]);
    const mapWrap = el('div', { id: 'global-map-el', style: 'height:calc(100vh - var(--topbar-height) - 140px);' });
    container.appendChild(el('div', { class: 'card', style: 'padding:0;overflow:hidden;' }, [toolbar, mapWrap]));

    async function loadAndRenderGlobalMap() {
      if (!App.globalMap) {
        const map = L.map(mapWrap, { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
        App.globalMap = map;
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri', maxZoom: 20 }).addTo(map);
      }
      const map = App.globalMap;
      if (App._globalMapLayerControl) { map.removeControl(App._globalMapLayerControl); App._globalMapLayerControl = null; }
      Object.values(App._globalMapLayerGroups || {}).forEach((lg) => map.removeLayer(lg));

      // Scoping sementara: kalau toggle "lintas project" dicentang, matikan Project Aktif
      // HANYA untuk pengambilan data view ini, lalu kembalikan seperti semula.
      const savedProjectId = App.currentProjectId;
      if (state.crossProject) App.currentProjectId = null;
      const [points, buildings] = await Promise.all([
        loadAllPointAssets(),
        (async () => {
          try {
            let q = App.supabase.from('detected_buildings').select('lat,lng,category,status,project_id').limit(ASSET_FETCH_LIMIT);
            q = scopeToProject(q, 'detected_buildings');
            const { data } = await q; return data || [];
          } catch (e) { return []; }
        })(),
      ]);
      App.currentProjectId = savedProjectId;

      const layerGroups = {};
      const colorOf = { pole: '#8E6E53', odp: '#1F7A54', odc: '#0B6E99', home: '#B3261E', closure: '#9A6700', handhole: '#5B6774', jointbox: '#6B4EA0' };
      ASSET_DEFS.forEach((def) => {
        const pts = points.filter((p) => p.asset_type === def.type && p.lat != null);
        const lg = window.L.markerClusterGroup ? L.markerClusterGroup({ disableClusteringAtZoom: 18 }) : L.layerGroup();
        pts.forEach((p) => lg.addLayer(L.circleMarker([p.lat, p.lng], { radius: 5, color: colorOf[def.type] || '#333', fillOpacity: 0.85 }).bindPopup('<b>' + def.label + '</b><br>' + (p.name || '-') + '<br>Status: ' + p.asset_status)));
        layerGroups[def.label] = lg;
      });
      const buildingCluster = window.L.markerClusterGroup ? L.markerClusterGroup({ disableClusteringAtZoom: 18, chunkedLoading: true }) : L.layerGroup();
      buildings.filter((b) => b.lat != null).forEach((b) => buildingCluster.addLayer(L.circleMarker([b.lat, b.lng], { radius: 4, color: '#2563EB', fillOpacity: 0.7 }).bindPopup('Kategori: ' + (b.category || '-') + '<br>Status: ' + (b.status || '-'))));
      layerGroups['Home Passed / Detected Building'] = buildingCluster;

      Object.values(layerGroups).forEach((lg) => lg.addTo(map));
      App._globalMapLayerGroups = layerGroups;
      App._globalMapLayerControl = L.control.layers({}, layerGroups, { collapsed: false, position: 'topright' }).addTo(map);

      const allPts = points.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]).concat(buildings.filter((b) => b.lat != null).map((b) => [b.lat, b.lng]));
      if (allPts.length) { try { map.fitBounds(allPts, { maxZoom: 16 }); } catch (e) {} }
      const scopeText = state.crossProject ? 'lintas seluruh project' : (App.currentProjectId ? ('project "' + App.currentProjectName + '"') : 'lintas-project (belum pilih Project Aktif)');
      toast('Global Map: ' + points.length + ' aset & ' + buildings.length + ' bangunan dimuat — ' + scopeText + '.', 'info');
      if (points._truncated) toast('Data aset dibatasi ' + ASSET_FETCH_LIMIT + ' baris/tabel untuk menjaga performa — sebagian data mungkin belum tampil.', 'warning', 6000);
    }

    setTimeout(loadAndRenderGlobalMap, 50);
  }, function destroyGlobalMap() {
    if (App.globalMap) { try { App.globalMap.remove(); } catch (e) {} App.globalMap = null; }
  });

  // ---------- ASSET & QC REPORTS ----------
  registerModule('asset-reports', async function renderAssetReports(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';
    const [points, lines] = await Promise.all([loadAllPointAssets(), loadAllLineAssets()]);
    const all = points.concat(lines);
    const changeLog = await (async () => { try { const { data } = await App.supabase.from('asset_change_log').select('*').order('created_at', { ascending: false }).limit(2000); return data || []; } catch (e) { return []; } })();
    const photos = await (async () => { try { const { data } = await App.supabase.from('asset_photo').select('*'); return data || []; } catch (e) { return []; } })();

    const PF = window.PlanningFinal;
    const reports = PF.buildAllAssetReports({ assets: all, changeLog, photos });
    const fname = 'asset_reports_' + new Date().toISOString().slice(0, 10);

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Asset & QC Reports'])]),
      el('p', { class: 'text-xs text-muted' }, [App.currentProjectId ? ('Menampilkan data project: ' + (App.currentProjectName || '—') + '.') : 'Belum pilih Project Aktif — menampilkan data lintas seluruh project.']),
    ]));

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Export'])]),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => PF.downloadBlob(fname + '.xls', 'application/vnd.ms-excel', PF.reportsToXLS(reports)) }, ['Semua Report (Excel)']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => PF.downloadBlob(fname + '_assets.geojson', 'application/geo+json', PF.assetsToGeoJSON(all)) }, ['Export Asset (GeoJSON)']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => PF.downloadBlob(fname + '_assets.kml', 'application/vnd.google-earth.kml+xml', PF.assetsToKML(all, 'Assets')) }, ['Export Asset (KML)']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => { const blob = await PF.assetsToKMZ(all, 'Assets'); PF.downloadBlob(fname + '_assets.kmz', 'application/vnd.google-earth.kmz', blob); } }, ['Export Asset (KMZ)']),
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => PF.openPrintable(Object.values(reports).map((r) => PF.reportToHtmlTable(r)).join(''), 'Asset & QC Reports') }, ['Cetak / PDF']),
      ]),
    ]));

    Object.values(reports).forEach((rep) => {
      container.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [el('h3', {}, [rep.title + ' (' + rep.rows.length + ')']), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => PF.downloadBlob(fname + '_' + rep.title.replace(/\s+/g, '_') + '.csv', 'text/csv', PF.reportToCSV(rep)) }, ['CSV'])]),
        el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
          el('thead', {}, [el('tr', {}, rep.columns.map((c) => el('th', {}, [c])))]),
          el('tbody', {}, rep.rows.slice(0, 200).map((r) => el('tr', {}, r.map((c) => el('td', {}, [String(c)]))))),
        ])]),
      ]));
    });
  });

  async function injectAssetManagementDashboard(container) {
    let assets = [];
    try { const points = await loadAllPointAssets(); const lines = await loadAllLineAssets(); assets = points.concat(lines); } catch (e) { return; }
    if (!assets.length) return;
    const byStatus = { draft: 0, approved: 0, installed: 0, verified: 0, maintenance: 0, removed: 0 };
    assets.forEach((a) => { if (byStatus[a.asset_status] != null) byStatus[a.asset_status]++; });
    const stat = (label, value, icon) => el('div', { class: 'stat-card' }, [el('div', { class: 'stat-icon' }, [el('i', { class: 'fa-solid ' + icon })]), el('div', {}, [el('div', { class: 'stat-value' }, [String(value)]), el('div', { class: 'stat-label' }, [label])])]);
    container.appendChild(el('div', { class: 'card', style: 'margin-top:16px;' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Asset Management — Ringkasan'])]),
      el('div', { class: 'stat-grid' }, [
        stat('Total Asset', fmtNumber(assets.length), 'fa-toolbox'),
        stat('Draft', byStatus.draft, 'fa-pen'),
        stat('Approved', byStatus.approved, 'fa-circle-check'),
        stat('Total Construction', byStatus.installed, 'fa-person-digging'),
        stat('Total QC', byStatus.verified, 'fa-clipboard-check'),
        stat('Maintenance', byStatus.maintenance, 'fa-screwdriver-wrench'),
        stat('Total As Built', byStatus.installed + byStatus.verified + byStatus.maintenance, 'fa-map-location-dot'),
      ]),
    ]));
  }

  /* ================= [CORE] SCREEN SWITCHING ================= */
  function showAuthScreen() {
    $('#app-splash').classList.add('hidden');
    $('#app-shell').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
  }

  function enterApp() {
    $('#app-splash').classList.add('hidden');
    $('#auth-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');

    if (App.profile) {
      $('#user-name').textContent = App.profile.full_name || 'Pengguna';
      $('#user-avatar').textContent = (App.profile.full_name || 'U').trim().charAt(0).toUpperCase();
    }
    $('#sidebar-version').textContent = 'v' + CFG.VERSION;
    renderProjectSwitcher(); // FIX #E5: isi switcher "Project Aktif" di topbar

    const startRoute = location.hash ? location.hash.replace('#/', '') : (localStorage.getItem('ma_last_route') || 'dashboard');
    if (!location.hash) location.hash = '#/' + startRoute;
    else handleHashChange();
  }

  /* ================= [CORE] EVENT BINDING ================= */
  function bindGlobalEvents() {
    $('#login-form').addEventListener('submit', (e) => {
      e.preventDefault();
      handleLogin($('#login-email').value.trim(), $('#login-password').value);
    });

    $('#theme-toggle-btn').addEventListener('click', toggleTheme);
    $('#sidebar-toggle-btn').addEventListener('click', toggleSidebar);
    $('#sidebar-collapse-btn').addEventListener('click', toggleSidebar);
    $('#sidebar-backdrop').addEventListener('click', closeSidebarMobile);

    $('#user-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#user-menu-dropdown').classList.toggle('hidden');
    });
    document.addEventListener('click', () => $('#user-menu-dropdown').classList.add('hidden'));

    $('#menu-logout').addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await confirmDialog('Anda yakin ingin keluar?', 'Keluar');
      if (ok) handleLogout();
    });
    $('#menu-setting').addEventListener('click', (e) => { e.preventDefault(); location.hash = '#/setting'; });

    $('#global-search').addEventListener('input', debounce((e) => runGlobalSearch(e.target.value), 300));
    document.addEventListener('click', (e) => { if (!e.target.closest('.topbar-search')) hideGlobalSearchResults(); });

    window.addEventListener('hashchange', handleHashChange);

    // Android back button (untuk WebView/TWA): cegah keluar aplikasi tiba-tiba,
    // minta konfirmasi jika di halaman selain dashboard.
    window.addEventListener('popstate', () => {
      if (App.currentRoute !== 'dashboard' && !location.hash) {
        history.pushState(null, '', '#/dashboard');
      }
    });
    history.pushState(null, '', location.href);
  }

  /* ================= [FINAL] OFFLINE DETECTION ================= */
  // Menutup celah dari FINAL_AUDIT_REPORT.md: sebelumnya tidak ada deteksi
  // koneksi sama sekali. Banner persisten (bukan toast yang hilang sendiri)
  // supaya planner sadar perubahan berisiko tidak tersimpan saat offline.
  function initOfflineDetection() {
    const banner = el('div', { id: 'offline-banner', class: 'hidden', style: 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#B3261E;color:#fff;text-align:center;padding:8px 12px;font-size:13px;font-weight:600;' }, [
      el('i', { class: 'fa-solid fa-wifi', style: 'margin-right:8px;' }),
      'Anda sedang OFFLINE — perubahan mungkin tidak tersimpan sampai koneksi kembali.',
    ]);
    document.body.appendChild(banner);
    function setOnline(isOnline) {
      banner.classList.toggle('hidden', isOnline);
      if (!isOnline) toast('Koneksi internet terputus.', 'error', 6000);
      else toast('Koneksi internet kembali normal.', 'success', 3000);
    }
    window.addEventListener('online', () => setOnline(true));
    window.addEventListener('offline', () => setOnline(false));
    if (!navigator.onLine) setOnline(false);
  }

  /* ================= [FINAL] BACKUP & RESTORE ================= */
  // Menutup celah dari FINAL_AUDIT_REPORT.md (sebelumnya hanya ada "Restore"
  // versi planning, BUKAN backup/restore database). Additive, halaman baru.
  const BACKUP_TABLES = [
    'projects', 'areas', 'pops', 'odc', 'odp', 'homes', 'poles', 'backbones',
    'distributions', 'kabels', 'closures', 'handholes', 'jointboxes',
    'planning_analysis', 'building_analysis', 'road_analysis', 'coverage_analysis',
    'planning_home', 'planning_odp', 'planning_odc', 'planning_backbone', 'planning_distribution', 'planning_boq',
    'planning_version', 'planning_validation', 'planning_approval', 'planning_history', 'planning_report',
    'detected_buildings', 'asset_change_log', 'asset_photo', 'asset_document',
  ];
  const BACKUP_PROJECT_SCOPED_TABLES = [
    'areas', 'pops', 'odc', 'odp', 'homes', 'poles', 'backbones',
    'distributions', 'kabels', 'closures', 'handholes', 'jointboxes', 'planning_analysis',
  ];

  ROUTE_TITLES['backup-restore'] = 'Backup & Restore';
  registerModule('backup-restore', async function renderBackupRestore(container) {
    container.innerHTML = ''; $('#page-toolbar').innerHTML = '';

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Export Database (Backup)'])]),
      el('p', { class: 'text-xs text-muted' }, ['Mengunduh seluruh isi ' + BACKUP_TABLES.length + ' tabel (kecuali data akun/auth) sebagai 1 file JSON. Simpan file ini di tempat aman.']),
      el('button', { class: 'btn btn-primary btn-sm', onclick: () => exportDatabase(null) }, [el('i', { class: 'fa-solid fa-download' }), ' Export Seluruh Database']),
    ]));

    const projectSelect = el('select', { class: 'text-input', style: 'max-width:320px;' }, [el('option', { value: '' }, ['— pilih project —'])]);
    (async () => { try { const { data } = await App.supabase.from('projects').select('id,name').order('created_at', { ascending: false }).limit(500); (data || []).forEach((p) => projectSelect.appendChild(el('option', { value: p.id }, [p.name]))); } catch (e) {} })();
    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Backup Project (per-project)'])]),
      el('p', { class: 'text-xs text-muted' }, ['Export seluruh data milik 1 project (' + BACKUP_PROJECT_SCOPED_TABLES.length + ' tabel yang punya project_id).']),
      el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [
        projectSelect,
        el('button', { class: 'btn btn-secondary btn-sm', onclick: () => { if (!projectSelect.value) { toast('Pilih project dahulu.', 'warning'); return; } exportDatabase(projectSelect.value); } }, [el('i', { class: 'fa-solid fa-download' }), ' Backup Project Ini']),
      ]),
    ]));

    const fileInput = el('input', { type: 'file', accept: 'application/json' });
    container.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('h3', {}, ['Import / Restore Database'])]),
      el('p', { class: 'text-xs text-muted' }, [
        '⚠ Import akan melakukan UPSERT (menimpa baris dengan id yang sama, menambah baris baru).',
        ' Tidak menghapus data yang sudah ada. Gunakan file hasil "Export Database"/"Backup Project" di atas.',
      ]),
      el('div', { style: 'display:flex;gap:8px;align-items:center;' }, [
        fileInput,
        el('button', { class: 'btn btn-secondary btn-sm', onclick: async () => {
          const file = fileInput.files[0]; if (!file) { toast('Pilih file backup (.json) dahulu.', 'warning'); return; }
          const ok = await confirmDialog('Import/Restore dari file ini? Data dengan id yang sama akan ditimpa.', 'Import Database');
          if (!ok) return;
          try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            await importDatabase(parsed);
          } catch (e) { toast('Gagal membaca/import file: ' + e.message, 'error'); }
        } }, [el('i', { class: 'fa-solid fa-upload' }), ' Import / Restore']),
      ]),
    ]));
  });

  async function exportDatabase(projectId) {
    const tables = projectId ? BACKUP_PROJECT_SCOPED_TABLES : BACKUP_TABLES;
    const dump = { exported_at: new Date().toISOString(), scope: projectId ? ('project:' + projectId) : 'full', tables: {} };
    toast('Mengekspor ' + tables.length + ' tabel...', 'info');
    for (const t of tables) {
      try {
        let q = App.supabase.from(t).select('*').limit(50000);
        if (projectId) q = t === 'projects' ? q.eq('id', projectId) : q.eq('project_id', projectId);
        const { data, error } = await q;
        dump.tables[t] = error ? [] : (data || []);
      } catch (e) { dump.tables[t] = []; }
    }
    if (projectId) {
      try { const { data } = await App.supabase.from('projects').select('*').eq('id', projectId).limit(1); dump.tables.projects = data || []; } catch (e) {}
    }
    const fname = (projectId ? 'backup_project_' + projectId : 'backup_database') + '_' + new Date().toISOString().slice(0, 10) + '.json';
    window.PlanningFinal.downloadBlob(fname, 'application/json', JSON.stringify(dump, null, 2));
    toast('Backup selesai diunduh: ' + fname, 'success');
  }

  async function importDatabase(parsed) {
    if (!parsed || !parsed.tables) { toast('Format file backup tidak dikenali.', 'error'); return; }
    let okCount = 0, failCount = 0;
    for (const t of Object.keys(parsed.tables)) {
      const rows = parsed.tables[t];
      if (!Array.isArray(rows) || !rows.length) continue;
      try {
        const { error } = await App.supabase.from(t).upsert(rows, { onConflict: 'id' });
        if (error) throw error;
        okCount += rows.length;
      } catch (e) { failCount++; console.warn('[Backup] gagal import tabel', t, e.message); }
    }
    toast('Import selesai: ' + okCount + ' baris berhasil, ' + failCount + ' tabel gagal (lihat console).', failCount ? 'warning' : 'success', 6000);
  }
  /* ================= [FINAL] GLOBAL SEARCH ================= */
  // Menutup celah dari FINAL_AUDIT_REPORT.md — sebelumnya input ini tidak
  // melakukan apa pun (hanya console.log). Mencari lintas Project/Rumah/
  // ODP/ODC berdasarkan nama, ditampilkan sebagai dropdown di bawah kotak cari.
  function hideGlobalSearchResults() {
    const box = document.getElementById('global-search-results');
    if (box) box.classList.add('hidden');
  }
  async function runGlobalSearch(q) {
    q = (q || '').trim();
    const wrap = document.querySelector('.topbar-search');
    let box = document.getElementById('global-search-results');
    if (!box) {
      box = el('div', { id: 'global-search-results', class: 'card hidden', style: 'position:absolute;top:100%;left:0;right:0;margin-top:4px;max-height:320px;overflow:auto;z-index:500;padding:6px;' });
      wrap.style.position = 'relative';
      wrap.appendChild(box);
    }
    if (q.length < 2) { box.classList.add('hidden'); return; }
    box.innerHTML = '<div class="text-xs text-muted" style="padding:6px;">Mencari...</div>';
    box.classList.remove('hidden');

    const [projects, homes, odps, odcs] = await Promise.all([
      App.supabase.from('projects').select('id,name').ilike('name', '%' + q + '%').limit(5).then((r) => r.data || []).catch(() => []),
      App.supabase.from('homes').select('id,owner_name,lat,lng').ilike('owner_name', '%' + q + '%').limit(5).then((r) => r.data || []).catch(() => []),
      App.supabase.from('odp').select('id,name,lat,lng').ilike('name', '%' + q + '%').limit(5).then((r) => r.data || []).catch(() => []),
      App.supabase.from('odc').select('id,name,lat,lng').ilike('name', '%' + q + '%').limit(5).then((r) => r.data || []).catch(() => []),
    ]);

    box.innerHTML = '';
    const section = (title, items, onClick) => {
      if (!items.length) return;
      box.appendChild(el('div', { class: 'text-xs text-muted', style: 'padding:4px 6px;font-weight:700;' }, [title]));
      items.forEach((it) => {
        const row = el('div', { class: 'nav-item', style: 'padding:6px 8px;cursor:pointer;' }, [it.name || it.owner_name || it.id]);
        row.addEventListener('click', () => { hideGlobalSearchResults(); onClick(it); });
        box.appendChild(row);
      });
    };
    section('Project', projects, (p) => { location.hash = '#/project-detail?id=' + p.id; });
    section('Rumah', homes, (h) => { if (h.lat != null) { location.hash = '#/mapping'; setTimeout(() => { if (App.map) { App.map.setView([h.lat, h.lng], 18); L.marker([h.lat, h.lng]).addTo(App.map).bindPopup(h.owner_name).openPopup(); } }, 300); } });
    section('ODP', odps, (o) => { if (o.lat != null) { location.hash = '#/mapping'; setTimeout(() => { if (App.map) { App.map.setView([o.lat, o.lng], 18); L.marker([o.lat, o.lng]).addTo(App.map).bindPopup(o.name).openPopup(); } }, 300); } });
    section('ODC', odcs, (o) => { if (o.lat != null) { location.hash = '#/mapping'; setTimeout(() => { if (App.map) { App.map.setView([o.lat, o.lng], 18); L.marker([o.lat, o.lng]).addTo(App.map).bindPopup(o.name).openPopup(); } }, 300); } });
    if (!box.childNodes.length) box.innerHTML = '<div class="text-xs text-muted" style="padding:6px;">Tidak ada hasil untuk "' + q + '".</div>';
  }

  /* ================= [CORE] BOOTSTRAP ================= */
  async function bootstrap() {
    buildSidebar();
    injectSmartPlanningNav(); // additive: menu Smart Planning (Coming Soon/disabled)
    bindGlobalEvents();
    initSupabase();
    initOfflineDetection();

    const savedTheme = localStorage.getItem('ma_theme') || CFG.THEME;
    applyTheme(savedTheme);

    const hasSession = await checkExistingSession();
    if (hasSession) {
      enterApp();
    } else {
      showAuthScreen();
    }

    // Dengarkan perubahan auth state (mis. token refresh / logout dari tab lain)
    App.supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') { App.session = null; showAuthScreen(); }
    });
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
