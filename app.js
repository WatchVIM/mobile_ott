/* ============================================================
   WatchVIM Universal Mobile + TV Frontend (app.js)
   - Reads /config.json
   - Fetches Stable Manifest -> Latest Catalog (fallback supported)
   - Schema-flex: films, series, seasons/episodes
   - Routes: Home, Tabs, Title, Series, Episode, Watch, LIVE Loop, Search, Login, Profile
   - Progress tracking + resume (titles & episodes)
   - Continue Watching row uses real progress %
   - LIVE Now Playing banner on Home
   - In-app PayPal TVOD modal (if PAYPAL_CLIENT_ID + TVOD_API_BASE)
   - TV D-pad navigation
   ============================================================ */

(() => {
  // =========================================================
  // CONFIG
  // =========================================================
  const DEFAULT_CONFIG = {
    MANIFEST_URL: "",
    CATALOG_URL_FALLBACK: "",
    LOGO_URL: "",
    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",
    PAYPAL_CLIENT_ID: "",
    TVOD_API_BASE: "",
    TVOD_CHECKOUT_URL_BASE: "",
    VAST_TAG: ""
  };

  let CONFIG = { ...DEFAULT_CONFIG };

  const state = {
    catalog: null,
    titles: [],
    byId: new Map(),
    activeTab: "Home",
    route: { name: "home", params: {} },
    session: null,
    user: null,

    // progress + continue watching
    lastWatchedKey: "watchvim_last_watched_v2",

    // LIVE / loop
    loop: {
      queue: [],
      index: 0,
      lastAdAt: 0,
      shuffle: true,
      playingAd: false
    },

    paypalReady: false
  };

  const app = document.getElementById("app") || document.body;

  // =========================================================
  // LOADERS
  // =========================================================
  async function loadConfigJSON() {
    try {
      const res = await fetch("/config.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      CONFIG = { ...CONFIG, ...json };
    } catch (_) {
      console.warn("config.json not found, using defaults.");
    }
  }

  async function fetchCatalogFromManifest() {
    if (!CONFIG.MANIFEST_URL) {
      if (!CONFIG.CATALOG_URL_FALLBACK) {
        throw new Error("Missing MANIFEST_URL and CATALOG_URL_FALLBACK in config.json");
      }
      const cRes = await fetch(CONFIG.CATALOG_URL_FALLBACK + "?t=" + Date.now(), { cache: "no-store" });
      if (!cRes.ok) throw new Error("Catalog fetch failed");
      return await cRes.json();
    }

    try {
      const mRes = await fetch(CONFIG.MANIFEST_URL + "?t=" + Date.now(), { cache: "no-store" });
      if (!mRes.ok) throw new Error("Manifest fetch failed");
      const manifest = await mRes.json();

      const catalogUrl =
        manifest.latestCatalogUrl ||
        manifest.catalogUrl ||
        manifest.stableCatalogUrl ||
        CONFIG.CATALOG_URL_FALLBACK;

      const cRes = await fetch(catalogUrl + "?t=" + Date.now(), { cache: "no-store" });
      if (!cRes.ok) throw new Error("Catalog fetch failed");
      return await cRes.json();
    } catch (e) {
      if (!CONFIG.CATALOG_URL_FALLBACK) throw e;
      const cRes = await fetch(CONFIG.CATALOG_URL_FALLBACK + "?t=" + Date.now(), { cache: "no-store" });
      if (!cRes.ok) throw e;
      return await cRes.json();
    }
  }

  function normalizeCatalog(catalog) {
    const titles = catalog.titles || catalog.publishedTitles || [];
    const byId = new Map();

    titles.forEach((t) => {
      byId.set(t.id, t);
      if (t.type === "series") {
        (t.seasons || []).forEach((s, si) => {
          (s.episodes || []).forEach((ep, ei) => {
            if (!ep.id) ep.id = `${t.id}_s${si + 1}e${ei + 1}`;
            ep.__seriesId = t.id;
            ep.__seasonIndex = si;
            ep.__epIndex = ei;
            byId.set(ep.id, ep);
          });
        });
      }
    });

    return { titles, byId };
  }

  async function loadData() {
    renderLoading();
    try {
      state.catalog = await fetchCatalogFromManifest();
      const norm = normalizeCatalog(state.catalog);
      state.titles = norm.titles;
      state.byId = norm.byId;

      initLoopQueue();
      maybeLoadPayPalSDK();
      render();
    } catch (err) {
      renderError(err);
    }
  }

  // =========================================================
  // OPTIONAL SUPABASE AUTH
  // =========================================================
  let supabase = null;
  let loginView = "login";

  async function initSupabaseIfPossible() {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return;

    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    supabase = window.supabase?.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    if (!supabase) return;

    const { data } = await supabase.auth.getSession();
    state.session = data.session || null;
    state.user = data.session?.user || null;

    supabase.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      state.user = session?.user || null;
      render();
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function signIn(email, password) {
    if (!supabase) return alert("Auth not configured.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) alert(error.message);
  }

  async function signUp(email, password, fullName) {
    if (!supabase) return alert("Auth not configured.");
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: fullName || "" } }
    });
    if (error) alert(error.message);
    else alert("Check your email to confirm your account.");
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  function setLoginView(view) {
    loginView = view === "signup" ? "signup" : "login";
    navTo(`#/login?mode=${loginView}`);
  }

  // =========================================================
  // ROUTER
  // =========================================================
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const parts = (path || "home").split("/").filter(Boolean);
    const query = Object.fromEntries(new URLSearchParams(qs || ""));

    if (parts[0] === "title" && parts[1]) return { name: "title", params: { id: parts[1] } };
    if (parts[0] === "series" && parts[1]) return { name: "series", params: { id: parts[1] } };
    if (parts[0] === "episode" && parts[1] && parts[2] && parts[3]) {
      return {
        name: "episode",
        params: {
          seriesId: parts[1],
          seasonIndex: parts[2],
          epIndex: parts[3],
          kind: query.kind || "content"
        }
      };
    }
    if (parts[0] === "watch" && parts[1]) {
      return { name: "watch", params: { id: parts[1], kind: query.kind || "content" } };
    }
    if (parts[0] === "loop") return { name: "loop", params: {} };
    if (parts[0] === "search") return { name: "search", params: {} };
    if (parts[0] === "login") return { name: "login", params: { mode: query.mode || "login" } };
    if (parts[0] === "profile") return { name: "profile", params: {} };

    return { name: "home", params: {} };
  }

  function navTo(hash) { location.hash = hash; }
  window.addEventListener("hashchange", render);

  // =========================================================
  // UTILS
  // =========================================================
  function esc(str = "") {
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  function toMins(x) { const n = Number(x); return Number.isFinite(n) ? n : ""; }

  function poster(t) {
    return (
      t.posterUrl ||
      t.appImages?.tvPosterUrl ||
      t.appImages?.mobilePosterUrl ||
      ""
    );
  }

  function hero(t) {
    return (
      t.heroUrl ||
      t.appImages?.tvHeroUrl ||
      t.appImages?.mobileHeroUrl ||
      poster(t) ||
      ""
    );
  }

  function typeLabel(type) {
    const map = { films: "Movie", documentaries: "Documentary", series: "Series", shorts: "Short", foreign: "Foreign" };
    return map[type] || type || "Title";
  }

  function muxIdFor(t, kind = "content") {
    return kind === "trailer" ? t.trailerPlaybackId : t.contentPlaybackId;
  }

  function isTV() {
    const ua = navigator.userAgent.toLowerCase();
    return (
      ua.includes("aft") || ua.includes("smarttv") || ua.includes("tizen") ||
      ua.includes("webos") || ua.includes("android tv") ||
      window.innerWidth >= 1024
    );
  }

  const TAB_FILTERS = {
    Home: () => true,
    Movies: (t) => t.type === "films" || t.type === "documentaries",
    Series: (t) => t.type === "series",
    Shorts: (t) => t.type === "shorts" || (t.runtimeMins && Number(t.runtimeMins) <= 40),
    Foreign: (t) =>
      t.type === "foreign" ||
      (t.genre || []).some(g => /foreign|international|world/i.test(g)) ||
      (t.language && !/english/i.test(t.language)),
    LIVE: () => false
  };

  // =========================================================
  // FEATURED
  // =========================================================
  function featuredItems() {
    const c = state.catalog || {};
    const direct =
      c.featuredTitles ||
      c.featured ||
      c.hero ||
      c.heroItems ||
      c.featuredItems ||
      null;

    if (Array.isArray(direct) && direct.length) {
      return direct.map(it => {
        if (!it) return null;
        if (typeof it === "string") return state.byId.get(it);
        if (it.refId) return state.byId.get(it.refId);
        if (it.id) return state.byId.get(it.id) || it;
        return it;
      }).filter(Boolean);
    }

    return state.titles.filter(t =>
      t.isFeatured === true ||
      t.featured === true ||
      t.appFeatured === true ||
      (Array.isArray(t.tags) && t.tags.some(tag => /featured/i.test(tag))) ||
      (Array.isArray(t.genre) && t.genre.some(g => /featured/i.test(g)))
    );
  }

  function sortFeatured(items) {
    return items.slice().sort((a, b) => {
      const ao = a.featuredOrder ?? a.featuredRank ?? a.rank ?? 9999;
      const bo = b.featuredOrder ?? b.featuredRank ?? b.rank ?? 9999;
      return ao - bo;
    });
  }

  // =========================================================
  // PROGRESS / CONTINUE WATCHING
  // Schema v2:
  // [{ refId, refType:"title"|"episode", routeHash, progressSec, durationSec, ratio, updatedAt }]
  // =========================================================
  function readLastWatched() {
    try { return JSON.parse(localStorage.getItem(state.lastWatchedKey) || "[]"); }
    catch { return []; }
  }

  function saveLastWatched(items) {
    localStorage.setItem(state.lastWatchedKey, JSON.stringify(items.slice(0, 30)));
  }

  function upsertWatchItem(item) {
    const items = readLastWatched()
      .filter(x => !(x.refId === item.refId && x.refType === item.refType));
    items.unshift({ ...item, updatedAt: Date.now() });
    saveLastWatched(items);
  }

  function recordProgress({ refType, refId, routeHash, progressSec, durationSec }) {
    if (!refId || !durationSec || durationSec <= 0) return;
    const ratio = progressSec / durationSec;

    upsertWatchItem({
      refType, refId, routeHash,
      progressSec: Math.max(0, progressSec),
      durationSec: Math.max(1, durationSec),
      ratio
    });
  }

  function getResumeFor(refType, refId) {
    return readLastWatched().find(x => x.refType === refType && x.refId === refId) || null;
  }

  function continueWatchingItems() {
    const items = readLastWatched()
      .filter(x => (x.ratio ?? 0) < 0.92)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return items.map(x => {
      const obj = state.byId.get(x.refId);
      return obj ? { meta: x, obj } : null;
    }).filter(Boolean);
  }

  // =========================================================
  // SHELL
  // =========================================================
  function Header() {
    const tabs = ["Home","Movies","Series","Shorts","Foreign","LIVE","Search"];
    const loggedIn = !!state.user;

    return `
      <header class="sticky top-0 z-30 bg-watchBlack/95 backdrop-blur border-b border-white/10 safe-bottom">
        <div class="px-4 py-3 flex items-center gap-3">
          <div class="flex items-center gap-2 cursor-pointer" onclick="setTab('Home')">
            <img id="appLogo"
              src="${esc(CONFIG.LOGO_URL)}"
              alt="WatchVIM"
              class="h-8 w-auto object-contain"
              onerror="this.onerror=null;this.style.display='none';document.getElementById('logoFallback').classList.remove('hidden');"
            />
            <div id="logoFallback" class="hidden text-lg font-black tracking-wide">WatchVIM</div>
          </div>

          <nav class="ml-auto flex gap-2 text-sm">
            ${tabs.map(tab=>`
              <button class="tv-focus px-3 py-1.5 rounded-full ${
                state.activeTab===tab ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
              }"
              onclick="${tab==="Search" ? "navTo('#/search')" : `setTab('${tab}')`}"
              >${tab}</button>
            `).join("")}
          </nav>

          <div class="ml-2 flex gap-2 text-sm">
            ${
              loggedIn
                ? `<button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="navTo('#/profile')">Profile</button>
                   <button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="signOut()">Log out</button>`
                : `<button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="navTo('#/login?mode=login')">Log in</button>`
            }
          </div>
        </div>
      </header>
    `;
  }

  function MobileTabBar() {
    if (isTV()) return "";
    const items = ["Home","Movies","Series","Shorts","Foreign","LIVE"];
    return `
      <footer class="fixed bottom-0 left-0 right-0 bg-watchBlack/95 border-t border-white/10 safe-bottom">
        <div class="flex justify-around px-2 py-2">
          ${items.map(tab=>`
            <button class="tv-focus flex-1 mx-1 py-2 rounded-lg text-xs ${
              state.activeTab===tab ? "bg-white text-black" : "bg-white/10"
            }" onclick="setTab('${tab}')">${tab}</button>
          `).join("")}
        </div>
      </footer>
    `;
  }

  function setTab(tab) {
    state.activeTab = tab;
    if (tab === "LIVE") navTo("#/loop");
    else navTo("#/home");
  }

  // =========================================================
  // UI BLOCKS
  // =========================================================
  function Card(t) {
    const img = poster(t);
    const href = t.type === "series" ? `#/series/${t.id}` : `#/title/${t.id}`;
    return `
      <button class="tile tv-focus min-w-[140px] md:min-w-[170px] text-left" onclick="navTo('${href}')">
        <div class="aspect-[2/3] rounded-xl overflow-hidden bg-white/5 border border-white/10">
          ${img ? `<img src="${esc(img)}" class="w-full h-full object-cover" />` : ""}
        </div>
        <div class="mt-2 text-sm font-semibold line-clamp-2">${esc(t.title||"Untitled")}</div>
        <div class="text-xs text-white/60">${esc(typeLabel(t.type))}</div>
      </button>
    `;
  }

  function ContinueCard({ obj, meta }) {
    const img = poster(obj) || hero(obj);
    const ratio = Math.max(0, Math.min(1, meta.ratio || 0));
    const href = meta.routeHash || (obj.type==="series" ? `#/series/${obj.id}` : `#/title/${obj.id}`);

    return `
      <button class="tile tv-focus min-w-[160px] md:min-w-[190px] text-left" onclick="navTo('${href}')">
        <div class="relative aspect-[2/3] rounded-xl overflow-hidden bg-white/5 border border-white/10">
          ${img ? `<img src="${esc(img)}" class="w-full h-full object-cover" />` : ""}
          <div class="absolute bottom-0 left-0 right-0 h-2 bg-black/60">
            <div style="width:${Math.round(ratio*100)}%" class="h-full bg-watchRed"></div>
          </div>
        </div>
        <div class="mt-2 text-sm font-semibold line-clamp-2">${esc(obj.title||"Untitled")}</div>
        <div class="text-xs text-white/60">${Math.round(ratio*100)}% watched</div>
      </button>
    `;
  }

  function Row(name, items, viewAllTab=null) {
    if (!items.length) return "";
    const tabTarget = viewAllTab || name;

    return `
      <section class="mt-6 px-4 md:px-8">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-lg font-bold">${esc(name)}</h3>
          ${
            viewAllTab
              ? `<button class="tv-focus text-xs text-white/60 hover:text-white" onclick="setTab('${esc(tabTarget)}')">View all</button>`
              : ""
          }
        </div>
        <div class="row-scroll flex gap-3 overflow-x-auto pb-2 no-scrollbar">
          ${items.map(Card).join("")}
        </div>
      </section>
    `;
  }

  function ContinueRow(items) {
    if (!items.length) return "";
    return `
      <section class="mt-6 px-4 md:px-8">
        <h3 class="text-lg font-bold mb-2">Continue Watching</h3>
        <div class="row-scroll flex gap-3 overflow-x-auto pb-2 no-scrollbar">
          ${items.map(ContinueCard).join("")}
        </div>
      </section>
    `;
  }

  function NowPlayingBanner() {
    if (!state.loop.queue.length) return "";
    const nowItem = currentLoopItem();
    if (!nowItem) return "";

    return `
      <section class="px-4 md:px-8 mt-4">
        <div class="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
          <div class="text-xs uppercase tracking-widest text-watchGold">Now Playing on LIVE</div>
          <div class="flex-1 text-sm font-semibold line-clamp-1">
            ${esc(nowItem.label || "")}
          </div>
          <button class="tv-focus px-3 py-1.5 rounded-lg bg-watchRed font-bold text-xs"
            onclick="setTab('LIVE')">Watch LIVE</button>
        </div>
      </section>
    `;
  }

  // =========================================================
  // HERO CAROUSEL
  // =========================================================
  function HeroCarousel(items) {
    if (!items.length) return "";
    return `
      <section class="relative w-full overflow-hidden">
        <div class="aspect-video md:aspect-[21/9] bg-black relative rounded-none">
          <div id="heroTrack" class="flex transition-transform duration-500 ease-out">
            ${items.map((t) => {
              const img = hero(t);
              const hasTrailer = !!t.trailerPlaybackId;

              return `
                <div class="hero-slide min-w-full relative">
                  ${
                    hasTrailer
                      ? `<mux-player
                          stream-type="on-demand"
                          playback-id="${esc(t.trailerPlaybackId)}"
                          class="w-full h-full object-cover opacity-90"
                          muted autoplay loop playsinline
                        ></mux-player>`
                      : img
                      ? `<img src="${esc(img)}" class="w-full h-full object-cover opacity-90"/>`
                      : ""
                  }
                  <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>

                  <div class="absolute left-0 right-0 bottom-0 p-4 md:p-8">
                    <div class="max-w-3xl space-y-2">
                      <div class="text-xs uppercase tracking-widest text-watchGold/90">${typeLabel(t.type)}</div>
                      <h1 class="text-2xl md:text-4xl font-black">${esc(t.title || "Untitled")}</h1>
                      <p class="text-white/80 line-clamp-3">${esc(t.synopsis || "")}</p>

                      <div class="pt-2 flex gap-2">
                        <button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
                          onclick="navTo('#/${t.type==='series'?'series':'title'}/${t.id}')">View</button>

                        ${t.trailerPlaybackId ? `
                          <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20"
                            onclick="navTo('#/watch/${t.id}?kind=trailer')">Play Trailer</button>
                        ` : ""}
                      </div>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>

          <button id="heroPrev" class="tv-focus absolute left-2 top-1/2 -translate-y-1/2 bg-black/60 px-3 py-2 rounded-full text-xl">‹</button>
          <button id="heroNext" class="tv-focus absolute right-2 top-1/2 -translate-y-1/2 bg-black/60 px-3 py-2 rounded-full text-xl">›</button>

          <div id="heroDots" class="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2">
            ${items.map((_, i)=>`
              <button data-hero-dot="${i}" class="tv-focus w-2.5 h-2.5 rounded-full bg-white/40"></button>
            `).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function initHeroCarousel() {
    const track = document.getElementById("heroTrack");
    if (!track) return;

    const slides = Array.from(track.querySelectorAll(".hero-slide"));
    if (!slides.length) return;

    let i = 0;
    const prev = document.getElementById("heroPrev");
    const next = document.getElementById("heroNext");
    const dots = Array.from(document.querySelectorAll("[data-hero-dot]"));

    function update() {
      track.style.transform = `translateX(-${i * 100}%)`;
      dots.forEach(d => {
        const on = Number(d.dataset.heroDot) === i;
        d.classList.toggle("bg-white", on);
        d.classList.toggle("bg-white/40", !on);
      });
    }

    if (prev) prev.onclick = () => { i = (i - 1 + slides.length) % slides.length; update(); };
    if (next) next.onclick = () => { i = (i + 1) % slides.length; update(); };

    dots.forEach(d => d.onclick = () => {
      i = Number(d.dataset.heroDot) || 0;
      update();
    });

    if (window.__heroTimer) clearInterval(window.__heroTimer);
    window.__heroTimer = setInterval(() => {
      i = (i + 1) % slides.length;
      update();
    }, 7000);

    update();
  }

  // =========================================================
  // PAGES
  // =========================================================
  function HomePage() {
    const all = state.titles.slice();

    const featured = sortFeatured(featuredItems());
    const heroItems = (featured.length ? featured : all).slice(0, 8);

    const movies  = all.filter(TAB_FILTERS.Movies);
    const series  = all.filter(TAB_FILTERS.Series);
    const shorts  = all.filter(TAB_FILTERS.Shorts);
    const foreign = all.filter(TAB_FILTERS.Foreign);

    const cw = continueWatchingItems();

    // genre buckets
    const byGenre = {};
    all.forEach(t => {
      (t.genre || ["Featured"]).forEach(g => {
        const key = g || "Featured";
        byGenre[key] = byGenre[key] || [];
        byGenre[key].push(t);
      });
    });

    const genreRows = Object.entries(byGenre)
      .slice(0, 6)
      .map(([g, items]) => Row(g, items.slice(0, 20)))
      .join("");

    return `
      ${HeroCarousel(heroItems)}
      ${NowPlayingBanner()}
      <div class="py-6 space-y-4">
        ${ContinueRow(cw)}
        ${Row("Top Movies & Docs", movies.slice(0,20), "Movies")}
        ${Row("Top Series", series.slice(0,20), "Series")}
        ${Row("Top Shorts", shorts.slice(0,20), "Shorts")}
        ${Row("Top Foreign", foreign.slice(0,20), "Foreign")}
        ${genreRows}
      </div>
    `;
  }

  function TabPage(tabName) {
    const filtered = state.titles.filter(TAB_FILTERS[tabName] || (()=>true));
    const heroItems = filtered.slice(0, 8);

    // genre bucket rows
    const byGenre = {};
    filtered.forEach(t => {
      (t.genre || ["Featured"]).forEach(g => {
        const key = g || "Featured";
        byGenre[key] = byGenre[key] || [];
        byGenre[key].push(t);
      });
    });

    const genreRows = Object.entries(byGenre)
      .slice(0, 8)
      .map(([g, items]) => Row(g, items.slice(0, 20)))
      .join("");

    return `
      ${HeroCarousel(heroItems)}
      <div class="py-6 space-y-4">
        ${Row(`Top ${tabName}`, filtered.slice(0, 24))}
        ${genreRows}
      </div>
    `;
  }

  function CreditsBlock(t) {
    const actors = (t.actors || t.cast || []).join?.(", ") || t.actors || t.cast || "";
    const director = (t.director || t.directors || "").toString();
    const writers = (t.writers || t.writer || []).join?.(", ") || t.writers || t.writer || "";
    const imdb = t.imdbRating || t.ratings?.imdb || "";
    const rt = t.rottenTomatoesRating || t.ratings?.rottenTomatoes || "";

    if (!actors && !director && !writers && !imdb && !rt) return "";

    return `
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        ${actors ? `<div><div class="text-xs text-white/60">Actors</div><div>${esc(actors)}</div></div>` : ""}
        ${director ? `<div><div class="text-xs text-white/60">Director</div><div>${esc(director)}</div></div>` : ""}
        ${writers ? `<div><div class="text-xs text-white/60">Writers</div><div>${esc(writers)}</div></div>` : ""}
        ${(imdb || rt) ? `
          <div class="flex gap-2 items-end">
            ${imdb ? `<span class="px-2 py-1 rounded bg-white/10 text-xs">IMDb: <b>${esc(imdb)}</b></span>` : ""}
            ${rt ? `<span class="px-2 py-1 rounded bg-white/10 text-xs">Rotten Tomatoes: <b>${esc(rt)}</b></span>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }

  function renderWatchCTA(t) {
    const monet = t.monetization || {};
    const tvod  = monet.tvod || {};
    const canWatch = monet.svod || monet.avod || !tvod.enabled;

    if (tvod.enabled && !state.user) {
      return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold"
                onclick="navTo('#/login?mode=login')">Log in to Rent/Buy</button>`;
    }

    if (tvod.enabled && state.user) {
      const rentPrice = tvod.rentPrice ? `$${tvod.rentPrice}` : "";
      const buyPrice  = tvod.buyPrice ? `$${tvod.buyPrice}` : "";
      return `
        <button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
          onclick="startTVODCheckout('${t.id}')">
          Rent / Buy ${rentPrice || buyPrice ? `(${rentPrice}${rentPrice && buyPrice ? " / " : ""}${buyPrice})` : ""}
        </button>
      `;
    }

    if (canWatch) {
      return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
                onclick="navTo('#/watch/${t.id}?kind=content')">Watch Now</button>`;
    }

    return "";
  }

  function TitlePage(id) {
    const t = state.byId.get(id);
    if (!t) return NotFound("Title not found");

    const img = hero(t);
    const monet = t.monetization || {};
    const tvod  = monet.tvod || {};
    const accessBadge = [
      monet.svod ? "SVOD" : null,
      monet.avod ? "AVOD" : null,
      tvod.enabled ? "TVOD" : null
    ].filter(Boolean).join(" • ");

    return `
      <section class="relative">
        <div class="aspect-video bg-black">
          ${img ? `<img src="${esc(img)}" class="w-full h-full object-cover opacity-90"/>` : ""}
          <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>
        </div>

        <div class="p-4 md:p-8 -mt-12 md:-mt-20 relative z-10">
          <div class="max-w-4xl space-y-3">
            <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>

            <div class="flex flex-wrap gap-2 text-xs text-white/70">
              <span class="px-2 py-1 rounded bg-white/10">${typeLabel(t.type)}</span>
              ${t.releaseYear ? `<span class="px-2 py-1 rounded bg-white/10">${esc(t.releaseYear)}</span>` : ""}
              ${toMins(t.runtimeMins) ? `<span class="px-2 py-1 rounded bg-white/10">${toMins(t.runtimeMins)} mins</span>` : ""}
              ${accessBadge ? `<span class="px-2 py-1 rounded bg-watchGold/20 text-watchGold">${accessBadge}</span>` : ""}
            </div>

            <h1 class="text-2xl md:text-4xl font-black">${esc(t.title || "Untitled")}</h1>
            <p class="text-white/80">${esc(t.synopsis || "")}</p>

            ${CreditsBlock(t)}

            <div class="flex flex-wrap gap-2 pt-2">
              ${t.trailerPlaybackId ? `
                <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20"
                  onclick="navTo('#/watch/${t.id}?kind=trailer')">Play Trailer</button>
              ` : ""}
              ${renderWatchCTA(t)}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function SeriesPage(id) {
    const s = state.byId.get(id);
    if (!s || s.type !== "series") return NotFound("Series not found");

    const img = hero(s);

    return `
      <section class="relative">
        <div class="aspect-video bg-black">
          ${img ? `<img src="${esc(img)}" class="w-full h-full object-cover opacity-90"/>` : ""}
          <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>
        </div>

        <div class="p-4 md:p-8 -mt-12 md:-mt-20 relative z-10">
          <div class="max-w-5xl space-y-3">
            <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
            <div class="text-xs uppercase tracking-widest text-watchGold/90">Series</div>
            <h1 class="text-2xl md:text-4xl font-black">${esc(s.title || "Untitled")}</h1>
            <p class="text-white/80">${esc(s.synopsis || "")}</p>

            ${CreditsBlock(s)}

            <div class="flex flex-wrap gap-2 pt-2">
              ${s.trailerPlaybackId ? `
                <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20"
                  onclick="navTo('#/watch/${s.id}?kind=trailer')">Play Trailer</button>
              ` : ""}
            </div>

            <div class="pt-6 space-y-5">
              ${(s.seasons || []).map((season, si) => SeasonBlock(s, season, si)).join("") ||
                `<div class="text-white/60 text-sm">No seasons published yet.</div>`}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function SeasonBlock(series, season, seasonIndex) {
    const episodes = season.episodes || [];
    return `
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-bold">Season ${season.seasonNumber || seasonIndex + 1}</h2>
          <div class="text-xs text-white/60">${episodes.length} episodes</div>
        </div>
        <div class="space-y-2">
          ${episodes.map((ep, ei) => EpisodeRow(series, ep, seasonIndex, ei)).join("")}
        </div>
      </div>
    `;
  }

  function EpisodeRow(series, ep, seasonIndex, epIndex) {
    const img = ep.thumbnailUrl || series.posterUrl || "";
    return `
      <div class="flex gap-3 p-2 rounded-lg bg-white/5 border border-white/10">
        <img src="${esc(img)}" class="w-20 h-28 object-cover rounded-md bg-black/40"/>
        <div class="flex-1 space-y-1">
          <div class="text-sm font-semibold">
            E${ep.episodeNumber || epIndex + 1} — ${esc(ep.title || "Untitled")}
          </div>
          <div class="text-xs text-white/60 line-clamp-2">${esc(ep.synopsis || "")}</div>
          <div class="text-xs text-white/60">${toMins(ep.runtimeMins) ? `${toMins(ep.runtimeMins)} mins` : ""}</div>

          <div class="flex gap-2 pt-1">
            ${ep.trailerPlaybackId ? `
              <button class="tv-focus px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20"
                onclick="navTo('#/episode/${series.id}/${seasonIndex}/${epIndex}?kind=trailer')">Trailer</button>
            ` : ""}
            <button class="tv-focus px-3 py-1.5 text-xs rounded bg-watchRed font-bold"
              onclick="navTo('#/episode/${series.id}/${seasonIndex}/${epIndex}?kind=content')">Watch</button>
          </div>
        </div>
      </div>
    `;
  }

  function EpisodeWatchPage(seriesId, seasonIndex, epIndex, kind="content") {
    const s = state.byId.get(seriesId);
    const season = s?.seasons?.[Number(seasonIndex)];
    const ep = season?.episodes?.[Number(epIndex)];
    if (!s || !ep) return NotFound("Episode not found");

    const pb = muxIdFor(ep, kind);
    if (!pb) {
      return `
        <div class="p-6 space-y-3">
          <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
          <div class="text-white/70">No ${kind} playback ID set for this episode.</div>
        </div>
      `;
    }

    return `
      <div class="p-4 md:p-8 space-y-4">
        <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
        <div class="text-xl font-bold">
          ${esc(s.title)} — S${season.seasonNumber || Number(seasonIndex)+1}E${ep.episodeNumber || Number(epIndex)+1}
        </div>

        ${CreditsBlock(ep)}

        <div id="playerWrap" class="relative aspect-video bg-black rounded-xl overflow-hidden border border-white/10"></div>
      </div>
    `;
  }

  function WatchPage(id, kind="content") {
    const t = state.byId.get(id);
    if (!t) return NotFound("Title not found");

    const pb = muxIdFor(t, kind);
    if (!pb) {
      return `
        <div class="p-6 space-y-3">
          <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
          <div class="text-white/70">No ${kind} playback ID set for this title.</div>
        </div>
      `;
    }

    return `
      <div class="p-4 md:p-8 space-y-4">
        <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
        <div class="text-xl font-bold">${esc(t.title)}</div>

        ${CreditsBlock(t)}

        <div id="playerWrap" class="relative aspect-video bg-black rounded-xl overflow-hidden border border-white/10"></div>
      </div>
    `;
  }

  function SearchPage() {
    return `
      <div class="p-4 md:p-8 space-y-4">
        <div class="text-2xl font-bold">Search</div>
        <input id="searchInput" class="w-full px-4 py-3 rounded-xl bg-white/10 outline-none"
          placeholder="Search titles..." />
        <div id="searchResults" class="grid grid-cols-2 md:grid-cols-6 gap-3 mt-2"></div>
      </div>
    `;
  }

  function wireSearch() {
    const input = document.getElementById("searchInput");
    const results = document.getElementById("searchResults");
    if (!input || !results) return;

    const all = state.titles.slice();

    const show = (q) => {
      const f = all.filter(t => (t.title || "").toLowerCase().includes(q.toLowerCase()));
      results.innerHTML = f.map(t => `
        <button class="tv-focus text-left group" onclick="navTo('#/${t.type==="series"?"series":"title"}/${t.id}')">
          <div class="rounded-xl overflow-hidden bg-white/5">
            <img src="${esc(poster(t) || hero(t))}" class="w-full aspect-[2/3] object-cover"/>
          </div>
          <div class="mt-2 text-sm line-clamp-1">${esc(t.title||"Untitled")}</div>
        </button>
      `).join("");
      if (isTV()) tvFocusReset();
    };

    input.addEventListener("input", e => show(e.target.value));
    show("");
  }

  function LoginPage() {
    if (!supabase) {
      return `
        <div class="p-6 max-w-md mx-auto space-y-3">
          <div class="text-2xl font-bold">Login</div>
          <div class="text-white/70 text-sm">
            Supabase isn’t configured yet. Add SUPABASE_URL and SUPABASE_ANON_KEY to /config.json.
          </div>
        </div>
      `;
    }

    const isLogin = loginView === "login";

    return `
      <div class="p-6 max-w-md mx-auto space-y-5">
        <div class="text-2xl font-black">Welcome to WatchVIM</div>

        <div class="flex rounded-xl bg-white/5 border border-white/10 p-1 text-sm">
          <button class="tv-focus flex-1 py-2 rounded-lg ${isLogin?"bg-white/15":"hover:bg-white/10 text-white/70"}"
            onclick="setLoginView('login')">Log In</button>
          <button class="tv-focus flex-1 py-2 rounded-lg ${!isLogin?"bg-white/15":"hover:bg-white/10 text-white/70"}"
            onclick="setLoginView('signup')">Become a Member</button>
        </div>

        ${!isLogin?`
          <div class="space-y-2">
            <div class="text-xs text-white/60">Full Name</div>
            <input id="signupName" class="w-full px-3 py-2 rounded bg-white/5 border border-white/10" placeholder="Your name"/>
          </div>`:""}

        <div class="space-y-2">
          <div class="text-xs text-white/60">Email</div>
          <input id="loginEmail" class="w-full px-3 py-2 rounded bg-white/5 border border-white/10" placeholder="you@email.com"/>
        </div>

        <div class="space-y-2">
          <div class="text-xs text-white/60">Password</div>
          <input id="loginPass" type="password" class="w-full px-3 py-2 rounded bg-white/5 border border-white/10" placeholder="••••••••"/>
        </div>

        ${!isLogin?`
          <div class="space-y-2">
            <div class="text-xs text-white/60">Confirm Password</div>
            <input id="signupPass2" type="password" class="w-full px-3 py-2 rounded bg-white/5 border border-white/10" placeholder="••••••••"/>
          </div>`:""}

        <button class="tv-focus w-full px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
          onclick="${isLogin?"handleSignIn()":"handleSignUp()"}">
          ${isLogin?"Log In":"Create Account"}
        </button>
      </div>
    `;
  }

  function ProfilePage() {
    if (!supabase) return NotFound("Auth not configured.");
    if (!state.user) {
      return `
        <div class="p-6 max-w-md mx-auto space-y-3">
          <div class="text-2xl font-bold">Profile</div>
          <div class="text-white/70">You’re not logged in.</div>
          <button class="tv-focus px-4 py-2 rounded bg-watchRed font-bold" onclick="navTo('#/login?mode=login')">Log in</button>
        </div>
      `;
    }

    const cw = continueWatchingItems();

    return `
      <div class="p-6 max-w-3xl mx-auto space-y-4">
        <div class="text-2xl font-bold">Your Profile</div>
        <div class="bg-white/5 border border-white/10 rounded-xl p-4">
          <div class="text-sm text-white/60">Email</div>
          <div class="font-semibold">${esc(state.user.email)}</div>
        </div>

        ${cw.length ? `
          <div class="space-y-2">
            <div class="text-lg font-bold">Continue Watching</div>
            <div class="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
              ${cw.slice(0,12).map(ContinueCard).join("")}
            </div>
          </div>
        ` : ""}
      </div>
    `;
  }

  function NotFound(msg="Not found") {
    return `
      <div class="p-6 text-center space-y-2">
        <div class="text-xl font-bold">${esc(msg)}</div>
        <button class="tv-focus px-4 py-2 rounded bg-white/10 hover:bg-white/20" onclick="setTab('Home')">Go Home</button>
      </div>
    `;
  }

  // =========================================================
  // PLAYER (Mux + VAST + resume)
  // =========================================================
  function mountPlayer({ refType, refId, routeHash, playbackId, vastTag, directUrl, resumeSec=0, trackKind="content" }) {
    const wrap = document.getElementById("playerWrap");
    if (!wrap) return;

    wrap.innerHTML = playbackId ? `
      <mux-player
        id="muxPlayer"
        class="w-full h-full"
        stream-type="on-demand"
        playback-id="${esc(playbackId)}"
        metadata-video-title="WatchVIM"
        controls autoplay playsinline
      ></mux-player>
    ` : `
      <video id="html5Player" class="w-full h-full" controls autoplay playsinline>
        <source src="${esc(directUrl||"")}" type="video/mp4" />
      </video>
    `;

    const playerEl = playbackId ? document.getElementById("muxPlayer") : document.getElementById("html5Player");
    if (!playerEl) return;

    // Resume only for content (not trailers)
    if (trackKind === "content" && resumeSec > 5) {
      const trySeek = () => {
        try { playerEl.currentTime = resumeSec; } catch (_) {}
      };
      playerEl.addEventListener("loadedmetadata", trySeek, { once:true });
      playerEl.addEventListener("canplay", trySeek, { once:true });
    }

    // Progress tracking
    if (trackKind === "content") {
      let lastSaveAt = 0;
      const onTime = () => {
        const ct = Number(playerEl.currentTime || 0);
        const dur = Number(playerEl.duration || 0);
        const now = Date.now();
        if (dur > 0 && now - lastSaveAt > 5000) {
          recordProgress({ refType, refId, routeHash, progressSec: ct, durationSec: dur });
          lastSaveAt = now;
        }
      };
      const onEnded = () => {
        const dur = Number(playerEl.duration || 0);
        recordProgress({ refType, refId, routeHash, progressSec: dur, durationSec: dur });
      };

      playerEl.addEventListener("timeupdate", onTime);
      playerEl.addEventListener("pause", onTime);
      playerEl.addEventListener("ended", onEnded);
    }

    if (vastTag) runVastPreroll(vastTag);
  }

  function runVastPreroll(vastTag) {
    const wrap = document.getElementById("playerWrap");
    if (!wrap) return;

    const adDiv = document.createElement("div");
    adDiv.id = "adContainer";
    adDiv.className = "absolute inset-0 z-10";
    wrap.appendChild(adDiv);

    function findVideoEl() {
      const mux = document.querySelector("#muxPlayer");
      const vid = mux?.shadowRoot?.querySelector("video");
      return vid || document.getElementById("html5Player");
    }

    let tries = 0;
    const tryInit = () => {
      tries++;
      const videoEl = findVideoEl();
      if (!videoEl) {
        if (tries < 8) return setTimeout(tryInit, 250);
        return;
      }

      try {
        const adDisplayContainer = new google.ima.AdDisplayContainer(adDiv, videoEl);
        const adsLoader = new google.ima.AdsLoader(adDisplayContainer);

        adsLoader.addEventListener(
          google.ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED,
          (e) => {
            const adsManager = e.getAdsManager(videoEl);
            adsManager.init(videoEl.clientWidth, videoEl.clientHeight, google.ima.ViewMode.NORMAL);
            adsManager.start();
          },
          false
        );

        const adsRequest = new google.ima.AdsRequest();
        adsRequest.adTagUrl = vastTag;
        adsRequest.linearAdSlotWidth = videoEl.clientWidth;
        adsRequest.linearAdSlotHeight = videoEl.clientHeight;

        adDisplayContainer.initialize();
        adsLoader.requestAds(adsRequest);
      } catch (err) {
        console.warn("VAST pre-roll failed, continuing.", err);
      }
    };

    tryInit();
  }

  // =========================================================
  // TVOD / PAYPAL MODAL
  // =========================================================
  function maybeLoadPayPalSDK() {
    if (!CONFIG.PAYPAL_CLIENT_ID) return;
    const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.PAYPAL_CLIENT_ID)}&currency=USD`;
    loadScript(src)
      .then(() => { state.paypalReady = true; })
      .catch(() => { state.paypalReady = false; });
  }

  async function startTVODCheckout(titleId) {
    const t = state.byId.get(titleId);
    if (!t) return alert("Title not found.");

    if (!state.user) {
      navTo("#/login?mode=login");
      return;
    }

    const tvod = t.monetization?.tvod || {};
    if (state.paypalReady && CONFIG.TVOD_API_BASE && (tvod.rentPrice || tvod.buyPrice)) {
      openTVODModal(titleId);
      return;
    }

    if (CONFIG.TVOD_CHECKOUT_URL_BASE) {
      const url =
        `${CONFIG.TVOD_CHECKOUT_URL_BASE}?titleId=${encodeURIComponent(titleId)}&user=${encodeURIComponent(state.user.id || state.user.email)}`;
      window.open(url, "_blank");
      return;
    }

    alert("TVOD checkout not configured. Add PAYPAL_CLIENT_ID + TVOD_API_BASE for in-app, or TVOD_CHECKOUT_URL_BASE for external checkout.");
  }

  function openTVODModal(titleId) {
    const t = state.byId.get(titleId);
    const tvod = t?.monetization?.tvod || {};
    if (!t || !tvod.enabled) return;

    closeTVODModal();

    const modal = document.createElement("div");
    modal.id = "tvodModal";
    modal.className = "fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-4";

    const hasRent = !!tvod.rentPrice;
    const hasBuy  = !!tvod.buyPrice;
    const defaultOption = hasRent ? "rent" : "buy";

    modal.innerHTML = `
      <div class="w-full max-w-lg bg-watchBlack border border-white/10 rounded-2xl p-4 space-y-3">
        <div class="flex items-center justify-between">
          <div class="text-lg font-bold">Rent / Buy</div>
          <button class="tv-focus px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-sm" onclick="closeTVODModal()">✕</button>
        </div>

        <div class="flex gap-3">
          <img src="${esc(poster(t)||hero(t))}" class="w-24 h-36 object-cover rounded-lg bg-white/5 border border-white/10"/>
          <div class="flex-1">
            <div class="text-base font-semibold line-clamp-2">${esc(t.title)}</div>
            <div class="text-xs text-white/60 mt-1">${esc(t.synopsis||"")}</div>
          </div>
        </div>

        <div class="space-y-2">
          ${hasRent?`
            <label class="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/10 cursor-pointer">
              <input type="radio" name="tvodOption" value="rent" checked />
              <div class="text-sm">Rent (48h) — <b>$${esc(tvod.rentPrice)}</b></div>
            </label>
          `:""}
          ${hasBuy?`
            <label class="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/10 cursor-pointer">
              <input type="radio" name="tvodOption" value="buy" ${!hasRent?"checked":""}/>
              <div class="text-sm">Buy — <b>$${esc(tvod.buyPrice)}</b></div>
            </label>
          `:""}
        </div>

        <div id="paypalButtons" class="pt-2"></div>
        <div id="tvodStatus" class="text-xs text-white/60"></div>
      </div>
    `;

    document.body.appendChild(modal);

    if (!window.paypal || !CONFIG.TVOD_API_BASE) {
      document.getElementById("tvodStatus").innerText =
        "PayPal or TVOD_API_BASE not configured. Falling back to external checkout.";
      return;
    }

    const getSelectedOption = () => {
      const el = modal.querySelector('input[name="tvodOption"]:checked');
      return el?.value || defaultOption;
    };

    window.paypal.Buttons({
      style: { layout: "vertical" },
      createOrder: async () => {
        const option = getSelectedOption();
        document.getElementById("tvodStatus").innerText = "Creating order…";
        const res = await fetch(`${CONFIG.TVOD_API_BASE}/paypal/create-order`, {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({
            titleId,
            option,
            userId: state.user?.id,
            email: state.user?.email
          })
        });
        const data = await res.json();
        if (!data?.orderId) throw new Error("No orderId returned");
        document.getElementById("tvodStatus").innerText = "Order created.";
        return data.orderId;
      },
      onApprove: async (data) => {
        document.getElementById("tvodStatus").innerText = "Finalizing purchase…";
        const res = await fetch(`${CONFIG.TVOD_API_BASE}/paypal/capture-order`, {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ orderId: data.orderID })
        });
        const out = await res.json();
        if (out?.ok === false) throw new Error(out?.message || "Capture failed");

        document.getElementById("tvodStatus").innerText = "Success! Enjoy watching.";
        setTimeout(() => {
          closeTVODModal();
          navTo(`#/watch/${titleId}?kind=content`);
        }, 800);
      },
      onError: (err) => {
        console.error(err);
        document.getElementById("tvodStatus").innerText =
          "Payment error. Please try again or use external checkout.";
      }
    }).render("#paypalButtons");
  }

  function closeTVODModal() {
    const el = document.getElementById("tvodModal");
    if (el) el.remove();
  }

  // =========================================================
  // LIVE / LOOP CHANNEL
  // =========================================================
  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function initLoopQueue() {
    const loop = state.catalog?.loopChannel;
    if (!loop || !(loop.rotationItems || []).length) {
      state.loop.queue = [];
      return;
    }

    const items = (loop.rotationItems || [])
      .map(resolveLoopItem)
      .filter(Boolean);

    state.loop.queue = loop.shuffle ? shuffleArray(items) : items;
    state.loop.index = 0;
    state.loop.lastAdAt = 0;
    state.loop.shuffle = !!loop.shuffle;
    state.loop.playingAd = false;
  }

  function resolveLoopItem(it) {
    if (!it) return null;
    const { refType, refId, label } = it;

    if (refType === "title") {
      const t = state.byId.get(refId);
      if (!t) return null;
      return {
        kind: "content",
        refType, refId,
        label: label || t.title || "Untitled",
        poster: poster(t),
        playbackId: t.contentPlaybackId || t.trailerPlaybackId || ""
      };
    }

    if (refType === "episode") {
      const ep = state.byId.get(refId);
      if (!ep) return null;
      const series = state.byId.get(ep.__seriesId);
      return {
        kind: "content",
        refType, refId,
        label: label || `${series?.title||"Series"} — S${Number(ep.__seasonIndex)+1}E${Number(ep.__epIndex)+1} • ${ep.title||"Untitled"}`,
        poster: ep.thumbnailUrl || series?.posterUrl || "",
        playbackId: ep.contentPlaybackId || ep.trailerPlaybackId || ""
      };
    }

    return null;
  }

  function pickLoopAd() {
    const loop = state.catalog?.loopChannel;
    const ads = loop?.sponsoredAds || [];
    if (!ads.length) return null;
    const ad = ads[Math.floor(Math.random() * ads.length)];
    if (!ad) return null;

    return {
      kind: "ad",
      label: ad.name || "Sponsored",
      durationSec: ad.durationSec || 15,
      playbackId: ad.muxAdPlaybackId || "",
      mediaUrl: ad.mediaUrl || "",
      clickUrl: ad.clickUrl || ""
    };
  }

  function shouldPlayAd() {
    const loop = state.catalog?.loopChannel;
    const freqMins = Number(loop?.adFrequencyMins || 12);
    if (!freqMins) return false;
    const elapsedMs = Date.now() - (state.loop.lastAdAt || 0);
    return elapsedMs >= freqMins * 60 * 1000;
  }

  function nextLoopItem() {
    if (!state.loop.queue.length) return null;
    state.loop.index = (state.loop.index + 1) % state.loop.queue.length;
    if (state.loop.index === 0 && state.loop.shuffle) {
      state.loop.queue = shuffleArray(state.loop.queue);
    }
    return state.loop.queue[state.loop.index];
  }

  function currentLoopItem() {
    return state.loop.queue[state.loop.index] || null;
  }

  function playNextLoop() {
    if (!state.loop.playingAd && shouldPlayAd()) {
      const ad = pickLoopAd();
      if (ad && (ad.playbackId || ad.mediaUrl)) {
        state.loop.playingAd = true;
        state.loop.lastAdAt = Date.now();
        renderLoopAd(ad);
        return;
      }
    }
    state.loop.playingAd = false;
    nextLoopItem();
    render();
  }

  function LoopPage() {
    const loop = state.catalog?.loopChannel;
    const queue = state.loop.queue;

    if (!loop || !queue.length) {
      return `
        <div class="p-6 md:p-8 space-y-3">
          <div class="text-2xl font-bold">LIVE</div>
          <div class="text-white/70">No LIVE rotation items are published yet.</div>
          <div class="text-xs text-white/60">In CMS → LIVE → add rotation items → Publish.</div>
        </div>
      `;
    }

    const nowItem = currentLoopItem();
    const playbackId = nowItem?.playbackId;

    return `
      <div class="p-4 md:p-8 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-2xl font-bold">LIVE</div>
            <div class="text-xs text-white/60">
              ${loop.shuffle ? "Shuffle On" : "Shuffle Off"} • Ads every ${loop.adFrequencyMins || 12} mins
            </div>
          </div>
          <div class="flex gap-2">
            <button class="tv-focus px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm" onclick="toggleLoopShuffle()">
              ${state.loop.shuffle ? "Disable Shuffle" : "Enable Shuffle"}
            </button>
            <button class="tv-focus px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-sm" onclick="skipLoop()">
              Next →
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-sm font-semibold">${esc(nowItem?.label||"")}</div>
          ${playbackId ? `
            <div class="aspect-video bg-black rounded-xl overflow-hidden border border-white/10">
              <mux-player id="loopPlayer" stream-type="on-demand"
                playback-id="${esc(playbackId)}"
                class="w-full h-full" controls autoplay></mux-player>
            </div>
          ` : `
            <div class="p-6 rounded-xl bg-white/5 border border-white/10 text-white/70">
              This item has no Playback ID. Skipping…
            </div>
          `}
        </div>

        <div class="pt-2">
          <div class="text-xs text-white/60 mb-2">Up Next</div>
          <div class="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            ${queue.slice(0,12).map((q,i)=>`
              <div class="min-w-[150px]">
                <div class="aspect-[2/3] rounded-lg overflow-hidden bg-white/5 border border-white/10">
                  ${q.poster ? `<img src="${esc(q.poster)}" class="w-full h-full object-cover"/>` : ""}
                </div>
                <div class="mt-1 text-xs line-clamp-2 ${i===state.loop.index?"text-watchGold":"text-white/80"}">${esc(q.label)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function attachLoopPlayerListeners() {
    const p = document.getElementById("loopPlayer");
    if (!p) return;

    const nowItem = currentLoopItem();
    if (!nowItem?.playbackId) {
      setTimeout(() => playNextLoop(), 500);
      return;
    }

    p.addEventListener("ended", () => playNextLoop());
    p.addEventListener("error", () => playNextLoop());
  }

  function renderLoopAd(ad) {
    app.innerHTML = `
      ${Header()}
      <div class="min-h-[calc(100vh-64px)] bg-watchBlack pb-24 md:pb-8">
        <div class="p-4 md:p-8 space-y-3">
          <div class="text-xs uppercase tracking-widest text-watchGold/90">Sponsored</div>
          <div class="text-lg font-bold">${esc(ad.label || "Ad")}</div>

          <div class="aspect-video bg-black rounded-xl overflow-hidden border border-white/10">
            ${ad.playbackId ? `
              <mux-player id="loopAdPlayer" stream-type="on-demand"
                playback-id="${esc(ad.playbackId)}" class="w-full h-full"
                autoplay controls></mux-player>
            ` : `
              <video id="loopAdPlayer" class="w-full h-full" autoplay controls>
                <source src="${esc(ad.mediaUrl)}" />
              </video>
            `}
          </div>

          ${ad.clickUrl ? `
            <a class="text-sm text-watchGold underline" href="${esc(ad.clickUrl)}" target="_blank" rel="noreferrer">Learn more</a>
          ` : ""}

          <button class="tv-focus px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-sm w-fit" onclick="playNextLoop()">Skip Ad →</button>
        </div>
      </div>
      ${MobileTabBar()}
      <footer class="px-4 md:px-8 py-6 text-xs text-white/50 border-t border-white/10">
        © WatchVIM — Powered by VIM Media
      </footer>
    `;

    const p = document.getElementById("loopAdPlayer");
    if (!p) return;
    p.addEventListener("ended", () => { state.loop.playingAd=false; render(); });
    p.addEventListener("error", () => { state.loop.playingAd=false; render(); });
  }

  // =========================================================
  // RENDER STATES
  // =========================================================
  function renderLoading() {
    app.innerHTML = `
      <div class="min-h-screen flex flex-col items-center justify-center gap-4 bg-watchBlack">
        <div class="animate-pulse w-16 h-16 rounded-2xl bg-white/10"></div>
        <div class="text-white/70 text-sm">Loading WatchVIM…</div>
      </div>
    `;
  }

  function renderError(err) {
    app.innerHTML = `
      <div class="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-watchBlack">
        <div class="text-2xl font-bold text-watchRed">Couldn’t load WatchVIM</div>
        <div class="text-white/70 max-w-xl">${esc(err?.message || err)}</div>
        <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20" onclick="location.reload()">Retry</button>
      </div>
    `;
  }

  // =========================================================
  // MAIN RENDER
  // =========================================================
  function render() {
    state.route = parseHash();
    const r = state.route;

    if (r.name==="login") loginView = r.params.mode==="signup" ? "signup" : "login";

    let page = "";
    if (r.name==="home") page = (state.activeTab==="Home") ? HomePage() : TabPage(state.activeTab);
    else if (r.name==="title") page = TitlePage(r.params.id);
    else if (r.name==="series") page = SeriesPage(r.params.id);
    else if (r.name==="episode") page = EpisodeWatchPage(r.params.seriesId, r.params.seasonIndex, r.params.epIndex, r.params.kind);
    else if (r.name==="watch") page = WatchPage(r.params.id, r.params.kind);
    else if (r.name==="loop") page = LoopPage();
    else if (r.name==="search") page = SearchPage();
    else if (r.name==="login") page = LoginPage();
    else if (r.name==="profile") page = ProfilePage();
    else page = HomePage();

    app.innerHTML = `
      ${Header()}
      <main class="flex-1 min-h-[calc(100vh-64px)] bg-watchBlack pb-24 md:pb-8">
        ${page}
      </main>
      ${MobileTabBar()}
      <footer class="px-4 md:px-8 py-6 text-xs text-white/50 border-t border-white/10">
        © WatchVIM — Powered by VIM Media
      </footer>
    `;

    // Post-render hooks
    if (r.name==="watch") {
      const t = state.byId.get(r.params.id);
      if (t) {
        const pb = muxIdFor(t, r.params.kind);
        const vastTag = t.vastTag || t.vast || CONFIG.VAST_TAG || "";
        const resume = (r.params.kind==="content") ? getResumeFor("title", t.id) : null;
        const resumeSec = resume?.progressSec || 0;

        mountPlayer({
          refType:"title",
          refId:t.id,
          routeHash:`#/watch/${t.id}?kind=${r.params.kind}`,
          playbackId: pb,
          vastTag,
          directUrl: t.videoUrl,
          resumeSec,
          trackKind:r.params.kind
        });
      }
    }

    if (r.name==="episode") {
      const s = state.byId.get(r.params.seriesId);
      const season = s?.seasons?.[Number(r.params.seasonIndex)];
      const ep = season?.episodes?.[Number(r.params.epIndex)];
      if (ep) {
        const pb = muxIdFor(ep, r.params.kind);
        const vastTag = ep.vastTag || ep.vast || CONFIG.VAST_TAG || "";
        const resume = (r.params.kind==="content") ? getResumeFor("episode", ep.id) : null;
        const resumeSec = resume?.progressSec || 0;

        mountPlayer({
          refType:"episode",
          refId:ep.id,
          routeHash:`#/episode/${s.id}/${r.params.seasonIndex}/${r.params.epIndex}?kind=${r.params.kind}`,
          playbackId: pb,
          vastTag,
          directUrl: ep.videoUrl,
          resumeSec,
          trackKind:r.params.kind
        });
      }
    }

    if (r.name==="loop") attachLoopPlayerListeners();
    if (r.name==="search") wireSearch();

    initHeroCarousel();
    if (isTV()) tvFocusReset();
    window.scrollTo(0,0);
  }

  // =========================================================
  // TV D-PAD NAV
  // =========================================================
  let tvFocusIndex = 0;

  function tvFocusable() {
    return Array.from(document.querySelectorAll(".tv-focus"))
      .filter(el => !el.disabled && el.offsetParent !== null);
  }

  function tvFocusReset() {
    const items = tvFocusable();
    if (!items.length) return;
    tvFocusIndex = 0;
    items.forEach(i => i.classList.remove("focus-ring"));
    items[0].classList.add("focus-ring");
    items[0].scrollIntoView({ block:"nearest", inline:"nearest" });
  }

  function tvMove(delta) {
    const items = tvFocusable();
    if (!items.length) return;
    items[tvFocusIndex]?.classList.remove("focus-ring");
    tvFocusIndex = Math.max(0, Math.min(items.length - 1, tvFocusIndex + delta));
    items[tvFocusIndex].classList.add("focus-ring");
    items[tvFocusIndex].scrollIntoView({ block:"nearest", inline:"nearest" });
  }

  function tvActivate() {
    const items = tvFocusable();
    const el = items[tvFocusIndex];
    if (!el) return;
    el.click();
  }

  window.addEventListener("keydown",(e)=>{
    if (!isTV()) return;
    switch(e.key){
      case "ArrowRight": tvMove(1); e.preventDefault(); break;
      case "ArrowLeft": tvMove(-1); e.preventDefault(); break;
      case "ArrowDown": tvMove(3); e.preventDefault(); break;
      case "ArrowUp": tvMove(-3); e.preventDefault(); break;
      case "Enter": tvActivate(); e.preventDefault(); break;
      case "Backspace":
      case "Escape":
        history.length>1 ? history.back() : navTo("#/home");
        e.preventDefault();
        break;
    }
  });

  // =========================================================
  // GLOBAL HANDLERS
  // =========================================================
  window.navTo = navTo;
  window.setTab = setTab;
  window.signOut = signOut;
  window.setLoginView = setLoginView;
  window.startTVODCheckout = startTVODCheckout;
  window.openTVODModal = openTVODModal;
  window.closeTVODModal = closeTVODModal;

  window.skipLoop = () => playNextLoop();
  window.toggleLoopShuffle = () => {
    state.loop.shuffle = !state.loop.shuffle;
    initLoopQueue();
    render();
  };

  window.handleSignIn = () => {
    const email = document.getElementById("loginEmail")?.value.trim();
    const password = document.getElementById("loginPass")?.value.trim();
    if (!email || !password) return alert("Enter email + password.");
    signIn(email, password);
  };

  window.handleSignUp = () => {
    const email = document.getElementById("loginEmail")?.value.trim();
    const password = document.getElementById("loginPass")?.value.trim();
    const password2 = document.getElementById("signupPass2")?.value.trim();
    const fullName = document.getElementById("signupName")?.value.trim();

    if (!fullName) return alert("Please enter your full name.");
    if (!email || !password || !password2) return alert("Fill out all fields.");
    if (password !== password2) return alert("Passwords do not match.");
    if (password.length < 6) return alert("Password must be at least 6 characters.");
    signUp(email, password, fullName);
  };

  // =========================================================
  // BOOT
  // =========================================================
  (async function boot(){
    await loadConfigJSON();
    await initSupabaseIfPossible();
    await loadData();
    render();
  })();

})();
