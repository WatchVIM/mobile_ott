/* ============================================================
   WatchVIM Mobile + TV Frontend (ROOT app.js)
   ============================================================ */

(() => {
  // =========================================================
  // CONFIG (fallbacks baked in)
  // =========================================================
  const DEFAULT_CONFIG = {
    MANIFEST_URL:
      "https://t6ht6kdwnezp05ut.public.blob.vercel-storage.com/manifest.json",
    CATALOG_URL_FALLBACK:
      "https://t6ht6kdwnezp05ut.public.blob.vercel-storage.com/catalog.json",
    LOGO_URL:
      "https://t6ht6kdwnezp05ut.public.blob.vercel-storage.com/WatchVIM%20-%20Content/WatchVIM_New_OTT_Logo.png",

    THEME: {
      accent: "#e11d48",
      background: "#0a0a0a",
      gold: "#d4af37",
    },

    SUPABASE_URL: "",
    SUPABASE_ANON_KEY: "",

    PAYPAL_CLIENT_ID: "",
    TVOD_API_BASE: "",
    TVOD_CHECKOUT_URL_BASE: "",
    VAST_TAG: "",
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
    loop: {
      queue: [],
      index: 0,
      lastAdAt: 0,
      shuffle: true,
      playingAd: false,
    },
  };

  const app = document.getElementById("app");

  // =========================================================
  // LOAD CONFIG + APPLY THEME
  // =========================================================
  async function loadConfigJSON() {
    const paths = [
      "/config.json?t=" + Date.now(), // root hosting
      "./config.json?t=" + Date.now(), // relative fallback
    ];

    for (const p of paths) {
      try {
        const res = await fetch(p, { cache: "no-store" });
        if (!res.ok) continue;
        const json = await res.json();
        CONFIG = { ...CONFIG, ...json };
        break;
      } catch (_) {}
    }

    const theme = CONFIG.THEME || {};
    document.documentElement.style.setProperty(
      "--watch-accent",
      theme.accent || "#e11d48"
    );
    document.documentElement.style.setProperty(
      "--watch-bg",
      theme.background || "#0a0a0a"
    );
    document.documentElement.style.setProperty(
      "--watch-gold",
      theme.gold || "#d4af37"
    );
  }

  // =========================================================
  // DATA LOADING (Manifest -> Catalog)
  // =========================================================
  async function fetchCatalogFromManifest() {
    try {
      const mRes = await fetch(CONFIG.MANIFEST_URL + "?t=" + Date.now(), {
        cache: "no-store",
      });
      if (!mRes.ok) throw new Error("Manifest fetch failed");
      const manifest = await mRes.json();

      const catalogUrl =
        manifest.latestCatalogUrl ||
        manifest.catalogUrl ||
        manifest.stableCatalogUrl ||
        CONFIG.CATALOG_URL_FALLBACK;

      const cRes = await fetch(catalogUrl + "?t=" + Date.now(), {
        cache: "no-store",
      });
      if (!cRes.ok) throw new Error("Catalog fetch failed");
      return await cRes.json();
    } catch (e) {
      const cRes = await fetch(
        CONFIG.CATALOG_URL_FALLBACK + "?t=" + Date.now(),
        { cache: "no-store" }
      );
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
      render();
    } catch (err) {
      renderError(err);
    }
  }

  // =========================================================
  // OPTIONAL SUPABASE AUTH
  // =========================================================
  let supabase = null;

  async function initSupabaseIfPossible() {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return;
    await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2");
    supabase = window.supabase?.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
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
      if ([...document.scripts].some((s) => s.src === src)) return resolve();
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
      email,
      password,
      options: { data: { full_name: fullName || "" } },
    });
    if (error) alert(error.message);
    else alert("Check your email to confirm your account.");
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  function isLoggedIn() {
    return !!state.user;
  }

  // =========================================================
  // ROUTER
  // =========================================================
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs] = raw.split("?");
    const parts = (path || "home").split("/").filter(Boolean);
    const query = Object.fromEntries(new URLSearchParams(qs || ""));

    if (parts[0] === "title" && parts[1])
      return { name: "title", params: { id: parts[1] } };
    if (parts[0] === "series" && parts[1])
      return { name: "series", params: { id: parts[1] } };
    if (parts[0] === "episode" && parts[1] && parts[2] && parts[3]) {
      return {
        name: "episode",
        params: {
          seriesId: parts[1],
          seasonIndex: parts[2],
          epIndex: parts[3],
          kind: query.kind || "content",
        },
      };
    }
    if (parts[0] === "watch" && parts[1])
      return { name: "watch", params: { id: parts[1], kind: query.kind || "content" } };
    if (parts[0] === "loop") return { name: "loop", params: {} };
    if (parts[0] === "search") return { name: "search", params: {} };
    if (parts[0] === "login")
      return { name: "login", params: { mode: query.mode || "login" } };
    if (parts[0] === "profile") return { name: "profile", params: {} };

    return { name: "home", params: {} };
  }

  function navTo(hash) {
    location.hash = hash;
  }
  window.addEventListener("hashchange", render);

  // =========================================================
  // UTILS
  // =========================================================
  function esc(str = "") {
    return String(str).replace(/[&<>"']/g, (m) =>
      (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[m]
      )
    );
  }
  function toMins(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : "";
  }

  function poster(t) {
    return (
      t.posterUrl ||
      t.appImages?.tvPosterUrl ||
      t.appImages?.mobilePosterUrl ||
      t.poster ||
      ""
    );
  }

  function hero(t) {
    return (
      t.heroUrl ||
      t.appImages?.tvHeroUrl ||
      t.appImages?.mobileHeroUrl ||
      t.heroImage ||
      poster(t) ||
      ""
    );
  }

  function typeLabel(type) {
    const map = {
      films: "Movie",
      documentaries: "Documentary",
      series: "Series",
      shorts: "Short",
      foreign: "Foreign",
    };
    return map[type] || type || "Title";
  }

  function muxIdFor(t, kind = "content") {
    return kind === "trailer" ? t.trailerPlaybackId : t.contentPlaybackId;
  }

  function isTV() {
    const ua = navigator.userAgent.toLowerCase();
    return (
      ua.includes("aft") ||
      ua.includes("smarttv") ||
      ua.includes("tizen") ||
      ua.includes("webos") ||
      ua.includes("android tv") ||
      window.innerWidth >= 1024
    );
  }

  const TAB_FILTERS = {
    Home: () => true,
    Movies: (t) => t.type === "films" || t.type === "documentaries",
    Series: (t) => t.type === "series",
    Shorts: (t) =>
      t.type === "shorts" || (t.runtimeMins && Number(t.runtimeMins) <= 40),
    Foreign: (t) =>
      t.type === "foreign" ||
      (t.genre || []).some((g) => /foreign|international|world/i.test(g)) ||
      (t.language && !/english/i.test(t.language)),
    LIVE: () => false,
  };

  // =========================================================
  // FEATURED + CONTINUE WATCHING
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
      return direct
        .map((it) => {
          if (!it) return null;
          if (typeof it === "string") return state.byId.get(it);
          if (it.refId) return state.byId.get(it.refId);
          if (it.id) return state.byId.get(it.id) || it;
          return it;
        })
        .filter(Boolean);
    }

    return state.titles.filter(
      (t) =>
        t.isFeatured === true ||
        t.featured === true ||
        (Array.isArray(t.tags) &&
          t.tags.some((tag) => /featured/i.test(tag))) ||
        (Array.isArray(t.genre) &&
          t.genre.some((g) => /featured/i.test(g)))
    );
  }

  function sortFeatured(items) {
    return items.slice().sort((a, b) => {
      const ao = a.featuredOrder ?? a.featuredRank ?? a.rank ?? 9999;
      const bo = b.featuredOrder ?? b.featuredRank ?? b.rank ?? 9999;
      return ao - bo;
    });
  }

  function readLastWatched() {
    try {
      return JSON.parse(
        localStorage.getItem("watchvim_last_watched") || "[]"
      );
    } catch {
      return [];
    }
  }
  function saveLastWatched(items) {
    localStorage.setItem(
      "watchvim_last_watched",
      JSON.stringify(items.slice(0, 20))
    );
  }
  function markWatched(titleId, progress = 0) {
    const items = readLastWatched().filter((x) => x.titleId !== titleId);
    items.unshift({ titleId, progress, at: Date.now() });
    saveLastWatched(items);
  }

  // =========================================================
  // SHELL
  // =========================================================
  function Header() {
    const tabs = ["Home", "Movies", "Series", "Shorts", "Foreign", "LIVE", "Search"];
    const loggedIn = isLoggedIn();

    return `
      <header class="sticky top-0 z-30 bg-watchBlack/95 backdrop-blur border-b border-white/10 safe-bottom">
        <div class="px-4 py-3 flex items-center gap-3">
          <div class="flex items-center gap-2 cursor-pointer" onclick="setTab('Home')">
            <img
              id="appLogo"
              src="${esc(CONFIG.LOGO_URL)}"
              alt="WatchVIM"
              class="h-8 w-auto object-contain"
              onerror="this.onerror=null;this.style.display='none';document.getElementById('logoFallback').classList.remove('hidden');"
            />
            <div id="logoFallback" class="hidden text-lg font-black tracking-wide">WatchVIM</div>
          </div>

          <nav class="ml-auto flex gap-2 text-sm">
            ${tabs
              .map(
                (tab) => `
              <button
                class="tv-focus px-3 py-1.5 rounded-full ${
                  state.activeTab === tab
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10"
                }"
                onclick="${
                  tab === "Search" ? "navTo('#/search')" : `setTab('${tab}')`
                }"
              >${tab}</button>
            `
              )
              .join("")}
          </nav>

          <div class="ml-2 flex gap-2 text-sm">
            ${
              loggedIn
                ? `
              <button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="navTo('#/profile')">Profile</button>
              <button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="signOut()">Log out</button>
            `
                : `
              <button class="tv-focus px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20" onclick="navTo('#/login?mode=login')">Log in</button>
              <button class="tv-focus px-3 py-1.5 rounded-lg bg-watchRed font-bold hover:opacity-90" onclick="navTo('#/login?mode=signup')">Become a Member</button>
            `
            }
          </div>
        </div>
      </header>
    `;
  }

  function MobileTabBar() {
    if (isTV()) return "";
    const items = ["Home", "Movies", "Series", "Shorts", "Foreign", "LIVE"];
    return `
      <footer class="fixed bottom-0 left-0 right-0 bg-watchBlack/95 border-t border-white/10 safe-bottom">
        <div class="flex justify-around px-2 py-2">
          ${items
            .map(
              (tab) => `
            <button class="tv-focus flex-1 mx-1 py-2 rounded-lg text-xs ${
              state.activeTab === tab ? "bg-white text-black" : "bg-white/10"
            }" onclick="setTab('${tab}')">${tab}</button>
          `
            )
            .join("")}
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
    const loggedIn = isLoggedIn();
    const target = loggedIn ? href : "#/login?mode=signup";

    // Poster size tweak: bigger on mobile, consistent 2:3 ratio
    return `
      <button class="tile tv-focus w-[46vw] sm:w-[32vw] md:w-[180px] max-w-[200px] text-left" onclick="navTo('${target}')">
        <div class="aspect-[2/3] rounded-xl overflow-hidden bg-white/5 border border-white/10">
          ${
            img
              ? `<img src="${esc(img)}" class="w-full h-full object-cover" />`
              : ""
          }
        </div>
        <div class="mt-2 text-sm font-semibold line-clamp-2">${
          esc(t.title || "Untitled")
        }</div>
        <div class="text-xs text-white/60">${esc(typeLabel(t.type))}</div>
      </button>
    `;
  }

  function Row(name, items, viewAllTab = null) {
    if (!items.length) return "";
    const tabTarget = viewAllTab || name;
    return `
      <section class="mt-6 px-4 md:px-8">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-lg font-bold">${esc(name)}</h3>
          ${
            viewAllTab
              ? `
            <button class="tv-focus text-xs text-white/60 hover:text-white" onclick="setTab('${esc(
              tabTarget
            )}')">View all</button>
          `
              : ``
          }
        </div>
        <div class="row-scroll flex gap-3 overflow-x-auto pb-2 no-scrollbar">
          ${items.map(Card).join("")}
        </div>
      </section>
    `;
  }

  // =========================================================
  // HERO (no autoplay; click/hover only)
  // =========================================================
  function HeroRow(items) {
    if (!items.length) return "";
    const t = items[0];
    const img = hero(t);
    const hasTrailer = !!t.trailerPlaybackId;
    const heroId = `hero_${t.id}`;
    const loggedIn = isLoggedIn();

    const viewHref = loggedIn
      ? `#/${t.type === "series" ? "series" : "title"}/${t.id}`
      : "#/login?mode=signup";
    const trailerHref = loggedIn
      ? `#/watch/${t.id}?kind=trailer`
      : "#/login?mode=signup";

    return `
      <section class="relative w-full overflow-hidden">
        <div id="${heroId}" class="aspect-video md:aspect-[21/9] bg-black relative">
          ${
            img
              ? `<img id="${heroId}_img" src="${esc(
                  img
                )}" class="w-full h-full object-cover opacity-90"/>`
              : ""
          }
          <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>

          ${
            hasTrailer
              ? `
            <button
              class="tv-focus absolute inset-0 flex items-center justify-center group"
              onclick="navTo('${trailerHref}')"
              data-hero-hover="${esc(t.trailerPlaybackId)}"
              aria-label="Play trailer preview"
            >
              <div class="w-16 h-16 md:w-20 md:h-20 rounded-full bg-black/60 border border-white/30 flex items-center justify-center text-3xl md:text-4xl group-hover:scale-105 transition">
                ▶
              </div>
            </button>
          `
              : ``
          }
        </div>

        <div class="absolute left-0 right-0 bottom-0 p-4 md:p-8">
          <div class="max-w-3xl space-y-2">
            <div class="text-xs uppercase tracking-widest text-watchGold/90">${typeLabel(
              t.type
            )}</div>
            <h1 class="text-2xl md:text-4xl font-black">${esc(
              t.title || "Untitled"
            )}</h1>
            <p class="text-white/80 line-clamp-3">${esc(
              t.synopsis || t.description || ""
            )}</p>

            <div class="flex flex-wrap gap-2 text-xs text-white/70">
              ${
                t.releaseYear
                  ? `<span class="px-2 py-1 rounded bg-white/10">${esc(
                      t.releaseYear
                    )}</span>`
                  : ""
              }
              ${
                toMins(t.runtimeMins)
                  ? `<span class="px-2 py-1 rounded bg-white/10">${toMins(
                      t.runtimeMins
                    )} mins</span>`
                  : ""
              }
              ${(t.genre || [])
                .slice(0, 4)
                .map(
                  (g) =>
                    `<span class="px-2 py-1 rounded bg-white/10">${esc(
                      g
                    )}</span>`
                )
                .join("")}
            </div>

            <div class="pt-2 flex gap-2">
              <button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
                onclick="navTo('${viewHref}')">${
                  loggedIn ? "View" : "Log in to View"
                }</button>

              ${
                hasTrailer
                  ? `
                <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20"
                  onclick="navTo('${trailerHref}')">${
                      loggedIn ? "Play Trailer" : "Log in to Watch"
                    }</button>
              `
                  : ""
              }
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function wireHeroHover() {
    if (isTV()) return;

    document.querySelectorAll("[data-hero-hover]").forEach((btn) => {
      const pb = btn.getAttribute("data-hero-hover");
      const container = btn.parentElement;
      if (!pb || !container) return;

      let previewEl = null;
      let timer = null;

      btn.addEventListener("mouseenter", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (previewEl) return;

          const imgEl = container.querySelector("img");
          if (imgEl) imgEl.classList.add("hidden");

          previewEl = document.createElement("mux-player");
          previewEl.setAttribute("stream-type", "on-demand");
          previewEl.setAttribute("playback-id", pb);
          previewEl.setAttribute("muted", "");
          previewEl.setAttribute("autoplay", "");
          previewEl.setAttribute("loop", "");
          previewEl.setAttribute("playsinline", "");
          previewEl.className =
            "absolute inset-0 w-full h-full object-cover opacity-90";

          container.insertBefore(previewEl, container.firstChild);
        }, 250);
      });

      btn.addEventListener("mouseleave", () => {
        if (timer) clearTimeout(timer);
        if (previewEl) {
          previewEl.remove();
          previewEl = null;
          const imgEl = container.querySelector("img");
          if (imgEl) imgEl.classList.remove("hidden");
        }
      });
    });
  }

  function CreditsBlock(t) {
    const actors =
      (t.actors || t.cast || []).join?.(", ") || t.actors || t.cast || "";
    const director = (t.director || t.directors || "").toString();
    const writers =
      (t.writers || t.writer || []).join?.(", ") ||
      t.writers ||
      t.writer ||
      "";
    const imdb = t.imdbRating || t.ratings?.imdb || "";
    const rt = t.rottenTomatoesRating || t.ratings?.rottenTomatoes || "";

    if (!actors && !director && !writers && !imdb && !rt) return "";
    return `
      <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        ${
          actors
            ? `<div><div class="text-xs text-white/60">Actors</div><div>${esc(
                actors
              )}</div></div>`
            : ""
        }
        ${
          director
            ? `<div><div class="text-xs text-white/60">Director</div><div>${esc(
                director
              )}</div></div>`
            : ""
        }
        ${
          writers
            ? `<div><div class="text-xs text-white/60">Writers</div><div>${esc(
                writers
              )}</div></div>`
            : ""
        }
        ${
          imdb || rt
            ? `
          <div class="flex gap-2 items-end">
            ${
              imdb
                ? `<span class="px-2 py-1 rounded bg-white/10 text-xs">IMDb: <b>${esc(
                    imdb
                  )}</b></span>`
                : ""
            }
            ${
              rt
                ? `<span class="px-2 py-1 rounded bg-white/10 text-xs">Rotten Tomatoes: <b>${esc(
                    rt
                  )}</b></span>`
                : ""
            }
          </div>`
            : ""
        }
      </div>
    `;
  }

  // =========================================================
  // HOME + TABS
  // =========================================================
  function HomePage() {
    const all = state.titles.slice();

    if (state.activeTab === "Home") {
      const featured = sortFeatured(featuredItems());
      const heroItems = (featured.length ? featured : all).slice(0, 1);

      const lastWatched = readLastWatched()
        .map((x) => state.byId.get(x.titleId))
        .filter(Boolean);

      const movies = all.filter(TAB_FILTERS.Movies);
      const series = all.filter(TAB_FILTERS.Series);
      const shorts = all.filter(TAB_FILTERS.Shorts);
      const foreign = all.filter(TAB_FILTERS.Foreign);

      return `
        ${HeroRow(heroItems)}
        <div class="py-6 space-y-2">
          ${
            lastWatched.length
              ? Row("Continue Watching", lastWatched.slice(0, 12))
              : ""
          }
          ${Row("Top Movies & Docs", movies.slice(0, 20), "Movies")}
          ${Row("Top Series", series.slice(0, 20), "Series")}
          ${Row("Top Shorts", shorts.slice(0, 20), "Shorts")}
          ${Row("Top Foreign", foreign.slice(0, 20), "Foreign")}
        </div>
      `;
    }

    const filtered = all.filter(TAB_FILTERS[state.activeTab] || (() => true));
    const heroItems = filtered.slice(0, 1);

    const byGenre = {};
    filtered.forEach((t) => {
      (t.genre || ["Featured"]).forEach((g) => {
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
      ${HeroRow(heroItems)}
      <div class="py-6 space-y-6">
        ${Row(`Top ${state.activeTab}`, filtered.slice(0, 20))}
        ${genreRows}
      </div>
    `;
  }

  // =========================================================
  // GATE PAGE (paywall)
  // =========================================================
  function GatePage() {
    return `
      <div class="min-h-[calc(100vh-64px)] flex flex-col items-center justify-center px-6 text-center bg-watchBlack">
        <div class="text-2xl md:text-3xl font-black mb-3">WatchVIM Members Only</div>
        <p class="text-white/70 max-w-md text-sm md:text-base mb-4">
          Create a free WatchVIM account or become a member to stream all movies, series, shorts, and our LIVE Loop Channel.
        </p>
        <div class="flex flex-col sm:flex-row gap-2">
          <button class="tv-focus px-5 py-2.5 rounded-lg bg-watchRed font-bold hover:opacity-90"
            onclick="navTo('#/login?mode=signup')">Become a Member</button>
          <button class="tv-focus px-5 py-2.5 rounded-lg bg-white/10 hover:bg-white/20"
            onclick="navTo('#/login?mode=login')">Log In</button>
        </div>
      </div>
    `;
  }

  // =========================================================
  // TITLE / SERIES / WATCH / SEARCH / LOGIN / LOOP
  // =========================================================
  function TitlePage(id) {
    const t = state.byId.get(id);
    if (!t) return NotFound("Title not found");

    const img = hero(t);
    const monet = t.monetization || {};
    const tvod = monet.tvod || {};
    const accessBadge = [
      monet.svod ? "SVOD" : null,
      monet.avod ? "AVOD" : null,
      tvod.enabled ? "TVOD" : null,
    ]
      .filter(Boolean)
      .join(" • ");

    return `
      <section class="relative">
        <div class="aspect-video bg-black">
          ${
            img
              ? `<img src="${esc(
                  img
                )}" class="w-full h-full object-cover opacity-90"/>`
              : ""
          }
          <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>
        </div>

        <div class="p-4 md:p-8 -mt-12 md:-mt-20 relative z-10">
          <div class="max-w-4xl space-y-3">
            <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>

            <div class="flex flex-wrap gap-2 text-xs text-white/70">
              <span class="px-2 py-1 rounded bg-white/10">${typeLabel(
                t.type
              )}</span>
              ${
                t.releaseYear
                  ? `<span class="px-2 py-1 rounded bg-white/10">${esc(
                      t.releaseYear
                    )}</span>`
                  : ""
              }
              ${
                toMins(t.runtimeMins)
                  ? `<span class="px-2 py-1 rounded bg-white/10">${toMins(
                      t.runtimeMins
                    )} mins</span>`
                  : ""
              }
              ${
                accessBadge
                  ? `<span class="px-2 py-1 rounded bg-watchGold/20 text-watchGold">${accessBadge}</span>`
                  : ""
              }
            </div>

            <h1 class="text-2xl md:text-4xl font-black">${esc(
              t.title || "Untitled"
            )}</h1>
            <p class="text-white/80">${esc(
              t.synopsis || t.description || ""
            )}</p>

            ${CreditsBlock(t)}

            <div class="flex flex-wrap gap-2 pt-2">
              ${
                t.trailerPlaybackId
                  ? `
                <button class="tv-focus px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20"
                  onclick="navTo('${isLoggedIn() ? `#/watch/${t.id}?kind=trailer` : "#/login?mode=signup"}')">${
                      isLoggedIn() ? "Play Trailer" : "Log in to Watch"
                    }</button>`
                  : ""
              }
              ${renderWatchCTA(t)}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderWatchCTA(t) {
    const monet = t.monetization || {};
    const tvod = monet.tvod || {};
    const loggedIn = isLoggedIn();

    // Global paywall: must be logged in to watch anything
    if (!loggedIn) {
      if (tvod.enabled) {
        return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold"
          onclick="navTo('#/login?mode=login')">Log in to Rent/Buy</button>`;
      }
      return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold"
        onclick="navTo('#/login?mode=signup')">Log in to Watch</button>`;
    }

    if (tvod.enabled && loggedIn) {
      return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
        onclick="startTVODCheckout('${t.id}')">Rent / Buy</button>`;
    }

    // Logged in, non-TVOD content
    return `<button class="tv-focus px-4 py-2 rounded-lg bg-watchRed font-bold hover:opacity-90"
      onclick="navTo('#/watch/${t.id}?kind=content')">Watch Now</button>`;
  }

  function SeriesPage(id) {
    const s = state.byId.get(id);
    if (!s || s.type !== "series") return NotFound("Series not found");
    const img = hero(s);

    return `
      <section class="relative">
        <div class="aspect-video bg-black">
          ${
            img
              ? `<img src="${esc(
                  img
                )}" class="w-full h-full object-cover opacity-90"/>`
              : ""
          }
          <div class="absolute inset-0 bg-gradient-to-t from-watchBlack via-watchBlack/40 to-transparent"></div>
        </div>

        <div class="p-4 md:p-8 -mt-12 md:-mt-20 relative z-10">
          <div class="max-w-5xl space-y-3">
            <button class="tv-focus text-xs text-white/70 hover:text-white" onclick="history.back()">← Back</button>
            <div class="text-xs uppercase tracking-widest text-watchGold/90">Series</div>
            <h1 class="text-2xl md:text
