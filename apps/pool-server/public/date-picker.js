/* loean 主题化日期选择器（替代浏览器原生日历弹层，浅色/深色随主题变量）。
 * 用法：new DatePickerController({ input, mode }) —— 自动替换原生日历；
 * 兼容 input[type=date] 与 input[type=datetime-local]，读写仍走 input.value（YYYY-MM-DD[THH:mm]）。
 */
(function () {
  const WD = ["一", "二", "三", "四", "五", "六", "日"];
  const pad = (n) => String(n).padStart(2, "0");

  /* 词表访问器：i18n.js 未加载时回退到传入的中文原文，保证单独引用本文件也不报错。 */
  const dp = (key, fallback) => (window.loeanI18n ? window.loeanI18n.t(key) : fallback);
  const dpLocale = () => (window.loeanI18n ? window.loeanI18n.locale() : "zh-CN");

  /* 星期表头与月份名走 Intl，避免为 12 个月和 7 个星期各写一条词表。 */
  function weekdayLabels() {
    const locale = dpLocale();
    if (locale === "zh-CN") return WD;
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    // 2024-01-01 是周一，据此取周一到周日
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }

  function monthLabel(index) {
    const locale = dpLocale();
    if (locale === "zh-CN") return (index + 1) + "月";
    return new Intl.DateTimeFormat(locale, { month: "short" }).format(new Date(2024, index, 1));
  }

  function ymd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function parseValue(v) {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return null;
    return {
      y: +m[1], mo: +m[2], d: +m[3],
      h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0,
      hasTime: !!m[4],
    };
  }

  /* 单例弹层：整页共用一个，随用随挂 */
  let panel = null;
  let active = null; // 当前 DatePickerController 实例

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "dp-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", dp("dp.aria.label", "选择日期"));
    panel.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-nav="prev" aria-label="${dp("dp.prev", "上个月")}">‹</button>
        <button type="button" class="dp-title" data-nav="title" aria-label="${dp("dp.chooseMonth", "选择月份")}"></button>
        <button type="button" class="dp-nav" data-nav="next" aria-label="${dp("dp.next", "下个月")}">›</button>
      </div>
      <div class="dp-grid" data-role="days"></div>
      <div class="dp-months" data-role="months" hidden></div>
      <div class="dp-foot">
        <button type="button" class="dp-act" data-act="clear">${dp("dp.clear", "清除")}</button>
        <span class="dp-foot-right">
          <button type="button" class="dp-act" data-act="now">${dp("dp.now", "此刻")}</button>
          <button type="button" class="dp-act strong" data-act="ok">${dp("dp.ok", "确定")}</button>
        </span>
      </div>`;
    document.body.appendChild(panel);

    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn || !active) return;
      const nav = btn.dataset.nav;
      const act = btn.dataset.act;
      if (nav === "prev") { active.view.setMonth(active.view.getMonth() - 1); active.renderGrid(); }
      else if (nav === "next") { active.view.setMonth(active.view.getMonth() + 1); active.renderGrid(); }
      else if (nav === "title") { active.toggleMonths(); }
      else if (act === "clear") { active.commit(null); }
      else if (act === "now") { active.view = new Date(); active.commit(active.mode === "datetime" ? active.view : null, true); }
      else if (act === "ok") { active.commit(); }
      else if (btn.dataset.month !== undefined) {
        active.view.setMonth(+btn.dataset.month);
        active.toggleMonths(false);
        active.renderGrid();
      }
    });

    document.addEventListener("pointerdown", (e) => {
      if (panel && !panel.hidden && active && !panel.contains(e.target) && e.target !== active.input) {
        active.close(false);
      }
    }, true);
    // 视口尺寸变化时重新锚定而不是关闭，避免初始化期的 resize 竞态误关弹层
    window.addEventListener("resize", () => {
      if (active && !panel.hidden) active.place();
    });
    document.addEventListener("scroll", () => {
      if (active && !panel.hidden) active.place();
    }, true);
    return panel;
  }

  class DatePickerController {
    constructor({ input, mode }) {
      this.input = input;
      this.mode = mode === "datetime" && input.type === "datetime-local" ? "datetime" : "date";
      ensurePanel();
      input.readOnly = true;              // 键盘输入改由弹层承担，避免触发原生日历
      input.style.caretColor = "transparent";
      input.classList.add("dp-input");
      input.addEventListener("click", (e) => { e.preventDefault(); this.open(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.open(); }
      });
    }

    open() {
      ensurePanel();
      if (active && active !== this) active.close(false);
      active = this;
      const cur = parseValue(this.input.value);
      this.view = cur ? new Date(cur.y, cur.mo - 1, cur.d) : new Date();
      this.draft = cur || null;
      this.renderGrid();
      this.place();
      panel.hidden = false;
    }

    close(commit) {
      if (commit) this.commit();
      panel.hidden = true;
      if (active === this) active = null;
    }

    place() {
      const r = this.input.getBoundingClientRect();
      panel.style.visibility = "hidden";
      panel.hidden = false;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const gap = 6;
      let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
      let top = r.bottom + gap;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - gap);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.visibility = "";
    }

    toggleMonths(force) {
      const m = panel.querySelector('[data-role="months"]');
      const show = force !== undefined ? force : m.hidden;
      if (show) {
        const y = this.view.getFullYear();
        m.innerHTML = `<div class="dp-year">${y}</div>` +
          Array.from({ length: 12 }, (_, i) =>
            `<button type="button" class="dp-month${i === this.view.getMonth() ? " cur" : ""}" data-month="${i}">${monthLabel(i)}</button>`).join("");
      }
      m.hidden = !show;
      panel.querySelector('[data-role="days"]').hidden = show;
    }

    renderGrid() {
      panel.querySelector(".dp-title").textContent = dpLocale() === "zh-CN"
        ? `${this.view.getFullYear()}年${pad(this.view.getMonth() + 1)}月`
        : new Intl.DateTimeFormat(dpLocale(), { year: "numeric", month: "long" })
            .format(new Date(this.view.getFullYear(), this.view.getMonth(), 1));
      const first = new Date(this.view.getFullYear(), this.view.getMonth(), 1);
      const startDow = (first.getDay() + 6) % 7; // 周一为首页
      const daysInMonth = new Date(this.view.getFullYear(), this.view.getMonth() + 1, 0).getDate();
      const daysPrev = new Date(this.view.getFullYear(), this.view.getMonth(), 0).getDate();
      const today = ymd(new Date());
      let html = weekdayLabels().map((w) => `<span class="dp-wd">${w}</span>`).join("");
      for (let i = startDow - 1; i >= 0; i--) {
        html += `<button type="button" class="dp-day out" data-d="${this.view.getFullYear()}-${pad(this.view.getMonth())}-${pad(daysPrev - i)}">${daysPrev - i}</button>`;
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${this.view.getFullYear()}-${pad(this.view.getMonth() + 1)}-${pad(d)}`;
        const cls = ["dp-day"];
        if (ds === today) cls.push("today");
        if (this.draft && ds === `${this.draft.y}-${pad(this.draft.mo)}-${pad(this.draft.d)}`) cls.push("sel");
        html += `<button type="button" class="${cls.join(" ")}" data-d="${ds}">${d}</button>`;
      }
      const rest = (7 - ((startDow + daysInMonth) % 7)) % 7;
      for (let d = 1; d <= rest; d++) {
        html += `<button type="button" class="dp-day out" data-d="${this.view.getFullYear()}-${pad(this.view.getMonth() + 2)}-${pad(d)}">${d}</button>`;
      }
      panel.querySelector('[data-role="days"]').innerHTML = html;
      panel.querySelector('[data-role="days"]').onclick = (e) => {
        const b = e.target.closest(".dp-day");
        if (!b || b.classList.contains("out")) { if (b) this.selectDay(b.dataset.d); return; }
        this.selectDay(b.dataset.d);
      };
    }

    selectDay(ds) {
      const cur = this.draft || parseValue(this.input.value) || { h: 0, mi: 0, hasTime: false };
      const [y, mo, d] = ds.split("-").map(Number);
      this.draft = { y, mo, d, h: cur.h || 0, mi: cur.mi || 0, hasTime: this.mode === "datetime" ? (cur.hasTime || true) : cur.hasTime };
      if (this.mode === "date") { this.commit(); return; }
      this.renderGrid();
    }

    commit(value, keepOpen) {
      if (value === null && arguments.length > 0) {
        this.input.value = "";
        this.input.dispatchEvent(new Event("change", { bubbles: true }));
        this.close(false);
        return;
      }
      const c = this.draft;
      if (!c) { this.close(false); return; }
      const timePart = this.mode === "datetime"
        ? `T${pad(c.h || 0)}:${pad(c.mi || 0)}`
        : "";
      this.input.value = `${c.y}-${pad(c.mo)}-${pad(c.d)}${timePart}`;
      this.input.dispatchEvent(new Event("change", { bubbles: true }));
      this.close(false);
      if (keepOpen) this.open();
    }
  }

  /* 自动接管：date / datetime-local 输入框初始化后自动挂控制器 */
  window.loeanDatePickers = {
    attach(input, mode) { return new DatePickerController({ input, mode }); },
    attachAll(root = document) {
      root.querySelectorAll('input[type="date"]').forEach((el) => new DatePickerController({ input: el, mode: "date" }));
      root.querySelectorAll('input[type="datetime-local"]').forEach((el) => new DatePickerController({ input: el, mode: "datetime" }));
    },
    /** 业务日「今天」（Asia/Shanghai 口径，与后端 BusinessTime 一致），返回 YYYY-MM-DD */
    today() {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      return parts; // en-CA 恰好输出 YYYY-MM-DD
    },
    /** 把筛选类日期输入框预填为业务日今天（不改 datetime 过期时间——空=永不过期） */
    presetToday(input) {
      if (!input || input.value) return input.value;
      input.value = this.today();
      return input.value;
    },
  };

  /* 面板是整页单例、只创建一次，标签在创建时就固化了；
     语言切换后需要重建，否则按钮仍停留在旧语言。 */
  document.addEventListener("loean:langchange", () => {
    if (!panel) return;
    const wasOpen = !panel.hidden;
    panel.remove();
    panel = null;
    if (wasOpen && active) {
      ensurePanel();
      active.renderGrid();
      panel.hidden = false;
      active.place();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => window.loeanDatePickers.attachAll());
  } else {
    window.loeanDatePickers.attachAll();
  }
})();
