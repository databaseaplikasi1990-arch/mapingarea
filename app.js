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
    mapLayers: {},           // key -> L.LayerGroup
    autosaveTimer: null,
    realtimeChannels: [],
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
    (children || []).forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
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
  });

  async function loadDashboardStats() {
    const tables = {
      totalProject: 'projects', totalArea: 'areas', totalRumah: 'homes',
      totalTiang: 'poles', totalOdc: 'odc', totalOdp: 'odp',
    };
    const result = { coveragePercent: 0, surveyProgressPercent: 0 };
    await Promise.all(Object.entries(tables).map(async ([statKey, table]) => {
      try {
        const { count, error } = await App.supabase.from(table).select('*', { count: 'exact', head: true });
        result[statKey] = error ? 0 : (count || 0);
      } catch (e) { result[statKey] = 0; }
    }));
    if (result.totalRumah && result.totalOdp) {
      // estimasi kasar coverage: rumah tercakup ODP vs total rumah (placeholder,
      // akan disempurnakan saat modul Coverage (Fase 3) tersedia).
      result.coveragePercent = Math.min(100, Math.round((result.totalOdp * CFG.SPLITTER.ODP_RATIO / result.totalRumah) * 100));
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
  }, function destroyMapping() {
    if (App.map) { App.map.remove(); App.map = null; }
    App.mapLayers = {};
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

  function refreshLayerList() {
    const listEl = $('#layer-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const keys = Object.keys(App.mapLayers);
    if (!keys.length) {
      listEl.appendChild(el('p', { class: 'text-muted' }, ['Belum ada layer. Import data untuk memulai.']));
      return;
    }
    keys.forEach((key) => {
      const name = key.split('_')[0];
      const item = el('div', { class: 'layer-item' }, [
        el('input', { type: 'checkbox', checked: 'checked', onchange: (e) => {
          const layer = App.mapLayers[key];
          if (e.target.checked) App.map.addLayer(layer); else App.map.removeLayer(layer);
        } }),
        el('span', {}, [name]),
        el('button', { class: 'icon-btn btn-icon-only', style: 'margin-left:auto;width:26px;height:26px;', onclick: () => {
          App.map.removeLayer(App.mapLayers[key]);
          delete App.mapLayers[key];
          refreshLayerList();
        } }, [el('i', { class: 'fa-solid fa-trash', style: 'font-size:11px' })]),
      ]);
      listEl.appendChild(item);
    });
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

      const wrapper = el('div');
      let overlayRef;
      const header = el('div', { class: 'modal-header' }, [
        el('h3', {}, [(isEdit ? 'Edit ' : 'Tambah ') + def.title]),
        el('button', { type: 'button', class: 'icon-btn', onclick: () => closeModal(overlayRef) }, [el('i', { class: 'fa-solid fa-xmark' })]),
      ]);
      const body = el('div', { class: 'modal-body' }, [formEl]);
      const footer = el('div', { class: 'modal-footer' }, [
        el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => closeModal(overlayRef) }, ['Batal']),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => submitAssetForm(inputRefs, existingRow, () => closeModal(overlayRef)) }, [isEdit ? 'Simpan Perubahan' : 'Simpan']),
      ]);
      wrapper.appendChild(header); wrapper.appendChild(body); wrapper.appendChild(footer);
      overlayRef = openModal(wrapper, { size: 'md' });
    }

    async function submitAssetForm(inputRefs, existingRow, onDone) {
      const payload = {};
      for (const f of def.fields) {
        const raw = inputRefs[f.key].value;
        if (f.required && !raw) { toast(f.label + ' wajib diisi.', 'warning'); return; }
        payload[f.key] = f.type === 'number' ? (raw === '' ? null : Number(raw)) : (raw || null);
      }
      try {
        let error;
        if (existingRow) {
          ({ error } = await App.supabase.from(def.table).update(payload).eq('id', existingRow.id));
        } else {
          ({ error } = await App.supabase.from(def.table).insert(payload));
        }
        if (error) throw error;
        toast(def.title + ' berhasil disimpan.', 'success');
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
      if (def.geometryType !== 'point' || row.lat == null || row.lng == null) {
        toast('Data ini tidak memiliki koordinat titik.', 'info');
        return;
      }
      location.hash = '#/mapping';
      setTimeout(() => {
        if (App.map) {
          App.map.setView([row.lat, row.lng], 17);
          L.marker([row.lat, row.lng]).addTo(App.map).bindPopup(row.name || row.owner_name || def.title).openPopup();
        }
      }, 300);
    }
  }

  // Mode "pilih lokasi di peta": pindah ke halaman Mapping, klik sekali di
  // peta untuk mengisi lat/lng pada form yang sedang terbuka.
  function pickLocationOnMap(onPick) {
    toast('Silakan klik pada peta untuk memilih lokasi.', 'info', 4000);
    location.hash = '#/mapping';
    const tryBind = () => {
      if (!App.map) { setTimeout(tryBind, 200); return; }
      const handler = (e) => {
        onPick(e.latlng.lat, e.latlng.lng);
        App.map.off('click', handler);
        toast('Lokasi dipilih. Kembali membuka form...', 'success');
      };
      App.map.on('click', handler);
    };
    setTimeout(tryBind, 250);
  }

  // Registrasi seluruh modul aset dari config.js
  Object.entries(CFG.ASSET_DEFS).forEach(([key, def]) => createAssetModule(key, def));

  /* ================= [MODULES] PLACEHOLDER FASE BERIKUTNYA ================= */
  // Modul di bawah ini akan diisi penuh pada Fase 2-5 sesuai roadmap.
  // Struktur registerModule sudah siap sehingga penambahan tidak mengubah
  // file lain (index.html / style.css tetap sama).
  const PENDING_MODULES = [
    ['import', 'Import Data', 'Gunakan tombol "Import Data" pada halaman Mapping.'],
    ['coverage', 'Coverage', 'Analisis area yang sudah/belum tercakup. (Fase 3)'],
    ['validation', 'Validation', 'Validasi topologi & aturan splitter jaringan. (Fase 3)'],
    ['heatmap', 'Heatmap', 'Kepadatan rumah/prospek pada peta. (Fase 3)'],
    ['scenario', 'Scenario & Version', 'Skenario perencanaan & version control. (Fase 4)'],
    ['approval', 'Approval', 'Alur persetujuan rencana jaringan. (Fase 4)'],
    ['summary', 'Planning Summary', 'Ringkasan hasil perencanaan. (Fase 4)'],
    ['boq', 'BOQ', 'Bill of Quantity tanpa harga. (Fase 4)'],
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

  /* ================= [REALTIME] ================= */
  function stopRealtime() {
    App.realtimeChannels.forEach((ch) => App.supabase.removeChannel(ch));
    App.realtimeChannels = [];
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

    $('#global-search').addEventListener('input', debounce((e) => {
      // Pencarian global lintas modul akan disempurnakan bertahap seiring
      // tabel data (rumah/ODC/ODP/project) tersedia di Fase 2+.
      console.log('search:', e.target.value);
    }, 300));

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

  /* ================= [CORE] BOOTSTRAP ================= */
  async function bootstrap() {
    buildSidebar();
    bindGlobalEvents();
    initSupabase();

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
