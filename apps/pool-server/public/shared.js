/* 管理台/成员页/号池页共用的基础 helpers。
   挂在 window 上而不是顶层 const：各页面脚本（app.js 等）还有自己的
   顶层声明，顶层 const/let 会在全局词法环境里重名冲突。
   i18n.js 必须先于本文件加载。 */

window.$ = (selector) => document.querySelector(selector);

/* 词表访问器：i18n.js 未加载时回退到 key 本身，便于肉眼发现漏翻。
   所有面向用户的文案都必须走 t()，不要再写死中文字符串。 */
window.t = (key, params) => (window.loeanI18n ? window.loeanI18n.t(key, params) : key);
window.locale = () => (window.loeanI18n ? window.loeanI18n.locale() : "zh-CN");

/* 后端错误解析：优先用响应的 code + params 走词表（跟随语言），
   查不到码时回退响应里的 error 原文，最后才用本地兜底 key。 */
window.errorText = (body, fallbackKey, fallbackParams) =>
  (window.loeanI18n ? window.loeanI18n.errorText(body, fallbackKey, fallbackParams) : (body && body.error) || "");

window.escapeHtml = function (value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

/* 协议白名单：只有 http/https 才允许赋给 href。
   escapeHtml 只转义引号，拦不住 javascript: 等伪协议——
   后端返回的 URL 字符串要放进 <a href> 前必须先过这里。 */
window.safeHttpUrl = function (value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
};
