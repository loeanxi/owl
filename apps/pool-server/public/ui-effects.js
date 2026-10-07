/* loean Racing Green · UI effects (不动业务 API) */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasFinePointer = window.matchMedia("(pointer: fine)").matches;

  /* ── Cursor glow ── */
  if (!prefersReducedMotion && hasFinePointer) {
    const glow = document.createElement("div");
    glow.className = "cursor-glow";
    document.body.appendChild(glow);
    // Dark theme emits a green glow (screen); light theme lays a soft multiply
    // shade instead. Both need the same position tracking.
    let gx = window.innerWidth / 2;
    let gy = window.innerHeight / 2;
    let cx = gx;
    let cy = gy;
    let frameId = 0;

    document.addEventListener("pointermove", (e) => {
      gx = e.clientX;
      gy = e.clientY;
      document.body.classList.add("has-pointer");
      const t = e.target && e.target.closest ? e.target.closest(".nav-item,.btn,.kpi,.row-btn,.member-card") : null;
      if (t) {
        const r = t.getBoundingClientRect();
        t.style.setProperty("--mx", e.clientX - r.left + "px");
        t.style.setProperty("--my", e.clientY - r.top + "px");
      }
      if (!frameId) frameId = requestAnimationFrame(loop);
    }, { passive: true });

    function loop() {
      frameId = 0;
      cx += (gx - cx) * 0.18;
      cy += (gy - cy) * 0.18;
      glow.style.left = cx + "px";
      glow.style.top = cy + "px";
      frameId = requestAnimationFrame(loop);
    }
    loop();

    // 指针离开窗口后收起，避免在浅色下留一块静止的暗晕。
    document.addEventListener("pointerleave", () => {
      document.body.classList.remove("has-pointer");
    });
  }

  /* ── Living waveform ── */
  function makeWave(cv) {
    const ctx = cv.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;

    function resize() {
      // 按 canvas 自身的盒子定尺寸，而不是父元素。
      // .home-wave / .member-wave 是绝对定位在很大的容器里（.home-art / .member-hero），
      // 用父元素高度会把波形画在 30px 窄条之外，只剩边缘被裁进去的残影。
      // .spark 里 canvas 是 width/height:100%，自身盒子与父级一致，行为不变。
      const rect = cv.getBoundingClientRect();
      W = Math.max(1, Math.floor(rect.width || cv.clientWidth));
      H = Math.max(1, Math.floor(rect.height || cv.clientHeight));
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);
    let colors = readWaveColors();
    let lightTheme = document.documentElement.dataset.theme === "light";
    window.addEventListener("loean:themechange", () => {
      colors = readWaveColors();
      lightTheme = document.documentElement.dataset.theme === "light";
      if (prefersReducedMotion) frame(performance.now());
    });

    function yAt(x, t) {
      let n =
        Math.sin(x * 0.018 + t * 1.6) * 0.45 +
        Math.sin(x * 0.041 - t * 1.1) * 0.28 +
        Math.sin(x * 0.007 + t * 0.55) * 0.35 +
        Math.sin(x * 0.09 + t * 2.4) * 0.08;
      n += Math.sin(x * 0.12 + t * 3) * Math.pow(Math.max(0, Math.sin(t * 2.8)), 8) * 0.55;
      return H * 0.5 + n * H * (lightTheme ? 0.16 : 0.28);
    }

    function frame(now) {
      const t = now * 0.001;
      ctx.clearRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(0.5, colors.fill);
      grad.addColorStop(1, "transparent");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      function strokePath(width, alpha, blur) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 2) {
          const y = yAt(x + t * 40, t);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = colors.stroke;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.shadowBlur = blur || 0;
        ctx.shadowColor = colors.shadow;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (lightTheme) {
        strokePath(1.25, 0.68, 0);
      } else {
        strokePath(5, 0.15, 12);
        strokePath(1.8, 0.9, 8);
      }
      ctx.shadowBlur = 0;
      if (!prefersReducedMotion) requestAnimationFrame(frame);
    }
    frame(performance.now());
  }

  function readWaveColors() {
    const styles = getComputedStyle(document.documentElement);
    return {
      fill: styles.getPropertyValue("--wave-fill").trim() || "rgba(47,158,90,0.12)",
      stroke: styles.getPropertyValue("--wave-stroke").trim() || "rgb(94,207,130)",
      shadow: styles.getPropertyValue("--wave-shadow").trim() || "rgba(47,158,90,0.65)",
    };
  }

  document.querySelectorAll(".wave-canvas").forEach(makeWave);

  /* ── 首页艺术板：鼠标视差（Idea 4）──
     指针在面板附近移动时，用 --px/--py 驱动各层不同幅度的位移，制造极浅纵深。
     位移压到 ±4px：再大就从"有空间感"变成"廉价 3D 卡片"。
     只在细指针设备上启用；reduced-motion 时完全不写变量，各层保持静止。 */
  function initArtParallax() {
    const art = $(".home-art");
    if (!art || prefersReducedMotion || !hasFinePointer) return;

    const MAX = 4;
    let raf = 0;
    let tx = 0, ty = 0;   // 目标
    let x = 0, y = 0;     // 当前（缓动后）

    function apply() {
      raf = 0;
      x += (tx - x) * 0.12;
      y += (ty - y) * 0.12;
      art.style.setProperty("--px", x.toFixed(2) + "px");
      art.style.setProperty("--py", y.toFixed(2) + "px");
      // 收敛后停下，避免长期占用一帧
      if (Math.abs(tx - x) > 0.01 || Math.abs(ty - y) > 0.01) {
        raf = requestAnimationFrame(apply);
      }
    }
    function kick() { if (!raf) raf = requestAnimationFrame(apply); }

    art.addEventListener("pointermove", (e) => {
      const r = art.getBoundingClientRect();
      // 相对面板中心的归一化偏移（-1 ~ 1），超出面板也继续但会夹住
      const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
      tx = -nx * MAX;
      ty = -ny * MAX;
      kick();
    }, { passive: true });

    // 指针离开后回到正中
    art.addEventListener("pointerleave", () => {
      tx = 0; ty = 0; kick();
    });
  }
  initArtParallax();

  /* ── 首页艺术板：首次进入才播放「写出来」（Idea 5）──
     与左上角品牌字的 brand-rewrite 同一套书写语言。
     用 sessionStorage 记住：同一次会话内刷新不再重放，否则每秒都在重写会很烦。 */
  (function initArtWriteOn() {
    const art = $(".home-art");
    if (!art || prefersReducedMotion) return;
    let seen = false;
    try { seen = sessionStorage.getItem("loean-hero-written") === "1"; } catch (e) { seen = false; }
    if (seen) return;
    art.classList.add("is-first-visit");
    try { sessionStorage.setItem("loean-hero-written", "1"); } catch (e) { /* 忽略隐私模式 */ }
    // 动画播完摘掉 class，避免 clip-path 长期留在元素上
    window.setTimeout(() => art.classList.remove("is-first-visit"), 2600);
  })();

  /* ── Gateway status: only show measurements backed by the current APIs ── */
  function setStatusBar(selector, pct) {
    const el = $(selector);
    if (!el) return;
    const value = Math.max(0, Math.min(100, pct));
    el.style.width = value + "%";
    el.classList.toggle("err", value > 0 && value < 30);
    el.classList.toggle("warn", value >= 30 && value < 70);
  }

  async function getGatewayData(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("网关状态请求失败");
    const body = await response.json();
    if (body.success === false || !body.data) throw new Error("网关状态不可用");
    return body.data;
  }

  let statusRefreshing = false;
  async function refreshStatusBay() {
    if (statusRefreshing) return;
    statusRefreshing = true;
    try {
      const [statusResult, usageResult] = await Promise.allSettled([
        getGatewayData("/api/gateway/status"),
        getGatewayData("/api/gateway/usage?limit=50"),
      ]);

      const dot = $("#gateway-live-dot");
      const poolValue = $("#g-pool-v");
      if (statusResult.status === "fulfilled") {
        const status = statusResult.value;
        const enabled = status.enabled === true;
        if (dot) {
          dot.classList.toggle("off", !enabled);
          dot.setAttribute("aria-label", enabled ? "网关已启用" : "网关已停用");
        }
        const accounts = status.pool?.accounts;
        if (Array.isArray(accounts)) {
          const total = accounts.length;
          const available = enabled ? accounts.filter((a) => a.enabled === true && a.cooling !== true).length : 0;
          if (poolValue) poolValue.textContent = `${available}/${total}`;
          setStatusBar("#g-pool-bar", total ? available / total * 100 : 0);
        } else {
          if (poolValue) poolValue.textContent = "—";
          setStatusBar("#g-pool-bar", 0);
        }
      } else {
        if (dot) {
          dot.classList.add("off");
          dot.setAttribute("aria-label", "状态未知");
        }
        if (poolValue) poolValue.textContent = "—";
        setStatusBar("#g-pool-bar", 0);
      }

      const latencyValue = $("#g-lat-v");
      const rateValue = $("#g-rate-v");
      if (usageResult.status === "fulfilled") {
        const usage = usageResult.value;
        const latencies = (Array.isArray(usage.items) ? usage.items : [])
          .filter((row) => String(row.status).toUpperCase() === "OK")
          .map((row) => Number(row.latencyMs))
          .filter((latency) => Number.isFinite(latency) && latency > 0);
        if (latencyValue) {
          latencyValue.textContent = latencies.length
            ? `${Math.round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length).toLocaleString("zh-CN")} ms`
            : "—";
        }
        const calls = Number(usage.summary?.calls);
        const fails = Number(usage.summary?.fails);
        const rate = Number.isFinite(calls) && Number.isFinite(fails) && calls > 0
          ? Math.max(0, Math.min(100, (calls - fails) / calls * 100))
          : null;
        if (rateValue) rateValue.textContent = rate === null ? "—" : `${Math.round(rate)}%`;
        setStatusBar("#g-rate-bar", rate ?? 0);
      } else {
        if (latencyValue) latencyValue.textContent = "—";
        if (rateValue) rateValue.textContent = "—";
        setStatusBar("#g-rate-bar", 0);
      }
    } finally {
      statusRefreshing = false;
    }
  }

  // The member page shares the visual script but must never request administrator-only status endpoints.
  if ($("#gateway-live-dot")) {
    refreshStatusBay();
    setInterval(refreshStatusBay, 15000);
  }

  /* ── KPI count-up on first meaningful paint ── */
  const counted = new WeakSet();

  function animateValue(el) {
    if (!el || counted.has(el)) return;
    const raw = (el.textContent || "").trim();
    if (!raw || raw === "0" || raw === "—" || raw.includes("—")) return;
    counted.add(el);
    if (prefersReducedMotion) return;

    const m = raw.match(/^([\d.,]+)(.*)$/);
    if (!m) return;
    const suffix = m[2] || "";
    const numText = m[1].replace(/,/g, "");
    const target = parseFloat(numText);
    if (!isFinite(target) || target <= 0) return;

    const compact = /[KkMm]$/.test(suffix) || raw.includes("K") || raw.includes("M");
    const dur = 900;
    const t0 = performance.now();

    function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = target * eased;
      el.textContent = compact
        ? (v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "K" : Math.round(v) + suffix)
        : (m[1].includes(",") ? Math.round(v).toLocaleString("en-US") : String(Math.round(v))) + suffix;
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = raw;
    }
    requestAnimationFrame(frame);
  }

  const kpiObserver = new MutationObserver((list) => {
    list.forEach((rec) => {
      if (rec.type === "characterData" || rec.type === "childList") {
        animateValue(rec.target.nodeType === 3 ? rec.target.parentElement : rec.target);
      }
    });
  });

  document.querySelectorAll(".kpi-value, .member-metric-value, .member-hero-value").forEach((el) => {
    kpiObserver.observe(el, { childList: true, characterData: true, subtree: true });
    animateValue(el);
  });
})();
