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
  // Jarak antar 2 titik lat/lng dalam meter (formula Haversine).
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

  // ---- Gambar Polygon/Garis di peta (leaflet.draw) --------------------
  // Dipakai oleh: (a) toolbar halaman Mapping (gambar bebas + toast info),
  // (b) form Area/Backbone/Distribution/Kabel (gambar lalu simpan ke DB).
  // shapeType: 'polygon' | 'polyline'
  // onComplete(geojsonGeometry, layer) dipanggil sekali setelah user selesai
  // menggambar (double-click / klik titik awal lagi, sesuai leaflet.draw).
  function drawGeometryOnMap(shapeType, onComplete) {
    toast('Gambar di peta, lalu klik titik awal lagi (atau double-click) untuk menyelesaikan.', 'info', 4500);
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

  /* ================= [COVERAGE] ANALISIS COVERAGE ODP (FASE 3) ================= */
  // Menghitung berapa rumah yang berada dalam radius layanan ODP terdekat
  // (CFG.COVERAGE.ODP_SERVICE_RADIUS_M) vs total rumah. Perhitungan dilakukan
  // di sisi client (vanilla JS, Haversine) — cukup untuk skala menengah;
  // untuk dataset sangat besar sebaiknya dipindah ke RPC/PostGIS di Fase lanjut.
  async function computeCoverage() {
    const radius = CFG.COVERAGE.ODP_SERVICE_RADIUS_M;
    const limit = CFG.PERFORMANCE.MAP_PAGE_SIZE;
    const [{ data: odpRows, error: odpErr }, { data: homeRows, error: homeErr }] = await Promise.all([
      App.supabase.from('odp').select('id, name, lat, lng').limit(limit),
      App.supabase.from('homes').select('id, owner_name, address, lat, lng, odp_id').limit(limit),
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
