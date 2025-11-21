/* ============================================================
   WatchVIM Universal Mobile + TV Frontend (JS)
   - Reads /config.json
   - Fetches CMS Stable Manifest -> catalog
   - Routes: Home, Tab, Title, Play, Search
   - TV D-pad navigation (arrow/enter/back)
   - Touch-first mobile UX + bottom tabs (if TV = false)
   ============================================================ */

(() => {
  // ---------------------------
  // CONFIG
  // ---------------------------
  const DEFAULT_CONFIG = {
    MANIFEST_URL: "",
    LOGO_URL: "./VIM FireTv Logo - 5.png",
    THEME: { accent: "#e11d48" },
    VAST_TAG: "" // optional global ad tag
  };

  let CONFIG = { ...DEFAULT_CONFIG };
  let CATALOG = null;

  const state = {
    tvMode: false,
    tvFocusIndex: 0
  };

  // Root element
  const root = document.getElementById("app") || document.body;

  // ---------------------------
  // LOADERS
  // ---------------------------
  async function loadConfigJSON() {
    try {
      const res = await fetch(`/config.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        CONFIG = { ...DEFAULT_CONFIG, ...json };
      }
    } catch (e) {
      console.warn("config.json not found, using defaults.");
    }
  }

  async function loadManifest() {
    if (!CONFIG.MANIFEST_URL) throw new Error("Missing MANIFEST_URL in config.json");
    const res = await fetch(CONFIG.MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("Manifest fetch failed");
    CATALOG = await res.json();
  }

  // ---------------------------
  // TV DETECTION
  // ---------------------------
  function isTV() {
    const ua = navigator.userAgent.toLowerCase();
    return (
      ua.includes("aft") || ua.includes("smarttv") || ua.includes("tizen") ||
      ua.includes("webos") || ua.includes("android tv") ||
      window.innerWidth >= 1024
    );
  }

  // ---------------------------
  // CATALOG HELPERS (schema-flexible)
  // ---------------------------
  function allTitles() {
    if (!CATALOG) return [];
    if (Array.isArray(CATALOG.titles)) return CATALOG.titles;
    if (Array.isArray(CATALOG.catalog)) return CATALOG.catalog;
    const cats = CATALOG.categories || {};
    return Object.values(cats).flat();
  }

  function getCategory(tabName) {
    if (!CATALOG) return [];
    const cats = CATALOG.categories || CATALOG || {};
    const key = Object.keys(cats).find(k => k.toLowerCase() === tabName.toLowerCase());
    return key ? cats[key] : [];
  }

  function byId(id) {
    return allTitles().find(t =>
      String(t.id) === String(id) || String(t.slug) === String(id)
    );
  }

  function heroItems() {
    return (CATALOG.hero || CATALOG.featured || allTitles().slice(0, 8)) || [];
  }

  function imgFor(t) {
    return t.heroImage || t.poster || t.thumbnail || t.image || "";
  }

  function badgeFor(t) {
    return t.type || t.category || "";
  }

  function muxPlaybackId(t) {
    return t.muxPlaybackId || t.playbackId || t.mux || "";
  }

  function vastTagFor(t) {
    return t.vastTag || t.vast || CONFIG.VAST_TAG || "";
  }

  // ---------------------------
  // ROUTER
  // ---------------------------
  const routes = {
    home: () => renderHome(),
    tab: (tab) => renderTab(tab),
    title: (id) => renderTitle(id),
    play: (id) => renderPlay(id),
    search: () => renderSearch()
  };

  function go(hash) {
    location.hash = hash;
  }

  function parseRoute() {
    const h = location.hash.replace("#/", "").trim();
    if (!h) return { name: "home", args: [] };
    const parts = h.split("/");
    return { name: parts[0], args: parts.slice(1) };
  }

  function renderRoute() {
    const { name, args } = parseRoute();
    const fn = routes[name] || routes.home;
    fn(...args);
    wireNavButtons();
    wireHero();
    if (state.tvMode) tvFocusReset();
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", renderRoute);

  // ---------------------------
  // SHELL LAYOUT
  // ---------------------------
  function shell({ activeTab = "home", contentHTML = "" }) {
    root.innerHTML = `
      <header class="flex items-center gap-3 px-4 py-3 sticky top-0 z-20 bg-black/90 backdrop-blur">
        <img src="${CONFIG.LOGO_URL}" alt="logo" class="h-8 w-auto" />
        <nav class="ml-auto flex gap-2 text-sm">
          ${tabBtn("home", "Home", activeTab)}
          ${tabBtn("Movies", "Movies", activeTab)}
          ${tabBtn("Series", "Series", activeTab)}
          ${tabBtn("Shorts", "Shorts", activeTab)}
          ${tabBtn("Foreign", "Foreign", activeTab)}
          ${tabBtn("search", "Search", activeTab)}
        </nav>
      </header>

      <main class="flex-1 px-3 md:px-6 pb-24 md:pb-8">
        ${contentHTML}
      </main>

      ${mobileTabBar(activeTab)}
    `;
  }

  function tabBtn(route, label, activeTab) {
    const isActive = activeTab.toLowerCase() === route.toLowerCase();
    return `
      <button data-nav="#/${route === "home" ? "" : route}"
        class="tv-focus px-3 py-1.5 rounded-full ${isActive ? "bg-white text-black" : "bg-white/10 hover:bg-white/20"}">
        ${label}
      </button>
    `;
  }

  function mobileTabBar(activeTab) {
    if (state.tvMode) return "";
    const items = [
      ["home", "Home"],
      ["Movies", "Movies"],
      ["Series", "Series"],
      ["Shorts", "Shorts"],
      ["Foreign", "Foreign"]
    ];
    return `
      <footer class="fixed bottom-0 left-0 right-0 bg-black/95 border-t border-white/10 safe-bottom">
        <div class="flex justify-around px-2 py-2">
          ${items.map(([r, l]) => {
            const on = activeTab.toLowerCase() === r.toLowerCase();
            return `
              <button data-nav="#/${r === "home" ? "" : r}"
                class="tv-focus flex-1 mx-1 py-2 rounded-lg text-xs ${on ? "bg-white text-black" : "bg-white/10"}">
                ${l}
              </button>
            `;
          }).join("")}
        </div>
      </footer>
    `;
  }

  function wireNavButtons() {
    document.querySelectorAll("[data-nav]").forEach(btn => {
      btn.addEventListener("click", () => go(btn.getAttribute("data-nav")));
    });
  }

  // ---------------------------
  // HOME
  // ---------------------------
  function renderHome() {
    const hero = heroItems();
    const rows = ["Movies", "Series", "Shorts", "Foreign"]
      .map(cat => ({ name: cat, items: getCategory(cat).slice(0, 20) }))
      .filter(r => r.items.length);

    shell({
      activeTab: "home",
      contentHTML: `
        ${renderHero(hero)}
        ${rows.map(r => renderRow(r.name, r.items)).join("")}
      `
    });
  }

  function renderHero(items) {
    if (!items.length) return "";
    return `
      <section class="mt-3">
        <div class="relative rounded-2xl overflow-hidden bg-white/5">
          <div id="heroTrack" class="flex transition-transform duration-500">
            ${items.map(t => `
              <div class="min-w-full relative">
                <img src="${imgFor(t)}" class="w-full h-[45vw] md:h-[28vw] object-cover opacity-90" />
                <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent"></div>
                <div class="absolute bottom-0 left-0 p-4 md:p-6">
                  <div class="text-xs uppercase tracking-widest text-white/70">${badgeFor(t)}</div>
                  <h2 class="text-xl md:text-3xl font-semibold mt-1">${t.title || t.name}</h2>
                  <p class="text-sm text-white/80 max-w-2xl line-clamp-2 mt-2">${t.description || ""}</p>
                  <div class="mt-3 flex gap-2">
                    <button class="tv-focus px-4 py-2 rounded-xl bg-white text-black font-medium"
                      data-nav="#/play/${t.id}">Play</button>
                    <button class="tv-focus px-4 py-2 rounded-xl bg-white/10"
                      data-nav="#/title/${t.id}">Details</button>
                  </div>
                </div>
              </div>
            `).join("")}
          </div>

          <button id="heroPrev" class="tv-focus absolute left-2 top-1/2 -translate-y-1/2 bg-black/60 px-3 py-2 rounded-full">‹</button>
          <button id="heroNext" class="tv-focus absolute right-2 top-1/2 -translate-y-1/2 bg-black/60 px-3 py-2 rounded-full">›</button>
        </div>
      </section>
    `;
  }

  let heroTimer = null;
  function wireHero() {
    const track = document.getElementById("heroTrack");
    if (!track) return;

    const slides = Array.from(track.children);
    let i = 0;

    const update = () => track.style.transform = `translateX(-${i * 100}%)`;

    const prev = document.getElementById("heroPrev");
    const next = document.getElementById("heroNext");

    if (prev) prev.onclick = () => { i = (i - 1 + slides.length) % slides.length; update(); };
    if (next) next.onclick = () => { i = (i + 1) % slides.length; update(); };

    if (heroTimer) clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      i = (i + 1) % slides.length; update();
    }, 7000);
  }

  // ---------------------------
  // ROWS + TILES
  // ---------------------------
  function renderRow(name, items) {
    return `
      <section class="mt-6">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-lg font-semibold">${name}</h3>
          <button class="tv-focus text-sm text-white/70 hover:text-white"
            data-nav="#/tab/${name}">View all</button>
        </div>

        <div class="row-scroll flex gap-3 overflow-x-auto pb-2">
          ${items.map(tileHTML).join("")}
        </div>
      </section>
    `;
  }

  function tileHTML(t) {
    return `
      <button class="tile tv-focus shrink-0 w-[38vw] md:w-[16vw] text-left group"
        data-nav="#/title/${t.id}">
        <div class="rounded-xl overflow-hidden bg-white/5">
          <img src="${imgFor(t)}"
            class="w-full aspect-[2/3] object-cover group-hover:opacity-90" />
        </div>
        <div class="mt-2">
          <div class="text-xs text-white/60">${badgeFor(t)}</div>
          <div class="text-sm font-medium line-clamp-1">${t.title || t.name}</div>
        </div>
      </button>
    `;
  }

  function tileGridHTML(t) {
    return `
      <button class="tv-focus text-left group" data-nav="#/title/${t.id}">
        <div class="rounded-xl overflow-hidden bg-white/5">
          <img src="${imgFor(t)}" class="w-full aspect-[2/3] object-cover" />
        </div>
        <div class="mt-2 text-sm line-clamp-1">${t.title || t.name}</div>
      </button>
    `;
  }

  // ---------------------------
  // TAB PAGE
  // ---------------------------
  function renderTab(tab) {
    const items = getCategory(tab);

    shell({
      activeTab: tab,
      contentHTML: `
        <h2 class="text-2xl font-semibold mt-4">${tab}</h2>
        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mt-4">
          ${items.map(tileGridHTML).join("")}
        </div>
      `
    });
  }

  // ---------------------------
  // TITLE DETAILS
  // ---------------------------
  function renderTitle(id) {
    const t = byId(id);
    if (!t) return renderNotFound();

    shell({
      activeTab: (t.category || t.type || "home"),
      contentHTML: `
        <section class="mt-4 grid md:grid-cols-3 gap-4">
          <div>
            <img src="${imgFor(t)}" class="w-full rounded-2xl bg-white/5 object-cover aspect-[2/3]" />
          </div>
          <div class="md:col-span-2">
            <div class="text-xs text-white/60 uppercase tracking-widest">${badgeFor(t)}</div>
            <h1 class="text-2xl md:text-4xl font-semibold mt-1">${t.title || t.name}</h1>
            <div class="text-sm text-white/70 mt-2">${t.year || ""} ${t.runtime ? "• " + t.runtime : ""}</div>

            <p class="mt-4 text-white/85 leading-relaxed">${t.description || ""}</p>

            <div class="mt-5 flex gap-2">
              <button class="tv-focus px-5 py-2.5 rounded-xl bg-white text-black font-semibold"
                data-nav="#/play/${t.id}">Play</button>
              ${t.trailerId ? `
                <button class="tv-focus px-5 py-2.5 rounded-xl bg-white/10"
                  data-nav="#/play/${t.trailerId}">Trailer</button>` : ``}
            </div>

            ${renderSeriesBlock(t)}
          </div>
        </section>
      `
    });
  }

  function renderSeriesBlock(t) {
    const seasons = t.seasons || t.seriesSeasons || [];
    if (!seasons.length) return "";

    return `
      <section class="mt-8">
        <h3 class="text-xl font-semibold mb-2">Seasons</h3>
        ${seasons.map((s, si) => `
          <div class="mb-4">
            <div class="text-sm text-white/70 mb-2">Season ${s.seasonNumber || (si + 1)}</div>
            <div class="row-scroll flex gap-3 overflow-x-auto pb-2">
              ${(s.episodes || []).map(ep => `
                <button class="tile tv-focus shrink-0 w-[60vw] md:w-[22vw] text-left"
                  data-nav="#/play/${ep.id}">
                  <div class="rounded-xl overflow-hidden bg-white/5">
                    <img src="${imgFor(ep) || imgFor(t)}" class="w-full aspect-video object-cover" />
                  </div>
                  <div class="mt-2 text-sm line-clamp-1">${ep.title || ep.name}</div>
                </button>
              `).join("")}
            </div>
          </div>
        `).join("")}
      </section>
    `;
  }

  // ---------------------------
  // PLAYBACK (Mux Player defined in HTML)
  // ---------------------------
  function renderPlay(id) {
    const t = byId(id);
    if (!t) return renderNotFound();

    const playbackId = muxPlaybackId(t);
    const vastTag = vastTagFor(t);
    const directUrl = t.videoUrl || t.mp4Url || "";

    shell({
      activeTab: "home",
      contentHTML: `
        <section class="mt-4">
          <div class="rounded-2xl overflow-hidden bg-black">
            <div id="playerWrap" class="relative w-full aspect-video bg-black"></div>
          </div>

          <div class="mt-3">
            <h2 class="text-xl font-semibold">${t.title || t.name}</h2>
            <p class="text-sm text-white/70 mt-1">${t.description || ""}</p>
          </div>
        </section>
      `
    });

    mountPlayer({ playbackId, vastTag, directUrl });
  }

  function mountPlayer({ playbackId, vastTag, directUrl }) {
    const wrap = document.getElementById("playerWrap");
    if (!wrap) return;
    wrap.innerHTML = "";

    if (playbackId) {
      wrap.innerHTML = `
        <mux-player
          id="muxPlayer"
          class="w-full h-full"
          stream-type="on-demand"
          playback-id="${playbackId}"
          metadata-video-title="WatchVIM"
          controls
          autoplay
        ></mux-player>
      `;
    } else {
      wrap.innerHTML = `
        <video id="html5Player" class="w-full h-full" controls autoplay playsinline>
          <source src="${directUrl}" type="video/mp4" />
        </video>
      `;
    }

    if (vastTag && window.google?.ima) runVastPreroll(vastTag);
  }

  function runVastPreroll(vastTag) {
    const wrap = document.getElementById("playerWrap");
    if (!wrap) return;

    const adDiv = document.createElement("div");
    adDiv.id = "adContainer";
    adDiv.className = "absolute inset-0 z-10";
    wrap.appendChild(adDiv);

    try {
      const muxVideo = document.querySelector("#muxPlayer")
        ?.shadowRoot?.querySelector("video");
      const html5Video = document.getElementById("html5Player");
      const videoEl = muxVideo || html5Video;
      if (!videoEl) return;

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
      console.warn("VAST preroll error, continuing content.", err);
    }
  }

  // ---------------------------
  // SEARCH
  // ---------------------------
  function renderSearch() {
    shell({
      activeTab: "search",
      contentHTML: `
        <section class="mt-4">
          <input id="searchInput" class="w-full px-4 py-3 rounded-xl bg-white/10 outline-none"
            placeholder="Search titles..." />
          <div id="searchResults" class="grid grid-cols-2 md:grid-cols-6 gap-3 mt-4"></div>
        </section>
      `
    });

    const input = document.getElementById("searchInput");
    const results = document.getElementById("searchResults");

    function show(q) {
      const filtered = allTitles().filter(t =>
        (t.title || t.name || "").toLowerCase().includes(q.toLowerCase())
      );
      results.innerHTML = filtered.map(tileGridHTML).join("");
      wireNavButtons();
      if (state.tvMode) tvFocusReset();
    }

    input.addEventListener("input", e => show(e.target.value));
    show("");
  }

  // ---------------------------
  // NOT FOUND
  // ---------------------------
  function renderNotFound() {
    shell({
      activeTab: "home",
      contentHTML: `
        <div class="mt-10 text-center">
          <h2 class="text-2xl font-semibold">Not found</h2>
          <button class="tv-focus mt-4 px-4 py-2 rounded-xl bg-white text-black"
            data-nav="#/">Go Home</button>
        </div>
      `
    });
  }

  // ---------------------------
  // TV D-PAD NAVIGATION
  // ---------------------------
  function tvFocusable() {
    return Array.from(document.querySelectorAll(".tv-focus"))
      .filter(el => !el.disabled && el.offsetParent !== null);
  }

  function tvFocusReset() {
    const items = tvFocusable();
    if (!items.length) return;
    state.tvFocusIndex = 0;
    items.forEach(i => i.classList.remove("focus-ring"));
    items[0].classList.add("focus-ring");
    items[0].scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function tvMove(delta) {
    const items = tvFocusable();
    if (!items.length) return;
    items[state.tvFocusIndex]?.classList.remove("focus-ring");

    state.tvFocusIndex = Math.max(
      0,
      Math.min(items.length - 1, state.tvFocusIndex + delta)
    );

    items[state.tvFocusIndex].classList.add("focus-ring");
    items[state.tvFocusIndex].scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function tvActivate() {
    const items = tvFocusable();
    const el = items[state.tvFocusIndex];
    if (!el) return;
    const nav = el.getAttribute("data-nav");
    if (nav) go(nav);
    else el.click();
  }

  window.addEventListener("keydown", (e) => {
    if (!state.tvMode) return;

    switch (e.key) {
      case "ArrowRight": tvMove(1); e.preventDefault(); break;
      case "ArrowLeft": tvMove(-1); e.preventDefault(); break;
      case "ArrowDown": tvMove(3); e.preventDefault(); break;
      case "ArrowUp": tvMove(-3); e.preventDefault(); break;
      case "Enter": tvActivate(); e.preventDefault(); break;
      case "Backspace":
      case "Escape":
        history.length > 1 ? history.back() : go("#/");
        e.preventDefault();
        break;
    }
  });

  // ---------------------------
  // BOOT
  // ---------------------------
  async function init() {
    state.tvMode = isTV();
    await loadConfigJSON();
    await loadManifest();
    renderRoute();
  }

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", init)
    : init();

})();
