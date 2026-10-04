var AT = (e, t) => () => (t || e((t = { exports: {} }).exports, t), t.exports);
var RI = AT((nr, ir) => {
  (function() {
    const t = document.createElement("link").relList;
    if (t && t.supports && t.supports("modulepreload")) return;
    for (const a of document.querySelectorAll('link[rel="modulepreload"]')) o(a);
    new MutationObserver((a) => {
      for (const s of a) if (s.type === "childList") for (const c of s.addedNodes) c.tagName === "LINK" && c.rel === "modulepreload" && o(c);
    }).observe(document, { childList: true, subtree: true });
    function n(a) {
      const s = {};
      return a.integrity && (s.integrity = a.integrity), a.referrerPolicy && (s.referrerPolicy = a.referrerPolicy), a.crossOrigin === "use-credentials" ? s.credentials = "include" : a.crossOrigin === "anonymous" ? s.credentials = "omit" : s.credentials = "same-origin", s;
    }
    function o(a) {
      if (a.ep) return;
      a.ep = true;
      const s = n(a);
      fetch(a.href, s);
    }
  })();
  /*! @license DOMPurify 3.4.8 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.8/LICENSE */
  function ah(e, t) {
    (t == null || t > e.length) && (t = e.length);
    for (var n = 0, o = Array(t); n < t; n++) o[n] = e[n];
    return o;
  }
  function CT(e) {
    if (Array.isArray(e)) return e;
  }
  function TT(e, t) {
    var n = e == null ? null : typeof Symbol < "u" && e[Symbol.iterator] || e["@@iterator"];
    if (n != null) {
      var o, a, s, c, u = [], f = true, m = false;
      try {
        if (s = (n = n.call(e)).next, t !== 0) for (; !(f = (o = s.call(n)).done) && (u.push(o.value), u.length !== t); f = true) ;
      } catch (h) {
        m = true, a = h;
      } finally {
        try {
          if (!f && n.return != null && (c = n.return(), Object(c) !== c)) return;
        } finally {
          if (m) throw a;
        }
      }
      return u;
    }
  }
  function ET() {
    throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`);
  }
  function kT(e, t) {
    return CT(e) || TT(e, t) || zT(e, t) || ET();
  }
  function zT(e, t) {
    if (e) {
      if (typeof e == "string") return ah(e, t);
      var n = {}.toString.call(e).slice(8, -1);
      return n === "Object" && e.constructor && (n = e.constructor.name), n === "Map" || n === "Set" ? Array.from(e) : n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n) ? ah(e, t) : void 0;
    }
  }
  const by = Object.entries, sh = Object.setPrototypeOf, DT = Object.isFrozen, MT = Object.getPrototypeOf, LT = Object.getOwnPropertyDescriptor;
  let bn = Object.freeze, oi = Object.seal, Yo = Object.create, _y = typeof Reflect < "u" && Reflect, cd = _y.apply, ud = _y.construct;
  bn || (bn = function(t) {
    return t;
  });
  oi || (oi = function(t) {
    return t;
  });
  cd || (cd = function(t, n) {
    for (var o = arguments.length, a = new Array(o > 2 ? o - 2 : 0), s = 2; s < o; s++) a[s - 2] = arguments[s];
    return t.apply(n, a);
  });
  ud || (ud = function(t) {
    for (var n = arguments.length, o = new Array(n > 1 ? n - 1 : 0), a = 1; a < n; a++) o[a - 1] = arguments[a];
    return new t(...o);
  });
  const Gr = Wt(Array.prototype.forEach), xT = Wt(Array.prototype.lastIndexOf), lh = Wt(Array.prototype.pop), jo = Wt(Array.prototype.push), OT = Wt(Array.prototype.splice), mn = Array.isArray, Fa = Wt(String.prototype.toLowerCase), xu = Wt(String.prototype.toString), ch = Wt(String.prototype.match), Ho = Wt(String.prototype.replace), uh = Wt(String.prototype.indexOf), PT = Wt(String.prototype.trim), IT = Wt(Number.prototype.toString), RT = Wt(Boolean.prototype.toString), dh = typeof BigInt > "u" ? null : Wt(BigInt.prototype.toString), fh = typeof Symbol > "u" ? null : Wt(Symbol.prototype.toString), Lt = Wt(Object.prototype.hasOwnProperty), Da = Wt(Object.prototype.toString), Qt = Wt(RegExp.prototype.test), Vo = FT(TypeError);
  function Wt(e) {
    return function(t) {
      t instanceof RegExp && (t.lastIndex = 0);
      for (var n = arguments.length, o = new Array(n > 1 ? n - 1 : 0), a = 1; a < n; a++) o[a - 1] = arguments[a];
      return cd(e, t, o);
    };
  }
  function FT(e) {
    return function() {
      for (var t = arguments.length, n = new Array(t), o = 0; o < t; o++) n[o] = arguments[o];
      return ud(e, n);
    };
  }
  function He(e, t) {
    let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : Fa;
    if (sh && sh(e, null), !mn(t)) return e;
    let o = t.length;
    for (; o--; ) {
      let a = t[o];
      if (typeof a == "string") {
        const s = n(a);
        s !== a && (DT(t) || (t[o] = s), a = s);
      }
      e[a] = true;
    }
    return e;
  }
  function NT(e) {
    for (let t = 0; t < e.length; t++) Lt(e, t) || (e[t] = null);
    return e;
  }
  function nn(e) {
    const t = Yo(null);
    for (const o of by(e)) {
      var n = kT(o, 2);
      const a = n[0], s = n[1];
      Lt(e, a) && (mn(s) ? t[a] = NT(s) : s && typeof s == "object" && s.constructor === Object ? t[a] = nn(s) : t[a] = s);
    }
    return t;
  }
  function WT(e) {
    switch (typeof e) {
      case "string":
        return e;
      case "number":
        return IT(e);
      case "boolean":
        return RT(e);
      case "bigint":
        return dh ? dh(e) : "0";
      case "symbol":
        return fh ? fh(e) : "Symbol()";
      case "undefined":
        return Da(e);
      case "function":
      case "object": {
        if (e === null) return Da(e);
        const t = e, n = Mi(t, "toString");
        if (typeof n == "function") {
          const o = n(t);
          return typeof o == "string" ? o : Da(o);
        }
        return Da(e);
      }
      default:
        return Da(e);
    }
  }
  function Mi(e, t) {
    for (; e !== null; ) {
      const o = LT(e, t);
      if (o) {
        if (o.get) return Wt(o.get);
        if (typeof o.value == "function") return Wt(o.value);
      }
      e = MT(e);
    }
    function n() {
      return null;
    }
    return n;
  }
  function BT(e) {
    try {
      return Qt(e, ""), true;
    } catch {
      return false;
    }
  }
  const ph = bn(["a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "big", "blink", "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite", "code", "col", "colgroup", "content", "data", "datalist", "dd", "decorator", "del", "details", "dfn", "dialog", "dir", "div", "dl", "dt", "element", "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "map", "mark", "marquee", "menu", "menuitem", "meter", "nav", "nobr", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select", "shadow", "slot", "small", "source", "spacer", "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "tr", "track", "tt", "u", "ul", "var", "video", "wbr"]), Ou = bn(["svg", "a", "altglyph", "altglyphdef", "altglyphitem", "animatecolor", "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc", "ellipse", "enterkeyhint", "exportparts", "filter", "font", "g", "glyph", "glyphref", "hkern", "image", "inputmode", "line", "lineargradient", "marker", "mask", "metadata", "mpath", "part", "path", "pattern", "polygon", "polyline", "radialgradient", "rect", "stop", "style", "switch", "symbol", "text", "textpath", "title", "tref", "tspan", "view", "vkern"]), Pu = bn(["feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"]), UT = bn(["animate", "color-profile", "cursor", "discard", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "foreignobject", "hatch", "hatchpath", "mesh", "meshgradient", "meshpatch", "meshrow", "missing-glyph", "script", "set", "solidcolor", "unknown", "use"]), Iu = bn(["math", "menclose", "merror", "mfenced", "mfrac", "mglyph", "mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msup", "msubsup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "mprescripts"]), jT = bn(["maction", "maligngroup", "malignmark", "mlongdiv", "mscarries", "mscarry", "msgroup", "mstack", "msline", "msrow", "semantics", "annotation", "annotation-xml", "mprescripts", "none"]), mh = bn(["#text"]), hh = bn(["accept", "action", "align", "alt", "autocapitalize", "autocomplete", "autopictureinpicture", "autoplay", "background", "bgcolor", "border", "capture", "cellpadding", "cellspacing", "checked", "cite", "class", "clear", "color", "cols", "colspan", "command", "commandfor", "controls", "controlslist", "coords", "crossorigin", "datetime", "decoding", "default", "dir", "disabled", "disablepictureinpicture", "disableremoteplayback", "download", "draggable", "enctype", "enterkeyhint", "exportparts", "face", "for", "headers", "height", "hidden", "high", "href", "hreflang", "id", "inert", "inputmode", "integrity", "ismap", "kind", "label", "lang", "list", "loading", "loop", "low", "max", "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "name", "nonce", "noshade", "novalidate", "nowrap", "open", "optimum", "part", "pattern", "placeholder", "playsinline", "popover", "popovertarget", "popovertargetaction", "poster", "preload", "pubdate", "radiogroup", "readonly", "rel", "required", "rev", "reversed", "role", "rows", "rowspan", "spellcheck", "scope", "selected", "shape", "size", "sizes", "slot", "span", "srclang", "start", "src", "srcset", "step", "style", "summary", "tabindex", "title", "translate", "type", "usemap", "valign", "value", "width", "wrap", "xmlns"]), Ru = bn(["accent-height", "accumulate", "additive", "alignment-baseline", "amplitude", "ascent", "attributename", "attributetype", "azimuth", "basefrequency", "baseline-shift", "begin", "bias", "by", "class", "clip", "clippathunits", "clip-path", "clip-rule", "color", "color-interpolation", "color-interpolation-filters", "color-profile", "color-rendering", "cx", "cy", "d", "dx", "dy", "diffuseconstant", "direction", "display", "divisor", "dur", "edgemode", "elevation", "end", "exponent", "fill", "fill-opacity", "fill-rule", "filter", "filterunits", "flood-color", "flood-opacity", "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "fx", "fy", "g1", "g2", "glyph-name", "glyphref", "gradientunits", "gradienttransform", "height", "href", "id", "image-rendering", "in", "in2", "intercept", "k", "k1", "k2", "k3", "k4", "kerning", "keypoints", "keysplines", "keytimes", "lang", "lengthadjust", "letter-spacing", "kernelmatrix", "kernelunitlength", "lighting-color", "local", "marker-end", "marker-mid", "marker-start", "markerheight", "markerunits", "markerwidth", "maskcontentunits", "maskunits", "max", "mask", "mask-type", "media", "method", "mode", "min", "name", "numoctaves", "offset", "operator", "opacity", "order", "orient", "orientation", "origin", "overflow", "paint-order", "path", "pathlength", "patterncontentunits", "patterntransform", "patternunits", "points", "preservealpha", "preserveaspectratio", "primitiveunits", "r", "rx", "ry", "radius", "refx", "refy", "repeatcount", "repeatdur", "restart", "result", "rotate", "scale", "seed", "shape-rendering", "slope", "specularconstant", "specularexponent", "spreadmethod", "startoffset", "stddeviation", "stitchtiles", "stop-color", "stop-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke", "stroke-width", "style", "surfacescale", "systemlanguage", "tabindex", "tablevalues", "targetx", "targety", "transform", "transform-origin", "text-anchor", "text-decoration", "text-rendering", "textlength", "type", "u1", "u2", "unicode", "values", "viewbox", "visibility", "version", "vert-adv-y", "vert-origin-x", "vert-origin-y", "width", "word-spacing", "wrap", "writing-mode", "xchannelselector", "ychannelselector", "x", "x1", "x2", "xmlns", "y", "y1", "y2", "z", "zoomandpan"]), gh = bn(["accent", "accentunder", "align", "bevelled", "close", "columnalign", "columnlines", "columnspacing", "columnspan", "denomalign", "depth", "dir", "display", "displaystyle", "encoding", "fence", "frame", "height", "href", "id", "largeop", "length", "linethickness", "lquote", "lspace", "mathbackground", "mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "movablelimits", "notation", "numalign", "open", "rowalign", "rowlines", "rowspacing", "rowspan", "rspace", "rquote", "scriptlevel", "scriptminsize", "scriptsizemultiplier", "selection", "separator", "separators", "stretchy", "subscriptshift", "supscriptshift", "symmetric", "voffset", "width", "xmlns"]), yl = bn(["xlink:href", "xml:id", "xlink:title", "xml:space", "xmlns:xlink"]), HT = oi(/{{[\w\W]*|^[\w\W]*}}/g), VT = oi(/<%[\w\W]*|^[\w\W]*%>/g), qT = oi(/\${[\w\W]*/g), $T = oi(/^data-[\-\w.\u00B7-\uFFFF]+$/), GT = oi(/^aria-[\-\w]+$/), yh = oi(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i), KT = oi(/^(?:\w+script|data):/i), YT = oi(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g), ZT = oi(/^html$/i), QT = oi(/^[a-z][.\w]*(-[.\w]+)+$/i), ki = { element: 1, attribute: 2, text: 3, cdataSection: 4, entityReference: 5, entityNode: 6, progressingInstruction: 7, comment: 8, document: 9, documentType: 10, documentFragment: 11, notation: 12 }, JT = function() {
    return typeof window > "u" ? null : window;
  }, XT = function(t, n) {
    if (typeof t != "object" || typeof t.createPolicy != "function") return null;
    let o = null;
    const a = "data-tt-policy-suffix";
    n && n.hasAttribute(a) && (o = n.getAttribute(a));
    const s = "dompurify" + (o ? "#" + o : "");
    try {
      return t.createPolicy(s, { createHTML(c) {
        return c;
      }, createScriptURL(c) {
        return c;
      } });
    } catch {
      return console.warn("TrustedTypes policy " + s + " could not be created."), null;
    }
  }, vh = function() {
    return { afterSanitizeAttributes: [], afterSanitizeElements: [], afterSanitizeShadowDOM: [], beforeSanitizeAttributes: [], beforeSanitizeElements: [], beforeSanitizeShadowDOM: [], uponSanitizeAttribute: [], uponSanitizeElement: [], uponSanitizeShadowNode: [] };
  };
  function Ay() {
    let e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : JT();
    const t = (_e) => Ay(_e);
    if (t.version = "3.4.8", t.removed = [], !e || !e.document || e.document.nodeType !== ki.document || !e.Element) return t.isSupported = false, t;
    let n = e.document;
    const o = n, a = o.currentScript;
    e.DocumentFragment;
    const s = e.HTMLTemplateElement, c = e.Node, u = e.Element, f = e.NodeFilter, m = e.NamedNodeMap;
    m === void 0 && (e.NamedNodeMap || e.MozNamedAttrMap), e.HTMLFormElement;
    const h = e.DOMParser, v = e.trustedTypes, C = u.prototype, D = Mi(C, "cloneNode"), W = Mi(C, "remove"), E = Mi(C, "nextSibling"), L = Mi(C, "childNodes"), b = Mi(C, "parentNode"), P = Mi(C, "shadowRoot"), B = Mi(C, "attributes"), k = c && c.prototype ? Mi(c.prototype, "nodeType") : null, j = c && c.prototype ? Mi(c.prototype, "nodeName") : null;
    if (typeof s == "function") {
      const _e = n.createElement("template");
      _e.content && _e.content.ownerDocument && (n = _e.content.ownerDocument);
    }
    let $, q = "", ue = 0;
    const ee = function(A) {
      if (ue > 0) throw Vo('The configured TRUSTED_TYPES_POLICY.createHTML must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose createHTML wraps DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.');
      ue++;
      try {
        return $.createHTML(A);
      } finally {
        ue--;
      }
    }, se = n, le = se.implementation, re = se.createNodeIterator, Ee = se.createDocumentFragment, fe = se.getElementsByTagName, ce = o.importNode;
    let G = vh();
    t.isSupported = typeof by == "function" && typeof b == "function" && le && le.createHTMLDocument !== void 0;
    const oe = HT, ie = VT, pe = qT, we = $T, Te = GT, ke = KT, tt = YT, Me = QT;
    let it = yh, Re = null;
    const ft = He({}, [...ph, ...Ou, ...Pu, ...Iu, ...mh]);
    let Ie = null;
    const pt = He({}, [...hh, ...Ru, ...gh, ...yl]);
    let be = Object.seal(Yo(null, { tagNameCheck: { writable: true, configurable: false, enumerable: true, value: null }, attributeNameCheck: { writable: true, configurable: false, enumerable: true, value: null }, allowCustomizedBuiltInElements: { writable: true, configurable: false, enumerable: true, value: false } })), Ae = null, _ = null;
    const z = Object.seal(Yo(null, { tagCheck: { writable: true, configurable: false, enumerable: true, value: null }, attributeCheck: { writable: true, configurable: false, enumerable: true, value: null } }));
    let U = true, Y = true, J = false, X = true, w = false, S = true, x = false, N = false, de = false, Z = false, O = false, H = false, ge = true, ze = false;
    const Fe = "user-content-";
    let Ke = true, Qe = false, Et = {}, vt = null;
    const In = He({}, ["annotation-xml", "audio", "colgroup", "desc", "foreignobject", "head", "iframe", "math", "mi", "mn", "mo", "ms", "mtext", "noembed", "noframes", "noscript", "plaintext", "script", "style", "svg", "template", "thead", "title", "video", "xmp"]);
    let Fi = null;
    const Nt = He({}, ["audio", "video", "img", "source", "image", "track"]);
    let qt = null;
    const Ni = He({}, ["alt", "class", "for", "id", "label", "name", "pattern", "placeholder", "role", "summary", "title", "value", "style", "xmlns"]), si = "http://www.w3.org/1998/Math/MathML", vo = "http://www.w3.org/2000/svg", $n = "http://www.w3.org/1999/xhtml";
    let pr = $n, wo = false, So = null;
    const gc = He({}, [si, vo, $n], xu);
    let ua = He({}, ["mi", "mo", "mn", "ms", "mtext"]), da = He({}, ["annotation-xml"]);
    const yc = He({}, ["title", "style", "font", "a", "script"]);
    let mr = null;
    const vc = ["application/xhtml+xml", "text/html"], wc = "text/html";
    let kt = null, _i = null;
    const Sc = n.createElement("form"), bo = function(A) {
      return A instanceof RegExp || A instanceof Function;
    }, fa = function() {
      let A = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
      if (_i && _i === A) return;
      (!A || typeof A != "object") && (A = {}), A = nn(A), mr = vc.indexOf(A.PARSER_MEDIA_TYPE) === -1 ? wc : A.PARSER_MEDIA_TYPE, kt = mr === "application/xhtml+xml" ? xu : Fa, Re = Lt(A, "ALLOWED_TAGS") && mn(A.ALLOWED_TAGS) ? He({}, A.ALLOWED_TAGS, kt) : ft, Ie = Lt(A, "ALLOWED_ATTR") && mn(A.ALLOWED_ATTR) ? He({}, A.ALLOWED_ATTR, kt) : pt, So = Lt(A, "ALLOWED_NAMESPACES") && mn(A.ALLOWED_NAMESPACES) ? He({}, A.ALLOWED_NAMESPACES, xu) : gc, qt = Lt(A, "ADD_URI_SAFE_ATTR") && mn(A.ADD_URI_SAFE_ATTR) ? He(nn(Ni), A.ADD_URI_SAFE_ATTR, kt) : Ni, Fi = Lt(A, "ADD_DATA_URI_TAGS") && mn(A.ADD_DATA_URI_TAGS) ? He(nn(Nt), A.ADD_DATA_URI_TAGS, kt) : Nt, vt = Lt(A, "FORBID_CONTENTS") && mn(A.FORBID_CONTENTS) ? He({}, A.FORBID_CONTENTS, kt) : In, Ae = Lt(A, "FORBID_TAGS") && mn(A.FORBID_TAGS) ? He({}, A.FORBID_TAGS, kt) : nn({}), _ = Lt(A, "FORBID_ATTR") && mn(A.FORBID_ATTR) ? He({}, A.FORBID_ATTR, kt) : nn({}), Et = Lt(A, "USE_PROFILES") ? A.USE_PROFILES && typeof A.USE_PROFILES == "object" ? nn(A.USE_PROFILES) : A.USE_PROFILES : false, U = A.ALLOW_ARIA_ATTR !== false, Y = A.ALLOW_DATA_ATTR !== false, J = A.ALLOW_UNKNOWN_PROTOCOLS || false, X = A.ALLOW_SELF_CLOSE_IN_ATTR !== false, w = A.SAFE_FOR_TEMPLATES || false, S = A.SAFE_FOR_XML !== false, x = A.WHOLE_DOCUMENT || false, Z = A.RETURN_DOM || false, O = A.RETURN_DOM_FRAGMENT || false, H = A.RETURN_TRUSTED_TYPE || false, de = A.FORCE_BODY || false, ge = A.SANITIZE_DOM !== false, ze = A.SANITIZE_NAMED_PROPS || false, Ke = A.KEEP_CONTENT !== false, Qe = A.IN_PLACE || false, it = BT(A.ALLOWED_URI_REGEXP) ? A.ALLOWED_URI_REGEXP : yh, pr = typeof A.NAMESPACE == "string" ? A.NAMESPACE : $n, ua = Lt(A, "MATHML_TEXT_INTEGRATION_POINTS") && A.MATHML_TEXT_INTEGRATION_POINTS && typeof A.MATHML_TEXT_INTEGRATION_POINTS == "object" ? nn(A.MATHML_TEXT_INTEGRATION_POINTS) : He({}, ["mi", "mo", "mn", "ms", "mtext"]), da = Lt(A, "HTML_INTEGRATION_POINTS") && A.HTML_INTEGRATION_POINTS && typeof A.HTML_INTEGRATION_POINTS == "object" ? nn(A.HTML_INTEGRATION_POINTS) : He({}, ["annotation-xml"]);
      const Q = Lt(A, "CUSTOM_ELEMENT_HANDLING") && A.CUSTOM_ELEMENT_HANDLING && typeof A.CUSTOM_ELEMENT_HANDLING == "object" ? nn(A.CUSTOM_ELEMENT_HANDLING) : Yo(null);
      if (be = Yo(null), Lt(Q, "tagNameCheck") && bo(Q.tagNameCheck) && (be.tagNameCheck = Q.tagNameCheck), Lt(Q, "attributeNameCheck") && bo(Q.attributeNameCheck) && (be.attributeNameCheck = Q.attributeNameCheck), Lt(Q, "allowCustomizedBuiltInElements") && typeof Q.allowCustomizedBuiltInElements == "boolean" && (be.allowCustomizedBuiltInElements = Q.allowCustomizedBuiltInElements), w && (Y = false), O && (Z = true), Et && (Re = He({}, mh), Ie = Yo(null), Et.html === true && (He(Re, ph), He(Ie, hh)), Et.svg === true && (He(Re, Ou), He(Ie, Ru), He(Ie, yl)), Et.svgFilters === true && (He(Re, Pu), He(Ie, Ru), He(Ie, yl)), Et.mathMl === true && (He(Re, Iu), He(Ie, gh), He(Ie, yl))), z.tagCheck = null, z.attributeCheck = null, Lt(A, "ADD_TAGS") && (typeof A.ADD_TAGS == "function" ? z.tagCheck = A.ADD_TAGS : mn(A.ADD_TAGS) && (Re === ft && (Re = nn(Re)), He(Re, A.ADD_TAGS, kt))), Lt(A, "ADD_ATTR") && (typeof A.ADD_ATTR == "function" ? z.attributeCheck = A.ADD_ATTR : mn(A.ADD_ATTR) && (Ie === pt && (Ie = nn(Ie)), He(Ie, A.ADD_ATTR, kt))), Lt(A, "ADD_URI_SAFE_ATTR") && mn(A.ADD_URI_SAFE_ATTR) && He(qt, A.ADD_URI_SAFE_ATTR, kt), Lt(A, "FORBID_CONTENTS") && mn(A.FORBID_CONTENTS) && (vt === In && (vt = nn(vt)), He(vt, A.FORBID_CONTENTS, kt)), Lt(A, "ADD_FORBID_CONTENTS") && mn(A.ADD_FORBID_CONTENTS) && (vt === In && (vt = nn(vt)), He(vt, A.ADD_FORBID_CONTENTS, kt)), Ke && (Re["#text"] = true), x && He(Re, ["html", "head", "body"]), Re.table && (He(Re, ["tbody"]), delete Ae.tbody), A.TRUSTED_TYPES_POLICY) {
        if (typeof A.TRUSTED_TYPES_POLICY.createHTML != "function") throw Vo('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
        if (typeof A.TRUSTED_TYPES_POLICY.createScriptURL != "function") throw Vo('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
        const me = $;
        $ = A.TRUSTED_TYPES_POLICY;
        try {
          q = ee("");
        } catch (nt) {
          throw $ = me, nt;
        }
      } else $ === void 0 && A.TRUSTED_TYPES_POLICY !== null && ($ = XT(v, a)), $ && typeof q == "string" && (q = ee(""));
      (G.uponSanitizeElement.length > 0 || G.uponSanitizeAttribute.length > 0) && Re === ft && (Re = nn(Re)), G.uponSanitizeAttribute.length > 0 && Ie === pt && (Ie = nn(Ie)), bn && bn(A), _i = A;
    }, Cs = He({}, [...Ou, ...Pu, ...UT]), Ts = He({}, [...Iu, ...jT]), bc = function(A) {
      let Q = b(A);
      (!Q || !Q.tagName) && (Q = { namespaceURI: pr, tagName: "template" });
      const me = Fa(A.tagName), nt = Fa(Q.tagName);
      return So[A.namespaceURI] ? A.namespaceURI === vo ? Q.namespaceURI === $n ? me === "svg" : Q.namespaceURI === si ? me === "svg" && (nt === "annotation-xml" || ua[nt]) : !!Cs[me] : A.namespaceURI === si ? Q.namespaceURI === $n ? me === "math" : Q.namespaceURI === vo ? me === "math" && da[nt] : !!Ts[me] : A.namespaceURI === $n ? Q.namespaceURI === vo && !da[nt] || Q.namespaceURI === si && !ua[nt] ? false : !Ts[me] && (yc[me] || !Cs[me]) : !!(mr === "application/xhtml+xml" && So[A.namespaceURI]) : false;
    }, Rn = function(A) {
      jo(t.removed, { element: A });
      try {
        b(A).removeChild(A);
      } catch {
        W(A);
      }
    }, Ai = function(A, Q) {
      try {
        jo(t.removed, { attribute: Q.getAttributeNode(A), from: Q });
      } catch {
        jo(t.removed, { attribute: null, from: Q });
      }
      if (Q.removeAttribute(A), A === "is") if (Z || O) try {
        Rn(Q);
      } catch {
      }
      else try {
        Q.setAttribute(A, "");
      } catch {
      }
    }, Es = function(A) {
      let Q = null, me = null;
      if (de) A = "<remove></remove>" + A;
      else {
        const ut = ch(A, /^[\r\n\t ]+/);
        me = ut && ut[0];
      }
      mr === "application/xhtml+xml" && pr === $n && (A = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + A + "</body></html>");
      const nt = $ ? ee(A) : A;
      if (pr === $n) try {
        Q = new h().parseFromString(nt, mr);
      } catch {
      }
      if (!Q || !Q.documentElement) {
        Q = le.createDocument(pr, "template", null);
        try {
          Q.documentElement.innerHTML = wo ? q : nt;
        } catch {
        }
      }
      const Ue = Q.body || Q.documentElement;
      return A && me && Ue.insertBefore(n.createTextNode(me), Ue.childNodes[0] || null), pr === $n ? fe.call(Q, x ? "html" : "body")[0] : x ? Q.documentElement : Ue;
    }, ks = function(A) {
      return re.call(A.ownerDocument || A, A, f.SHOW_ELEMENT | f.SHOW_COMMENT | f.SHOW_TEXT | f.SHOW_PROCESSING_INSTRUCTION | f.SHOW_CDATA_SECTION, null);
    }, _o = function(A) {
      var Q, me;
      A.normalize();
      const nt = re.call(A.ownerDocument || A, A, f.SHOW_TEXT | f.SHOW_COMMENT | f.SHOW_CDATA_SECTION | f.SHOW_PROCESSING_INSTRUCTION, null);
      let Ue = nt.nextNode();
      for (; Ue; ) {
        let Pt = Ue.data;
        Gr([oe, ie, pe], (cn) => {
          Pt = Ho(Pt, cn, " ");
        }), Ue.data = Pt, Ue = nt.nextNode();
      }
      const ut = (Q = (me = A.querySelectorAll) === null || me === void 0 ? void 0 : me.call(A, "template")) !== null && Q !== void 0 ? Q : [];
      Gr(Array.from(ut), (Pt) => {
        hr(Pt.content) && _o(Pt.content);
      });
    }, Ao = function(A) {
      const Q = j ? j(A) : null;
      return typeof Q != "string" || kt(Q) !== "form" ? false : typeof A.nodeName != "string" || typeof A.textContent != "string" || typeof A.removeChild != "function" || A.attributes !== B(A) || typeof A.removeAttribute != "function" || typeof A.setAttribute != "function" || typeof A.namespaceURI != "string" || typeof A.insertBefore != "function" || typeof A.hasChildNodes != "function" || A.nodeType !== k(A) || A.childNodes !== L(A);
    }, hr = function(A) {
      if (!k || typeof A != "object" || A === null) return false;
      try {
        return k(A) === ki.documentFragment;
      } catch {
        return false;
      }
    }, Co = function(A) {
      if (!k || typeof A != "object" || A === null) return false;
      try {
        return typeof k(A) == "number";
      } catch {
        return false;
      }
    };
    function li(_e, A, Q) {
      Gr(_e, (me) => {
        me.call(t, A, Q, _i);
      });
    }
    const zs = function(A) {
      let Q = null;
      if (li(G.beforeSanitizeElements, A, null), Ao(A)) return Rn(A), true;
      const me = kt(j ? j(A) : A.nodeName);
      if (li(G.uponSanitizeElement, A, { tagName: me, allowedTags: Re }), S && A.hasChildNodes() && !Co(A.firstElementChild) && Qt(/<[/\w!]/g, A.innerHTML) && Qt(/<[/\w!]/g, A.textContent) || S && A.namespaceURI === $n && me === "style" && Co(A.firstElementChild) || A.nodeType === ki.progressingInstruction || S && A.nodeType === ki.comment && Qt(/<[/\w]/g, A.data)) return Rn(A), true;
      if (Ae[me] || !(z.tagCheck instanceof Function && z.tagCheck(me)) && !Re[me]) {
        if (!Ae[me] && Ms(me) && (be.tagNameCheck instanceof RegExp && Qt(be.tagNameCheck, me) || be.tagNameCheck instanceof Function && be.tagNameCheck(me))) return false;
        if (Ke && !vt[me]) {
          const Ue = b(A), ut = L(A);
          if (ut && Ue) {
            const Pt = ut.length;
            for (let cn = Pt - 1; cn >= 0; --cn) {
              const An = D(ut[cn], true);
              Ue.insertBefore(An, E(A));
            }
          }
        }
        return Rn(A), true;
      }
      return (k ? k(A) : A.nodeType) === ki.element && !bc(A) || (me === "noscript" || me === "noembed" || me === "noframes") && Qt(/<\/no(script|embed|frames)/i, A.innerHTML) ? (Rn(A), true) : (w && A.nodeType === ki.text && (Q = A.textContent, Gr([oe, ie, pe], (Ue) => {
        Q = Ho(Q, Ue, " ");
      }), A.textContent !== Q && (jo(t.removed, { element: A.cloneNode() }), A.textContent = Q)), li(G.afterSanitizeElements, A, null), false);
    }, Ds = function(A, Q, me) {
      if (_[Q] || ge && (Q === "id" || Q === "name") && (me in n || me in Sc)) return false;
      const nt = Ie[Q] || z.attributeCheck instanceof Function && z.attributeCheck(Q, A);
      if (!(Y && !_[Q] && Qt(we, Q))) {
        if (!(U && Qt(Te, Q))) {
          if (!nt || _[Q]) {
            if (!(Ms(A) && (be.tagNameCheck instanceof RegExp && Qt(be.tagNameCheck, A) || be.tagNameCheck instanceof Function && be.tagNameCheck(A)) && (be.attributeNameCheck instanceof RegExp && Qt(be.attributeNameCheck, Q) || be.attributeNameCheck instanceof Function && be.attributeNameCheck(Q, A)) || Q === "is" && be.allowCustomizedBuiltInElements && (be.tagNameCheck instanceof RegExp && Qt(be.tagNameCheck, me) || be.tagNameCheck instanceof Function && be.tagNameCheck(me)))) return false;
          } else if (!qt[Q]) {
            if (!Qt(it, Ho(me, tt, ""))) {
              if (!((Q === "src" || Q === "xlink:href" || Q === "href") && A !== "script" && uh(me, "data:") === 0 && Fi[A])) {
                if (!(J && !Qt(ke, Ho(me, tt, "")))) {
                  if (me) return false;
                }
              }
            }
          }
        }
      }
      return true;
    }, To = He({}, ["annotation-xml", "color-profile", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "missing-glyph"]), Ms = function(A) {
      return !To[Fa(A)] && Qt(Me, A);
    }, Fr = function(A) {
      li(G.beforeSanitizeAttributes, A, null);
      const Q = A.attributes;
      if (!Q || Ao(A)) return;
      const me = { attrName: "", attrValue: "", keepAttr: true, allowedAttributes: Ie, forceKeepAttr: void 0 };
      let nt = Q.length;
      for (; nt--; ) {
        const Ue = Q[nt], ut = Ue.name, Pt = Ue.namespaceURI, cn = Ue.value, An = kt(ut), ko = cn;
        let Dt = ut === "value" ? ko : PT(ko);
        if (me.attrName = An, me.attrValue = Dt, me.keepAttr = true, me.forceKeepAttr = void 0, li(G.uponSanitizeAttribute, A, me), Dt = me.attrValue, ze && (An === "id" || An === "name") && uh(Dt, Fe) !== 0 && (Ai(ut, A), Dt = Fe + Dt), S && Qt(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, Dt)) {
          Ai(ut, A);
          continue;
        }
        if (An === "attributename" && ch(Dt, "href")) {
          Ai(ut, A);
          continue;
        }
        if (me.forceKeepAttr) continue;
        if (!me.keepAttr) {
          Ai(ut, A);
          continue;
        }
        if (!X && Qt(/\/>/i, Dt)) {
          Ai(ut, A);
          continue;
        }
        w && Gr([oe, ie, pe], (pa) => {
          Dt = Ho(Dt, pa, " ");
        });
        const Ls = kt(A.nodeName);
        if (!Ds(Ls, An, Dt)) {
          Ai(ut, A);
          continue;
        }
        if ($ && typeof v == "object" && typeof v.getAttributeType == "function" && !Pt) switch (v.getAttributeType(Ls, An)) {
          case "TrustedHTML": {
            Dt = ee(Dt);
            break;
          }
          case "TrustedScriptURL": {
            Dt = $.createScriptURL(Dt);
            break;
          }
        }
        if (Dt !== ko) try {
          Pt ? A.setAttributeNS(Pt, ut, Dt) : A.setAttribute(ut, Dt), Ao(A) ? Rn(A) : lh(t.removed);
        } catch {
          Ai(ut, A);
        }
      }
      li(G.afterSanitizeAttributes, A, null);
    }, Eo = function(A) {
      let Q = null;
      const me = ks(A);
      for (li(G.beforeSanitizeShadowDOM, A, null); Q = me.nextNode(); ) if (li(G.uponSanitizeShadowNode, Q, null), zs(Q), Fr(Q), hr(Q.content) && Eo(Q.content), (k ? k(Q) : Q.nodeType) === ki.element) {
        const Ue = P ? P(Q) : Q.shadowRoot;
        hr(Ue) && (gr(Ue), Eo(Ue));
      }
      li(G.afterSanitizeShadowDOM, A, null);
    }, gr = function(A) {
      const Q = k ? k(A) : A.nodeType;
      if (Q === ki.element) {
        const Ue = P ? P(A) : A.shadowRoot;
        hr(Ue) && (gr(Ue), Eo(Ue));
      }
      const me = L ? L(A) : A.childNodes;
      if (!me) return;
      const nt = [];
      Gr(me, (Ue) => {
        jo(nt, Ue);
      });
      for (const Ue of nt) gr(Ue);
      if (Q === ki.element) {
        const Ue = j ? j(A) : null;
        if (typeof Ue == "string" && kt(Ue) === "template") {
          const ut = A.content;
          hr(ut) && gr(ut);
        }
      }
    };
    return t.sanitize = function(_e) {
      let A = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {}, Q = null, me = null, nt = null, Ue = null;
      if (wo = !_e, wo && (_e = "<!-->"), typeof _e != "string" && !Co(_e) && (_e = WT(_e), typeof _e != "string")) throw Vo("dirty is not a string, aborting");
      if (!t.isSupported) return _e;
      if (N || fa(A), t.removed = [], typeof _e == "string" && (Qe = false), Qe) {
        const cn = j ? j(_e) : _e.nodeName;
        if (typeof cn == "string") {
          const An = kt(cn);
          if (!Re[An] || Ae[An]) throw Vo("root node is forbidden and cannot be sanitized in-place");
        }
        if (Ao(_e)) throw Vo("root node is clobbered and cannot be sanitized in-place");
        gr(_e);
      } else if (Co(_e)) Q = Es("<!---->"), me = Q.ownerDocument.importNode(_e, true), me.nodeType === ki.element && me.nodeName === "BODY" || me.nodeName === "HTML" ? Q = me : Q.appendChild(me), gr(me);
      else {
        if (!Z && !w && !x && _e.indexOf("<") === -1) return $ && H ? ee(_e) : _e;
        if (Q = Es(_e), !Q) return Z ? null : H ? q : "";
      }
      Q && de && Rn(Q.firstChild);
      const ut = ks(Qe ? _e : Q);
      for (; nt = ut.nextNode(); ) zs(nt), Fr(nt), hr(nt.content) && Eo(nt.content);
      if (Qe) return w && _o(_e), _e;
      if (Z) {
        if (w && _o(Q), O) for (Ue = Ee.call(Q.ownerDocument); Q.firstChild; ) Ue.appendChild(Q.firstChild);
        else Ue = Q;
        return (Ie.shadowroot || Ie.shadowrootmode) && (Ue = ce.call(o, Ue, true)), Ue;
      }
      let Pt = x ? Q.outerHTML : Q.innerHTML;
      return x && Re["!doctype"] && Q.ownerDocument && Q.ownerDocument.doctype && Q.ownerDocument.doctype.name && Qt(ZT, Q.ownerDocument.doctype.name) && (Pt = "<!DOCTYPE " + Q.ownerDocument.doctype.name + `>
` + Pt), w && Gr([oe, ie, pe], (cn) => {
        Pt = Ho(Pt, cn, " ");
      }), $ && H ? ee(Pt) : Pt;
    }, t.setConfig = function() {
      let _e = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
      fa(_e), N = true;
    }, t.clearConfig = function() {
      _i = null, N = false;
    }, t.isValidAttribute = function(_e, A, Q) {
      _i || fa({});
      const me = kt(_e), nt = kt(A);
      return Ds(me, nt, Q);
    }, t.addHook = function(_e, A) {
      typeof A == "function" && jo(G[_e], A);
    }, t.removeHook = function(_e, A) {
      if (A !== void 0) {
        const Q = xT(G[_e], A);
        return Q === -1 ? void 0 : OT(G[_e], Q, 1)[0];
      }
      return lh(G[_e]);
    }, t.removeHooks = function(_e) {
      G[_e] = [];
    }, t.removeAllHooks = function() {
      G = vh();
    }, t;
  }
  var eE = Ay();
  const dd = "__pc_driver_store_watcher_listener_id__";
  function tE() {
    try {
      return window.sessionStorage.getItem(dd);
    } catch {
      return null;
    }
  }
  function Fu(e) {
    try {
      e ? window.sessionStorage.setItem(dd, e) : window.sessionStorage.removeItem(dd);
    } catch {
    }
  }
  class nE {
    constructor() {
      this.listenerId = null, this.isWatching = false, this.callbacks = /* @__PURE__ */ new Map(), this.debugMode = false, this.retryCount = 0, this.maxRetries = 3, this.retryDelay = 1e3, this.batchUpdates = /* @__PURE__ */ new Map(), this.batchTimer = null, this.batchDelay = 50, this.autoReconnect = true, this.reconnecting = false, this.boundHandleStoreChange = this.handleStoreChange.bind(this);
    }
    async start(t = {}) {
      if (this.isWatching) return this.log("warn", "Store 监听器已在运行"), true;
      this.debugMode = t.debug || false, this.maxRetries = t.maxRetries || 3, this.retryDelay = t.retryDelay || 1e3;
      try {
        window.electronAPI.removeEventListener("storeChange", "storeWatcher");
        const n = tE();
        if (n) try {
          await window.electronAPI.unwatchAllStore(n);
        } catch (a) {
          this.log("debug", `启动前清理残留监听失败: ${a.message}`);
        }
        const o = await window.electronAPI.watchAllStore();
        return o.success ? (this.listenerId = o.listenerId, this.isWatching = true, this.retryCount = 0, Fu(this.listenerId), window.electronAPI.addEventListener("storeChange", "storeWatcher", this.boundHandleStoreChange), this.log("info", `主进程 Store 监听器已启动，监听器ID: ${this.listenerId}`), true) : (this.log("error", `启动 Store 监听器失败: ${o.error}`), false);
      } catch (n) {
        return this.log("error", `启动 Store 监听器出错: ${n.message}`), await this.handleRetry("start");
      }
    }
    async stop(t = false) {
      if (!this.isWatching || !this.listenerId) {
        Fu(null);
        return;
      }
      try {
        this.batchTimer && (clearTimeout(this.batchTimer), this.batchTimer = null), window.electronAPI.removeEventListener("storeChange", "storeWatcher");
        try {
          await window.electronAPI.unwatchAllStore(this.listenerId);
        } catch (n) {
          this.log("debug", `停止监听时出错（可能窗口已销毁）: ${n.message}`);
        }
        this.isWatching = false, this.listenerId = null, Fu(null), t && this.callbacks.clear(), this.batchUpdates.clear(), this.log("info", "主进程 Store 监听器已停止");
      } catch (n) {
        this.log("error", `停止 Store 监听器出错: ${n.message}`);
      }
    }
    async restart(t = {}) {
      if (this.reconnecting) return this.log("warn", "正在重连中，跳过重复请求"), false;
      this.reconnecting = true;
      try {
        this.isWatching && await this.stop(false), await new Promise((o) => setTimeout(o, 100));
        const n = await this.start(t);
        return n && this.log("info", "Store 监听器已成功重启"), n;
      } catch (n) {
        return this.log("error", `重启 Store 监听器出错: ${n.message}`), false;
      } finally {
        this.reconnecting = false;
      }
    }
    async set(t, n, o = false, a = false) {
      try {
        if (a) return this.addToBatch("set", t, n, o);
        const s = await window.electronAPI.setStore(t, n, o);
        return s.success ? (this.log("debug", `设置 Store 数据成功 [${t}]:`, n), s) : this.autoReconnect && !this.isWatching && s.error && (s.error.includes("destroyed") || s.error === "renderer-unloading") && (this.log("warn", `检测到连接断开，尝试自动重连 [${t}]`), await this.restart()) ? await this.set(t, n, o, a) : (this.log("error", `设置 Store 数据失败 [${t}]: ${s.error}`), s);
      } catch (s) {
        return this.log("error", `设置 Store 数据出错 [${t}]: ${s.message}`), { success: false, error: s.message };
      }
    }
    async get(t, n = null) {
      try {
        const o = await window.electronAPI.getStore(t, n);
        return o.success ? (this.log("debug", `获取 Store 数据成功 [${t}]:`, o.value), o) : (this.log("error", `获取 Store 数据失败 [${t}]: ${o.error}`), o);
      } catch (o) {
        return this.log("error", `获取 Store 数据出错 [${t}]: ${o.message}`), { success: false, error: o.message };
      }
    }
    async has(t) {
      try {
        const n = await window.electronAPI.hasStore(t);
        return n.success ? (this.log("debug", `检查 Store 数据存在 [${t}]: ${n.exists}`), n) : (this.log("error", `检查 Store 数据失败 [${t}]: ${n.error}`), n);
      } catch (n) {
        return this.log("error", `检查 Store 数据出错 [${t}]: ${n.message}`), { success: false, error: n.message };
      }
    }
    async delete(t, n = false) {
      try {
        if (n) return this.addToBatch("delete", t);
        const o = await window.electronAPI.deleteStore(t);
        return o.success ? (this.log("debug", `删除 Store 数据成功 [${t}]`), o) : (this.log("error", `删除 Store 数据失败 [${t}]: ${o.error}`), o);
      } catch (o) {
        return this.log("error", `删除 Store 数据出错 [${t}]: ${o.message}`), { success: false, error: o.message };
      }
    }
    async clear() {
      try {
        const t = await window.electronAPI.clearStore();
        return t.success ? (this.log("info", `清空 Store 数据成功，清除了 ${t.clearedKeys.length} 项`), t) : (this.log("error", `清空 Store 数据失败: ${t.error}`), t);
      } catch (t) {
        return this.log("error", `清空 Store 数据出错: ${t.message}`), { success: false, error: t.message };
      }
    }
    async getAll() {
      try {
        const t = await window.electronAPI.getAllStore();
        return this.log("debug", "获取所有 Store 数据成功:", t), { success: true, value: t };
      } catch (t) {
        return this.log("error", `获取所有 Store 数据出错: ${t.message}`), { success: false, error: t.message };
      }
    }
    async batchSet(t) {
      try {
        const n = [];
        for (const o of t) if (o.type === "set") {
          const a = await this.set(o.key, o.value, o.persistent || false);
          n.push({ key: o.key, result: a });
        } else if (o.type === "delete") {
          const a = await this.delete(o.key);
          n.push({ key: o.key, result: a });
        }
        return this.log("info", `批量操作完成，处理了 ${n.length} 项操作`), { success: true, results: n };
      } catch (n) {
        return this.log("error", `批量操作出错: ${n.message}`), { success: false, error: n.message };
      }
    }
    addToBatch(t, n, o, a) {
      return this.batchUpdates.set(n, { type: t, value: o, persistent: a }), this.batchTimer && clearTimeout(this.batchTimer), this.batchTimer = setTimeout(() => {
        this.flushBatch();
      }, this.batchDelay), Promise.resolve({ success: true, batched: true });
    }
    async flushBatch() {
      if (this.batchUpdates.size === 0) return;
      const t = Array.from(this.batchUpdates.entries()).map(([n, o]) => ({ type: o.type, key: n, value: o.value, persistent: o.persistent }));
      return this.batchUpdates.clear(), this.batchTimer = null, await this.batchSet(t);
    }
    watch(t, n) {
      this.callbacks.has(t) || this.callbacks.set(t, []);
      const o = this.callbacks.get(t);
      return o.includes(n) ? (this.log("debug", `跳过重复监听器 [${t}]`), () => {
        this.unwatch(t, n);
      }) : (o.push(n), this.log("debug", `已添加监听器 [${t}]`), () => {
        this.unwatch(t, n);
      });
    }
    unwatch(t, n) {
      if (this.callbacks.has(t)) {
        const o = this.callbacks.get(t), a = o.indexOf(n);
        a > -1 && (o.splice(a, 1), this.log("debug", `已移除监听器 [${t}]`)), o.length === 0 && this.callbacks.delete(t);
      }
    }
    unwatchAll(t) {
      this.callbacks.has(t) && (this.callbacks.delete(t), this.log("debug", `已移除 [${t}] 下所有监听器`));
    }
    handleStoreChange(t) {
      const { changeData: n } = t, { key: o, value: a, oldValue: s } = n;
      this.log("debug", `Store 变化 [${o}]:`, { newValue: a, oldValue: s }), this.callbacks.has(o) && this.callbacks.get(o).forEach((c) => {
        try {
          c(a, s, o);
        } catch (u) {
          this.log("error", `Store 监听器回调执行错误 [${o}]: ${u.message}`);
        }
      }), this.callbacks.has("*") && this.callbacks.get("*").forEach((c) => {
        try {
          c(n);
        } catch (u) {
          this.log("error", `Store 全局监听器回调执行错误: ${u.message}`);
        }
      });
    }
    watchAll(t) {
      return this.watch("*", t);
    }
    async handleRetry(t) {
      if (this.retryCount < this.maxRetries) {
        if (this.retryCount += 1, this.log("warn", `操作失败，${this.retryDelay}ms 后进行第 ${this.retryCount} 次重试`), await new Promise((n) => setTimeout(n, this.retryDelay)), t === "start") return await this.start();
      } else this.log("error", `操作失败，已达到最大重试次数 ${this.maxRetries}`);
      return false;
    }
    log(t, n, ...o) {
      if (!this.debugMode && t === "debug") return;
      const a = `[主进程Store监听 ${(/* @__PURE__ */ new Date()).toISOString()}]`;
      switch (t) {
        case "debug":
          console.debug(a, n, ...o);
          break;
        case "info":
          console.info(a, n, ...o);
          break;
        case "warn":
          console.warn(a, n, ...o);
          break;
        case "error":
          console.error(a, n, ...o);
          break;
        default:
          console.log(a, n, ...o);
          break;
      }
    }
    setDebugMode(t) {
      this.debugMode = t, this.log("info", `调试模式已${t ? "启用" : "禁用"}`);
    }
  }
  const zn = new nE();
  function Cy() {
    return { startWatching: async (D = {}) => await zn.start({ ...D, debug: false }), stopWatching: async (D = false) => {
      await zn.stop(D);
    }, restartWatching: async (D = {}) => await zn.restart(D), watchKey: (D, W) => zn.watch(D, W), watchAll: (D) => zn.watchAll(D), setData: async (D, W, E = false, L = false) => await zn.set(D, W, E, L), getData: async (D, W = null) => await zn.get(D, W), hasData: async (D) => await zn.has(D), deleteData: async (D, W = false) => await zn.delete(D, W), clearData: async () => await zn.clear(), getAllData: async () => await zn.getAll(), batchSetData: async (D) => await zn.batchSet(D), setDebugMode: (D) => {
      zn.setDebugMode(D);
    }, isWatching: () => zn.isWatching };
  }
  /**
  * @vue/shared v3.5.35
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **/
  function Qd(e) {
    const t = /* @__PURE__ */ Object.create(null);
    for (const n of e.split(",")) t[n] = 1;
    return (n) => n in t;
  }
  const yt = {}, ea = [], gi = () => {
  }, Ty = () => false, ql = (e) => e.charCodeAt(0) === 111 && e.charCodeAt(1) === 110 && (e.charCodeAt(2) > 122 || e.charCodeAt(2) < 97), $l = (e) => e.startsWith("onUpdate:"), Vt = Object.assign, Jd = (e, t) => {
    const n = e.indexOf(t);
    n > -1 && e.splice(n, 1);
  }, iE = Object.prototype.hasOwnProperty, et = (e, t) => iE.call(e, t), xe = Array.isArray, ta = (e) => us(e) === "[object Map]", Ey = (e) => us(e) === "[object Set]", wh = (e) => us(e) === "[object Date]", Pe = (e) => typeof e == "function", ht = (e) => typeof e == "string", qn = (e) => typeof e == "symbol", ot = (e) => e !== null && typeof e == "object", ky = (e) => (ot(e) || Pe(e)) && Pe(e.then) && Pe(e.catch), zy = Object.prototype.toString, us = (e) => zy.call(e), rE = (e) => us(e).slice(8, -1), Dy = (e) => us(e) === "[object Object]", Gl = (e) => ht(e) && e !== "NaN" && e[0] !== "-" && "" + parseInt(e, 10) === e, Ua = Qd(",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"), Kl = (e) => {
    const t = /* @__PURE__ */ Object.create(null);
    return (n) => t[n] || (t[n] = e(n));
  }, oE = /-\w/g, wn = Kl((e) => e.replace(oE, (t) => t.slice(1).toUpperCase())), aE = /\B([A-Z])/g, po = Kl((e) => e.replace(aE, "-$1").toLowerCase()), Yl = Kl((e) => e.charAt(0).toUpperCase() + e.slice(1)), Nu = Kl((e) => e ? `on${Yl(e)}` : ""), Pi = (e, t) => !Object.is(e, t), Wu = (e, ...t) => {
    for (let n = 0; n < e.length; n++) e[n](...t);
  }, My = (e, t, n, o = false) => {
    Object.defineProperty(e, t, { configurable: true, enumerable: false, writable: o, value: n });
  }, sE = (e) => {
    const t = parseFloat(e);
    return isNaN(t) ? e : t;
  }, lE = (e) => {
    const t = ht(e) ? Number(e) : NaN;
    return isNaN(t) ? e : t;
  };
  let Sh;
  const Zl = () => Sh || (Sh = typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : typeof window < "u" ? window : typeof global < "u" ? global : {});
  function ds(e) {
    if (xe(e)) {
      const t = {};
      for (let n = 0; n < e.length; n++) {
        const o = e[n], a = ht(o) ? fE(o) : ds(o);
        if (a) for (const s in a) t[s] = a[s];
      }
      return t;
    } else if (ht(e) || ot(e)) return e;
  }
  const cE = /;(?![^(]*\))/g, uE = /:([^]+)/, dE = /\/\*[^]*?\*\//g;
  function fE(e) {
    const t = {};
    return e.replace(dE, "").split(cE).forEach((n) => {
      if (n) {
        const o = n.split(uE);
        o.length > 1 && (t[o[0].trim()] = o[1].trim());
      }
    }), t;
  }
  function mi(e) {
    let t = "";
    if (ht(e)) t = e;
    else if (xe(e)) for (let n = 0; n < e.length; n++) {
      const o = mi(e[n]);
      o && (t += o + " ");
    }
    else if (ot(e)) for (const n in e) e[n] && (t += n + " ");
    return t.trim();
  }
  const pE = "itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly", mE = Qd(pE);
  function Ly(e) {
    return !!e || e === "";
  }
  function hE(e, t) {
    if (e.length !== t.length) return false;
    let n = true;
    for (let o = 0; n && o < e.length; o++) n = Xd(e[o], t[o]);
    return n;
  }
  function Xd(e, t) {
    if (e === t) return true;
    let n = wh(e), o = wh(t);
    if (n || o) return n && o ? e.getTime() === t.getTime() : false;
    if (n = qn(e), o = qn(t), n || o) return e === t;
    if (n = xe(e), o = xe(t), n || o) return n && o ? hE(e, t) : false;
    if (n = ot(e), o = ot(t), n || o) {
      if (!n || !o) return false;
      const a = Object.keys(e).length, s = Object.keys(t).length;
      if (a !== s) return false;
      for (const c in e) {
        const u = e.hasOwnProperty(c), f = t.hasOwnProperty(c);
        if (u && !f || !u && f || !Xd(e[c], t[c])) return false;
      }
    }
    return String(e) === String(t);
  }
  const xy = (e) => !!(e && e.__v_isRef === true), ef = (e) => ht(e) ? e : e == null ? "" : xe(e) || ot(e) && (e.toString === zy || !Pe(e.toString)) ? xy(e) ? ef(e.value) : JSON.stringify(e, Oy, 2) : String(e), Oy = (e, t) => xy(t) ? Oy(e, t.value) : ta(t) ? { [`Map(${t.size})`]: [...t.entries()].reduce((n, [o, a], s) => (n[Bu(o, s) + " =>"] = a, n), {}) } : Ey(t) ? { [`Set(${t.size})`]: [...t.values()].map((n) => Bu(n)) } : qn(t) ? Bu(t) : ot(t) && !xe(t) && !Dy(t) ? String(t) : t, Bu = (e, t = "") => {
    var n;
    return qn(e) ? `Symbol(${(n = e.description) != null ? n : t})` : e;
  };
  /**
  * @vue/reactivity v3.5.35
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **/
  let jt;
  class Py {
    constructor(t = false) {
      this.detached = t, this._active = true, this._on = 0, this.effects = [], this.cleanups = [], this._isPaused = false, this._warnOnRun = true, this.__v_skip = true, !t && jt && (jt.active ? (this.parent = jt, this.index = (jt.scopes || (jt.scopes = [])).push(this) - 1) : (this._active = false, this._warnOnRun = false));
    }
    get active() {
      return this._active;
    }
    pause() {
      if (this._active) {
        this._isPaused = true;
        let t, n;
        if (this.scopes) for (t = 0, n = this.scopes.length; t < n; t++) this.scopes[t].pause();
        for (t = 0, n = this.effects.length; t < n; t++) this.effects[t].pause();
      }
    }
    resume() {
      if (this._active && this._isPaused) {
        this._isPaused = false;
        let t, n;
        if (this.scopes) for (t = 0, n = this.scopes.length; t < n; t++) this.scopes[t].resume();
        for (t = 0, n = this.effects.length; t < n; t++) this.effects[t].resume();
      }
    }
    run(t) {
      if (this._active) {
        const n = jt;
        try {
          return jt = this, t();
        } finally {
          jt = n;
        }
      }
    }
    on() {
      ++this._on === 1 && (this.prevScope = jt, jt = this);
    }
    off() {
      if (this._on > 0 && --this._on === 0) {
        if (jt === this) jt = this.prevScope;
        else {
          let t = jt;
          for (; t; ) {
            if (t.prevScope === this) {
              t.prevScope = this.prevScope;
              break;
            }
            t = t.prevScope;
          }
        }
        this.prevScope = void 0;
      }
    }
    stop(t) {
      if (this._active) {
        this._active = false;
        let n, o;
        for (n = 0, o = this.effects.length; n < o; n++) this.effects[n].stop();
        for (this.effects.length = 0, n = 0, o = this.cleanups.length; n < o; n++) this.cleanups[n]();
        if (this.cleanups.length = 0, this.scopes) {
          for (n = 0, o = this.scopes.length; n < o; n++) this.scopes[n].stop(true);
          this.scopes.length = 0;
        }
        if (!this.detached && this.parent && !t) {
          const a = this.parent.scopes.pop();
          a && a !== this && (this.parent.scopes[this.index] = a, a.index = this.index);
        }
        this.parent = void 0;
      }
    }
  }
  function Iy(e) {
    return new Py(e);
  }
  function tf() {
    return jt;
  }
  function Ry(e, t = false) {
    jt && jt.cleanups.push(e);
  }
  let St;
  const Uu = /* @__PURE__ */ new WeakSet();
  class Fy {
    constructor(t) {
      this.fn = t, this.deps = void 0, this.depsTail = void 0, this.flags = 5, this.next = void 0, this.cleanup = void 0, this.scheduler = void 0, jt && (jt.active ? jt.effects.push(this) : this.flags &= -2);
    }
    pause() {
      this.flags |= 64;
    }
    resume() {
      this.flags & 64 && (this.flags &= -65, Uu.has(this) && (Uu.delete(this), this.trigger()));
    }
    notify() {
      this.flags & 2 && !(this.flags & 32) || this.flags & 8 || Wy(this);
    }
    run() {
      if (!(this.flags & 1)) return this.fn();
      this.flags |= 2, bh(this), By(this);
      const t = St, n = yi;
      St = this, yi = true;
      try {
        return this.fn();
      } finally {
        Uy(this), St = t, yi = n, this.flags &= -3;
      }
    }
    stop() {
      if (this.flags & 1) {
        for (let t = this.deps; t; t = t.nextDep) of(t);
        this.deps = this.depsTail = void 0, bh(this), this.onStop && this.onStop(), this.flags &= -2;
      }
    }
    trigger() {
      this.flags & 64 ? Uu.add(this) : this.scheduler ? this.scheduler() : this.runIfDirty();
    }
    runIfDirty() {
      fd(this) && this.run();
    }
    get dirty() {
      return fd(this);
    }
  }
  let Ny = 0, ja, Ha;
  function Wy(e, t = false) {
    if (e.flags |= 8, t) {
      e.next = Ha, Ha = e;
      return;
    }
    e.next = ja, ja = e;
  }
  function nf() {
    Ny++;
  }
  function rf() {
    if (--Ny > 0) return;
    if (Ha) {
      let t = Ha;
      for (Ha = void 0; t; ) {
        const n = t.next;
        t.next = void 0, t.flags &= -9, t = n;
      }
    }
    let e;
    for (; ja; ) {
      let t = ja;
      for (ja = void 0; t; ) {
        const n = t.next;
        if (t.next = void 0, t.flags &= -9, t.flags & 1) try {
          t.trigger();
        } catch (o) {
          e || (e = o);
        }
        t = n;
      }
    }
    if (e) throw e;
  }
  function By(e) {
    for (let t = e.deps; t; t = t.nextDep) t.version = -1, t.prevActiveLink = t.dep.activeLink, t.dep.activeLink = t;
  }
  function Uy(e) {
    let t, n = e.depsTail, o = n;
    for (; o; ) {
      const a = o.prevDep;
      o.version === -1 ? (o === n && (n = a), of(o), gE(o)) : t = o, o.dep.activeLink = o.prevActiveLink, o.prevActiveLink = void 0, o = a;
    }
    e.deps = t, e.depsTail = n;
  }
  function fd(e) {
    for (let t = e.deps; t; t = t.nextDep) if (t.dep.version !== t.version || t.dep.computed && (jy(t.dep.computed) || t.dep.version !== t.version)) return true;
    return !!e._dirty;
  }
  function jy(e) {
    if (e.flags & 4 && !(e.flags & 16) || (e.flags &= -17, e.globalVersion === Za) || (e.globalVersion = Za, !e.isSSR && e.flags & 128 && (!e.deps && !e._dirty || !fd(e)))) return;
    e.flags |= 2;
    const t = e.dep, n = St, o = yi;
    St = e, yi = true;
    try {
      By(e);
      const a = e.fn(e._value);
      (t.version === 0 || Pi(a, e._value)) && (e.flags |= 128, e._value = a, t.version++);
    } catch (a) {
      throw t.version++, a;
    } finally {
      St = n, yi = o, Uy(e), e.flags &= -3;
    }
  }
  function of(e, t = false) {
    const { dep: n, prevSub: o, nextSub: a } = e;
    if (o && (o.nextSub = a, e.prevSub = void 0), a && (a.prevSub = o, e.nextSub = void 0), n.subs === e && (n.subs = o, !o && n.computed)) {
      n.computed.flags &= -5;
      for (let s = n.computed.deps; s; s = s.nextDep) of(s, true);
    }
    !t && !--n.sc && n.map && n.map.delete(n.key);
  }
  function gE(e) {
    const { prevDep: t, nextDep: n } = e;
    t && (t.nextDep = n, e.prevDep = void 0), n && (n.prevDep = t, e.nextDep = void 0);
  }
  let yi = true;
  const Hy = [];
  function or() {
    Hy.push(yi), yi = false;
  }
  function ar() {
    const e = Hy.pop();
    yi = e === void 0 ? true : e;
  }
  function bh(e) {
    const { cleanup: t } = e;
    if (e.cleanup = void 0, t) {
      const n = St;
      St = void 0;
      try {
        t();
      } finally {
        St = n;
      }
    }
  }
  let Za = 0;
  class yE {
    constructor(t, n) {
      this.sub = t, this.dep = n, this.version = n.version, this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0;
    }
  }
  class af {
    constructor(t) {
      this.computed = t, this.version = 0, this.activeLink = void 0, this.subs = void 0, this.map = void 0, this.key = void 0, this.sc = 0, this.__v_skip = true;
    }
    track(t) {
      if (!St || !yi || St === this.computed) return;
      let n = this.activeLink;
      if (n === void 0 || n.sub !== St) n = this.activeLink = new yE(St, this), St.deps ? (n.prevDep = St.depsTail, St.depsTail.nextDep = n, St.depsTail = n) : St.deps = St.depsTail = n, Vy(n);
      else if (n.version === -1 && (n.version = this.version, n.nextDep)) {
        const o = n.nextDep;
        o.prevDep = n.prevDep, n.prevDep && (n.prevDep.nextDep = o), n.prevDep = St.depsTail, n.nextDep = void 0, St.depsTail.nextDep = n, St.depsTail = n, St.deps === n && (St.deps = o);
      }
      return n;
    }
    trigger(t) {
      this.version++, Za++, this.notify(t);
    }
    notify(t) {
      nf();
      try {
        for (let n = this.subs; n; n = n.prevSub) n.sub.notify() && n.sub.dep.notify();
      } finally {
        rf();
      }
    }
  }
  function Vy(e) {
    if (e.dep.sc++, e.sub.flags & 4) {
      const t = e.dep.computed;
      if (t && !e.dep.subs) {
        t.flags |= 20;
        for (let o = t.deps; o; o = o.nextDep) Vy(o);
      }
      const n = e.dep.subs;
      n !== e && (e.prevSub = n, n && (n.nextSub = e)), e.dep.subs = e;
    }
  }
  const Ll = /* @__PURE__ */ new WeakMap(), io = /* @__PURE__ */ Symbol(""), pd = /* @__PURE__ */ Symbol(""), Qa = /* @__PURE__ */ Symbol("");
  function on(e, t, n) {
    if (yi && St) {
      let o = Ll.get(e);
      o || Ll.set(e, o = /* @__PURE__ */ new Map());
      let a = o.get(n);
      a || (o.set(n, a = new af()), a.map = o, a.key = n), a.track();
    }
  }
  function Ji(e, t, n, o, a, s) {
    const c = Ll.get(e);
    if (!c) {
      Za++;
      return;
    }
    const u = (f) => {
      f && f.trigger();
    };
    if (nf(), t === "clear") c.forEach(u);
    else {
      const f = xe(e), m = f && Gl(n);
      if (f && n === "length") {
        const h = Number(o);
        c.forEach((v, C) => {
          (C === "length" || C === Qa || !qn(C) && C >= h) && u(v);
        });
      } else switch ((n !== void 0 || c.has(void 0)) && u(c.get(n)), m && u(c.get(Qa)), t) {
        case "add":
          f ? m && u(c.get("length")) : (u(c.get(io)), ta(e) && u(c.get(pd)));
          break;
        case "delete":
          f || (u(c.get(io)), ta(e) && u(c.get(pd)));
          break;
        case "set":
          ta(e) && u(c.get(io));
          break;
      }
    }
    rf();
  }
  function vE(e, t) {
    const n = Ll.get(e);
    return n && n.get(t);
  }
  function qo(e) {
    const t = Xe(e);
    return t === e ? t : (on(t, "iterate", Qa), ii(e) ? t : t.map(sr));
  }
  function sf(e) {
    return on(e = Xe(e), "iterate", Qa), e;
  }
  function xi(e, t) {
    return Lr(e) ? Ja(rr(e) ? sr(t) : t) : sr(t);
  }
  const wE = { __proto__: null, [Symbol.iterator]() {
    return ju(this, Symbol.iterator, (e) => xi(this, e));
  }, concat(...e) {
    return qo(this).concat(...e.map((t) => xe(t) ? qo(t) : t));
  }, entries() {
    return ju(this, "entries", (e) => (e[1] = xi(this, e[1]), e));
  }, every(e, t) {
    return Gi(this, "every", e, t, void 0, arguments);
  }, filter(e, t) {
    return Gi(this, "filter", e, t, (n) => n.map((o) => xi(this, o)), arguments);
  }, find(e, t) {
    return Gi(this, "find", e, t, (n) => xi(this, n), arguments);
  }, findIndex(e, t) {
    return Gi(this, "findIndex", e, t, void 0, arguments);
  }, findLast(e, t) {
    return Gi(this, "findLast", e, t, (n) => xi(this, n), arguments);
  }, findLastIndex(e, t) {
    return Gi(this, "findLastIndex", e, t, void 0, arguments);
  }, forEach(e, t) {
    return Gi(this, "forEach", e, t, void 0, arguments);
  }, includes(...e) {
    return Hu(this, "includes", e);
  }, indexOf(...e) {
    return Hu(this, "indexOf", e);
  }, join(e) {
    return qo(this).join(e);
  }, lastIndexOf(...e) {
    return Hu(this, "lastIndexOf", e);
  }, map(e, t) {
    return Gi(this, "map", e, t, void 0, arguments);
  }, pop() {
    return Ma(this, "pop");
  }, push(...e) {
    return Ma(this, "push", e);
  }, reduce(e, ...t) {
    return _h(this, "reduce", e, t);
  }, reduceRight(e, ...t) {
    return _h(this, "reduceRight", e, t);
  }, shift() {
    return Ma(this, "shift");
  }, some(e, t) {
    return Gi(this, "some", e, t, void 0, arguments);
  }, splice(...e) {
    return Ma(this, "splice", e);
  }, toReversed() {
    return qo(this).toReversed();
  }, toSorted(e) {
    return qo(this).toSorted(e);
  }, toSpliced(...e) {
    return qo(this).toSpliced(...e);
  }, unshift(...e) {
    return Ma(this, "unshift", e);
  }, values() {
    return ju(this, "values", (e) => xi(this, e));
  } };
  function ju(e, t, n) {
    const o = sf(e), a = o[t]();
    return o !== e && !ii(e) && (a._next = a.next, a.next = () => {
      const s = a._next();
      return s.done || (s.value = n(s.value)), s;
    }), a;
  }
  const SE = Array.prototype;
  function Gi(e, t, n, o, a, s) {
    const c = sf(e), u = c !== e && !ii(e), f = c[t];
    if (f !== SE[t]) {
      const v = f.apply(e, s);
      return u ? sr(v) : v;
    }
    let m = n;
    c !== e && (u ? m = function(v, C) {
      return n.call(this, xi(e, v), C, e);
    } : n.length > 2 && (m = function(v, C) {
      return n.call(this, v, C, e);
    }));
    const h = f.call(c, m, o);
    return u && a ? a(h) : h;
  }
  function _h(e, t, n, o) {
    const a = sf(e), s = a !== e && !ii(e);
    let c = n, u = false;
    a !== e && (s ? (u = o.length === 0, c = function(m, h, v) {
      return u && (u = false, m = xi(e, m)), n.call(this, m, xi(e, h), v, e);
    }) : n.length > 3 && (c = function(m, h, v) {
      return n.call(this, m, h, v, e);
    }));
    const f = a[t](c, ...o);
    return u ? xi(e, f) : f;
  }
  function Hu(e, t, n) {
    const o = Xe(e);
    on(o, "iterate", Qa);
    const a = o[t](...n);
    return (a === -1 || a === false) && Xl(n[0]) ? (n[0] = Xe(n[0]), o[t](...n)) : a;
  }
  function Ma(e, t, n = []) {
    or(), nf();
    const o = Xe(e)[t].apply(e, n);
    return rf(), ar(), o;
  }
  const bE = Qd("__proto__,__v_isRef,__isVue"), qy = new Set(Object.getOwnPropertyNames(Symbol).filter((e) => e !== "arguments" && e !== "caller").map((e) => Symbol[e]).filter(qn));
  function _E(e) {
    qn(e) || (e = String(e));
    const t = Xe(this);
    return on(t, "has", e), t.hasOwnProperty(e);
  }
  class $y {
    constructor(t = false, n = false) {
      this._isReadonly = t, this._isShallow = n;
    }
    get(t, n, o) {
      if (n === "__v_skip") return t.__v_skip;
      const a = this._isReadonly, s = this._isShallow;
      if (n === "__v_isReactive") return !a;
      if (n === "__v_isReadonly") return a;
      if (n === "__v_isShallow") return s;
      if (n === "__v_raw") return o === (a ? s ? Jy : Qy : s ? Zy : Yy).get(t) || Object.getPrototypeOf(t) === Object.getPrototypeOf(o) ? t : void 0;
      const c = xe(t);
      if (!a) {
        let f;
        if (c && (f = wE[n])) return f;
        if (n === "hasOwnProperty") return _E;
      }
      const u = Reflect.get(t, n, bt(t) ? t : o);
      if ((qn(n) ? qy.has(n) : bE(n)) || (a || on(t, "get", n), s)) return u;
      if (bt(u)) {
        const f = c && Gl(n) ? u : u.value;
        return a && ot(f) ? hd(f) : f;
      }
      return ot(u) ? a ? hd(u) : la(u) : u;
    }
  }
  class Gy extends $y {
    constructor(t = false) {
      super(false, t);
    }
    set(t, n, o, a) {
      let s = t[n];
      const c = xe(t) && Gl(n);
      if (!this._isShallow) {
        const m = Lr(s);
        if (!ii(o) && !Lr(o) && (s = Xe(s), o = Xe(o)), !c && bt(s) && !bt(o)) return m || (s.value = o), true;
      }
      const u = c ? Number(n) < t.length : et(t, n), f = Reflect.set(t, n, o, bt(t) ? t : a);
      return t === Xe(a) && (u ? Pi(o, s) && Ji(t, "set", n, o) : Ji(t, "add", n, o)), f;
    }
    deleteProperty(t, n) {
      const o = et(t, n);
      t[n];
      const a = Reflect.deleteProperty(t, n);
      return a && o && Ji(t, "delete", n, void 0), a;
    }
    has(t, n) {
      const o = Reflect.has(t, n);
      return (!qn(n) || !qy.has(n)) && on(t, "has", n), o;
    }
    ownKeys(t) {
      return on(t, "iterate", xe(t) ? "length" : io), Reflect.ownKeys(t);
    }
  }
  class Ky extends $y {
    constructor(t = false) {
      super(true, t);
    }
    set(t, n) {
      return true;
    }
    deleteProperty(t, n) {
      return true;
    }
  }
  const AE = new Gy(), CE = new Ky(), TE = new Gy(true), EE = new Ky(true), md = (e) => e, vl = (e) => Reflect.getPrototypeOf(e);
  function kE(e, t, n) {
    return function(...o) {
      const a = this.__v_raw, s = Xe(a), c = ta(s), u = e === "entries" || e === Symbol.iterator && c, f = e === "keys" && c, m = a[e](...o), h = n ? md : t ? Ja : sr;
      return !t && on(s, "iterate", f ? pd : io), Vt(Object.create(m), { next() {
        const { value: v, done: C } = m.next();
        return C ? { value: v, done: C } : { value: u ? [h(v[0]), h(v[1])] : h(v), done: C };
      } });
    };
  }
  function wl(e) {
    return function(...t) {
      return e === "delete" ? false : e === "clear" ? void 0 : this;
    };
  }
  function zE(e, t) {
    const n = { get(a) {
      const s = this.__v_raw, c = Xe(s), u = Xe(a);
      e || (Pi(a, u) && on(c, "get", a), on(c, "get", u));
      const { has: f } = vl(c), m = t ? md : e ? Ja : sr;
      if (f.call(c, a)) return m(s.get(a));
      if (f.call(c, u)) return m(s.get(u));
      s !== c && s.get(a);
    }, get size() {
      const a = this.__v_raw;
      return !e && on(Xe(a), "iterate", io), a.size;
    }, has(a) {
      const s = this.__v_raw, c = Xe(s), u = Xe(a);
      return e || (Pi(a, u) && on(c, "has", a), on(c, "has", u)), a === u ? s.has(a) : s.has(a) || s.has(u);
    }, forEach(a, s) {
      const c = this, u = c.__v_raw, f = Xe(u), m = t ? md : e ? Ja : sr;
      return !e && on(f, "iterate", io), u.forEach((h, v) => a.call(s, m(h), m(v), c));
    } };
    return Vt(n, e ? { add: wl("add"), set: wl("set"), delete: wl("delete"), clear: wl("clear") } : { add(a) {
      const s = Xe(this), c = vl(s), u = Xe(a), f = !t && !ii(a) && !Lr(a) ? u : a;
      return c.has.call(s, f) || Pi(a, f) && c.has.call(s, a) || Pi(u, f) && c.has.call(s, u) || (s.add(f), Ji(s, "add", f, f)), this;
    }, set(a, s) {
      !t && !ii(s) && !Lr(s) && (s = Xe(s));
      const c = Xe(this), { has: u, get: f } = vl(c);
      let m = u.call(c, a);
      m || (a = Xe(a), m = u.call(c, a));
      const h = f.call(c, a);
      return c.set(a, s), m ? Pi(s, h) && Ji(c, "set", a, s) : Ji(c, "add", a, s), this;
    }, delete(a) {
      const s = Xe(this), { has: c, get: u } = vl(s);
      let f = c.call(s, a);
      f || (a = Xe(a), f = c.call(s, a)), u && u.call(s, a);
      const m = s.delete(a);
      return f && Ji(s, "delete", a, void 0), m;
    }, clear() {
      const a = Xe(this), s = a.size !== 0, c = a.clear();
      return s && Ji(a, "clear", void 0, void 0), c;
    } }), ["keys", "values", "entries", Symbol.iterator].forEach((a) => {
      n[a] = kE(a, e, t);
    }), n;
  }
  function Ql(e, t) {
    const n = zE(e, t);
    return (o, a, s) => a === "__v_isReactive" ? !e : a === "__v_isReadonly" ? e : a === "__v_raw" ? o : Reflect.get(et(n, a) && a in o ? n : o, a, s);
  }
  const DE = { get: Ql(false, false) }, ME = { get: Ql(false, true) }, LE = { get: Ql(true, false) }, xE = { get: Ql(true, true) }, Yy = /* @__PURE__ */ new WeakMap(), Zy = /* @__PURE__ */ new WeakMap(), Qy = /* @__PURE__ */ new WeakMap(), Jy = /* @__PURE__ */ new WeakMap();
  function OE(e) {
    switch (e) {
      case "Object":
      case "Array":
        return 1;
      case "Map":
      case "Set":
      case "WeakMap":
      case "WeakSet":
        return 2;
      default:
        return 0;
    }
  }
  function la(e) {
    return Lr(e) ? e : Jl(e, false, AE, DE, Yy);
  }
  function lf(e) {
    return Jl(e, false, TE, ME, Zy);
  }
  function hd(e) {
    return Jl(e, true, CE, LE, Qy);
  }
  function PE(e) {
    return Jl(e, true, EE, xE, Jy);
  }
  function Jl(e, t, n, o, a) {
    if (!ot(e) || e.__v_raw && !(t && e.__v_isReactive) || e.__v_skip || !Object.isExtensible(e)) return e;
    const s = a.get(e);
    if (s) return s;
    const c = OE(rE(e));
    if (c === 0) return e;
    const u = new Proxy(e, c === 2 ? o : n);
    return a.set(e, u), u;
  }
  function rr(e) {
    return Lr(e) ? rr(e.__v_raw) : !!(e && e.__v_isReactive);
  }
  function Lr(e) {
    return !!(e && e.__v_isReadonly);
  }
  function ii(e) {
    return !!(e && e.__v_isShallow);
  }
  function Xl(e) {
    return e ? !!e.__v_raw : false;
  }
  function Xe(e) {
    const t = e && e.__v_raw;
    return t ? Xe(t) : e;
  }
  function Xy(e) {
    return !et(e, "__v_skip") && Object.isExtensible(e) && My(e, "__v_skip", true), e;
  }
  const sr = (e) => ot(e) ? la(e) : e, Ja = (e) => ot(e) ? hd(e) : e;
  function bt(e) {
    return e ? e.__v_isRef === true : false;
  }
  function Ln(e) {
    return ev(e, false);
  }
  function cf(e) {
    return ev(e, true);
  }
  function ev(e, t) {
    return bt(e) ? e : new IE(e, t);
  }
  class IE {
    constructor(t, n) {
      this.dep = new af(), this.__v_isRef = true, this.__v_isShallow = false, this._rawValue = n ? t : Xe(t), this._value = n ? t : sr(t), this.__v_isShallow = n;
    }
    get value() {
      return this.dep.track(), this._value;
    }
    set value(t) {
      const n = this._rawValue, o = this.__v_isShallow || ii(t) || Lr(t);
      t = o ? t : Xe(t), Pi(t, n) && (this._rawValue = t, this._value = o ? t : sr(t), this.dep.trigger());
    }
  }
  function Je(e) {
    return bt(e) ? e.value : e;
  }
  function na(e) {
    return Pe(e) ? e() : Je(e);
  }
  const RE = { get: (e, t, n) => t === "__v_raw" ? e : Je(Reflect.get(e, t, n)), set: (e, t, n, o) => {
    const a = e[t];
    return bt(a) && !bt(n) ? (a.value = n, true) : Reflect.set(e, t, n, o);
  } };
  function tv(e) {
    return rr(e) ? e : new Proxy(e, RE);
  }
  function FE(e) {
    const t = xe(e) ? new Array(e.length) : {};
    for (const n in e) t[n] = nv(e, n);
    return t;
  }
  class NE {
    constructor(t, n, o) {
      this._object = t, this._defaultValue = o, this.__v_isRef = true, this._value = void 0, this._key = qn(n) ? n : String(n), this._raw = Xe(t);
      let a = true, s = t;
      if (!xe(t) || qn(this._key) || !Gl(this._key)) do
        a = !Xl(s) || ii(s);
      while (a && (s = s.__v_raw));
      this._shallow = a;
    }
    get value() {
      let t = this._object[this._key];
      return this._shallow && (t = Je(t)), this._value = t === void 0 ? this._defaultValue : t;
    }
    set value(t) {
      if (this._shallow && bt(this._raw[this._key])) {
        const n = this._object[this._key];
        if (bt(n)) {
          n.value = t;
          return;
        }
      }
      this._object[this._key] = t;
    }
    get dep() {
      return vE(this._raw, this._key);
    }
  }
  class WE {
    constructor(t) {
      this._getter = t, this.__v_isRef = true, this.__v_isReadonly = true, this._value = void 0;
    }
    get value() {
      return this._value = this._getter();
    }
  }
  function BE(e, t, n) {
    return bt(e) ? e : Pe(e) ? new WE(e) : ot(e) && arguments.length > 1 ? nv(e, t, n) : Ln(e);
  }
  function nv(e, t, n) {
    return new NE(e, t, n);
  }
  class UE {
    constructor(t, n, o) {
      this.fn = t, this.setter = n, this._value = void 0, this.dep = new af(this), this.__v_isRef = true, this.deps = void 0, this.depsTail = void 0, this.flags = 16, this.globalVersion = Za - 1, this.next = void 0, this.effect = this, this.__v_isReadonly = !n, this.isSSR = o;
    }
    notify() {
      if (this.flags |= 16, !(this.flags & 8) && St !== this) return Wy(this, true), true;
    }
    get value() {
      const t = this.dep.track();
      return jy(this), t && (t.version = this.dep.version), this._value;
    }
    set value(t) {
      this.setter && this.setter(t);
    }
  }
  function jE(e, t, n = false) {
    let o, a;
    return Pe(e) ? o = e : (o = e.get, a = e.set), new UE(o, a, n);
  }
  const Sl = {}, xl = /* @__PURE__ */ new WeakMap();
  let Xr;
  function HE(e, t = false, n = Xr) {
    if (n) {
      let o = xl.get(n);
      o || xl.set(n, o = []), o.push(e);
    }
  }
  function VE(e, t, n = yt) {
    const { immediate: o, deep: a, once: s, scheduler: c, augmentJob: u, call: f } = n, m = (k) => a ? k : ii(k) || a === false || a === 0 ? Xi(k, 1) : Xi(k);
    let h, v, C, D, W = false, E = false;
    if (bt(e) ? (v = () => e.value, W = ii(e)) : rr(e) ? (v = () => m(e), W = true) : xe(e) ? (E = true, W = e.some((k) => rr(k) || ii(k)), v = () => e.map((k) => {
      if (bt(k)) return k.value;
      if (rr(k)) return m(k);
      if (Pe(k)) return f ? f(k, 2) : k();
    })) : Pe(e) ? t ? v = f ? () => f(e, 2) : e : v = () => {
      if (C) {
        or();
        try {
          C();
        } finally {
          ar();
        }
      }
      const k = Xr;
      Xr = h;
      try {
        return f ? f(e, 3, [D]) : e(D);
      } finally {
        Xr = k;
      }
    } : v = gi, t && a) {
      const k = v, j = a === true ? 1 / 0 : a;
      v = () => Xi(k(), j);
    }
    const L = tf(), b = () => {
      h.stop(), L && L.active && Jd(L.effects, h);
    };
    if (s && t) {
      const k = t;
      t = (...j) => {
        k(...j), b();
      };
    }
    let P = E ? new Array(e.length).fill(Sl) : Sl;
    const B = (k) => {
      if (!(!(h.flags & 1) || !h.dirty && !k)) if (t) {
        const j = h.run();
        if (a || W || (E ? j.some(($, q) => Pi($, P[q])) : Pi(j, P))) {
          C && C();
          const $ = Xr;
          Xr = h;
          try {
            const q = [j, P === Sl ? void 0 : E && P[0] === Sl ? [] : P, D];
            P = j, f ? f(t, 3, q) : t(...q);
          } finally {
            Xr = $;
          }
        }
      } else h.run();
    };
    return u && u(B), h = new Fy(v), h.scheduler = c ? () => c(B, false) : B, D = (k) => HE(k, false, h), C = h.onStop = () => {
      const k = xl.get(h);
      if (k) {
        if (f) f(k, 4);
        else for (const j of k) j();
        xl.delete(h);
      }
    }, t ? o ? B(true) : P = h.run() : c ? c(B.bind(null, true), true) : h.run(), b.pause = h.pause.bind(h), b.resume = h.resume.bind(h), b.stop = b, b;
  }
  function Xi(e, t = 1 / 0, n) {
    if (t <= 0 || !ot(e) || e.__v_skip || (n = n || /* @__PURE__ */ new Map(), (n.get(e) || 0) >= t)) return e;
    if (n.set(e, t), t--, bt(e)) Xi(e.value, t, n);
    else if (xe(e)) for (let o = 0; o < e.length; o++) Xi(e[o], t, n);
    else if (Ey(e) || ta(e)) e.forEach((o) => {
      Xi(o, t, n);
    });
    else if (Dy(e)) {
      for (const o in e) Xi(e[o], t, n);
      for (const o of Object.getOwnPropertySymbols(e)) Object.prototype.propertyIsEnumerable.call(e, o) && Xi(e[o], t, n);
    }
    return e;
  }
  /**
  * @vue/runtime-core v3.5.35
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **/
  function fs(e, t, n, o) {
    try {
      return o ? e(...o) : e();
    } catch (a) {
      ec(a, t, n);
    }
  }
  function ai(e, t, n, o) {
    if (Pe(e)) {
      const a = fs(e, t, n, o);
      return a && ky(a) && a.catch((s) => {
        ec(s, t, n);
      }), a;
    }
    if (xe(e)) {
      const a = [];
      for (let s = 0; s < e.length; s++) a.push(ai(e[s], t, n, o));
      return a;
    }
  }
  function ec(e, t, n, o = true) {
    const a = t ? t.vnode : null, { errorHandler: s, throwUnhandledErrorInProduction: c } = t && t.appContext.config || yt;
    if (t) {
      let u = t.parent;
      const f = t.proxy, m = `https://vuejs.org/error-reference/#runtime-${n}`;
      for (; u; ) {
        const h = u.ec;
        if (h) {
          for (let v = 0; v < h.length; v++) if (h[v](e, f, m) === false) return;
        }
        u = u.parent;
      }
      if (s) {
        or(), fs(s, null, 10, [e, f, m]), ar();
        return;
      }
    }
    qE(e, n, a, o, c);
  }
  function qE(e, t, n, o = true, a = false) {
    if (a) throw e;
    console.error(e);
  }
  const vn = [];
  let Li = -1;
  const ia = [];
  let Dr = null, Zo = 0;
  const iv = Promise.resolve();
  let Ol = null;
  function uf(e) {
    const t = Ol || iv;
    return e ? t.then(this ? e.bind(this) : e) : t;
  }
  function $E(e) {
    let t = Li + 1, n = vn.length;
    for (; t < n; ) {
      const o = t + n >>> 1, a = vn[o], s = Xa(a);
      s < e || s === e && a.flags & 2 ? t = o + 1 : n = o;
    }
    return t;
  }
  function df(e) {
    if (!(e.flags & 1)) {
      const t = Xa(e), n = vn[vn.length - 1];
      !n || !(e.flags & 2) && t >= Xa(n) ? vn.push(e) : vn.splice($E(t), 0, e), e.flags |= 1, rv();
    }
  }
  function rv() {
    Ol || (Ol = iv.then(av));
  }
  function GE(e) {
    xe(e) ? ia.push(...e) : Dr && e.id === -1 ? Dr.splice(Zo + 1, 0, e) : e.flags & 1 || (ia.push(e), e.flags |= 1), rv();
  }
  function Ah(e, t, n = Li + 1) {
    for (; n < vn.length; n++) {
      const o = vn[n];
      if (o && o.flags & 2) {
        if (e && o.id !== e.uid) continue;
        vn.splice(n, 1), n--, o.flags & 4 && (o.flags &= -2), o(), o.flags & 4 || (o.flags &= -2);
      }
    }
  }
  function ov(e) {
    if (ia.length) {
      const t = [...new Set(ia)].sort((n, o) => Xa(n) - Xa(o));
      if (ia.length = 0, Dr) {
        Dr.push(...t);
        return;
      }
      for (Dr = t, Zo = 0; Zo < Dr.length; Zo++) {
        const n = Dr[Zo];
        n.flags & 4 && (n.flags &= -2), n.flags & 8 || n(), n.flags &= -2;
      }
      Dr = null, Zo = 0;
    }
  }
  const Xa = (e) => e.id == null ? e.flags & 2 ? -1 : 1 / 0 : e.id;
  function av(e) {
    try {
      for (Li = 0; Li < vn.length; Li++) {
        const t = vn[Li];
        t && !(t.flags & 8) && (t.flags & 4 && (t.flags &= -2), fs(t, t.i, t.i ? 15 : 14), t.flags & 4 || (t.flags &= -2));
      }
    } finally {
      for (; Li < vn.length; Li++) {
        const t = vn[Li];
        t && (t.flags &= -2);
      }
      Li = -1, vn.length = 0, ov(), Ol = null, (vn.length || ia.length) && av();
    }
  }
  let Xt = null, sv = null;
  function Pl(e) {
    const t = Xt;
    return Xt = e, sv = e && e.type.__scopeId || null, t;
  }
  function Va(e, t = Xt, n) {
    if (!t || e._n) return e;
    const o = (...a) => {
      o._d && Nl(-1);
      const s = Pl(t);
      let c;
      try {
        c = e(...a);
      } finally {
        Pl(s), o._d && Nl(1);
      }
      return c;
    };
    return o._n = true, o._c = true, o._d = true, o;
  }
  function KE(e, t) {
    if (Xt === null) return e;
    const n = rc(Xt), o = e.dirs || (e.dirs = []);
    for (let a = 0; a < t.length; a++) {
      let [s, c, u, f = yt] = t[a];
      s && (Pe(s) && (s = { mounted: s, updated: s }), s.deep && Xi(c), o.push({ dir: s, instance: n, value: c, oldValue: void 0, arg: u, modifiers: f }));
    }
    return e;
  }
  function Kr(e, t, n, o) {
    const a = e.dirs, s = t && t.dirs;
    for (let c = 0; c < a.length; c++) {
      const u = a[c];
      s && (u.oldValue = s[c].value);
      let f = u.dir[o];
      f && (or(), ai(f, n, 8, [e.el, u, e, t]), ar());
    }
  }
  function lv(e, t) {
    if (ln) {
      let n = ln.provides;
      const o = ln.parent && ln.parent.provides;
      o === n && (n = ln.provides = Object.create(o)), n[e] = t;
    }
  }
  function ri(e, t, n = false) {
    const o = On();
    if (o || ro) {
      let a = ro ? ro._context.provides : o ? o.parent == null || o.ce ? o.vnode.appContext && o.vnode.appContext.provides : o.parent.provides : void 0;
      if (a && e in a) return a[e];
      if (arguments.length > 1) return n && Pe(t) ? t.call(o && o.proxy) : t;
    }
  }
  function YE() {
    return !!(On() || ro);
  }
  const ZE = /* @__PURE__ */ Symbol.for("v-scx"), QE = () => ri(ZE);
  function vi(e, t, n) {
    return cv(e, t, n);
  }
  function cv(e, t, n = yt) {
    const { immediate: o, deep: a, flush: s, once: c } = n, u = Vt({}, n), f = t && o || !t && s !== "post";
    let m;
    if (ns) {
      if (s === "sync") {
        const D = QE();
        m = D.__watcherHandles || (D.__watcherHandles = []);
      } else if (!f) {
        const D = () => {
        };
        return D.stop = gi, D.resume = gi, D.pause = gi, D;
      }
    }
    const h = ln;
    u.call = (D, W, E) => ai(D, h, W, E);
    let v = false;
    s === "post" ? u.scheduler = (D) => {
      Mn(D, h && h.suspense);
    } : s !== "sync" && (v = true, u.scheduler = (D, W) => {
      W ? D() : df(D);
    }), u.augmentJob = (D) => {
      t && (D.flags |= 4), v && (D.flags |= 2, h && (D.id = h.uid, D.i = h));
    };
    const C = VE(e, t, u);
    return ns && (m ? m.push(C) : f && C()), C;
  }
  function JE(e, t, n) {
    const o = this.proxy, a = ht(e) ? e.includes(".") ? uv(o, e) : () => o[e] : e.bind(o, o);
    let s;
    Pe(t) ? s = t : (s = t.handler, n = t);
    const c = hs(this), u = cv(a, s.bind(o), n);
    return c(), u;
  }
  function uv(e, t) {
    const n = t.split(".");
    return () => {
      let o = e;
      for (let a = 0; a < n.length && o; a++) o = o[n[a]];
      return o;
    };
  }
  const XE = /* @__PURE__ */ Symbol("_vte"), dv = (e) => e.__isTeleport, ti = /* @__PURE__ */ Symbol("_leaveCb"), La = /* @__PURE__ */ Symbol("_enterCb");
  function e2() {
    const e = { isMounted: false, isLeaving: false, isUnmounting: false, leavingVNodes: /* @__PURE__ */ new Map() };
    return ps(() => {
      e.isMounted = true;
    }), wv(() => {
      e.isUnmounting = true;
    }), e;
  }
  const ei = [Function, Array], fv = { mode: String, appear: Boolean, persisted: Boolean, onBeforeEnter: ei, onEnter: ei, onAfterEnter: ei, onEnterCancelled: ei, onBeforeLeave: ei, onLeave: ei, onAfterLeave: ei, onLeaveCancelled: ei, onBeforeAppear: ei, onAppear: ei, onAfterAppear: ei, onAppearCancelled: ei }, pv = (e) => {
    const t = e.subTree;
    return t.component ? pv(t.component) : t;
  }, t2 = { name: "BaseTransition", props: fv, setup(e, { slots: t }) {
    const n = On(), o = e2();
    return () => {
      const a = t.default && gv(t.default(), true), s = a && a.length ? mv(a) : n.subTree ? Xo() : void 0;
      if (!s) return;
      const c = Xe(e), { mode: u } = c;
      if (o.isLeaving) return Vu(s);
      const f = Ch(s);
      if (!f) return Vu(s);
      let m = gd(f, c, o, n, (v) => m = v);
      f.type !== sn && es(f, m);
      let h = n.subTree && Ch(n.subTree);
      if (h && h.type !== sn && !eo(h, f) && pv(n).type !== sn) {
        let v = gd(h, c, o, n);
        if (es(h, v), u === "out-in" && f.type !== sn) return o.isLeaving = true, v.afterLeave = () => {
          o.isLeaving = false, n.job.flags & 8 || n.update(), delete v.afterLeave, h = void 0;
        }, Vu(s);
        u === "in-out" && f.type !== sn ? v.delayLeave = (C, D, W) => {
          const E = hv(o, h);
          E[String(h.key)] = h, C[ti] = () => {
            D(), C[ti] = void 0, delete m.delayedLeave, h = void 0;
          }, m.delayedLeave = () => {
            W(), delete m.delayedLeave, h = void 0;
          };
        } : h = void 0;
      } else h && (h = void 0);
      return s;
    };
  } };
  function mv(e) {
    let t = e[0];
    if (e.length > 1) {
      for (const n of e) if (n.type !== sn) {
        t = n;
        break;
      }
    }
    return t;
  }
  const n2 = t2;
  function hv(e, t) {
    const { leavingVNodes: n } = e;
    let o = n.get(t.type);
    return o || (o = /* @__PURE__ */ Object.create(null), n.set(t.type, o)), o;
  }
  function gd(e, t, n, o, a) {
    const { appear: s, mode: c, persisted: u = false, onBeforeEnter: f, onEnter: m, onAfterEnter: h, onEnterCancelled: v, onBeforeLeave: C, onLeave: D, onAfterLeave: W, onLeaveCancelled: E, onBeforeAppear: L, onAppear: b, onAfterAppear: P, onAppearCancelled: B } = t, k = String(e.key), j = hv(n, e), $ = (ee, se) => {
      ee && ai(ee, o, 9, se);
    }, q = (ee, se) => {
      const le = se[1];
      $(ee, se), xe(ee) ? ee.every((re) => re.length <= 1) && le() : ee.length <= 1 && le();
    }, ue = { mode: c, persisted: u, beforeEnter(ee) {
      let se = f;
      if (!n.isMounted) if (s) se = L || f;
      else return;
      ee[ti] && ee[ti](true);
      const le = j[k];
      le && eo(e, le) && le.el[ti] && le.el[ti](), $(se, [ee]);
    }, enter(ee) {
      if (j[k] === e) return;
      let se = m, le = h, re = v;
      if (!n.isMounted) if (s) se = b || m, le = P || h, re = B || v;
      else return;
      let Ee = false;
      ee[La] = (ce) => {
        Ee || (Ee = true, ce ? $(re, [ee]) : $(le, [ee]), ue.delayedLeave && ue.delayedLeave(), ee[La] = void 0);
      };
      const fe = ee[La].bind(null, false);
      se ? q(se, [ee, fe]) : fe();
    }, leave(ee, se) {
      const le = String(e.key);
      if (ee[La] && ee[La](true), n.isUnmounting) return se();
      $(C, [ee]);
      let re = false;
      ee[ti] = (fe) => {
        re || (re = true, se(), fe ? $(E, [ee]) : $(W, [ee]), ee[ti] = void 0, j[le] === e && delete j[le]);
      };
      const Ee = ee[ti].bind(null, false);
      j[le] = e, D ? q(D, [ee, Ee]) : Ee();
    }, clone(ee) {
      const se = gd(ee, t, n, o, a);
      return a && a(se), se;
    } };
    return ue;
  }
  function Vu(e) {
    if (tc(e)) return e = xr(e), e.children = null, e;
  }
  function Ch(e) {
    if (!tc(e)) return dv(e.type) && e.children ? mv(e.children) : e;
    if (e.component) return e.component.subTree;
    const { shapeFlag: t, children: n } = e;
    if (n) {
      if (t & 16) return n[0];
      if (t & 32 && Pe(n.default)) return n.default();
    }
  }
  function es(e, t) {
    e.shapeFlag & 6 && e.component ? (e.transition = t, es(e.component.subTree, t)) : e.shapeFlag & 128 ? (e.ssContent.transition = t.clone(e.ssContent), e.ssFallback.transition = t.clone(e.ssFallback)) : e.transition = t;
  }
  function gv(e, t = false, n) {
    let o = [], a = 0;
    for (let s = 0; s < e.length; s++) {
      let c = e[s];
      const u = n == null ? c.key : String(n) + String(c.key != null ? c.key : s);
      c.type === an ? (c.patchFlag & 128 && a++, o = o.concat(gv(c.children, t, u))) : (t || c.type !== sn) && o.push(u != null ? xr(c, { key: u }) : c);
    }
    if (a > 1) for (let s = 0; s < o.length; s++) o[s].patchFlag = -2;
    return o;
  }
  function Si(e, t) {
    return Pe(e) ? Vt({ name: e.name }, t, { setup: e }) : e;
  }
  function yv(e) {
    e.ids = [e.ids[0] + e.ids[2]++ + "-", 0, 0];
  }
  function Th(e, t) {
    let n;
    return !!((n = Object.getOwnPropertyDescriptor(e, t)) && !n.configurable);
  }
  const Il = /* @__PURE__ */ new WeakMap();
  function qa(e, t, n, o, a = false) {
    if (xe(e)) {
      e.forEach((E, L) => qa(E, t && (xe(t) ? t[L] : t), n, o, a));
      return;
    }
    if (ra(o) && !a) {
      o.shapeFlag & 512 && o.type.__asyncResolved && o.component.subTree.component && qa(e, t, n, o.component.subTree);
      return;
    }
    const s = o.shapeFlag & 4 ? rc(o.component) : o.el, c = a ? null : s, { i: u, r: f } = e, m = t && t.r, h = u.refs === yt ? u.refs = {} : u.refs, v = u.setupState, C = Xe(v), D = v === yt ? Ty : (E) => Th(h, E) ? false : et(C, E), W = (E, L) => !(L && Th(h, L));
    if (m != null && m !== f) {
      if (Eh(t), ht(m)) h[m] = null, D(m) && (v[m] = null);
      else if (bt(m)) {
        const E = t;
        W(m, E.k) && (m.value = null), E.k && (h[E.k] = null);
      }
    }
    if (Pe(f)) fs(f, u, 12, [c, h]);
    else {
      const E = ht(f), L = bt(f);
      if (E || L) {
        const b = () => {
          if (e.f) {
            const P = E ? D(f) ? v[f] : h[f] : W() || !e.k ? f.value : h[e.k];
            if (a) xe(P) && Jd(P, s);
            else if (xe(P)) P.includes(s) || P.push(s);
            else if (E) h[f] = [s], D(f) && (v[f] = h[f]);
            else {
              const B = [s];
              W(f, e.k) && (f.value = B), e.k && (h[e.k] = B);
            }
          } else E ? (h[f] = c, D(f) && (v[f] = c)) : L && (W(f, e.k) && (f.value = c), e.k && (h[e.k] = c));
        };
        if (c) {
          const P = () => {
            b(), Il.delete(e);
          };
          P.id = -1, Il.set(e, P), Mn(P, n);
        } else Eh(e), b();
      }
    }
  }
  function Eh(e) {
    const t = Il.get(e);
    t && (t.flags |= 8, Il.delete(e));
  }
  Zl().requestIdleCallback;
  Zl().cancelIdleCallback;
  const ra = (e) => !!e.type.__asyncLoader, tc = (e) => e.type.__isKeepAlive;
  function i2(e, t) {
    vv(e, "a", t);
  }
  function r2(e, t) {
    vv(e, "da", t);
  }
  function vv(e, t, n = ln) {
    const o = e.__wdc || (e.__wdc = () => {
      let a = n;
      for (; a; ) {
        if (a.isDeactivated) return;
        a = a.parent;
      }
      return e();
    });
    if (nc(t, o, n), n) {
      let a = n.parent;
      for (; a && a.parent; ) tc(a.parent.vnode) && o2(o, t, n, a), a = a.parent;
    }
  }
  function o2(e, t, n, o) {
    const a = nc(t, e, o, true);
    ff(() => {
      Jd(o[t], a);
    }, n);
  }
  function nc(e, t, n = ln, o = false) {
    if (n) {
      const a = n[e] || (n[e] = []), s = t.__weh || (t.__weh = (...c) => {
        or();
        const u = hs(n), f = ai(t, n, e, c);
        return u(), ar(), f;
      });
      return o ? a.unshift(s) : a.push(s), s;
    }
  }
  const cr = (e) => (t, n = ln) => {
    (!ns || e === "sp") && nc(e, (...o) => t(...o), n);
  }, a2 = cr("bm"), ps = cr("m"), s2 = cr("bu"), l2 = cr("u"), wv = cr("bum"), ff = cr("um"), c2 = cr("sp"), u2 = cr("rtg"), d2 = cr("rtc");
  function f2(e, t = ln) {
    nc("ec", e, t);
  }
  const Sv = "components", bv = /* @__PURE__ */ Symbol.for("v-ndc");
  function p2(e) {
    return ht(e) ? m2(Sv, e, false) || e : e || bv;
  }
  function m2(e, t, n = true, o = false) {
    const a = Xt || ln;
    if (a) {
      const s = a.type;
      if (e === Sv) {
        const u = Q2(s, false);
        if (u && (u === t || u === wn(t) || u === Yl(wn(t)))) return s;
      }
      const c = kh(a[e] || s[e], t) || kh(a.appContext[e], t);
      return !c && o ? s : c;
    }
  }
  function kh(e, t) {
    return e && (e[t] || e[wn(t)] || e[Yl(wn(t))]);
  }
  function Rl(e, t, n = {}, o, a) {
    if (Xt.ce || Xt.parent && ra(Xt.parent) && Xt.parent.ce) {
      const m = Object.keys(n).length > 0;
      return t !== "default" && (n.name = t), Gt(), Mr(an, null, [Kt("slot", n, o && o())], m ? -2 : 64);
    }
    let s = e[t];
    s && s._c && (s._d = false), Gt();
    const c = s && _v(s(n)), u = n.key || c && c.key, f = Mr(an, { key: (u && !qn(u) ? u : `_${t}`) + (!c && o ? "_fb" : "") }, c || (o ? o() : []), c && e._ === 1 ? 64 : -2);
    return f.scopeId && (f.slotScopeIds = [f.scopeId + "-s"]), s && s._c && (s._d = true), f;
  }
  function _v(e) {
    return e.some((t) => ao(t) ? !(t.type === sn || t.type === an && !_v(t.children)) : true) ? e : null;
  }
  const yd = (e) => e ? Hv(e) ? rc(e) : yd(e.parent) : null, $a = Vt(/* @__PURE__ */ Object.create(null), { $: (e) => e, $el: (e) => e.vnode.el, $data: (e) => e.data, $props: (e) => e.props, $attrs: (e) => e.attrs, $slots: (e) => e.slots, $refs: (e) => e.refs, $parent: (e) => yd(e.parent), $root: (e) => yd(e.root), $host: (e) => e.ce, $emit: (e) => e.emit, $options: (e) => Cv(e), $forceUpdate: (e) => e.f || (e.f = () => {
    df(e.update);
  }), $nextTick: (e) => e.n || (e.n = uf.bind(e.proxy)), $watch: (e) => JE.bind(e) }), qu = (e, t) => e !== yt && !e.__isScriptSetup && et(e, t), h2 = { get({ _: e }, t) {
    if (t === "__v_skip") return true;
    const { ctx: n, setupState: o, data: a, props: s, accessCache: c, type: u, appContext: f } = e;
    if (t[0] !== "$") {
      const C = c[t];
      if (C !== void 0) switch (C) {
        case 1:
          return o[t];
        case 2:
          return a[t];
        case 4:
          return n[t];
        case 3:
          return s[t];
      }
      else {
        if (qu(o, t)) return c[t] = 1, o[t];
        if (a !== yt && et(a, t)) return c[t] = 2, a[t];
        if (et(s, t)) return c[t] = 3, s[t];
        if (n !== yt && et(n, t)) return c[t] = 4, n[t];
        vd && (c[t] = 0);
      }
    }
    const m = $a[t];
    let h, v;
    if (m) return t === "$attrs" && on(e.attrs, "get", ""), m(e);
    if ((h = u.__cssModules) && (h = h[t])) return h;
    if (n !== yt && et(n, t)) return c[t] = 4, n[t];
    if (v = f.config.globalProperties, et(v, t)) return v[t];
  }, set({ _: e }, t, n) {
    const { data: o, setupState: a, ctx: s } = e;
    return qu(a, t) ? (a[t] = n, true) : o !== yt && et(o, t) ? (o[t] = n, true) : et(e.props, t) || t[0] === "$" && t.slice(1) in e ? false : (s[t] = n, true);
  }, has({ _: { data: e, setupState: t, accessCache: n, ctx: o, appContext: a, props: s, type: c } }, u) {
    let f;
    return !!(n[u] || e !== yt && u[0] !== "$" && et(e, u) || qu(t, u) || et(s, u) || et(o, u) || et($a, u) || et(a.config.globalProperties, u) || (f = c.__cssModules) && f[u]);
  }, defineProperty(e, t, n) {
    return n.get != null ? e._.accessCache[t] = 0 : et(n, "value") && this.set(e, t, n.value, null), Reflect.defineProperty(e, t, n);
  } };
  function zh(e) {
    return xe(e) ? e.reduce((t, n) => (t[n] = null, t), {}) : e;
  }
  let vd = true;
  function g2(e) {
    const t = Cv(e), n = e.proxy, o = e.ctx;
    vd = false, t.beforeCreate && Dh(t.beforeCreate, e, "bc");
    const { data: a, computed: s, methods: c, watch: u, provide: f, inject: m, created: h, beforeMount: v, mounted: C, beforeUpdate: D, updated: W, activated: E, deactivated: L, beforeDestroy: b, beforeUnmount: P, destroyed: B, unmounted: k, render: j, renderTracked: $, renderTriggered: q, errorCaptured: ue, serverPrefetch: ee, expose: se, inheritAttrs: le, components: re, directives: Ee, filters: fe } = t;
    if (m && y2(m, o, null), c) for (const oe in c) {
      const ie = c[oe];
      Pe(ie) && (o[oe] = ie.bind(n));
    }
    if (a) {
      const oe = a.call(n, n);
      ot(oe) && (e.data = la(oe));
    }
    if (vd = true, s) for (const oe in s) {
      const ie = s[oe], pe = Pe(ie) ? ie.bind(n, n) : Pe(ie.get) ? ie.get.bind(n, n) : gi, we = !Pe(ie) && Pe(ie.set) ? ie.set.bind(n) : gi, Te = We({ get: pe, set: we });
      Object.defineProperty(o, oe, { enumerable: true, configurable: true, get: () => Te.value, set: (ke) => Te.value = ke });
    }
    if (u) for (const oe in u) Av(u[oe], o, n, oe);
    if (f) {
      const oe = Pe(f) ? f.call(n) : f;
      Reflect.ownKeys(oe).forEach((ie) => {
        lv(ie, oe[ie]);
      });
    }
    h && Dh(h, e, "c");
    function G(oe, ie) {
      xe(ie) ? ie.forEach((pe) => oe(pe.bind(n))) : ie && oe(ie.bind(n));
    }
    if (G(a2, v), G(ps, C), G(s2, D), G(l2, W), G(i2, E), G(r2, L), G(f2, ue), G(d2, $), G(u2, q), G(wv, P), G(ff, k), G(c2, ee), xe(se)) if (se.length) {
      const oe = e.exposed || (e.exposed = {});
      se.forEach((ie) => {
        Object.defineProperty(oe, ie, { get: () => n[ie], set: (pe) => n[ie] = pe, enumerable: true });
      });
    } else e.exposed || (e.exposed = {});
    j && e.render === gi && (e.render = j), le != null && (e.inheritAttrs = le), re && (e.components = re), Ee && (e.directives = Ee), ee && yv(e);
  }
  function y2(e, t, n = gi) {
    xe(e) && (e = wd(e));
    for (const o in e) {
      const a = e[o];
      let s;
      ot(a) ? "default" in a ? s = ri(a.from || o, a.default, true) : s = ri(a.from || o) : s = ri(a), bt(s) ? Object.defineProperty(t, o, { enumerable: true, configurable: true, get: () => s.value, set: (c) => s.value = c }) : t[o] = s;
    }
  }
  function Dh(e, t, n) {
    ai(xe(e) ? e.map((o) => o.bind(t.proxy)) : e.bind(t.proxy), t, n);
  }
  function Av(e, t, n, o) {
    let a = o.includes(".") ? uv(n, o) : () => n[o];
    if (ht(e)) {
      const s = t[e];
      Pe(s) && vi(a, s);
    } else if (Pe(e)) vi(a, e.bind(n));
    else if (ot(e)) if (xe(e)) e.forEach((s) => Av(s, t, n, o));
    else {
      const s = Pe(e.handler) ? e.handler.bind(n) : t[e.handler];
      Pe(s) && vi(a, s, e);
    }
  }
  function Cv(e) {
    const t = e.type, { mixins: n, extends: o } = t, { mixins: a, optionsCache: s, config: { optionMergeStrategies: c } } = e.appContext, u = s.get(t);
    let f;
    return u ? f = u : !a.length && !n && !o ? f = t : (f = {}, a.length && a.forEach((m) => Fl(f, m, c, true)), Fl(f, t, c)), ot(t) && s.set(t, f), f;
  }
  function Fl(e, t, n, o = false) {
    const { mixins: a, extends: s } = t;
    s && Fl(e, s, n, true), a && a.forEach((c) => Fl(e, c, n, true));
    for (const c in t) if (!(o && c === "expose")) {
      const u = v2[c] || n && n[c];
      e[c] = u ? u(e[c], t[c]) : t[c];
    }
    return e;
  }
  const v2 = { data: Mh, props: Lh, emits: Lh, methods: Na, computed: Na, beforeCreate: pn, created: pn, beforeMount: pn, mounted: pn, beforeUpdate: pn, updated: pn, beforeDestroy: pn, beforeUnmount: pn, destroyed: pn, unmounted: pn, activated: pn, deactivated: pn, errorCaptured: pn, serverPrefetch: pn, components: Na, directives: Na, watch: S2, provide: Mh, inject: w2 };
  function Mh(e, t) {
    return t ? e ? function() {
      return Vt(Pe(e) ? e.call(this, this) : e, Pe(t) ? t.call(this, this) : t);
    } : t : e;
  }
  function w2(e, t) {
    return Na(wd(e), wd(t));
  }
  function wd(e) {
    if (xe(e)) {
      const t = {};
      for (let n = 0; n < e.length; n++) t[e[n]] = e[n];
      return t;
    }
    return e;
  }
  function pn(e, t) {
    return e ? [...new Set([].concat(e, t))] : t;
  }
  function Na(e, t) {
    return e ? Vt(/* @__PURE__ */ Object.create(null), e, t) : t;
  }
  function Lh(e, t) {
    return e ? xe(e) && xe(t) ? [.../* @__PURE__ */ new Set([...e, ...t])] : Vt(/* @__PURE__ */ Object.create(null), zh(e), zh(t ?? {})) : t;
  }
  function S2(e, t) {
    if (!e) return t;
    if (!t) return e;
    const n = Vt(/* @__PURE__ */ Object.create(null), e);
    for (const o in t) n[o] = pn(e[o], t[o]);
    return n;
  }
  function Tv() {
    return { app: null, config: { isNativeTag: Ty, performance: false, globalProperties: {}, optionMergeStrategies: {}, errorHandler: void 0, warnHandler: void 0, compilerOptions: {} }, mixins: [], components: {}, directives: {}, provides: /* @__PURE__ */ Object.create(null), optionsCache: /* @__PURE__ */ new WeakMap(), propsCache: /* @__PURE__ */ new WeakMap(), emitsCache: /* @__PURE__ */ new WeakMap() };
  }
  let b2 = 0;
  function _2(e, t) {
    return function(o, a = null) {
      Pe(o) || (o = Vt({}, o)), a != null && !ot(a) && (a = null);
      const s = Tv(), c = /* @__PURE__ */ new WeakSet(), u = [];
      let f = false;
      const m = s.app = { _uid: b2++, _component: o, _props: a, _container: null, _context: s, _instance: null, version: X2, get config() {
        return s.config;
      }, set config(h) {
      }, use(h, ...v) {
        return c.has(h) || (h && Pe(h.install) ? (c.add(h), h.install(m, ...v)) : Pe(h) && (c.add(h), h(m, ...v))), m;
      }, mixin(h) {
        return s.mixins.includes(h) || s.mixins.push(h), m;
      }, component(h, v) {
        return v ? (s.components[h] = v, m) : s.components[h];
      }, directive(h, v) {
        return v ? (s.directives[h] = v, m) : s.directives[h];
      }, mount(h, v, C) {
        if (!f) {
          const D = m._ceVNode || Kt(o, a);
          return D.appContext = s, C === true ? C = "svg" : C === false && (C = void 0), e(D, h, C), f = true, m._container = h, h.__vue_app__ = m, rc(D.component);
        }
      }, onUnmount(h) {
        u.push(h);
      }, unmount() {
        f && (ai(u, m._instance, 16), e(null, m._container), delete m._container.__vue_app__);
      }, provide(h, v) {
        return s.provides[h] = v, m;
      }, runWithContext(h) {
        const v = ro;
        ro = m;
        try {
          return h();
        } finally {
          ro = v;
        }
      } };
      return m;
    };
  }
  let ro = null;
  const A2 = (e, t) => t === "modelValue" || t === "model-value" ? e.modelModifiers : e[`${t}Modifiers`] || e[`${wn(t)}Modifiers`] || e[`${po(t)}Modifiers`];
  function C2(e, t, ...n) {
    if (e.isUnmounted) return;
    const o = e.vnode.props || yt;
    let a = n;
    const s = t.startsWith("update:"), c = s && A2(o, t.slice(7));
    c && (c.trim && (a = n.map((h) => ht(h) ? h.trim() : h)), c.number && (a = n.map(sE)));
    let u, f = o[u = Nu(t)] || o[u = Nu(wn(t))];
    !f && s && (f = o[u = Nu(po(t))]), f && ai(f, e, 6, a);
    const m = o[u + "Once"];
    if (m) {
      if (!e.emitted) e.emitted = {};
      else if (e.emitted[u]) return;
      e.emitted[u] = true, ai(m, e, 6, a);
    }
  }
  const T2 = /* @__PURE__ */ new WeakMap();
  function Ev(e, t, n = false) {
    const o = n ? T2 : t.emitsCache, a = o.get(e);
    if (a !== void 0) return a;
    const s = e.emits;
    let c = {}, u = false;
    if (!Pe(e)) {
      const f = (m) => {
        const h = Ev(m, t, true);
        h && (u = true, Vt(c, h));
      };
      !n && t.mixins.length && t.mixins.forEach(f), e.extends && f(e.extends), e.mixins && e.mixins.forEach(f);
    }
    return !s && !u ? (ot(e) && o.set(e, null), null) : (xe(s) ? s.forEach((f) => c[f] = null) : Vt(c, s), ot(e) && o.set(e, c), c);
  }
  function ic(e, t) {
    return !e || !ql(t) ? false : (t = t.slice(2).replace(/Once$/, ""), et(e, t[0].toLowerCase() + t.slice(1)) || et(e, po(t)) || et(e, t));
  }
  function xh(e) {
    const { type: t, vnode: n, proxy: o, withProxy: a, propsOptions: [s], slots: c, attrs: u, emit: f, render: m, renderCache: h, props: v, data: C, setupState: D, ctx: W, inheritAttrs: E } = e, L = Pl(e);
    let b, P;
    try {
      if (n.shapeFlag & 4) {
        const k = a || o, j = k;
        b = Oi(m.call(j, k, h, v, D, C, W)), P = u;
      } else {
        const k = t;
        b = Oi(k.length > 1 ? k(v, { attrs: u, slots: c, emit: f }) : k(v, null)), P = t.props ? u : E2(u);
      }
    } catch (k) {
      Ga.length = 0, ec(k, e, 1), b = Kt(sn);
    }
    let B = b;
    if (P && E !== false) {
      const k = Object.keys(P), { shapeFlag: j } = B;
      k.length && j & 7 && (s && k.some($l) && (P = k2(P, s)), B = xr(B, P, false, true));
    }
    return n.dirs && (B = xr(B, null, false, true), B.dirs = B.dirs ? B.dirs.concat(n.dirs) : n.dirs), n.transition && es(B, n.transition), b = B, Pl(L), b;
  }
  const E2 = (e) => {
    let t;
    for (const n in e) (n === "class" || n === "style" || ql(n)) && ((t || (t = {}))[n] = e[n]);
    return t;
  }, k2 = (e, t) => {
    const n = {};
    for (const o in e) (!$l(o) || !(o.slice(9) in t)) && (n[o] = e[o]);
    return n;
  };
  function z2(e, t, n) {
    const { props: o, children: a, component: s } = e, { props: c, children: u, patchFlag: f } = t, m = s.emitsOptions;
    if (t.dirs || t.transition) return true;
    if (n && f >= 0) {
      if (f & 1024) return true;
      if (f & 16) return o ? Oh(o, c, m) : !!c;
      if (f & 8) {
        const h = t.dynamicProps;
        for (let v = 0; v < h.length; v++) {
          const C = h[v];
          if (kv(c, o, C) && !ic(m, C)) return true;
        }
      }
    } else return (a || u) && (!u || !u.$stable) ? true : o === c ? false : o ? c ? Oh(o, c, m) : true : !!c;
    return false;
  }
  function Oh(e, t, n) {
    const o = Object.keys(t);
    if (o.length !== Object.keys(e).length) return true;
    for (let a = 0; a < o.length; a++) {
      const s = o[a];
      if (kv(t, e, s) && !ic(n, s)) return true;
    }
    return false;
  }
  function kv(e, t, n) {
    const o = e[n], a = t[n];
    return n === "style" && ot(o) && ot(a) ? !Xd(o, a) : o !== a;
  }
  function D2({ vnode: e, parent: t, suspense: n }, o) {
    for (; t; ) {
      const a = t.subTree;
      if (a.suspense && a.suspense.activeBranch === e && (a.suspense.vnode.el = a.el = o, e = a), a === e) (e = t.vnode).el = o, t = t.parent;
      else break;
    }
    n && n.activeBranch === e && (n.vnode.el = o);
  }
  const zv = {}, Dv = () => Object.create(zv), Mv = (e) => Object.getPrototypeOf(e) === zv;
  function M2(e, t, n, o = false) {
    const a = {}, s = Dv();
    e.propsDefaults = /* @__PURE__ */ Object.create(null), Lv(e, t, a, s);
    for (const c in e.propsOptions[0]) c in a || (a[c] = void 0);
    n ? e.props = o ? a : lf(a) : e.type.props ? e.props = a : e.props = s, e.attrs = s;
  }
  function L2(e, t, n, o) {
    const { props: a, attrs: s, vnode: { patchFlag: c } } = e, u = Xe(a), [f] = e.propsOptions;
    let m = false;
    if ((o || c > 0) && !(c & 16)) {
      if (c & 8) {
        const h = e.vnode.dynamicProps;
        for (let v = 0; v < h.length; v++) {
          let C = h[v];
          if (ic(e.emitsOptions, C)) continue;
          const D = t[C];
          if (f) if (et(s, C)) D !== s[C] && (s[C] = D, m = true);
          else {
            const W = wn(C);
            a[W] = Sd(f, u, W, D, e, false);
          }
          else D !== s[C] && (s[C] = D, m = true);
        }
      }
    } else {
      Lv(e, t, a, s) && (m = true);
      let h;
      for (const v in u) (!t || !et(t, v) && ((h = po(v)) === v || !et(t, h))) && (f ? n && (n[v] !== void 0 || n[h] !== void 0) && (a[v] = Sd(f, u, v, void 0, e, true)) : delete a[v]);
      if (s !== u) for (const v in s) (!t || !et(t, v)) && (delete s[v], m = true);
    }
    m && Ji(e.attrs, "set", "");
  }
  function Lv(e, t, n, o) {
    const [a, s] = e.propsOptions;
    let c = false, u;
    if (t) for (let f in t) {
      if (Ua(f)) continue;
      const m = t[f];
      let h;
      a && et(a, h = wn(f)) ? !s || !s.includes(h) ? n[h] = m : (u || (u = {}))[h] = m : ic(e.emitsOptions, f) || (!(f in o) || m !== o[f]) && (o[f] = m, c = true);
    }
    if (s) {
      const f = Xe(n), m = u || yt;
      for (let h = 0; h < s.length; h++) {
        const v = s[h];
        n[v] = Sd(a, f, v, m[v], e, !et(m, v));
      }
    }
    return c;
  }
  function Sd(e, t, n, o, a, s) {
    const c = e[n];
    if (c != null) {
      const u = et(c, "default");
      if (u && o === void 0) {
        const f = c.default;
        if (c.type !== Function && !c.skipFactory && Pe(f)) {
          const { propsDefaults: m } = a;
          if (n in m) o = m[n];
          else {
            const h = hs(a);
            o = m[n] = f.call(null, t), h();
          }
        } else o = f;
        a.ce && a.ce._setProp(n, o);
      }
      c[0] && (s && !u ? o = false : c[1] && (o === "" || o === po(n)) && (o = true));
    }
    return o;
  }
  const x2 = /* @__PURE__ */ new WeakMap();
  function xv(e, t, n = false) {
    const o = n ? x2 : t.propsCache, a = o.get(e);
    if (a) return a;
    const s = e.props, c = {}, u = [];
    let f = false;
    if (!Pe(e)) {
      const h = (v) => {
        f = true;
        const [C, D] = xv(v, t, true);
        Vt(c, C), D && u.push(...D);
      };
      !n && t.mixins.length && t.mixins.forEach(h), e.extends && h(e.extends), e.mixins && e.mixins.forEach(h);
    }
    if (!s && !f) return ot(e) && o.set(e, ea), ea;
    if (xe(s)) for (let h = 0; h < s.length; h++) {
      const v = wn(s[h]);
      Ph(v) && (c[v] = yt);
    }
    else if (s) for (const h in s) {
      const v = wn(h);
      if (Ph(v)) {
        const C = s[h], D = c[v] = xe(C) || Pe(C) ? { type: C } : Vt({}, C), W = D.type;
        let E = false, L = true;
        if (xe(W)) for (let b = 0; b < W.length; ++b) {
          const P = W[b], B = Pe(P) && P.name;
          if (B === "Boolean") {
            E = true;
            break;
          } else B === "String" && (L = false);
        }
        else E = Pe(W) && W.name === "Boolean";
        D[0] = E, D[1] = L, (E || et(D, "default")) && u.push(v);
      }
    }
    const m = [c, u];
    return ot(e) && o.set(e, m), m;
  }
  function Ph(e) {
    return e[0] !== "$" && !Ua(e);
  }
  const pf = (e) => e === "_" || e === "_ctx" || e === "$stable", mf = (e) => xe(e) ? e.map(Oi) : [Oi(e)], O2 = (e, t, n) => {
    if (t._n) return t;
    const o = Va((...a) => mf(t(...a)), n);
    return o._c = false, o;
  }, Ov = (e, t, n) => {
    const o = e._ctx;
    for (const a in e) {
      if (pf(a)) continue;
      const s = e[a];
      if (Pe(s)) t[a] = O2(a, s, o);
      else if (s != null) {
        const c = mf(s);
        t[a] = () => c;
      }
    }
  }, Pv = (e, t) => {
    const n = mf(t);
    e.slots.default = () => n;
  }, Iv = (e, t, n) => {
    for (const o in t) (n || !pf(o)) && (e[o] = t[o]);
  }, P2 = (e, t, n) => {
    const o = e.slots = Dv();
    if (e.vnode.shapeFlag & 32) {
      const a = t._;
      a ? (Iv(o, t, n), n && My(o, "_", a, true)) : Ov(t, o);
    } else t && Pv(e, t);
  }, I2 = (e, t, n) => {
    const { vnode: o, slots: a } = e;
    let s = true, c = yt;
    if (o.shapeFlag & 32) {
      const u = t._;
      u ? n && u === 1 ? s = false : Iv(a, t, n) : (s = !t.$stable, Ov(t, a)), c = t;
    } else t && (Pv(e, t), c = { default: 1 });
    if (s) for (const u in a) !pf(u) && c[u] == null && delete a[u];
  }, Mn = B2;
  function R2(e) {
    return F2(e);
  }
  function F2(e, t) {
    const n = Zl();
    n.__VUE__ = true;
    const { insert: o, remove: a, patchProp: s, createElement: c, createText: u, createComment: f, setText: m, setElementText: h, parentNode: v, nextSibling: C, setScopeId: D = gi, insertStaticContent: W } = e, E = (_, z, U, Y = null, J = null, X = null, w = void 0, S = null, x = !!z.dynamicChildren) => {
      if (_ === z) return;
      _ && !eo(_, z) && (Y = ft(_), ke(_, J, X, true), _ = null), z.patchFlag === -2 && (x = false, z.dynamicChildren = null);
      const { type: N, ref: de, shapeFlag: Z } = z;
      switch (N) {
        case ms:
          L(_, z, U, Y);
          break;
        case sn:
          b(_, z, U, Y);
          break;
        case Gu:
          _ == null && P(z, U, Y, w);
          break;
        case an:
          re(_, z, U, Y, J, X, w, S, x);
          break;
        default:
          Z & 1 ? j(_, z, U, Y, J, X, w, S, x) : Z & 6 ? Ee(_, z, U, Y, J, X, w, S, x) : (Z & 64 || Z & 128) && N.process(_, z, U, Y, J, X, w, S, x, be);
      }
      de != null && J ? qa(de, _ && _.ref, X, z || _, !z) : de == null && _ && _.ref != null && qa(_.ref, null, X, _, true);
    }, L = (_, z, U, Y) => {
      if (_ == null) o(z.el = u(z.children), U, Y);
      else {
        const J = z.el = _.el;
        z.children !== _.children && m(J, z.children);
      }
    }, b = (_, z, U, Y) => {
      _ == null ? o(z.el = f(z.children || ""), U, Y) : z.el = _.el;
    }, P = (_, z, U, Y) => {
      [_.el, _.anchor] = W(_.children, z, U, Y, _.el, _.anchor);
    }, B = ({ el: _, anchor: z }, U, Y) => {
      let J;
      for (; _ && _ !== z; ) J = C(_), o(_, U, Y), _ = J;
      o(z, U, Y);
    }, k = ({ el: _, anchor: z }) => {
      let U;
      for (; _ && _ !== z; ) U = C(_), a(_), _ = U;
      a(z);
    }, j = (_, z, U, Y, J, X, w, S, x) => {
      if (z.type === "svg" ? w = "svg" : z.type === "math" && (w = "mathml"), _ == null) $(z, U, Y, J, X, w, S, x);
      else {
        const N = _.el && _.el._isVueCE ? _.el : null;
        try {
          N && N._beginPatch(), ee(_, z, J, X, w, S, x);
        } finally {
          N && N._endPatch();
        }
      }
    }, $ = (_, z, U, Y, J, X, w, S) => {
      let x, N;
      const { props: de, shapeFlag: Z, transition: O, dirs: H } = _;
      if (x = _.el = c(_.type, X, de && de.is, de), Z & 8 ? h(x, _.children) : Z & 16 && ue(_.children, x, null, Y, J, $u(_, X), w, S), H && Kr(_, null, Y, "created"), q(x, _, _.scopeId, w, Y), de) {
        for (const ze in de) ze !== "value" && !Ua(ze) && s(x, ze, null, de[ze], X, Y);
        "value" in de && s(x, "value", null, de.value, X), (N = de.onVnodeBeforeMount) && zi(N, Y, _);
      }
      H && Kr(_, null, Y, "beforeMount");
      const ge = N2(J, O);
      ge && O.beforeEnter(x), o(x, z, U), ((N = de && de.onVnodeMounted) || ge || H) && Mn(() => {
        try {
          N && zi(N, Y, _), ge && O.enter(x), H && Kr(_, null, Y, "mounted");
        } finally {
        }
      }, J);
    }, q = (_, z, U, Y, J) => {
      if (U && D(_, U), Y) for (let X = 0; X < Y.length; X++) D(_, Y[X]);
      if (J) {
        let X = J.subTree;
        if (z === X || Wv(X.type) && (X.ssContent === z || X.ssFallback === z)) {
          const w = J.vnode;
          q(_, w, w.scopeId, w.slotScopeIds, J.parent);
        }
      }
    }, ue = (_, z, U, Y, J, X, w, S, x = 0) => {
      for (let N = x; N < _.length; N++) {
        const de = _[N] = S ? Qi(_[N]) : Oi(_[N]);
        E(null, de, z, U, Y, J, X, w, S);
      }
    }, ee = (_, z, U, Y, J, X, w) => {
      const S = z.el = _.el;
      let { patchFlag: x, dynamicChildren: N, dirs: de } = z;
      x |= _.patchFlag & 16;
      const Z = _.props || yt, O = z.props || yt;
      let H;
      if (U && Yr(U, false), (H = O.onVnodeBeforeUpdate) && zi(H, U, z, _), de && Kr(z, _, U, "beforeUpdate"), U && Yr(U, true), (Z.innerHTML && O.innerHTML == null || Z.textContent && O.textContent == null) && h(S, ""), N ? se(_.dynamicChildren, N, S, U, Y, $u(z, J), X) : w || ie(_, z, S, null, U, Y, $u(z, J), X, false), x > 0) {
        if (x & 16) le(S, Z, O, U, J);
        else if (x & 2 && Z.class !== O.class && s(S, "class", null, O.class, J), x & 4 && s(S, "style", Z.style, O.style, J), x & 8) {
          const ge = z.dynamicProps;
          for (let ze = 0; ze < ge.length; ze++) {
            const Fe = ge[ze], Ke = Z[Fe], Qe = O[Fe];
            (Qe !== Ke || Fe === "value") && s(S, Fe, Ke, Qe, J, U);
          }
        }
        x & 1 && _.children !== z.children && h(S, z.children);
      } else !w && N == null && le(S, Z, O, U, J);
      ((H = O.onVnodeUpdated) || de) && Mn(() => {
        H && zi(H, U, z, _), de && Kr(z, _, U, "updated");
      }, Y);
    }, se = (_, z, U, Y, J, X, w) => {
      for (let S = 0; S < z.length; S++) {
        const x = _[S], N = z[S], de = x.el && (x.type === an || !eo(x, N) || x.shapeFlag & 198) ? v(x.el) : U;
        E(x, N, de, null, Y, J, X, w, true);
      }
    }, le = (_, z, U, Y, J) => {
      if (z !== U) {
        if (z !== yt) for (const X in z) !Ua(X) && !(X in U) && s(_, X, z[X], null, J, Y);
        for (const X in U) {
          if (Ua(X)) continue;
          const w = U[X], S = z[X];
          w !== S && X !== "value" && s(_, X, S, w, J, Y);
        }
        "value" in U && s(_, "value", z.value, U.value, J);
      }
    }, re = (_, z, U, Y, J, X, w, S, x) => {
      const N = z.el = _ ? _.el : u(""), de = z.anchor = _ ? _.anchor : u("");
      let { patchFlag: Z, dynamicChildren: O, slotScopeIds: H } = z;
      H && (S = S ? S.concat(H) : H), _ == null ? (o(N, U, Y), o(de, U, Y), ue(z.children || [], U, de, J, X, w, S, x)) : Z > 0 && Z & 64 && O && _.dynamicChildren && _.dynamicChildren.length === O.length ? (se(_.dynamicChildren, O, U, J, X, w, S), (z.key != null || J && z === J.subTree) && Rv(_, z, true)) : ie(_, z, U, de, J, X, w, S, x);
    }, Ee = (_, z, U, Y, J, X, w, S, x) => {
      z.slotScopeIds = S, _ == null ? z.shapeFlag & 512 ? J.ctx.activate(z, U, Y, w, x) : fe(z, U, Y, J, X, w, x) : ce(_, z, x);
    }, fe = (_, z, U, Y, J, X, w) => {
      const S = _.component = $2(_, Y, J);
      if (tc(_) && (S.ctx.renderer = be), G2(S, false, w), S.asyncDep) {
        if (J && J.registerDep(S, G, w), !_.el) {
          const x = S.subTree = Kt(sn);
          b(null, x, z, U), _.placeholder = x.el;
        }
      } else G(S, _, z, U, J, X, w);
    }, ce = (_, z, U) => {
      const Y = z.component = _.component;
      if (z2(_, z, U)) if (Y.asyncDep && !Y.asyncResolved) {
        oe(Y, z, U);
        return;
      } else Y.next = z, Y.update();
      else z.el = _.el, Y.vnode = z;
    }, G = (_, z, U, Y, J, X, w) => {
      const S = () => {
        if (_.isMounted) {
          let { next: Z, bu: O, u: H, parent: ge, vnode: ze } = _;
          {
            const vt = Fv(_);
            if (vt) {
              Z && (Z.el = ze.el, oe(_, Z, w)), vt.asyncDep.then(() => {
                Mn(() => {
                  _.isUnmounted || N();
                }, J);
              });
              return;
            }
          }
          let Fe = Z, Ke;
          Yr(_, false), Z ? (Z.el = ze.el, oe(_, Z, w)) : Z = ze, O && Wu(O), (Ke = Z.props && Z.props.onVnodeBeforeUpdate) && zi(Ke, ge, Z, ze), Yr(_, true);
          const Qe = xh(_), Et = _.subTree;
          _.subTree = Qe, E(Et, Qe, v(Et.el), ft(Et), _, J, X), Z.el = Qe.el, Fe === null && D2(_, Qe.el), H && Mn(H, J), (Ke = Z.props && Z.props.onVnodeUpdated) && Mn(() => zi(Ke, ge, Z, ze), J);
        } else {
          let Z;
          const { el: O, props: H } = z, { bm: ge, m: ze, parent: Fe, root: Ke, type: Qe } = _, Et = ra(z);
          Yr(_, false), ge && Wu(ge), !Et && (Z = H && H.onVnodeBeforeMount) && zi(Z, Fe, z), Yr(_, true);
          {
            Ke.ce && Ke.ce._hasShadowRoot() && Ke.ce._injectChildStyle(Qe, _.parent ? _.parent.type : void 0);
            const vt = _.subTree = xh(_);
            E(null, vt, U, Y, _, J, X), z.el = vt.el;
          }
          if (ze && Mn(ze, J), !Et && (Z = H && H.onVnodeMounted)) {
            const vt = z;
            Mn(() => zi(Z, Fe, vt), J);
          }
          (z.shapeFlag & 256 || Fe && ra(Fe.vnode) && Fe.vnode.shapeFlag & 256) && _.a && Mn(_.a, J), _.isMounted = true, z = U = Y = null;
        }
      };
      _.scope.on();
      const x = _.effect = new Fy(S);
      _.scope.off();
      const N = _.update = x.run.bind(x), de = _.job = x.runIfDirty.bind(x);
      de.i = _, de.id = _.uid, x.scheduler = () => df(de), Yr(_, true), N();
    }, oe = (_, z, U) => {
      z.component = _;
      const Y = _.vnode.props;
      _.vnode = z, _.next = null, L2(_, z.props, Y, U), I2(_, z.children, U), or(), Ah(_), ar();
    }, ie = (_, z, U, Y, J, X, w, S, x = false) => {
      const N = _ && _.children, de = _ ? _.shapeFlag : 0, Z = z.children, { patchFlag: O, shapeFlag: H } = z;
      if (O > 0) {
        if (O & 128) {
          we(N, Z, U, Y, J, X, w, S, x);
          return;
        } else if (O & 256) {
          pe(N, Z, U, Y, J, X, w, S, x);
          return;
        }
      }
      H & 8 ? (de & 16 && Re(N, J, X), Z !== N && h(U, Z)) : de & 16 ? H & 16 ? we(N, Z, U, Y, J, X, w, S, x) : Re(N, J, X, true) : (de & 8 && h(U, ""), H & 16 && ue(Z, U, Y, J, X, w, S, x));
    }, pe = (_, z, U, Y, J, X, w, S, x) => {
      _ = _ || ea, z = z || ea;
      const N = _.length, de = z.length, Z = Math.min(N, de);
      let O;
      for (O = 0; O < Z; O++) {
        const H = z[O] = x ? Qi(z[O]) : Oi(z[O]);
        E(_[O], H, U, null, J, X, w, S, x);
      }
      N > de ? Re(_, J, X, true, false, Z) : ue(z, U, Y, J, X, w, S, x, Z);
    }, we = (_, z, U, Y, J, X, w, S, x) => {
      let N = 0;
      const de = z.length;
      let Z = _.length - 1, O = de - 1;
      for (; N <= Z && N <= O; ) {
        const H = _[N], ge = z[N] = x ? Qi(z[N]) : Oi(z[N]);
        if (eo(H, ge)) E(H, ge, U, null, J, X, w, S, x);
        else break;
        N++;
      }
      for (; N <= Z && N <= O; ) {
        const H = _[Z], ge = z[O] = x ? Qi(z[O]) : Oi(z[O]);
        if (eo(H, ge)) E(H, ge, U, null, J, X, w, S, x);
        else break;
        Z--, O--;
      }
      if (N > Z) {
        if (N <= O) {
          const H = O + 1, ge = H < de ? z[H].el : Y;
          for (; N <= O; ) E(null, z[N] = x ? Qi(z[N]) : Oi(z[N]), U, ge, J, X, w, S, x), N++;
        }
      } else if (N > O) for (; N <= Z; ) ke(_[N], J, X, true), N++;
      else {
        const H = N, ge = N, ze = /* @__PURE__ */ new Map();
        for (N = ge; N <= O; N++) {
          const Nt = z[N] = x ? Qi(z[N]) : Oi(z[N]);
          Nt.key != null && ze.set(Nt.key, N);
        }
        let Fe, Ke = 0;
        const Qe = O - ge + 1;
        let Et = false, vt = 0;
        const In = new Array(Qe);
        for (N = 0; N < Qe; N++) In[N] = 0;
        for (N = H; N <= Z; N++) {
          const Nt = _[N];
          if (Ke >= Qe) {
            ke(Nt, J, X, true);
            continue;
          }
          let qt;
          if (Nt.key != null) qt = ze.get(Nt.key);
          else for (Fe = ge; Fe <= O; Fe++) if (In[Fe - ge] === 0 && eo(Nt, z[Fe])) {
            qt = Fe;
            break;
          }
          qt === void 0 ? ke(Nt, J, X, true) : (In[qt - ge] = N + 1, qt >= vt ? vt = qt : Et = true, E(Nt, z[qt], U, null, J, X, w, S, x), Ke++);
        }
        const Fi = Et ? W2(In) : ea;
        for (Fe = Fi.length - 1, N = Qe - 1; N >= 0; N--) {
          const Nt = ge + N, qt = z[Nt], Ni = z[Nt + 1], si = Nt + 1 < de ? Ni.el || Nv(Ni) : Y;
          In[N] === 0 ? E(null, qt, U, si, J, X, w, S, x) : Et && (Fe < 0 || N !== Fi[Fe] ? Te(qt, U, si, 2) : Fe--);
        }
      }
    }, Te = (_, z, U, Y, J = null) => {
      const { el: X, type: w, transition: S, children: x, shapeFlag: N } = _;
      if (N & 6) {
        Te(_.component.subTree, z, U, Y);
        return;
      }
      if (N & 128) {
        _.suspense.move(z, U, Y);
        return;
      }
      if (N & 64) {
        w.move(_, z, U, be);
        return;
      }
      if (w === an) {
        o(X, z, U);
        for (let Z = 0; Z < x.length; Z++) Te(x[Z], z, U, Y);
        o(_.anchor, z, U);
        return;
      }
      if (w === Gu) {
        B(_, z, U);
        return;
      }
      if (Y !== 2 && N & 1 && S) if (Y === 0) S.persisted && !X[ti] ? o(X, z, U) : (S.beforeEnter(X), o(X, z, U), Mn(() => S.enter(X), J));
      else {
        const { leave: Z, delayLeave: O, afterLeave: H } = S, ge = () => {
          _.ctx.isUnmounted ? a(X) : o(X, z, U);
        }, ze = () => {
          const Fe = X._isLeaving || !!X[ti];
          X._isLeaving && X[ti](true), S.persisted && !Fe ? ge() : Z(X, () => {
            ge(), H && H();
          });
        };
        O ? O(X, ge, ze) : ze();
      }
      else o(X, z, U);
    }, ke = (_, z, U, Y = false, J = false) => {
      const { type: X, props: w, ref: S, children: x, dynamicChildren: N, shapeFlag: de, patchFlag: Z, dirs: O, cacheIndex: H, memo: ge } = _;
      if (Z === -2 && (J = false), S != null && (or(), qa(S, null, U, _, true), ar()), H != null && (z.renderCache[H] = void 0), de & 256) {
        z.ctx.deactivate(_);
        return;
      }
      const ze = de & 1 && O, Fe = !ra(_);
      let Ke;
      if (Fe && (Ke = w && w.onVnodeBeforeUnmount) && zi(Ke, z, _), de & 6) it(_.component, U, Y);
      else {
        if (de & 128) {
          _.suspense.unmount(U, Y);
          return;
        }
        ze && Kr(_, null, z, "beforeUnmount"), de & 64 ? _.type.remove(_, z, U, be, Y) : N && !N.hasOnce && (X !== an || Z > 0 && Z & 64) ? Re(N, z, U, false, true) : (X === an && Z & 384 || !J && de & 16) && Re(x, z, U), Y && tt(_);
      }
      const Qe = ge != null && H == null;
      (Fe && (Ke = w && w.onVnodeUnmounted) || ze || Qe) && Mn(() => {
        Ke && zi(Ke, z, _), ze && Kr(_, null, z, "unmounted"), Qe && (_.el = null);
      }, U);
    }, tt = (_) => {
      const { type: z, el: U, anchor: Y, transition: J } = _;
      if (z === an) {
        Me(U, Y);
        return;
      }
      if (z === Gu) {
        k(_);
        return;
      }
      const X = () => {
        a(U), J && !J.persisted && J.afterLeave && J.afterLeave();
      };
      if (_.shapeFlag & 1 && J && !J.persisted) {
        const { leave: w, delayLeave: S } = J, x = () => w(U, X);
        S ? S(_.el, X, x) : x();
      } else X();
    }, Me = (_, z) => {
      let U;
      for (; _ !== z; ) U = C(_), a(_), _ = U;
      a(z);
    }, it = (_, z, U) => {
      const { bum: Y, scope: J, job: X, subTree: w, um: S, m: x, a: N } = _;
      Ih(x), Ih(N), Y && Wu(Y), J.stop(), X && (X.flags |= 8, ke(w, _, z, U)), S && Mn(S, z), Mn(() => {
        _.isUnmounted = true;
      }, z);
    }, Re = (_, z, U, Y = false, J = false, X = 0) => {
      for (let w = X; w < _.length; w++) ke(_[w], z, U, Y, J);
    }, ft = (_) => {
      if (_.shapeFlag & 6) return ft(_.component.subTree);
      if (_.shapeFlag & 128) return _.suspense.next();
      const z = C(_.anchor || _.el), U = z && z[XE];
      return U ? C(U) : z;
    };
    let Ie = false;
    const pt = (_, z, U) => {
      let Y;
      _ == null ? z._vnode && (ke(z._vnode, null, null, true), Y = z._vnode.component) : E(z._vnode || null, _, z, null, null, null, U), z._vnode = _, Ie || (Ie = true, Ah(Y), ov(), Ie = false);
    }, be = { p: E, um: ke, m: Te, r: tt, mt: fe, mc: ue, pc: ie, pbc: se, n: ft, o: e };
    return { render: pt, hydrate: void 0, createApp: _2(pt) };
  }
  function $u({ type: e, props: t }, n) {
    return n === "svg" && e === "foreignObject" || n === "mathml" && e === "annotation-xml" && t && t.encoding && t.encoding.includes("html") ? void 0 : n;
  }
  function Yr({ effect: e, job: t }, n) {
    n ? (e.flags |= 32, t.flags |= 4) : (e.flags &= -33, t.flags &= -5);
  }
  function N2(e, t) {
    return (!e || e && !e.pendingBranch) && t && !t.persisted;
  }
  function Rv(e, t, n = false) {
    const o = e.children, a = t.children;
    if (xe(o) && xe(a)) for (let s = 0; s < o.length; s++) {
      const c = o[s];
      let u = a[s];
      u.shapeFlag & 1 && !u.dynamicChildren && ((u.patchFlag <= 0 || u.patchFlag === 32) && (u = a[s] = Qi(a[s]), u.el = c.el), !n && u.patchFlag !== -2 && Rv(c, u)), u.type === ms && (u.patchFlag === -1 && (u = a[s] = Qi(u)), u.el = c.el), u.type === sn && !u.el && (u.el = c.el);
    }
  }
  function W2(e) {
    const t = e.slice(), n = [0];
    let o, a, s, c, u;
    const f = e.length;
    for (o = 0; o < f; o++) {
      const m = e[o];
      if (m !== 0) {
        if (a = n[n.length - 1], e[a] < m) {
          t[o] = a, n.push(o);
          continue;
        }
        for (s = 0, c = n.length - 1; s < c; ) u = s + c >> 1, e[n[u]] < m ? s = u + 1 : c = u;
        m < e[n[s]] && (s > 0 && (t[o] = n[s - 1]), n[s] = o);
      }
    }
    for (s = n.length, c = n[s - 1]; s-- > 0; ) n[s] = c, c = t[c];
    return n;
  }
  function Fv(e) {
    const t = e.subTree.component;
    if (t) return t.asyncDep && !t.asyncResolved ? t : Fv(t);
  }
  function Ih(e) {
    if (e) for (let t = 0; t < e.length; t++) e[t].flags |= 8;
  }
  function Nv(e) {
    if (e.placeholder) return e.placeholder;
    const t = e.component;
    return t ? Nv(t.subTree) : null;
  }
  const Wv = (e) => e.__isSuspense;
  function B2(e, t) {
    t && t.pendingBranch ? xe(e) ? t.effects.push(...e) : t.effects.push(e) : GE(e);
  }
  const an = /* @__PURE__ */ Symbol.for("v-fgt"), ms = /* @__PURE__ */ Symbol.for("v-txt"), sn = /* @__PURE__ */ Symbol.for("v-cmt"), Gu = /* @__PURE__ */ Symbol.for("v-stc"), Ga = [];
  let Vn = null;
  function Gt(e = false) {
    Ga.push(Vn = e ? null : []);
  }
  function U2() {
    Ga.pop(), Vn = Ga[Ga.length - 1] || null;
  }
  let ts = 1;
  function Nl(e, t = false) {
    ts += e, e < 0 && Vn && t && (Vn.hasOnce = true);
  }
  function Bv(e) {
    return e.dynamicChildren = ts > 0 ? Vn || ea : null, U2(), ts > 0 && Vn && Vn.push(e), e;
  }
  function Ri(e, t, n, o, a, s) {
    return Bv(lr(e, t, n, o, a, s, true));
  }
  function Mr(e, t, n, o, a) {
    return Bv(Kt(e, t, n, o, a, true));
  }
  function ao(e) {
    return e ? e.__v_isVNode === true : false;
  }
  function eo(e, t) {
    return e.type === t.type && e.key === t.key;
  }
  const Uv = ({ key: e }) => e ?? null, Tl = ({ ref: e, ref_key: t, ref_for: n }) => (typeof e == "number" && (e = "" + e), e != null ? ht(e) || bt(e) || Pe(e) ? { i: Xt, r: e, k: t, f: !!n } : e : null);
  function lr(e, t = null, n = null, o = 0, a = null, s = e === an ? 0 : 1, c = false, u = false) {
    const f = { __v_isVNode: true, __v_skip: true, type: e, props: t, key: t && Uv(t), ref: t && Tl(t), scopeId: sv, slotScopeIds: null, children: n, component: null, suspense: null, ssContent: null, ssFallback: null, dirs: null, transition: null, el: null, anchor: null, target: null, targetStart: null, targetAnchor: null, staticCount: 0, shapeFlag: s, patchFlag: o, dynamicProps: a, dynamicChildren: null, appContext: null, ctx: Xt };
    return u ? (gf(f, n), s & 128 && e.normalize(f)) : n && (f.shapeFlag |= ht(n) ? 8 : 16), ts > 0 && !c && Vn && (f.patchFlag > 0 || s & 6) && f.patchFlag !== 32 && Vn.push(f), f;
  }
  const Kt = j2;
  function j2(e, t = null, n = null, o = 0, a = null, s = false) {
    if ((!e || e === bv) && (e = sn), ao(e)) {
      const u = xr(e, t, true);
      return n && gf(u, n), ts > 0 && !s && Vn && (u.shapeFlag & 6 ? Vn[Vn.indexOf(e)] = u : Vn.push(u)), u.patchFlag = -2, u;
    }
    if (J2(e) && (e = e.__vccOpts), t) {
      t = H2(t);
      let { class: u, style: f } = t;
      u && !ht(u) && (t.class = mi(u)), ot(f) && (Xl(f) && !xe(f) && (f = Vt({}, f)), t.style = ds(f));
    }
    const c = ht(e) ? 1 : Wv(e) ? 128 : dv(e) ? 64 : ot(e) ? 4 : Pe(e) ? 2 : 0;
    return lr(e, t, n, o, a, c, s, true);
  }
  function H2(e) {
    return e ? Xl(e) || Mv(e) ? Vt({}, e) : e : null;
  }
  function xr(e, t, n = false, o = false) {
    const { props: a, ref: s, patchFlag: c, children: u, transition: f } = e, m = t ? jv(a || {}, t) : a, h = { __v_isVNode: true, __v_skip: true, type: e.type, props: m, key: m && Uv(m), ref: t && t.ref ? n && s ? xe(s) ? s.concat(Tl(t)) : [s, Tl(t)] : Tl(t) : s, scopeId: e.scopeId, slotScopeIds: e.slotScopeIds, children: u, target: e.target, targetStart: e.targetStart, targetAnchor: e.targetAnchor, staticCount: e.staticCount, shapeFlag: e.shapeFlag, patchFlag: t && e.type !== an ? c === -1 ? 16 : c | 16 : c, dynamicProps: e.dynamicProps, dynamicChildren: e.dynamicChildren, appContext: e.appContext, dirs: e.dirs, transition: f, component: e.component, suspense: e.suspense, ssContent: e.ssContent && xr(e.ssContent), ssFallback: e.ssFallback && xr(e.ssFallback), placeholder: e.placeholder, el: e.el, anchor: e.anchor, ctx: e.ctx, ce: e.ce };
    return f && o && es(h, f.clone(h)), h;
  }
  function hf(e = " ", t = 0) {
    return Kt(ms, null, e, t);
  }
  function Xo(e = "", t = false) {
    return t ? (Gt(), Mr(sn, null, e)) : Kt(sn, null, e);
  }
  function Oi(e) {
    return e == null || typeof e == "boolean" ? Kt(sn) : xe(e) ? Kt(an, null, e.slice()) : ao(e) ? Qi(e) : Kt(ms, null, String(e));
  }
  function Qi(e) {
    return e.el === null && e.patchFlag !== -1 || e.memo ? e : xr(e);
  }
  function gf(e, t) {
    let n = 0;
    const { shapeFlag: o } = e;
    if (t == null) t = null;
    else if (xe(t)) n = 16;
    else if (typeof t == "object") if (o & 65) {
      const a = t.default;
      a && (a._c && (a._d = false), gf(e, a()), a._c && (a._d = true));
      return;
    } else {
      n = 32;
      const a = t._;
      !a && !Mv(t) ? t._ctx = Xt : a === 3 && Xt && (Xt.slots._ === 1 ? t._ = 1 : (t._ = 2, e.patchFlag |= 1024));
    }
    else Pe(t) ? (t = { default: t, _ctx: Xt }, n = 32) : (t = String(t), o & 64 ? (n = 16, t = [hf(t)]) : n = 8);
    e.children = t, e.shapeFlag |= n;
  }
  function jv(...e) {
    const t = {};
    for (let n = 0; n < e.length; n++) {
      const o = e[n];
      for (const a in o) if (a === "class") t.class !== o.class && (t.class = mi([t.class, o.class]));
      else if (a === "style") t.style = ds([t.style, o.style]);
      else if (ql(a)) {
        const s = t[a], c = o[a];
        c && s !== c && !(xe(s) && s.includes(c)) ? t[a] = s ? [].concat(s, c) : c : c == null && s == null && !$l(a) && (t[a] = c);
      } else a !== "" && (t[a] = o[a]);
    }
    return t;
  }
  function zi(e, t, n, o = null) {
    ai(e, t, 7, [n, o]);
  }
  const V2 = Tv();
  let q2 = 0;
  function $2(e, t, n) {
    const o = e.type, a = (t ? t.appContext : e.appContext) || V2, s = { uid: q2++, vnode: e, type: o, parent: t, appContext: a, root: null, next: null, subTree: null, effect: null, update: null, job: null, scope: new Py(true), render: null, proxy: null, exposed: null, exposeProxy: null, withProxy: null, provides: t ? t.provides : Object.create(a.provides), ids: t ? t.ids : ["", 0, 0], accessCache: null, renderCache: [], components: null, directives: null, propsOptions: xv(o, a), emitsOptions: Ev(o, a), emit: null, emitted: null, propsDefaults: yt, inheritAttrs: o.inheritAttrs, ctx: yt, data: yt, props: yt, attrs: yt, slots: yt, refs: yt, setupState: yt, setupContext: null, suspense: n, suspenseId: n ? n.pendingId : 0, asyncDep: null, asyncResolved: false, isMounted: false, isUnmounted: false, isDeactivated: false, bc: null, c: null, bm: null, m: null, bu: null, u: null, um: null, bum: null, da: null, a: null, rtg: null, rtc: null, ec: null, sp: null };
    return s.ctx = { _: s }, s.root = t ? t.root : s, s.emit = C2.bind(null, s), e.ce && e.ce(s), s;
  }
  let ln = null;
  const On = () => ln || Xt;
  let Wl, bd;
  {
    const e = Zl(), t = (n, o) => {
      let a;
      return (a = e[n]) || (a = e[n] = []), a.push(o), (s) => {
        a.length > 1 ? a.forEach((c) => c(s)) : a[0](s);
      };
    };
    Wl = t("__VUE_INSTANCE_SETTERS__", (n) => ln = n), bd = t("__VUE_SSR_SETTERS__", (n) => ns = n);
  }
  const hs = (e) => {
    const t = ln;
    return Wl(e), e.scope.on(), () => {
      e.scope.off(), Wl(t);
    };
  }, Rh = () => {
    ln && ln.scope.off(), Wl(null);
  };
  function Hv(e) {
    return e.vnode.shapeFlag & 4;
  }
  let ns = false;
  function G2(e, t = false, n = false) {
    t && bd(t);
    const { props: o, children: a } = e.vnode, s = Hv(e);
    M2(e, o, s, t), P2(e, a, n || t);
    const c = s ? K2(e, t) : void 0;
    return t && bd(false), c;
  }
  function K2(e, t) {
    const n = e.type;
    e.accessCache = /* @__PURE__ */ Object.create(null), e.proxy = new Proxy(e.ctx, h2);
    const { setup: o } = n;
    if (o) {
      or();
      const a = e.setupContext = o.length > 1 ? Z2(e) : null, s = hs(e), c = fs(o, e, 0, [e.props, a]), u = ky(c);
      if (ar(), s(), (u || e.sp) && !ra(e) && yv(e), u) {
        if (c.then(Rh, Rh), t) return c.then((f) => {
          Fh(e, f);
        }).catch((f) => {
          ec(f, e, 0);
        });
        e.asyncDep = c;
      } else Fh(e, c);
    } else Vv(e);
  }
  function Fh(e, t, n) {
    Pe(t) ? e.type.__ssrInlineRender ? e.ssrRender = t : e.render = t : ot(t) && (e.setupState = tv(t)), Vv(e);
  }
  function Vv(e, t, n) {
    const o = e.type;
    e.render || (e.render = o.render || gi);
    {
      const a = hs(e);
      or();
      try {
        g2(e);
      } finally {
        ar(), a();
      }
    }
  }
  const Y2 = { get(e, t) {
    return on(e, "get", ""), e[t];
  } };
  function Z2(e) {
    const t = (n) => {
      e.exposed = n || {};
    };
    return { attrs: new Proxy(e.attrs, Y2), slots: e.slots, emit: e.emit, expose: t };
  }
  function rc(e) {
    return e.exposed ? e.exposeProxy || (e.exposeProxy = new Proxy(tv(Xy(e.exposed)), { get(t, n) {
      if (n in t) return t[n];
      if (n in $a) return $a[n](e);
    }, has(t, n) {
      return n in t || n in $a;
    } })) : e.proxy;
  }
  function Q2(e, t = true) {
    return Pe(e) ? e.displayName || e.name : e.name || t && e.__name;
  }
  function J2(e) {
    return Pe(e) && "__vccOpts" in e;
  }
  const We = (e, t) => jE(e, t, ns);
  function yf(e, t, n) {
    try {
      Nl(-1);
      const o = arguments.length;
      return o === 2 ? ot(t) && !xe(t) ? ao(t) ? Kt(e, null, [t]) : Kt(e, t) : Kt(e, null, t) : (o > 3 ? n = Array.prototype.slice.call(arguments, 2) : o === 3 && ao(n) && (n = [n]), Kt(e, t, n));
    } finally {
      Nl(1);
    }
  }
  const X2 = "3.5.35", ek = gi;
  /**
  * @vue/runtime-dom v3.5.35
  * (c) 2018-present Yuxi (Evan) You and Vue contributors
  * @license MIT
  **/
  let _d;
  const Nh = typeof window < "u" && window.trustedTypes;
  if (Nh) try {
    _d = Nh.createPolicy("vue", { createHTML: (e) => e });
  } catch {
  }
  const qv = _d ? (e) => _d.createHTML(e) : (e) => e, tk = "http://www.w3.org/2000/svg", nk = "http://www.w3.org/1998/Math/MathML", Zi = typeof document < "u" ? document : null, Wh = Zi && Zi.createElement("template"), ik = { insert: (e, t, n) => {
    t.insertBefore(e, n || null);
  }, remove: (e) => {
    const t = e.parentNode;
    t && t.removeChild(e);
  }, createElement: (e, t, n, o) => {
    const a = t === "svg" ? Zi.createElementNS(tk, e) : t === "mathml" ? Zi.createElementNS(nk, e) : n ? Zi.createElement(e, { is: n }) : Zi.createElement(e);
    return e === "select" && o && o.multiple != null && a.setAttribute("multiple", o.multiple), a;
  }, createText: (e) => Zi.createTextNode(e), createComment: (e) => Zi.createComment(e), setText: (e, t) => {
    e.nodeValue = t;
  }, setElementText: (e, t) => {
    e.textContent = t;
  }, parentNode: (e) => e.parentNode, nextSibling: (e) => e.nextSibling, querySelector: (e) => Zi.querySelector(e), setScopeId(e, t) {
    e.setAttribute(t, "");
  }, insertStaticContent(e, t, n, o, a, s) {
    const c = n ? n.previousSibling : t.lastChild;
    if (a && (a === s || a.nextSibling)) for (; t.insertBefore(a.cloneNode(true), n), !(a === s || !(a = a.nextSibling)); ) ;
    else {
      Wh.innerHTML = qv(o === "svg" ? `<svg>${e}</svg>` : o === "mathml" ? `<math>${e}</math>` : e);
      const u = Wh.content;
      if (o === "svg" || o === "mathml") {
        const f = u.firstChild;
        for (; f.firstChild; ) u.appendChild(f.firstChild);
        u.removeChild(f);
      }
      t.insertBefore(u, n);
    }
    return [c ? c.nextSibling : t.firstChild, n ? n.previousSibling : t.lastChild];
  } }, Er = "transition", xa = "animation", is = /* @__PURE__ */ Symbol("_vtc"), $v = { name: String, type: String, css: { type: Boolean, default: true }, duration: [String, Number, Object], enterFromClass: String, enterActiveClass: String, enterToClass: String, appearFromClass: String, appearActiveClass: String, appearToClass: String, leaveFromClass: String, leaveActiveClass: String, leaveToClass: String }, rk = Vt({}, fv, $v), ok = (e) => (e.displayName = "Transition", e.props = rk, e), Gv = ok((e, { slots: t }) => yf(n2, ak(e), t)), Zr = (e, t = []) => {
    xe(e) ? e.forEach((n) => n(...t)) : e && e(...t);
  }, Bh = (e) => e ? xe(e) ? e.some((t) => t.length > 1) : e.length > 1 : false;
  function ak(e) {
    const t = {};
    for (const re in e) re in $v || (t[re] = e[re]);
    if (e.css === false) return t;
    const { name: n = "v", type: o, duration: a, enterFromClass: s = `${n}-enter-from`, enterActiveClass: c = `${n}-enter-active`, enterToClass: u = `${n}-enter-to`, appearFromClass: f = s, appearActiveClass: m = c, appearToClass: h = u, leaveFromClass: v = `${n}-leave-from`, leaveActiveClass: C = `${n}-leave-active`, leaveToClass: D = `${n}-leave-to` } = e, W = sk(a), E = W && W[0], L = W && W[1], { onBeforeEnter: b, onEnter: P, onEnterCancelled: B, onLeave: k, onLeaveCancelled: j, onBeforeAppear: $ = b, onAppear: q = P, onAppearCancelled: ue = B } = t, ee = (re, Ee, fe, ce) => {
      re._enterCancelled = ce, Qr(re, Ee ? h : u), Qr(re, Ee ? m : c), fe && fe();
    }, se = (re, Ee) => {
      re._isLeaving = false, Qr(re, v), Qr(re, D), Qr(re, C), Ee && Ee();
    }, le = (re) => (Ee, fe) => {
      const ce = re ? q : P, G = () => ee(Ee, re, fe);
      Zr(ce, [Ee, G]), Uh(() => {
        Qr(Ee, re ? f : s), Ki(Ee, re ? h : u), Bh(ce) || jh(Ee, o, E, G);
      });
    };
    return Vt(t, { onBeforeEnter(re) {
      Zr(b, [re]), Ki(re, s), Ki(re, c);
    }, onBeforeAppear(re) {
      Zr($, [re]), Ki(re, f), Ki(re, m);
    }, onEnter: le(false), onAppear: le(true), onLeave(re, Ee) {
      re._isLeaving = true;
      const fe = () => se(re, Ee);
      Ki(re, v), re._enterCancelled ? (Ki(re, C), qh(re)) : (qh(re), Ki(re, C)), Uh(() => {
        re._isLeaving && (Qr(re, v), Ki(re, D), Bh(k) || jh(re, o, L, fe));
      }), Zr(k, [re, fe]);
    }, onEnterCancelled(re) {
      ee(re, false, void 0, true), Zr(B, [re]);
    }, onAppearCancelled(re) {
      ee(re, true, void 0, true), Zr(ue, [re]);
    }, onLeaveCancelled(re) {
      se(re), Zr(j, [re]);
    } });
  }
  function sk(e) {
    if (e == null) return null;
    if (ot(e)) return [Ku(e.enter), Ku(e.leave)];
    {
      const t = Ku(e);
      return [t, t];
    }
  }
  function Ku(e) {
    return lE(e);
  }
  function Ki(e, t) {
    t.split(/\s+/).forEach((n) => n && e.classList.add(n)), (e[is] || (e[is] = /* @__PURE__ */ new Set())).add(t);
  }
  function Qr(e, t) {
    t.split(/\s+/).forEach((o) => o && e.classList.remove(o));
    const n = e[is];
    n && (n.delete(t), n.size || (e[is] = void 0));
  }
  function Uh(e) {
    requestAnimationFrame(() => {
      requestAnimationFrame(e);
    });
  }
  let lk = 0;
  function jh(e, t, n, o) {
    const a = e._endId = ++lk, s = () => {
      a === e._endId && o();
    };
    if (n != null) return setTimeout(s, n);
    const { type: c, timeout: u, propCount: f } = ck(e, t);
    if (!c) return o();
    const m = c + "end";
    let h = 0;
    const v = () => {
      e.removeEventListener(m, C), s();
    }, C = (D) => {
      D.target === e && ++h >= f && v();
    };
    setTimeout(() => {
      h < f && v();
    }, u + 1), e.addEventListener(m, C);
  }
  function ck(e, t) {
    const n = window.getComputedStyle(e), o = (W) => (n[W] || "").split(", "), a = o(`${Er}Delay`), s = o(`${Er}Duration`), c = Hh(a, s), u = o(`${xa}Delay`), f = o(`${xa}Duration`), m = Hh(u, f);
    let h = null, v = 0, C = 0;
    t === Er ? c > 0 && (h = Er, v = c, C = s.length) : t === xa ? m > 0 && (h = xa, v = m, C = f.length) : (v = Math.max(c, m), h = v > 0 ? c > m ? Er : xa : null, C = h ? h === Er ? s.length : f.length : 0);
    const D = h === Er && /\b(?:transform|all)(?:,|$)/.test(o(`${Er}Property`).toString());
    return { type: h, timeout: v, propCount: C, hasTransform: D };
  }
  function Hh(e, t) {
    for (; e.length < t.length; ) e = e.concat(e);
    return Math.max(...t.map((n, o) => Vh(n) + Vh(e[o])));
  }
  function Vh(e) {
    return e === "auto" ? 0 : Number(e.slice(0, -1).replace(",", ".")) * 1e3;
  }
  function qh(e) {
    return (e ? e.ownerDocument : document).body.offsetHeight;
  }
  function uk(e, t, n) {
    const o = e[is];
    o && (t = (t ? [t, ...o] : [...o]).join(" ")), t == null ? e.removeAttribute("class") : n ? e.setAttribute("class", t) : e.className = t;
  }
  const Bl = /* @__PURE__ */ Symbol("_vod"), Kv = /* @__PURE__ */ Symbol("_vsh"), dk = { name: "show", beforeMount(e, { value: t }, { transition: n }) {
    e[Bl] = e.style.display === "none" ? "" : e.style.display, n && t ? n.beforeEnter(e) : Oa(e, t);
  }, mounted(e, { value: t }, { transition: n }) {
    n && t && n.enter(e);
  }, updated(e, { value: t, oldValue: n }, { transition: o }) {
    !t != !n && (o ? t ? (o.beforeEnter(e), Oa(e, true), o.enter(e)) : o.leave(e, () => {
      Oa(e, false);
    }) : Oa(e, t));
  }, beforeUnmount(e, { value: t }) {
    Oa(e, t);
  } };
  function Oa(e, t) {
    e.style.display = t ? e[Bl] : "none", e[Kv] = !t;
  }
  const fk = /* @__PURE__ */ Symbol(""), pk = /(?:^|;)\s*display\s*:/;
  function mk(e, t, n) {
    const o = e.style, a = ht(n);
    let s = false;
    if (n && !a) {
      if (t) if (ht(t)) for (const c of t.split(";")) {
        const u = c.slice(0, c.indexOf(":")).trim();
        n[u] == null && Wa(o, u, "");
      }
      else for (const c in t) n[c] == null && Wa(o, c, "");
      for (const c in n) {
        c === "display" && (s = true);
        const u = n[c];
        u != null ? gk(e, c, !ht(t) && t ? t[c] : void 0, u) || Wa(o, c, u) : Wa(o, c, "");
      }
    } else if (a) {
      if (t !== n) {
        const c = o[fk];
        c && (n += ";" + c), o.cssText = n, s = pk.test(n);
      }
    } else t && e.removeAttribute("style");
    Bl in e && (e[Bl] = s ? o.display : "", e[Kv] && (o.display = "none"));
  }
  const $h = /\s*!important$/;
  function Wa(e, t, n) {
    if (xe(n)) n.forEach((o) => Wa(e, t, o));
    else if (n == null && (n = ""), t.startsWith("--")) e.setProperty(t, n);
    else {
      const o = hk(e, t);
      $h.test(n) ? e.setProperty(po(o), n.replace($h, ""), "important") : e[o] = n;
    }
  }
  const Gh = ["Webkit", "Moz", "ms"], Yu = {};
  function hk(e, t) {
    const n = Yu[t];
    if (n) return n;
    let o = wn(t);
    if (o !== "filter" && o in e) return Yu[t] = o;
    o = Yl(o);
    for (let a = 0; a < Gh.length; a++) {
      const s = Gh[a] + o;
      if (s in e) return Yu[t] = s;
    }
    return t;
  }
  function gk(e, t, n, o) {
    return e.tagName === "TEXTAREA" && (t === "width" || t === "height") && ht(o) && n === o;
  }
  const Kh = "http://www.w3.org/1999/xlink";
  function Yh(e, t, n, o, a, s = mE(t)) {
    o && t.startsWith("xlink:") ? n == null ? e.removeAttributeNS(Kh, t.slice(6, t.length)) : e.setAttributeNS(Kh, t, n) : n == null || s && !Ly(n) ? e.removeAttribute(t) : e.setAttribute(t, s ? "" : qn(n) ? String(n) : n);
  }
  function Zh(e, t, n, o, a) {
    if (t === "innerHTML" || t === "textContent") {
      n != null && (e[t] = t === "innerHTML" ? qv(n) : n);
      return;
    }
    const s = e.tagName;
    if (t === "value" && s !== "PROGRESS" && !s.includes("-")) {
      const u = s === "OPTION" ? e.getAttribute("value") || "" : e.value, f = n == null ? e.type === "checkbox" ? "on" : "" : String(n);
      (u !== f || !("_value" in e)) && (e.value = f), n == null && e.removeAttribute(t), e._value = n;
      return;
    }
    let c = false;
    if (n === "" || n == null) {
      const u = typeof e[t];
      u === "boolean" ? n = Ly(n) : n == null && u === "string" ? (n = "", c = true) : u === "number" && (n = 0, c = true);
    }
    try {
      e[t] = n;
    } catch {
    }
    c && e.removeAttribute(a || t);
  }
  function yk(e, t, n, o) {
    e.addEventListener(t, n, o);
  }
  function vk(e, t, n, o) {
    e.removeEventListener(t, n, o);
  }
  const Qh = /* @__PURE__ */ Symbol("_vei");
  function wk(e, t, n, o, a = null) {
    const s = e[Qh] || (e[Qh] = {}), c = s[t];
    if (o && c) c.value = o;
    else {
      const [u, f] = Sk(t);
      if (o) {
        const m = s[t] = Ak(o, a);
        yk(e, u, m, f);
      } else c && (vk(e, u, c, f), s[t] = void 0);
    }
  }
  const Jh = /(?:Once|Passive|Capture)$/;
  function Sk(e) {
    let t;
    if (Jh.test(e)) {
      t = {};
      let o;
      for (; o = e.match(Jh); ) e = e.slice(0, e.length - o[0].length), t[o[0].toLowerCase()] = true;
    }
    return [e[2] === ":" ? e.slice(3) : po(e.slice(2)), t];
  }
  let Zu = 0;
  const bk = Promise.resolve(), _k = () => Zu || (bk.then(() => Zu = 0), Zu = Date.now());
  function Ak(e, t) {
    const n = (o) => {
      if (!o._vts) o._vts = Date.now();
      else if (o._vts <= n.attached) return;
      const a = n.value;
      if (xe(a)) {
        const s = o.stopImmediatePropagation;
        o.stopImmediatePropagation = () => {
          s.call(o), o._stopped = true;
        };
        const c = a.slice(), u = [o];
        for (let f = 0; f < c.length && !o._stopped; f++) {
          const m = c[f];
          m && ai(m, t, 5, u);
        }
      } else ai(a, t, 5, [o]);
    };
    return n.value = e, n.attached = _k(), n;
  }
  const Xh = (e) => e.charCodeAt(0) === 111 && e.charCodeAt(1) === 110 && e.charCodeAt(2) > 96 && e.charCodeAt(2) < 123, Ck = (e, t, n, o, a, s) => {
    const c = a === "svg";
    t === "class" ? uk(e, o, c) : t === "style" ? mk(e, n, o) : ql(t) ? $l(t) || wk(e, t, n, o, s) : (t[0] === "." ? (t = t.slice(1), true) : t[0] === "^" ? (t = t.slice(1), false) : Tk(e, t, o, c)) ? (Zh(e, t, o), !e.tagName.includes("-") && (t === "value" || t === "checked" || t === "selected") && Yh(e, t, o, c, s, t !== "value")) : e._isVueCE && (Ek(e, t) || e._def.__asyncLoader && (/[A-Z]/.test(t) || !ht(o))) ? Zh(e, wn(t), o, s, t) : (t === "true-value" ? e._trueValue = o : t === "false-value" && (e._falseValue = o), Yh(e, t, o, c));
  };
  function Tk(e, t, n, o) {
    if (o) return !!(t === "innerHTML" || t === "textContent" || t in e && Xh(t) && Pe(n));
    if (t === "spellcheck" || t === "draggable" || t === "translate" || t === "autocorrect" || t === "sandbox" && e.tagName === "IFRAME" || t === "form" || t === "list" && e.tagName === "INPUT" || t === "type" && e.tagName === "TEXTAREA") return false;
    if (t === "width" || t === "height") {
      const a = e.tagName;
      if (a === "IMG" || a === "VIDEO" || a === "CANVAS" || a === "SOURCE") return false;
    }
    return Xh(t) && ht(n) ? false : t in e;
  }
  function Ek(e, t) {
    const n = e._def.props;
    if (!n) return false;
    const o = wn(t);
    return Array.isArray(n) ? n.some((a) => wn(a) === o) : Object.keys(n).some((a) => wn(a) === o);
  }
  const kk = ["ctrl", "shift", "alt", "meta"], zk = { stop: (e) => e.stopPropagation(), prevent: (e) => e.preventDefault(), self: (e) => e.target !== e.currentTarget, ctrl: (e) => !e.ctrlKey, shift: (e) => !e.shiftKey, alt: (e) => !e.altKey, meta: (e) => !e.metaKey, left: (e) => "button" in e && e.button !== 0, middle: (e) => "button" in e && e.button !== 1, right: (e) => "button" in e && e.button !== 2, exact: (e, t) => kk.some((n) => e[`${n}Key`] && !t.includes(n)) }, Dk = (e, t) => {
    if (!e) return e;
    const n = e._withMods || (e._withMods = {}), o = t.join(".");
    return n[o] || (n[o] = (a, ...s) => {
      for (let c = 0; c < t.length; c++) {
        const u = zk[t[c]];
        if (u && u(a, t)) return;
      }
      return e(a, ...s);
    });
  }, Mk = Vt({ patchProp: Ck }, ik);
  let eg;
  function Lk() {
    return eg || (eg = R2(Mk));
  }
  const tg = (...e) => {
    Lk().render(...e);
  };
  /*!
  * pinia v2.3.1
  * (c) 2025 Eduardo San Martin Morote
  * @license MIT
  */
  let Yv;
  const vf = (e) => Yv = e, xk = /* @__PURE__ */ Symbol();
  function Ad(e) {
    return e && typeof e == "object" && Object.prototype.toString.call(e) === "[object Object]" && typeof e.toJSON != "function";
  }
  var Ka;
  (function(e) {
    e.direct = "direct", e.patchObject = "patch object", e.patchFunction = "patch function";
  })(Ka || (Ka = {}));
  const Zv = () => {
  };
  function ng(e, t, n, o = Zv) {
    e.push(t);
    const a = () => {
      const s = e.indexOf(t);
      s > -1 && (e.splice(s, 1), o());
    };
    return !n && tf() && Ry(a), a;
  }
  function $o(e, ...t) {
    e.slice().forEach((n) => {
      n(...t);
    });
  }
  const Ok = (e) => e(), ig = /* @__PURE__ */ Symbol(), Qu = /* @__PURE__ */ Symbol();
  function Cd(e, t) {
    e instanceof Map && t instanceof Map ? t.forEach((n, o) => e.set(o, n)) : e instanceof Set && t instanceof Set && t.forEach(e.add, e);
    for (const n in t) {
      if (!t.hasOwnProperty(n)) continue;
      const o = t[n], a = e[n];
      Ad(a) && Ad(o) && e.hasOwnProperty(n) && !bt(o) && !rr(o) ? e[n] = Cd(a, o) : e[n] = o;
    }
    return e;
  }
  const Pk = /* @__PURE__ */ Symbol();
  function Ik(e) {
    return !Ad(e) || !e.hasOwnProperty(Pk);
  }
  const { assign: zr } = Object;
  function Rk(e) {
    return !!(bt(e) && e.effect);
  }
  function Fk(e, t, n, o) {
    const { state: a, actions: s, getters: c } = t, u = n.state.value[e];
    let f;
    function m() {
      u || (n.state.value[e] = a ? a() : {});
      const h = FE(n.state.value[e]);
      return zr(h, s, Object.keys(c || {}).reduce((v, C) => (v[C] = Xy(We(() => {
        vf(n);
        const D = n._s.get(e);
        return c[C].call(D, D);
      })), v), {}));
    }
    return f = Qv(e, m, t, n, o, true), f;
  }
  function Qv(e, t, n = {}, o, a, s) {
    let c;
    const u = zr({ actions: {} }, n), f = { deep: true };
    let m, h, v = [], C = [], D;
    const W = o.state.value[e];
    !s && !W && (o.state.value[e] = {});
    let E;
    function L(ue) {
      let ee;
      m = h = false, typeof ue == "function" ? (ue(o.state.value[e]), ee = { type: Ka.patchFunction, storeId: e, events: D }) : (Cd(o.state.value[e], ue), ee = { type: Ka.patchObject, payload: ue, storeId: e, events: D });
      const se = E = /* @__PURE__ */ Symbol();
      uf().then(() => {
        E === se && (m = true);
      }), h = true, $o(v, ee, o.state.value[e]);
    }
    const b = s ? function() {
      const { state: ee } = n, se = ee ? ee() : {};
      this.$patch((le) => {
        zr(le, se);
      });
    } : Zv;
    function P() {
      c.stop(), v = [], C = [], o._s.delete(e);
    }
    const B = (ue, ee = "") => {
      if (ig in ue) return ue[Qu] = ee, ue;
      const se = function() {
        vf(o);
        const le = Array.from(arguments), re = [], Ee = [];
        function fe(oe) {
          re.push(oe);
        }
        function ce(oe) {
          Ee.push(oe);
        }
        $o(C, { args: le, name: se[Qu], store: j, after: fe, onError: ce });
        let G;
        try {
          G = ue.apply(this && this.$id === e ? this : j, le);
        } catch (oe) {
          throw $o(Ee, oe), oe;
        }
        return G instanceof Promise ? G.then((oe) => ($o(re, oe), oe)).catch((oe) => ($o(Ee, oe), Promise.reject(oe))) : ($o(re, G), G);
      };
      return se[ig] = true, se[Qu] = ee, se;
    }, k = { _p: o, $id: e, $onAction: ng.bind(null, C), $patch: L, $reset: b, $subscribe(ue, ee = {}) {
      const se = ng(v, ue, ee.detached, () => le()), le = c.run(() => vi(() => o.state.value[e], (re) => {
        (ee.flush === "sync" ? h : m) && ue({ storeId: e, type: Ka.direct, events: D }, re);
      }, zr({}, f, ee)));
      return se;
    }, $dispose: P }, j = la(k);
    o._s.set(e, j);
    const q = (o._a && o._a.runWithContext || Ok)(() => o._e.run(() => (c = Iy()).run(() => t({ action: B }))));
    for (const ue in q) {
      const ee = q[ue];
      if (bt(ee) && !Rk(ee) || rr(ee)) s || (W && Ik(ee) && (bt(ee) ? ee.value = W[ue] : Cd(ee, W[ue])), o.state.value[e][ue] = ee);
      else if (typeof ee == "function") {
        const se = B(ee, ue);
        q[ue] = se, u.actions[ue] = ee;
      }
    }
    return zr(j, q), zr(Xe(j), q), Object.defineProperty(j, "$state", { get: () => o.state.value[e], set: (ue) => {
      L((ee) => {
        zr(ee, ue);
      });
    } }), o._p.forEach((ue) => {
      zr(j, c.run(() => ue({ store: j, app: o._a, pinia: o, options: u })));
    }), W && s && n.hydrate && n.hydrate(j.$state, W), m = true, h = true, j;
  }
  /*! #__NO_SIDE_EFFECTS__ */
  // @__NO_SIDE_EFFECTS__
  function wf(e, t, n) {
    let o, a;
    const s = typeof t == "function";
    typeof e == "string" ? (o = e, a = s ? n : t) : (a = e, o = e.id);
    function c(u, f) {
      const m = YE();
      return u = u || (m ? ri(xk, null) : null), u && vf(u), u = Yv, u._s.has(o) || (s ? Qv(o, t, a, u) : Fk(o, a, u)), u._s.get(o);
    }
    return c.$id = o, c;
  }
  function Sf(e) {
    {
      const t = Xe(e), n = {};
      for (const o in t) {
        const a = t[o];
        a.effect ? n[o] = We({ get: () => e[o], set(s) {
          e[o] = s;
        } }) : (bt(a) || rr(a)) && (n[o] = BE(e, o));
      }
      return n;
    }
  }
  function Jv(e, t) {
    return function() {
      return e.apply(t, arguments);
    };
  }
  const { toString: Nk } = Object.prototype, { getPrototypeOf: oc } = Object, { iterator: ac, toStringTag: Xv } = Symbol, sc = /* @__PURE__ */ ((e) => (t) => {
    const n = Nk.call(t);
    return e[n] || (e[n] = n.slice(8, -1).toLowerCase());
  })(/* @__PURE__ */ Object.create(null)), bi = (e) => (e = e.toLowerCase(), (t) => sc(t) === e), lc = (e) => (t) => typeof t === e, { isArray: so } = Array, oa = lc("undefined");
  function ca(e) {
    return e !== null && !oa(e) && e.constructor !== null && !oa(e.constructor) && xn(e.constructor.isBuffer) && e.constructor.isBuffer(e);
  }
  const ew = bi("ArrayBuffer");
  function Wk(e) {
    let t;
    return typeof ArrayBuffer < "u" && ArrayBuffer.isView ? t = ArrayBuffer.isView(e) : t = e && e.buffer && ew(e.buffer), t;
  }
  const Bk = lc("string"), xn = lc("function"), tw = lc("number"), gs = (e) => e !== null && typeof e == "object", Uk = (e) => e === true || e === false, El = (e) => {
    if (sc(e) !== "object") return false;
    const t = oc(e);
    return (t === null || t === Object.prototype || Object.getPrototypeOf(t) === null) && !(Xv in e) && !(ac in e);
  }, jk = (e) => {
    if (!gs(e) || ca(e)) return false;
    try {
      return Object.keys(e).length === 0 && Object.getPrototypeOf(e) === Object.prototype;
    } catch {
      return false;
    }
  }, Hk = bi("Date"), Vk = bi("File"), qk = (e) => !!(e && typeof e.uri < "u"), $k = (e) => e && typeof e.getParts < "u", Gk = bi("Blob"), Kk = bi("FileList"), Yk = (e) => gs(e) && xn(e.pipe);
  function Zk() {
    return typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : typeof window < "u" ? window : typeof global < "u" ? global : {};
  }
  const rg = Zk(), og = typeof rg.FormData < "u" ? rg.FormData : void 0, Qk = (e) => {
    if (!e) return false;
    if (og && e instanceof og) return true;
    const t = oc(e);
    if (!t || t === Object.prototype || !xn(e.append)) return false;
    const n = sc(e);
    return n === "formdata" || n === "object" && xn(e.toString) && e.toString() === "[object FormData]";
  }, Jk = bi("URLSearchParams"), [Xk, ez, tz, nz] = ["ReadableStream", "Request", "Response", "Headers"].map(bi), iz = (e) => e.trim ? e.trim() : e.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, "");
  function ys(e, t, { allOwnKeys: n = false } = {}) {
    if (e === null || typeof e > "u") return;
    let o, a;
    if (typeof e != "object" && (e = [e]), so(e)) for (o = 0, a = e.length; o < a; o++) t.call(null, e[o], o, e);
    else {
      if (ca(e)) return;
      const s = n ? Object.getOwnPropertyNames(e) : Object.keys(e), c = s.length;
      let u;
      for (o = 0; o < c; o++) u = s[o], t.call(null, e[u], u, e);
    }
  }
  function nw(e, t) {
    if (ca(e)) return null;
    t = t.toLowerCase();
    const n = Object.keys(e);
    let o = n.length, a;
    for (; o-- > 0; ) if (a = n[o], t === a.toLowerCase()) return a;
    return null;
  }
  const to = typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : typeof window < "u" ? window : global, iw = (e) => !oa(e) && e !== to;
  function Td(...e) {
    const { caseless: t, skipUndefined: n } = iw(this) && this || {}, o = {}, a = (s, c) => {
      if (c === "__proto__" || c === "constructor" || c === "prototype") return;
      const u = t && typeof c == "string" && nw(o, c) || c, f = Ed(o, u) ? o[u] : void 0;
      El(f) && El(s) ? o[u] = Td(f, s) : El(s) ? o[u] = Td({}, s) : so(s) ? o[u] = s.slice() : (!n || !oa(s)) && (o[u] = s);
    };
    for (let s = 0, c = e.length; s < c; s++) {
      const u = e[s];
      if (!u || ca(u) || (ys(u, a), typeof u != "object" || so(u))) continue;
      const f = Object.getOwnPropertySymbols(u);
      for (let m = 0; m < f.length; m++) {
        const h = f[m];
        hz.call(u, h) && a(u[h], h);
      }
    }
    return o;
  }
  const rz = (e, t, n, { allOwnKeys: o } = {}) => (ys(t, (a, s) => {
    n && xn(a) ? Object.defineProperty(e, s, { __proto__: null, value: Jv(a, n), writable: true, enumerable: true, configurable: true }) : Object.defineProperty(e, s, { __proto__: null, value: a, writable: true, enumerable: true, configurable: true });
  }, { allOwnKeys: o }), e), oz = (e) => (e.charCodeAt(0) === 65279 && (e = e.slice(1)), e), az = (e, t, n, o) => {
    e.prototype = Object.create(t.prototype, o), Object.defineProperty(e.prototype, "constructor", { __proto__: null, value: e, writable: true, enumerable: false, configurable: true }), Object.defineProperty(e, "super", { __proto__: null, value: t.prototype }), n && Object.assign(e.prototype, n);
  }, sz = (e, t, n, o) => {
    let a, s, c;
    const u = {};
    if (t = t || {}, e == null) return t;
    do {
      for (a = Object.getOwnPropertyNames(e), s = a.length; s-- > 0; ) c = a[s], (!o || o(c, e, t)) && !u[c] && (t[c] = e[c], u[c] = true);
      e = n !== false && oc(e);
    } while (e && (!n || n(e, t)) && e !== Object.prototype);
    return t;
  }, lz = (e, t, n) => {
    e = String(e), (n === void 0 || n > e.length) && (n = e.length), n -= t.length;
    const o = e.indexOf(t, n);
    return o !== -1 && o === n;
  }, cz = (e) => {
    if (!e) return null;
    if (so(e)) return e;
    let t = e.length;
    if (!tw(t)) return null;
    const n = new Array(t);
    for (; t-- > 0; ) n[t] = e[t];
    return n;
  }, uz = /* @__PURE__ */ ((e) => (t) => e && t instanceof e)(typeof Uint8Array < "u" && oc(Uint8Array)), dz = (e, t) => {
    const o = (e && e[ac]).call(e);
    let a;
    for (; (a = o.next()) && !a.done; ) {
      const s = a.value;
      t.call(e, s[0], s[1]);
    }
  }, fz = (e, t) => {
    let n;
    const o = [];
    for (; (n = e.exec(t)) !== null; ) o.push(n);
    return o;
  }, pz = bi("HTMLFormElement"), mz = (e) => e.toLowerCase().replace(/[-_\s]([a-z\d])(\w*)/g, function(n, o, a) {
    return o.toUpperCase() + a;
  }), Ed = (({ hasOwnProperty: e }) => (t, n) => e.call(t, n))(Object.prototype), { propertyIsEnumerable: hz } = Object.prototype, gz = bi("RegExp"), rw = (e, t) => {
    const n = Object.getOwnPropertyDescriptors(e), o = {};
    ys(n, (a, s) => {
      let c;
      (c = t(a, s, e)) !== false && (o[s] = c || a);
    }), Object.defineProperties(e, o);
  }, yz = (e) => {
    rw(e, (t, n) => {
      if (xn(e) && ["arguments", "caller", "callee"].includes(n)) return false;
      const o = e[n];
      if (xn(o)) {
        if (t.enumerable = false, "writable" in t) {
          t.writable = false;
          return;
        }
        t.set || (t.set = () => {
          throw Error("Can not rewrite read-only method '" + n + "'");
        });
      }
    });
  }, vz = (e, t) => {
    const n = {}, o = (a) => {
      a.forEach((s) => {
        n[s] = true;
      });
    };
    return so(e) ? o(e) : o(String(e).split(t)), n;
  }, wz = () => {
  }, Sz = (e, t) => e != null && Number.isFinite(e = +e) ? e : t;
  function bz(e) {
    return !!(e && xn(e.append) && e[Xv] === "FormData" && e[ac]);
  }
  const _z = (e) => {
    const t = /* @__PURE__ */ new WeakSet(), n = (o) => {
      if (gs(o)) {
        if (t.has(o)) return;
        if (ca(o)) return o;
        if (!("toJSON" in o)) {
          t.add(o);
          const a = so(o) ? [] : {};
          return ys(o, (s, c) => {
            const u = n(s);
            !oa(u) && (a[c] = u);
          }), t.delete(o), a;
        }
      }
      return o;
    };
    return n(e);
  }, Az = bi("AsyncFunction"), Cz = (e) => e && (gs(e) || xn(e)) && xn(e.then) && xn(e.catch), ow = ((e, t) => e ? setImmediate : t ? ((n, o) => (to.addEventListener("message", ({ source: a, data: s }) => {
    a === to && s === n && o.length && o.shift()();
  }, false), (a) => {
    o.push(a), to.postMessage(n, "*");
  }))(`axios@${Math.random()}`, []) : (n) => setTimeout(n))(typeof setImmediate == "function", xn(to.postMessage)), Tz = typeof queueMicrotask < "u" ? queueMicrotask.bind(to) : typeof process < "u" && process.nextTick || ow, Ez = (e) => e != null && xn(e[ac]), F = { isArray: so, isArrayBuffer: ew, isBuffer: ca, isFormData: Qk, isArrayBufferView: Wk, isString: Bk, isNumber: tw, isBoolean: Uk, isObject: gs, isPlainObject: El, isEmptyObject: jk, isReadableStream: Xk, isRequest: ez, isResponse: tz, isHeaders: nz, isUndefined: oa, isDate: Hk, isFile: Vk, isReactNativeBlob: qk, isReactNative: $k, isBlob: Gk, isRegExp: gz, isFunction: xn, isStream: Yk, isURLSearchParams: Jk, isTypedArray: uz, isFileList: Kk, forEach: ys, merge: Td, extend: rz, trim: iz, stripBOM: oz, inherits: az, toFlatObject: sz, kindOf: sc, kindOfTest: bi, endsWith: lz, toArray: cz, forEachEntry: dz, matchAll: fz, isHTMLForm: pz, hasOwnProperty: Ed, hasOwnProp: Ed, reduceDescriptors: rw, freezeMethods: yz, toObjectSet: vz, toCamelCase: mz, noop: wz, toFiniteNumber: Sz, findKey: nw, global: to, isContextDefined: iw, isSpecCompliantForm: bz, toJSONObject: _z, isAsyncFn: Az, isThenable: Cz, setImmediate: ow, asap: Tz, isIterable: Ez }, kz = F.toObjectSet(["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host", "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer", "retry-after", "user-agent"]), zz = (e) => {
    const t = {};
    let n, o, a;
    return e && e.split(`
`).forEach(function(c) {
      a = c.indexOf(":"), n = c.substring(0, a).trim().toLowerCase(), o = c.substring(a + 1).trim(), !(!n || t[n] && kz[n]) && (n === "set-cookie" ? t[n] ? t[n].push(o) : t[n] = [o] : t[n] = t[n] ? t[n] + ", " + o : o);
    }), t;
  };
  function Dz(e) {
    let t = 0, n = e.length;
    for (; t < n; ) {
      const o = e.charCodeAt(t);
      if (o !== 9 && o !== 32) break;
      t += 1;
    }
    for (; n > t; ) {
      const o = e.charCodeAt(n - 1);
      if (o !== 9 && o !== 32) break;
      n -= 1;
    }
    return t === 0 && n === e.length ? e : e.slice(t, n);
  }
  const Mz = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f]+", "g"), Lz = new RegExp("[^\\u0009\\u0020-\\u007e\\u0080-\\u00ff]+", "g");
  function bf(e, t) {
    return F.isArray(e) ? e.map((n) => bf(n, t)) : Dz(String(e).replace(t, ""));
  }
  const xz = (e) => bf(e, Mz), Oz = (e) => bf(e, Lz);
  function aw(e) {
    const t = /* @__PURE__ */ Object.create(null);
    return F.forEach(e.toJSON(), (n, o) => {
      t[o] = Oz(n);
    }), t;
  }
  const ag = /* @__PURE__ */ Symbol("internals");
  function Pa(e) {
    return e && String(e).trim().toLowerCase();
  }
  function kl(e) {
    return e === false || e == null ? e : F.isArray(e) ? e.map(kl) : xz(String(e));
  }
  function Pz(e) {
    const t = /* @__PURE__ */ Object.create(null), n = /([^\s,;=]+)\s*(?:=\s*([^,;]+))?/g;
    let o;
    for (; o = n.exec(e); ) t[o[1]] = o[2];
    return t;
  }
  const Iz = (e) => /^[-_a-zA-Z0-9^`|~,!#$%&'*+.]+$/.test(e.trim());
  function Ju(e, t, n, o, a) {
    if (F.isFunction(o)) return o.call(this, t, n);
    if (a && (t = n), !!F.isString(t)) {
      if (F.isString(o)) return t.indexOf(o) !== -1;
      if (F.isRegExp(o)) return o.test(t);
    }
  }
  function Rz(e) {
    return e.trim().toLowerCase().replace(/([a-z\d])(\w*)/g, (t, n, o) => n.toUpperCase() + o);
  }
  function Fz(e, t) {
    const n = F.toCamelCase(" " + t);
    ["get", "set", "has"].forEach((o) => {
      Object.defineProperty(e, o + n, { __proto__: null, value: function(a, s, c) {
        return this[o].call(this, t, a, s, c);
      }, configurable: true });
    });
  }
  let Sn = class {
    constructor(t) {
      t && this.set(t);
    }
    set(t, n, o) {
      const a = this;
      function s(u, f, m) {
        const h = Pa(f);
        if (!h) return;
        const v = F.findKey(a, h);
        (!v || a[v] === void 0 || m === true || m === void 0 && a[v] !== false) && (a[v || f] = kl(u));
      }
      const c = (u, f) => F.forEach(u, (m, h) => s(m, h, f));
      if (F.isPlainObject(t) || t instanceof this.constructor) c(t, n);
      else if (F.isString(t) && (t = t.trim()) && !Iz(t)) c(zz(t), n);
      else if (F.isObject(t) && F.isIterable(t)) {
        let u = {}, f, m;
        for (const h of t) {
          if (!F.isArray(h)) throw new TypeError("Object iterator must return a key-value pair");
          u[m = h[0]] = (f = u[m]) ? F.isArray(f) ? [...f, h[1]] : [f, h[1]] : h[1];
        }
        c(u, n);
      } else t != null && s(n, t, o);
      return this;
    }
    get(t, n) {
      if (t = Pa(t), t) {
        const o = F.findKey(this, t);
        if (o) {
          const a = this[o];
          if (!n) return a;
          if (n === true) return Pz(a);
          if (F.isFunction(n)) return n.call(this, a, o);
          if (F.isRegExp(n)) return n.exec(a);
          throw new TypeError("parser must be boolean|regexp|function");
        }
      }
    }
    has(t, n) {
      if (t = Pa(t), t) {
        const o = F.findKey(this, t);
        return !!(o && this[o] !== void 0 && (!n || Ju(this, this[o], o, n)));
      }
      return false;
    }
    delete(t, n) {
      const o = this;
      let a = false;
      function s(c) {
        if (c = Pa(c), c) {
          const u = F.findKey(o, c);
          u && (!n || Ju(o, o[u], u, n)) && (delete o[u], a = true);
        }
      }
      return F.isArray(t) ? t.forEach(s) : s(t), a;
    }
    clear(t) {
      const n = Object.keys(this);
      let o = n.length, a = false;
      for (; o--; ) {
        const s = n[o];
        (!t || Ju(this, this[s], s, t, true)) && (delete this[s], a = true);
      }
      return a;
    }
    normalize(t) {
      const n = this, o = {};
      return F.forEach(this, (a, s) => {
        const c = F.findKey(o, s);
        if (c) {
          n[c] = kl(a), delete n[s];
          return;
        }
        const u = t ? Rz(s) : String(s).trim();
        u !== s && delete n[s], n[u] = kl(a), o[u] = true;
      }), this;
    }
    concat(...t) {
      return this.constructor.concat(this, ...t);
    }
    toJSON(t) {
      const n = /* @__PURE__ */ Object.create(null);
      return F.forEach(this, (o, a) => {
        o != null && o !== false && (n[a] = t && F.isArray(o) ? o.join(", ") : o);
      }), n;
    }
    [Symbol.iterator]() {
      return Object.entries(this.toJSON())[Symbol.iterator]();
    }
    toString() {
      return Object.entries(this.toJSON()).map(([t, n]) => t + ": " + n).join(`
`);
    }
    getSetCookie() {
      return this.get("set-cookie") || [];
    }
    get [Symbol.toStringTag]() {
      return "AxiosHeaders";
    }
    static from(t) {
      return t instanceof this ? t : new this(t);
    }
    static concat(t, ...n) {
      const o = new this(t);
      return n.forEach((a) => o.set(a)), o;
    }
    static accessor(t) {
      const o = (this[ag] = this[ag] = { accessors: {} }).accessors, a = this.prototype;
      function s(c) {
        const u = Pa(c);
        o[u] || (Fz(a, c), o[u] = true);
      }
      return F.isArray(t) ? t.forEach(s) : s(t), this;
    }
  };
  Sn.accessor(["Content-Type", "Content-Length", "Accept", "Accept-Encoding", "User-Agent", "Authorization"]);
  F.reduceDescriptors(Sn.prototype, ({ value: e }, t) => {
    let n = t[0].toUpperCase() + t.slice(1);
    return { get: () => e, set(o) {
      this[n] = o;
    } };
  });
  F.freezeMethods(Sn);
  const Nz = "[REDACTED ****]";
  function Wz(e) {
    if (F.hasOwnProp(e, "toJSON")) return true;
    let t = Object.getPrototypeOf(e);
    for (; t && t !== Object.prototype; ) {
      if (F.hasOwnProp(t, "toJSON")) return true;
      t = Object.getPrototypeOf(t);
    }
    return false;
  }
  function Bz(e, t) {
    const n = new Set(t.map((s) => String(s).toLowerCase())), o = [], a = (s) => {
      if (s === null || typeof s != "object" || F.isBuffer(s)) return s;
      if (o.indexOf(s) !== -1) return;
      s instanceof Sn && (s = s.toJSON()), o.push(s);
      let c;
      if (F.isArray(s)) c = [], s.forEach((u, f) => {
        const m = a(u);
        F.isUndefined(m) || (c[f] = m);
      });
      else {
        if (!F.isPlainObject(s) && Wz(s)) return o.pop(), s;
        c = /* @__PURE__ */ Object.create(null);
        for (const [u, f] of Object.entries(s)) {
          const m = n.has(u.toLowerCase()) ? Nz : a(f);
          F.isUndefined(m) || (c[u] = m);
        }
      }
      return o.pop(), c;
    };
    return a(e);
  }
  let Se = class sw extends Error {
    static from(t, n, o, a, s, c) {
      const u = new sw(t.message, n || t.code, o, a, s);
      return u.cause = t, u.name = t.name, t.status != null && u.status == null && (u.status = t.status), c && Object.assign(u, c), u;
    }
    constructor(t, n, o, a, s) {
      super(t), Object.defineProperty(this, "message", { __proto__: null, value: t, enumerable: true, writable: true, configurable: true }), this.name = "AxiosError", this.isAxiosError = true, n && (this.code = n), o && (this.config = o), a && (this.request = a), s && (this.response = s, this.status = s.status);
    }
    toJSON() {
      const t = this.config, n = t && F.hasOwnProp(t, "redact") ? t.redact : void 0, o = F.isArray(n) && n.length > 0 ? Bz(t, n) : F.toJSONObject(t);
      return { message: this.message, name: this.name, description: this.description, number: this.number, fileName: this.fileName, lineNumber: this.lineNumber, columnNumber: this.columnNumber, stack: this.stack, config: o, code: this.code, status: this.status };
    }
  };
  Se.ERR_BAD_OPTION_VALUE = "ERR_BAD_OPTION_VALUE";
  Se.ERR_BAD_OPTION = "ERR_BAD_OPTION";
  Se.ECONNABORTED = "ECONNABORTED";
  Se.ETIMEDOUT = "ETIMEDOUT";
  Se.ECONNREFUSED = "ECONNREFUSED";
  Se.ERR_NETWORK = "ERR_NETWORK";
  Se.ERR_FR_TOO_MANY_REDIRECTS = "ERR_FR_TOO_MANY_REDIRECTS";
  Se.ERR_DEPRECATED = "ERR_DEPRECATED";
  Se.ERR_BAD_RESPONSE = "ERR_BAD_RESPONSE";
  Se.ERR_BAD_REQUEST = "ERR_BAD_REQUEST";
  Se.ERR_CANCELED = "ERR_CANCELED";
  Se.ERR_NOT_SUPPORT = "ERR_NOT_SUPPORT";
  Se.ERR_INVALID_URL = "ERR_INVALID_URL";
  Se.ERR_FORM_DATA_DEPTH_EXCEEDED = "ERR_FORM_DATA_DEPTH_EXCEEDED";
  const Uz = null;
  function kd(e) {
    return F.isPlainObject(e) || F.isArray(e);
  }
  function lw(e) {
    return F.endsWith(e, "[]") ? e.slice(0, -2) : e;
  }
  function Xu(e, t, n) {
    return e ? e.concat(t).map(function(a, s) {
      return a = lw(a), !n && s ? "[" + a + "]" : a;
    }).join(n ? "." : "") : t;
  }
  function jz(e) {
    return F.isArray(e) && !e.some(kd);
  }
  const Hz = F.toFlatObject(F, {}, null, function(t) {
    return /^is[A-Z]/.test(t);
  });
  function cc(e, t, n) {
    if (!F.isObject(e)) throw new TypeError("target must be an object");
    t = t || new FormData(), n = F.toFlatObject(n, { metaTokens: true, dots: false, indexes: false }, false, function(L, b) {
      return !F.isUndefined(b[L]);
    });
    const o = n.metaTokens, a = n.visitor || v, s = n.dots, c = n.indexes, u = n.Blob || typeof Blob < "u" && Blob, f = n.maxDepth === void 0 ? 100 : n.maxDepth, m = u && F.isSpecCompliantForm(t);
    if (!F.isFunction(a)) throw new TypeError("visitor must be a function");
    function h(E) {
      if (E === null) return "";
      if (F.isDate(E)) return E.toISOString();
      if (F.isBoolean(E)) return E.toString();
      if (!m && F.isBlob(E)) throw new Se("Blob is not supported. Use a Buffer instead.");
      return F.isArrayBuffer(E) || F.isTypedArray(E) ? m && typeof Blob == "function" ? new Blob([E]) : Buffer.from(E) : E;
    }
    function v(E, L, b) {
      let P = E;
      if (F.isReactNative(t) && F.isReactNativeBlob(E)) return t.append(Xu(b, L, s), h(E)), false;
      if (E && !b && typeof E == "object") {
        if (F.endsWith(L, "{}")) L = o ? L : L.slice(0, -2), E = JSON.stringify(E);
        else if (F.isArray(E) && jz(E) || (F.isFileList(E) || F.endsWith(L, "[]")) && (P = F.toArray(E))) return L = lw(L), P.forEach(function(k, j) {
          !(F.isUndefined(k) || k === null) && t.append(c === true ? Xu([L], j, s) : c === null ? L : L + "[]", h(k));
        }), false;
      }
      return kd(E) ? true : (t.append(Xu(b, L, s), h(E)), false);
    }
    const C = [], D = Object.assign(Hz, { defaultVisitor: v, convertValue: h, isVisitable: kd });
    function W(E, L, b = 0) {
      if (!F.isUndefined(E)) {
        if (b > f) throw new Se("Object is too deeply nested (" + b + " levels). Max depth: " + f, Se.ERR_FORM_DATA_DEPTH_EXCEEDED);
        if (C.indexOf(E) !== -1) throw new Error("Circular reference detected in " + L.join("."));
        C.push(E), F.forEach(E, function(B, k) {
          (!(F.isUndefined(B) || B === null) && a.call(t, B, F.isString(k) ? k.trim() : k, L, D)) === true && W(B, L ? L.concat(k) : [k], b + 1);
        }), C.pop();
      }
    }
    if (!F.isObject(e)) throw new TypeError("data must be an object");
    return W(e), t;
  }
  function sg(e) {
    const t = { "!": "%21", "'": "%27", "(": "%28", ")": "%29", "~": "%7E", "%20": "+" };
    return encodeURIComponent(e).replace(/[!'()~]|%20/g, function(o) {
      return t[o];
    });
  }
  function _f(e, t) {
    this._pairs = [], e && cc(e, this, t);
  }
  const cw = _f.prototype;
  cw.append = function(t, n) {
    this._pairs.push([t, n]);
  };
  cw.toString = function(t) {
    const n = t ? function(o) {
      return t.call(this, o, sg);
    } : sg;
    return this._pairs.map(function(a) {
      return n(a[0]) + "=" + n(a[1]);
    }, "").join("&");
  };
  function Vz(e) {
    return encodeURIComponent(e).replace(/%3A/gi, ":").replace(/%24/g, "$").replace(/%2C/gi, ",").replace(/%20/g, "+");
  }
  function uw(e, t, n) {
    if (!t) return e;
    const o = n && n.encode || Vz, a = F.isFunction(n) ? { serialize: n } : n, s = a && a.serialize;
    let c;
    if (s ? c = s(t, a) : c = F.isURLSearchParams(t) ? t.toString() : new _f(t, a).toString(o), c) {
      const u = e.indexOf("#");
      u !== -1 && (e = e.slice(0, u)), e += (e.indexOf("?") === -1 ? "?" : "&") + c;
    }
    return e;
  }
  class lg {
    constructor() {
      this.handlers = [];
    }
    use(t, n, o) {
      return this.handlers.push({ fulfilled: t, rejected: n, synchronous: o ? o.synchronous : false, runWhen: o ? o.runWhen : null }), this.handlers.length - 1;
    }
    eject(t) {
      this.handlers[t] && (this.handlers[t] = null);
    }
    clear() {
      this.handlers && (this.handlers = []);
    }
    forEach(t) {
      F.forEach(this.handlers, function(o) {
        o !== null && t(o);
      });
    }
  }
  const Af = { silentJSONParsing: true, forcedJSONParsing: true, clarifyTimeoutError: false, legacyInterceptorReqResOrdering: true, advertiseZstdAcceptEncoding: false }, qz = typeof URLSearchParams < "u" ? URLSearchParams : _f, $z = typeof FormData < "u" ? FormData : null, Gz = typeof Blob < "u" ? Blob : null, Kz = { isBrowser: true, classes: { URLSearchParams: qz, FormData: $z, Blob: Gz }, protocols: ["http", "https", "file", "blob", "url", "data"] }, Cf = typeof window < "u" && typeof document < "u", zd = typeof navigator == "object" && navigator || void 0, Yz = Cf && (!zd || ["ReactNative", "NativeScript", "NS"].indexOf(zd.product) < 0), Zz = typeof WorkerGlobalScope < "u" && self instanceof WorkerGlobalScope && typeof self.importScripts == "function", Qz = Cf && window.location.href || "http://localhost", Jz = Object.freeze(Object.defineProperty({ __proto__: null, hasBrowserEnv: Cf, hasStandardBrowserEnv: Yz, hasStandardBrowserWebWorkerEnv: Zz, navigator: zd, origin: Qz }, Symbol.toStringTag, { value: "Module" })), Jt = { ...Jz, ...Kz };
  function Xz(e, t) {
    return cc(e, new Jt.classes.URLSearchParams(), { visitor: function(n, o, a, s) {
      return Jt.isNode && F.isBuffer(n) ? (this.append(o, n.toString("base64")), false) : s.defaultVisitor.apply(this, arguments);
    }, ...t });
  }
  function eD(e) {
    return F.matchAll(/\w+|\[(\w*)]/g, e).map((t) => t[0] === "[]" ? "" : t[1] || t[0]);
  }
  function tD(e) {
    const t = {}, n = Object.keys(e);
    let o;
    const a = n.length;
    let s;
    for (o = 0; o < a; o++) s = n[o], t[s] = e[s];
    return t;
  }
  function dw(e) {
    function t(n, o, a, s) {
      let c = n[s++];
      if (c === "__proto__") return true;
      const u = Number.isFinite(+c), f = s >= n.length;
      return c = !c && F.isArray(a) ? a.length : c, f ? (F.hasOwnProp(a, c) ? a[c] = F.isArray(a[c]) ? a[c].concat(o) : [a[c], o] : a[c] = o, !u) : ((!F.hasOwnProp(a, c) || !F.isObject(a[c])) && (a[c] = []), t(n, o, a[c], s) && F.isArray(a[c]) && (a[c] = tD(a[c])), !u);
    }
    if (F.isFormData(e) && F.isFunction(e.entries)) {
      const n = {};
      return F.forEachEntry(e, (o, a) => {
        t(eD(o), a, n, 0);
      }), n;
    }
    return null;
  }
  const Go = (e, t) => e != null && F.hasOwnProp(e, t) ? e[t] : void 0;
  function nD(e, t, n) {
    if (F.isString(e)) try {
      return (t || JSON.parse)(e), F.trim(e);
    } catch (o) {
      if (o.name !== "SyntaxError") throw o;
    }
    return (n || JSON.stringify)(e);
  }
  const vs = { transitional: Af, adapter: ["xhr", "http", "fetch"], transformRequest: [function(t, n) {
    const o = n.getContentType() || "", a = o.indexOf("application/json") > -1, s = F.isObject(t);
    if (s && F.isHTMLForm(t) && (t = new FormData(t)), F.isFormData(t)) return a ? JSON.stringify(dw(t)) : t;
    if (F.isArrayBuffer(t) || F.isBuffer(t) || F.isStream(t) || F.isFile(t) || F.isBlob(t) || F.isReadableStream(t)) return t;
    if (F.isArrayBufferView(t)) return t.buffer;
    if (F.isURLSearchParams(t)) return n.setContentType("application/x-www-form-urlencoded;charset=utf-8", false), t.toString();
    let u;
    if (s) {
      const f = Go(this, "formSerializer");
      if (o.indexOf("application/x-www-form-urlencoded") > -1) return Xz(t, f).toString();
      if ((u = F.isFileList(t)) || o.indexOf("multipart/form-data") > -1) {
        const m = Go(this, "env"), h = m && m.FormData;
        return cc(u ? { "files[]": t } : t, h && new h(), f);
      }
    }
    return s || a ? (n.setContentType("application/json", false), nD(t)) : t;
  }], transformResponse: [function(t) {
    const n = Go(this, "transitional") || vs.transitional, o = n && n.forcedJSONParsing, a = Go(this, "responseType"), s = a === "json";
    if (F.isResponse(t) || F.isReadableStream(t)) return t;
    if (t && F.isString(t) && (o && !a || s)) {
      const u = !(n && n.silentJSONParsing) && s;
      try {
        return JSON.parse(t, Go(this, "parseReviver"));
      } catch (f) {
        if (u) throw f.name === "SyntaxError" ? Se.from(f, Se.ERR_BAD_RESPONSE, this, null, Go(this, "response")) : f;
      }
    }
    return t;
  }], timeout: 0, xsrfCookieName: "XSRF-TOKEN", xsrfHeaderName: "X-XSRF-TOKEN", maxContentLength: -1, maxBodyLength: -1, env: { FormData: Jt.classes.FormData, Blob: Jt.classes.Blob }, validateStatus: function(t) {
    return t >= 200 && t < 300;
  }, headers: { common: { Accept: "application/json, text/plain, */*", "Content-Type": void 0 } } };
  F.forEach(["delete", "get", "head", "post", "put", "patch", "query"], (e) => {
    vs.headers[e] = {};
  });
  function ed(e, t) {
    const n = this || vs, o = t || n, a = Sn.from(o.headers);
    let s = o.data;
    return F.forEach(e, function(u) {
      s = u.call(n, s, a.normalize(), t ? t.status : void 0);
    }), a.normalize(), s;
  }
  function fw(e) {
    return !!(e && e.__CANCEL__);
  }
  let ws = class extends Se {
    constructor(t, n, o) {
      super(t ?? "canceled", Se.ERR_CANCELED, n, o), this.name = "CanceledError", this.__CANCEL__ = true;
    }
  };
  function pw(e, t, n) {
    const o = n.config.validateStatus;
    !n.status || !o || o(n.status) ? e(n) : t(new Se("Request failed with status code " + n.status, n.status >= 400 && n.status < 500 ? Se.ERR_BAD_REQUEST : Se.ERR_BAD_RESPONSE, n.config, n.request, n));
  }
  function iD(e) {
    const t = /^([-+\w]{1,25}):(?:\/\/)?/.exec(e);
    return t && t[1] || "";
  }
  function rD(e, t) {
    e = e || 10;
    const n = new Array(e), o = new Array(e);
    let a = 0, s = 0, c;
    return t = t !== void 0 ? t : 1e3, function(f) {
      const m = Date.now(), h = o[s];
      c || (c = m), n[a] = f, o[a] = m;
      let v = s, C = 0;
      for (; v !== a; ) C += n[v++], v = v % e;
      if (a = (a + 1) % e, a === s && (s = (s + 1) % e), m - c < t) return;
      const D = h && m - h;
      return D ? Math.round(C * 1e3 / D) : void 0;
    };
  }
  function oD(e, t) {
    let n = 0, o = 1e3 / t, a, s;
    const c = (m, h = Date.now()) => {
      n = h, a = null, s && (clearTimeout(s), s = null), e(...m);
    };
    return [(...m) => {
      const h = Date.now(), v = h - n;
      v >= o ? c(m, h) : (a = m, s || (s = setTimeout(() => {
        s = null, c(a);
      }, o - v)));
    }, () => a && c(a)];
  }
  const Ul = (e, t, n = 3) => {
    let o = 0;
    const a = rD(50, 250);
    return oD((s) => {
      if (!s || typeof s.loaded != "number") return;
      const c = s.loaded, u = s.lengthComputable ? s.total : void 0, f = u != null ? Math.min(c, u) : c, m = Math.max(0, f - o), h = a(m);
      o = Math.max(o, f);
      const v = { loaded: f, total: u, progress: u ? f / u : void 0, bytes: m, rate: h || void 0, estimated: h && u ? (u - f) / h : void 0, event: s, lengthComputable: u != null, [t ? "download" : "upload"]: true };
      e(v);
    }, n);
  }, cg = (e, t) => {
    const n = e != null;
    return [(o) => t[0]({ lengthComputable: n, total: e, loaded: o }), t[1]];
  }, ug = (e) => (...t) => F.asap(() => e(...t)), aD = Jt.hasStandardBrowserEnv ? /* @__PURE__ */ ((e, t) => (n) => (n = new URL(n, Jt.origin), e.protocol === n.protocol && e.host === n.host && (t || e.port === n.port)))(new URL(Jt.origin), Jt.navigator && /(msie|trident)/i.test(Jt.navigator.userAgent)) : () => true, sD = Jt.hasStandardBrowserEnv ? { write(e, t, n, o, a, s, c) {
    if (typeof document > "u") return;
    const u = [`${e}=${encodeURIComponent(t)}`];
    F.isNumber(n) && u.push(`expires=${new Date(n).toUTCString()}`), F.isString(o) && u.push(`path=${o}`), F.isString(a) && u.push(`domain=${a}`), s === true && u.push("secure"), F.isString(c) && u.push(`SameSite=${c}`), document.cookie = u.join("; ");
  }, read(e) {
    if (typeof document > "u") return null;
    const t = document.cookie.split(";");
    for (let n = 0; n < t.length; n++) {
      const o = t[n].replace(/^\s+/, ""), a = o.indexOf("=");
      if (a !== -1 && o.slice(0, a) === e) return decodeURIComponent(o.slice(a + 1));
    }
    return null;
  }, remove(e) {
    this.write(e, "", Date.now() - 864e5, "/");
  } } : { write() {
  }, read() {
    return null;
  }, remove() {
  } };
  function lD(e) {
    return typeof e != "string" ? false : /^([a-z][a-z\d+\-.]*:)?\/\//i.test(e);
  }
  function cD(e, t) {
    return t ? e.replace(/\/?\/$/, "") + "/" + t.replace(/^\/+/, "") : e;
  }
  function mw(e, t, n) {
    let o = !lD(t);
    return e && (o || n === false) ? cD(e, t) : t;
  }
  const dg = (e) => e instanceof Sn ? { ...e } : e;
  function lo(e, t) {
    t = t || {};
    const n = /* @__PURE__ */ Object.create(null);
    Object.defineProperty(n, "hasOwnProperty", { __proto__: null, value: Object.prototype.hasOwnProperty, enumerable: false, writable: true, configurable: true });
    function o(m, h, v, C) {
      return F.isPlainObject(m) && F.isPlainObject(h) ? F.merge.call({ caseless: C }, m, h) : F.isPlainObject(h) ? F.merge({}, h) : F.isArray(h) ? h.slice() : h;
    }
    function a(m, h, v, C) {
      if (F.isUndefined(h)) {
        if (!F.isUndefined(m)) return o(void 0, m, v, C);
      } else return o(m, h, v, C);
    }
    function s(m, h) {
      if (!F.isUndefined(h)) return o(void 0, h);
    }
    function c(m, h) {
      if (F.isUndefined(h)) {
        if (!F.isUndefined(m)) return o(void 0, m);
      } else return o(void 0, h);
    }
    function u(m, h, v) {
      if (F.hasOwnProp(t, v)) return o(m, h);
      if (F.hasOwnProp(e, v)) return o(void 0, m);
    }
    const f = { url: s, method: s, data: s, baseURL: c, transformRequest: c, transformResponse: c, paramsSerializer: c, timeout: c, timeoutMessage: c, withCredentials: c, withXSRFToken: c, adapter: c, responseType: c, xsrfCookieName: c, xsrfHeaderName: c, onUploadProgress: c, onDownloadProgress: c, decompress: c, maxContentLength: c, maxBodyLength: c, beforeRedirect: c, transport: c, httpAgent: c, httpsAgent: c, cancelToken: c, socketPath: c, allowedSocketPaths: c, responseEncoding: c, validateStatus: u, headers: (m, h, v) => a(dg(m), dg(h), v, true) };
    return F.forEach(Object.keys({ ...e, ...t }), function(h) {
      if (h === "__proto__" || h === "constructor" || h === "prototype") return;
      const v = F.hasOwnProp(f, h) ? f[h] : a, C = F.hasOwnProp(e, h) ? e[h] : void 0, D = F.hasOwnProp(t, h) ? t[h] : void 0, W = v(C, D, h);
      F.isUndefined(W) && v !== u || (n[h] = W);
    }), n;
  }
  const uD = ["content-type", "content-length"];
  function dD(e, t, n) {
    if (n !== "content-only") {
      e.set(t);
      return;
    }
    Object.entries(t).forEach(([o, a]) => {
      uD.includes(o.toLowerCase()) && e.set(o, a);
    });
  }
  const fD = (e) => encodeURIComponent(e).replace(/%([0-9A-F]{2})/gi, (t, n) => String.fromCharCode(parseInt(n, 16)));
  function hw(e) {
    const t = lo({}, e), n = (C) => F.hasOwnProp(t, C) ? t[C] : void 0, o = n("data");
    let a = n("withXSRFToken");
    const s = n("xsrfHeaderName"), c = n("xsrfCookieName");
    let u = n("headers");
    const f = n("auth"), m = n("baseURL"), h = n("allowAbsoluteUrls"), v = n("url");
    if (t.headers = u = Sn.from(u), t.url = uw(mw(m, v, h), n("params"), n("paramsSerializer")), f && u.set("Authorization", "Basic " + btoa((f.username || "") + ":" + (f.password ? fD(f.password) : ""))), F.isFormData(o) && (Jt.hasStandardBrowserEnv || Jt.hasStandardBrowserWebWorkerEnv || F.isReactNative(o) ? u.setContentType(void 0) : F.isFunction(o.getHeaders) && dD(u, o.getHeaders(), n("formDataHeaderPolicy"))), Jt.hasStandardBrowserEnv && (F.isFunction(a) && (a = a(t)), a === true || a == null && aD(t.url))) {
      const D = s && c && sD.read(c);
      D && u.set(s, D);
    }
    return t;
  }
  const pD = typeof XMLHttpRequest < "u", mD = pD && function(e) {
    return new Promise(function(n, o) {
      const a = hw(e);
      let s = a.data;
      const c = Sn.from(a.headers).normalize();
      let { responseType: u, onUploadProgress: f, onDownloadProgress: m } = a, h, v, C, D, W;
      function E() {
        D && D(), W && W(), a.cancelToken && a.cancelToken.unsubscribe(h), a.signal && a.signal.removeEventListener("abort", h);
      }
      let L = new XMLHttpRequest();
      L.open(a.method.toUpperCase(), a.url, true), L.timeout = a.timeout;
      function b() {
        if (!L) return;
        const B = Sn.from("getAllResponseHeaders" in L && L.getAllResponseHeaders()), j = { data: !u || u === "text" || u === "json" ? L.responseText : L.response, status: L.status, statusText: L.statusText, headers: B, config: e, request: L };
        pw(function(q) {
          n(q), E();
        }, function(q) {
          o(q), E();
        }, j), L = null;
      }
      "onloadend" in L ? L.onloadend = b : L.onreadystatechange = function() {
        !L || L.readyState !== 4 || L.status === 0 && !(L.responseURL && L.responseURL.startsWith("file:")) || setTimeout(b);
      }, L.onabort = function() {
        L && (o(new Se("Request aborted", Se.ECONNABORTED, e, L)), E(), L = null);
      }, L.onerror = function(k) {
        const j = k && k.message ? k.message : "Network Error", $ = new Se(j, Se.ERR_NETWORK, e, L);
        $.event = k || null, o($), E(), L = null;
      }, L.ontimeout = function() {
        let k = a.timeout ? "timeout of " + a.timeout + "ms exceeded" : "timeout exceeded";
        const j = a.transitional || Af;
        a.timeoutErrorMessage && (k = a.timeoutErrorMessage), o(new Se(k, j.clarifyTimeoutError ? Se.ETIMEDOUT : Se.ECONNABORTED, e, L)), E(), L = null;
      }, s === void 0 && c.setContentType(null), "setRequestHeader" in L && F.forEach(aw(c), function(k, j) {
        L.setRequestHeader(j, k);
      }), F.isUndefined(a.withCredentials) || (L.withCredentials = !!a.withCredentials), u && u !== "json" && (L.responseType = a.responseType), m && ([C, W] = Ul(m, true), L.addEventListener("progress", C)), f && L.upload && ([v, D] = Ul(f), L.upload.addEventListener("progress", v), L.upload.addEventListener("loadend", D)), (a.cancelToken || a.signal) && (h = (B) => {
        L && (o(!B || B.type ? new ws(null, e, L) : B), L.abort(), E(), L = null);
      }, a.cancelToken && a.cancelToken.subscribe(h), a.signal && (a.signal.aborted ? h() : a.signal.addEventListener("abort", h)));
      const P = iD(a.url);
      if (P && !Jt.protocols.includes(P)) {
        o(new Se("Unsupported protocol " + P + ":", Se.ERR_BAD_REQUEST, e));
        return;
      }
      L.send(s || null);
    });
  }, hD = (e, t) => {
    if (e = e ? e.filter(Boolean) : [], !t && !e.length) return;
    const n = new AbortController();
    let o = false;
    const a = function(f) {
      if (!o) {
        o = true, c();
        const m = f instanceof Error ? f : this.reason;
        n.abort(m instanceof Se ? m : new ws(m instanceof Error ? m.message : m));
      }
    };
    let s = t && setTimeout(() => {
      s = null, a(new Se(`timeout of ${t}ms exceeded`, Se.ETIMEDOUT));
    }, t);
    const c = () => {
      e && (s && clearTimeout(s), s = null, e.forEach((f) => {
        f.unsubscribe ? f.unsubscribe(a) : f.removeEventListener("abort", a);
      }), e = null);
    };
    e.forEach((f) => f.addEventListener("abort", a));
    const { signal: u } = n;
    return u.unsubscribe = () => F.asap(c), u;
  }, gD = function* (e, t) {
    let n = e.byteLength;
    if (n < t) {
      yield e;
      return;
    }
    let o = 0, a;
    for (; o < n; ) a = o + t, yield e.slice(o, a), o = a;
  }, yD = async function* (e, t) {
    for await (const n of vD(e)) yield* gD(n, t);
  }, vD = async function* (e) {
    if (e[Symbol.asyncIterator]) {
      yield* e;
      return;
    }
    const t = e.getReader();
    try {
      for (; ; ) {
        const { done: n, value: o } = await t.read();
        if (n) break;
        yield o;
      }
    } finally {
      await t.cancel();
    }
  }, fg = (e, t, n, o) => {
    const a = yD(e, t);
    let s = 0, c, u = (f) => {
      c || (c = true, o && o(f));
    };
    return new ReadableStream({ async pull(f) {
      try {
        const { done: m, value: h } = await a.next();
        if (m) {
          u(), f.close();
          return;
        }
        let v = h.byteLength;
        if (n) {
          let C = s += v;
          n(C);
        }
        f.enqueue(new Uint8Array(h));
      } catch (m) {
        throw u(m), m;
      }
    }, cancel(f) {
      return u(f), a.return();
    } }, { highWaterMark: 2 });
  };
  function wD(e) {
    if (!e || typeof e != "string" || !e.startsWith("data:")) return 0;
    const t = e.indexOf(",");
    if (t < 0) return 0;
    const n = e.slice(5, t), o = e.slice(t + 1);
    if (/;base64/i.test(n)) {
      let c = o.length;
      const u = o.length;
      for (let D = 0; D < u; D++) if (o.charCodeAt(D) === 37 && D + 2 < u) {
        const W = o.charCodeAt(D + 1), E = o.charCodeAt(D + 2);
        (W >= 48 && W <= 57 || W >= 65 && W <= 70 || W >= 97 && W <= 102) && (E >= 48 && E <= 57 || E >= 65 && E <= 70 || E >= 97 && E <= 102) && (c -= 2, D += 2);
      }
      let f = 0, m = u - 1;
      const h = (D) => D >= 2 && o.charCodeAt(D - 2) === 37 && o.charCodeAt(D - 1) === 51 && (o.charCodeAt(D) === 68 || o.charCodeAt(D) === 100);
      m >= 0 && (o.charCodeAt(m) === 61 ? (f++, m--) : h(m) && (f++, m -= 3)), f === 1 && m >= 0 && (o.charCodeAt(m) === 61 || h(m)) && f++;
      const C = Math.floor(c / 4) * 3 - (f || 0);
      return C > 0 ? C : 0;
    }
    if (typeof Buffer < "u" && typeof Buffer.byteLength == "function") return Buffer.byteLength(o, "utf8");
    let s = 0;
    for (let c = 0, u = o.length; c < u; c++) {
      const f = o.charCodeAt(c);
      if (f < 128) s += 1;
      else if (f < 2048) s += 2;
      else if (f >= 55296 && f <= 56319 && c + 1 < u) {
        const m = o.charCodeAt(c + 1);
        m >= 56320 && m <= 57343 ? (s += 4, c++) : s += 3;
      } else s += 3;
    }
    return s;
  }
  const Tf = "1.17.0", pg = 64 * 1024, { isFunction: bl } = F, SD = (e) => encodeURIComponent(e).replace(/%([0-9A-F]{2})/gi, (t, n) => String.fromCharCode(parseInt(n, 16))), mg = (e) => {
    if (!F.isString(e)) return e;
    try {
      return decodeURIComponent(e);
    } catch {
      return e;
    }
  }, hg = (e, ...t) => {
    try {
      return !!e(...t);
    } catch {
      return false;
    }
  }, bD = (e) => {
    const t = e.indexOf("://");
    let n = e;
    return t !== -1 && (n = n.slice(t + 3)), n.includes("@") || n.includes(":");
  }, _D = (e) => {
    const t = F.global !== void 0 && F.global !== null ? F.global : globalThis, { ReadableStream: n, TextEncoder: o } = t;
    e = F.merge.call({ skipUndefined: true }, { Request: t.Request, Response: t.Response }, e);
    const { fetch: a, Request: s, Response: c } = e, u = a ? bl(a) : typeof fetch == "function", f = bl(s), m = bl(c);
    if (!u) return false;
    const h = u && bl(n), v = u && (typeof o == "function" ? /* @__PURE__ */ ((b) => (P) => b.encode(P))(new o()) : async (b) => new Uint8Array(await new s(b).arrayBuffer())), C = f && h && hg(() => {
      let b = false;
      const P = new s(Jt.origin, { body: new n(), method: "POST", get duplex() {
        return b = true, "half";
      } }), B = P.headers.has("Content-Type");
      return P.body != null && P.body.cancel(), b && !B;
    }), D = m && h && hg(() => F.isReadableStream(new c("").body)), W = { stream: D && ((b) => b.body) };
    u && ["text", "arrayBuffer", "blob", "formData", "stream"].forEach((b) => {
      !W[b] && (W[b] = (P, B) => {
        let k = P && P[b];
        if (k) return k.call(P);
        throw new Se(`Response type '${b}' is not supported`, Se.ERR_NOT_SUPPORT, B);
      });
    });
    const E = async (b) => {
      if (b == null) return 0;
      if (F.isBlob(b)) return b.size;
      if (F.isSpecCompliantForm(b)) return (await new s(Jt.origin, { method: "POST", body: b }).arrayBuffer()).byteLength;
      if (F.isArrayBufferView(b) || F.isArrayBuffer(b)) return b.byteLength;
      if (F.isURLSearchParams(b) && (b = b + ""), F.isString(b)) return (await v(b)).byteLength;
    }, L = async (b, P) => {
      const B = F.toFiniteNumber(b.getContentLength());
      return B ?? E(P);
    };
    return async (b) => {
      let { url: P, method: B, data: k, signal: j, cancelToken: $, timeout: q, onDownloadProgress: ue, onUploadProgress: ee, responseType: se, headers: le, withCredentials: re = "same-origin", fetchOptions: Ee, maxContentLength: fe, maxBodyLength: ce } = hw(b);
      const G = F.isNumber(fe) && fe > -1, oe = F.isNumber(ce) && ce > -1, ie = (Me) => F.hasOwnProp(b, Me) ? b[Me] : void 0;
      let pe = a || fetch;
      se = se ? (se + "").toLowerCase() : "text";
      let we = hD([j, $ && $.toAbortSignal()], q), Te = null;
      const ke = we && we.unsubscribe && (() => {
        we.unsubscribe();
      });
      let tt;
      try {
        let Me;
        const it = ie("auth");
        if (it) {
          const Ae = it.username || "", _ = it.password || "";
          Me = { username: Ae, password: _ };
        }
        if (bD(P)) {
          const Ae = new URL(P, Jt.origin);
          if (!Me && (Ae.username || Ae.password)) {
            const _ = mg(Ae.username), z = mg(Ae.password);
            Me = { username: _, password: z };
          }
          (Ae.username || Ae.password) && (Ae.username = "", Ae.password = "", P = Ae.href);
        }
        if (Me && (le.delete("authorization"), le.set("Authorization", "Basic " + btoa(SD((Me.username || "") + ":" + (Me.password || ""))))), G && typeof P == "string" && P.startsWith("data:") && wD(P) > fe) throw new Se("maxContentLength size of " + fe + " exceeded", Se.ERR_BAD_RESPONSE, b, Te);
        if (oe && B !== "get" && B !== "head") {
          const Ae = await L(le, k);
          if (typeof Ae == "number" && isFinite(Ae) && Ae > ce) throw new Se("Request body larger than maxBodyLength limit", Se.ERR_BAD_REQUEST, b, Te);
        }
        if (ee && C && B !== "get" && B !== "head" && (tt = await L(le, k)) !== 0) {
          let Ae = new s(P, { method: "POST", body: k, duplex: "half" }), _;
          if (F.isFormData(k) && (_ = Ae.headers.get("content-type")) && le.setContentType(_), Ae.body) {
            const [z, U] = cg(tt, Ul(ug(ee)));
            k = fg(Ae.body, pg, z, U);
          }
        }
        F.isString(re) || (re = re ? "include" : "omit");
        const Re = f && "credentials" in s.prototype;
        if (F.isFormData(k)) {
          const Ae = le.getContentType();
          Ae && /^multipart\/form-data/i.test(Ae) && !/boundary=/i.test(Ae) && le.delete("content-type");
        }
        le.set("User-Agent", "axios/" + Tf, false);
        const ft = { ...Ee, signal: we, method: B.toUpperCase(), headers: aw(le.normalize()), body: k, duplex: "half", credentials: Re ? re : void 0 };
        Te = f && new s(P, ft);
        let Ie = await (f ? pe(Te, Ee) : pe(P, ft));
        if (G) {
          const Ae = F.toFiniteNumber(Ie.headers.get("content-length"));
          if (Ae != null && Ae > fe) throw new Se("maxContentLength size of " + fe + " exceeded", Se.ERR_BAD_RESPONSE, b, Te);
        }
        const pt = D && (se === "stream" || se === "response");
        if (D && Ie.body && (ue || G || pt && ke)) {
          const Ae = {};
          ["status", "statusText", "headers"].forEach((X) => {
            Ae[X] = Ie[X];
          });
          const _ = F.toFiniteNumber(Ie.headers.get("content-length")), [z, U] = ue && cg(_, Ul(ug(ue), true)) || [];
          let Y = 0;
          const J = (X) => {
            if (G && (Y = X, Y > fe)) throw new Se("maxContentLength size of " + fe + " exceeded", Se.ERR_BAD_RESPONSE, b, Te);
            z && z(X);
          };
          Ie = new c(fg(Ie.body, pg, J, () => {
            U && U(), ke && ke();
          }), Ae);
        }
        se = se || "text";
        let be = await W[F.findKey(W, se) || "text"](Ie, b);
        if (G && !D && !pt) {
          let Ae;
          if (be != null && (typeof be.byteLength == "number" ? Ae = be.byteLength : typeof be.size == "number" ? Ae = be.size : typeof be == "string" && (Ae = typeof o == "function" ? new o().encode(be).byteLength : be.length)), typeof Ae == "number" && Ae > fe) throw new Se("maxContentLength size of " + fe + " exceeded", Se.ERR_BAD_RESPONSE, b, Te);
        }
        return !pt && ke && ke(), await new Promise((Ae, _) => {
          pw(Ae, _, { data: be, headers: Sn.from(Ie.headers), status: Ie.status, statusText: Ie.statusText, config: b, request: Te });
        });
      } catch (Me) {
        if (ke && ke(), we && we.aborted && we.reason instanceof Se) {
          const it = we.reason;
          throw it.config = b, Te && (it.request = Te), Me !== it && (it.cause = Me), it;
        }
        throw Me && Me.name === "TypeError" && /Load failed|fetch/i.test(Me.message) ? Object.assign(new Se("Network Error", Se.ERR_NETWORK, b, Te, Me && Me.response), { cause: Me.cause || Me }) : Se.from(Me, Me && Me.code, b, Te, Me && Me.response);
      }
    };
  }, AD = /* @__PURE__ */ new Map(), gw = (e) => {
    let t = e && e.env || {};
    const { fetch: n, Request: o, Response: a } = t, s = [o, a, n];
    let c = s.length, u = c, f, m, h = AD;
    for (; u--; ) f = s[u], m = h.get(f), m === void 0 && h.set(f, m = u ? /* @__PURE__ */ new Map() : _D(t)), h = m;
    return m;
  };
  gw();
  const Ef = { http: Uz, xhr: mD, fetch: { get: gw } };
  F.forEach(Ef, (e, t) => {
    if (e) {
      try {
        Object.defineProperty(e, "name", { __proto__: null, value: t });
      } catch {
      }
      Object.defineProperty(e, "adapterName", { __proto__: null, value: t });
    }
  });
  const gg = (e) => `- ${e}`, CD = (e) => F.isFunction(e) || e === null || e === false;
  function TD(e, t) {
    e = F.isArray(e) ? e : [e];
    const { length: n } = e;
    let o, a;
    const s = {};
    for (let c = 0; c < n; c++) {
      o = e[c];
      let u;
      if (a = o, !CD(o) && (a = Ef[(u = String(o)).toLowerCase()], a === void 0)) throw new Se(`Unknown adapter '${u}'`);
      if (a && (F.isFunction(a) || (a = a.get(t)))) break;
      s[u || "#" + c] = a;
    }
    if (!a) {
      const c = Object.entries(s).map(([f, m]) => `adapter ${f} ` + (m === false ? "is not supported by the environment" : "is not available in the build"));
      let u = n ? c.length > 1 ? `since :
` + c.map(gg).join(`
`) : " " + gg(c[0]) : "as no adapter specified";
      throw new Se("There is no suitable adapter to dispatch the request " + u, "ERR_NOT_SUPPORT");
    }
    return a;
  }
  const yw = { getAdapter: TD, adapters: Ef };
  function td(e) {
    if (e.cancelToken && e.cancelToken.throwIfRequested(), e.signal && e.signal.aborted) throw new ws(null, e);
  }
  function yg(e) {
    return td(e), e.headers = Sn.from(e.headers), e.data = ed.call(e, e.transformRequest), ["post", "put", "patch"].indexOf(e.method) !== -1 && e.headers.setContentType("application/x-www-form-urlencoded", false), yw.getAdapter(e.adapter || vs.adapter, e)(e).then(function(o) {
      td(e), e.response = o;
      try {
        o.data = ed.call(e, e.transformResponse, o);
      } finally {
        delete e.response;
      }
      return o.headers = Sn.from(o.headers), o;
    }, function(o) {
      if (!fw(o) && (td(e), o && o.response)) {
        e.response = o.response;
        try {
          o.response.data = ed.call(e, e.transformResponse, o.response);
        } finally {
          delete e.response;
        }
        o.response.headers = Sn.from(o.response.headers);
      }
      return Promise.reject(o);
    });
  }
  const uc = {};
  ["object", "boolean", "number", "function", "string", "symbol"].forEach((e, t) => {
    uc[e] = function(o) {
      return typeof o === e || "a" + (t < 1 ? "n " : " ") + e;
    };
  });
  const vg = {};
  uc.transitional = function(t, n, o) {
    function a(s, c) {
      return "[Axios v" + Tf + "] Transitional option '" + s + "'" + c + (o ? ". " + o : "");
    }
    return (s, c, u) => {
      if (t === false) throw new Se(a(c, " has been removed" + (n ? " in " + n : "")), Se.ERR_DEPRECATED);
      return n && !vg[c] && (vg[c] = true, console.warn(a(c, " has been deprecated since v" + n + " and will be removed in the near future"))), t ? t(s, c, u) : true;
    };
  };
  uc.spelling = function(t) {
    return (n, o) => (console.warn(`${o} is likely a misspelling of ${t}`), true);
  };
  function ED(e, t, n) {
    if (typeof e != "object") throw new Se("options must be an object", Se.ERR_BAD_OPTION_VALUE);
    const o = Object.keys(e);
    let a = o.length;
    for (; a-- > 0; ) {
      const s = o[a], c = Object.prototype.hasOwnProperty.call(t, s) ? t[s] : void 0;
      if (c) {
        const u = e[s], f = u === void 0 || c(u, s, e);
        if (f !== true) throw new Se("option " + s + " must be " + f, Se.ERR_BAD_OPTION_VALUE);
        continue;
      }
      if (n !== true) throw new Se("Unknown option " + s, Se.ERR_BAD_OPTION);
    }
  }
  const zl = { assertOptions: ED, validators: uc }, Dn = zl.validators;
  let oo = class {
    constructor(t) {
      this.defaults = t || {}, this.interceptors = { request: new lg(), response: new lg() };
    }
    async request(t, n) {
      try {
        return await this._request(t, n);
      } catch (o) {
        if (o instanceof Error) {
          let a = {};
          Error.captureStackTrace ? Error.captureStackTrace(a) : a = new Error();
          const s = (() => {
            if (!a.stack) return "";
            const c = a.stack.indexOf(`
`);
            return c === -1 ? "" : a.stack.slice(c + 1);
          })();
          try {
            if (!o.stack) o.stack = s;
            else if (s) {
              const c = s.indexOf(`
`), u = c === -1 ? -1 : s.indexOf(`
`, c + 1), f = u === -1 ? "" : s.slice(u + 1);
              String(o.stack).endsWith(f) || (o.stack += `
` + s);
            }
          } catch {
          }
        }
        throw o;
      }
    }
    _request(t, n) {
      typeof t == "string" ? (n = n || {}, n.url = t) : n = t || {}, n = lo(this.defaults, n);
      const { transitional: o, paramsSerializer: a, headers: s } = n;
      o !== void 0 && zl.assertOptions(o, { silentJSONParsing: Dn.transitional(Dn.boolean), forcedJSONParsing: Dn.transitional(Dn.boolean), clarifyTimeoutError: Dn.transitional(Dn.boolean), legacyInterceptorReqResOrdering: Dn.transitional(Dn.boolean), advertiseZstdAcceptEncoding: Dn.transitional(Dn.boolean) }, false), a != null && (F.isFunction(a) ? n.paramsSerializer = { serialize: a } : zl.assertOptions(a, { encode: Dn.function, serialize: Dn.function }, true)), n.allowAbsoluteUrls !== void 0 || (this.defaults.allowAbsoluteUrls !== void 0 ? n.allowAbsoluteUrls = this.defaults.allowAbsoluteUrls : n.allowAbsoluteUrls = true), zl.assertOptions(n, { baseUrl: Dn.spelling("baseURL"), withXsrfToken: Dn.spelling("withXSRFToken") }, true), n.method = (n.method || this.defaults.method || "get").toLowerCase();
      let c = s && F.merge(s.common, s[n.method]);
      s && F.forEach(["delete", "get", "head", "post", "put", "patch", "query", "common"], (W) => {
        delete s[W];
      }), n.headers = Sn.concat(c, s);
      const u = [];
      let f = true;
      this.interceptors.request.forEach(function(E) {
        if (typeof E.runWhen == "function" && E.runWhen(n) === false) return;
        f = f && E.synchronous;
        const L = n.transitional || Af;
        L && L.legacyInterceptorReqResOrdering ? u.unshift(E.fulfilled, E.rejected) : u.push(E.fulfilled, E.rejected);
      });
      const m = [];
      this.interceptors.response.forEach(function(E) {
        m.push(E.fulfilled, E.rejected);
      });
      let h, v = 0, C;
      if (!f) {
        const W = [yg.bind(this), void 0];
        for (W.unshift(...u), W.push(...m), C = W.length, h = Promise.resolve(n); v < C; ) h = h.then(W[v++], W[v++]);
        return h;
      }
      C = u.length;
      let D = n;
      for (; v < C; ) {
        const W = u[v++], E = u[v++];
        try {
          D = W(D);
        } catch (L) {
          E.call(this, L);
          break;
        }
      }
      try {
        h = yg.call(this, D);
      } catch (W) {
        return Promise.reject(W);
      }
      for (v = 0, C = m.length; v < C; ) h = h.then(m[v++], m[v++]);
      return h;
    }
    getUri(t) {
      t = lo(this.defaults, t);
      const n = mw(t.baseURL, t.url, t.allowAbsoluteUrls);
      return uw(n, t.params, t.paramsSerializer);
    }
  };
  F.forEach(["delete", "get", "head", "options"], function(t) {
    oo.prototype[t] = function(n, o) {
      return this.request(lo(o || {}, { method: t, url: n, data: (o || {}).data }));
    };
  });
  F.forEach(["post", "put", "patch", "query"], function(t) {
    function n(o) {
      return function(s, c, u) {
        return this.request(lo(u || {}, { method: t, headers: o ? { "Content-Type": "multipart/form-data" } : {}, url: s, data: c }));
      };
    }
    oo.prototype[t] = n(), t !== "query" && (oo.prototype[t + "Form"] = n(true));
  });
  let kD = class vw {
    constructor(t) {
      if (typeof t != "function") throw new TypeError("executor must be a function.");
      let n;
      this.promise = new Promise(function(s) {
        n = s;
      });
      const o = this;
      this.promise.then((a) => {
        if (!o._listeners) return;
        let s = o._listeners.length;
        for (; s-- > 0; ) o._listeners[s](a);
        o._listeners = null;
      }), this.promise.then = (a) => {
        let s;
        const c = new Promise((u) => {
          o.subscribe(u), s = u;
        }).then(a);
        return c.cancel = function() {
          o.unsubscribe(s);
        }, c;
      }, t(function(s, c, u) {
        o.reason || (o.reason = new ws(s, c, u), n(o.reason));
      });
    }
    throwIfRequested() {
      if (this.reason) throw this.reason;
    }
    subscribe(t) {
      if (this.reason) {
        t(this.reason);
        return;
      }
      this._listeners ? this._listeners.push(t) : this._listeners = [t];
    }
    unsubscribe(t) {
      if (!this._listeners) return;
      const n = this._listeners.indexOf(t);
      n !== -1 && this._listeners.splice(n, 1);
    }
    toAbortSignal() {
      const t = new AbortController(), n = (o) => {
        t.abort(o);
      };
      return this.subscribe(n), t.signal.unsubscribe = () => this.unsubscribe(n), t.signal;
    }
    static source() {
      let t;
      return { token: new vw(function(a) {
        t = a;
      }), cancel: t };
    }
  };
  function zD(e) {
    return function(n) {
      return e.apply(null, n);
    };
  }
  function DD(e) {
    return F.isObject(e) && e.isAxiosError === true;
  }
  const Dd = { Continue: 100, SwitchingProtocols: 101, Processing: 102, EarlyHints: 103, Ok: 200, Created: 201, Accepted: 202, NonAuthoritativeInformation: 203, NoContent: 204, ResetContent: 205, PartialContent: 206, MultiStatus: 207, AlreadyReported: 208, ImUsed: 226, MultipleChoices: 300, MovedPermanently: 301, Found: 302, SeeOther: 303, NotModified: 304, UseProxy: 305, Unused: 306, TemporaryRedirect: 307, PermanentRedirect: 308, BadRequest: 400, Unauthorized: 401, PaymentRequired: 402, Forbidden: 403, NotFound: 404, MethodNotAllowed: 405, NotAcceptable: 406, ProxyAuthenticationRequired: 407, RequestTimeout: 408, Conflict: 409, Gone: 410, LengthRequired: 411, PreconditionFailed: 412, PayloadTooLarge: 413, UriTooLong: 414, UnsupportedMediaType: 415, RangeNotSatisfiable: 416, ExpectationFailed: 417, ImATeapot: 418, MisdirectedRequest: 421, UnprocessableEntity: 422, Locked: 423, FailedDependency: 424, TooEarly: 425, UpgradeRequired: 426, PreconditionRequired: 428, TooManyRequests: 429, RequestHeaderFieldsTooLarge: 431, UnavailableForLegalReasons: 451, InternalServerError: 500, NotImplemented: 501, BadGateway: 502, ServiceUnavailable: 503, GatewayTimeout: 504, HttpVersionNotSupported: 505, VariantAlsoNegotiates: 506, InsufficientStorage: 507, LoopDetected: 508, NotExtended: 510, NetworkAuthenticationRequired: 511, WebServerIsDown: 521, ConnectionTimedOut: 522, OriginIsUnreachable: 523, TimeoutOccurred: 524, SslHandshakeFailed: 525, InvalidSslCertificate: 526 };
  Object.entries(Dd).forEach(([e, t]) => {
    Dd[t] = e;
  });
  function ww(e) {
    const t = new oo(e), n = Jv(oo.prototype.request, t);
    return F.extend(n, oo.prototype, t, { allOwnKeys: true }), F.extend(n, t, null, { allOwnKeys: true }), n.create = function(a) {
      return ww(lo(e, a));
    }, n;
  }
  const Ot = ww(vs);
  Ot.Axios = oo;
  Ot.CanceledError = ws;
  Ot.CancelToken = kD;
  Ot.isCancel = fw;
  Ot.VERSION = Tf;
  Ot.toFormData = cc;
  Ot.AxiosError = Se;
  Ot.Cancel = Ot.CanceledError;
  Ot.all = function(t) {
    return Promise.all(t);
  };
  Ot.spread = zD;
  Ot.isAxiosError = DD;
  Ot.mergeConfig = lo;
  Ot.AxiosHeaders = Sn;
  Ot.formToJSON = (e) => dw(F.isHTMLForm(e) ? new FormData(e) : e);
  Ot.getAdapter = yw.getAdapter;
  Ot.HttpStatusCode = Dd;
  Ot.default = Ot;
  const { Axios: UI, AxiosError: jI, CanceledError: HI, isCancel: VI, CancelToken: qI, VERSION: $I, all: GI, Cancel: KI, isAxiosError: YI, spread: ZI, toFormData: QI, AxiosHeaders: JI, HttpStatusCode: XI, formToJSON: eR, getAdapter: tR, mergeConfig: nR, create: iR } = Ot, Md = { tab: "Tab", enter: "Enter", space: "Space", left: "ArrowLeft", up: "ArrowUp", right: "ArrowRight", down: "ArrowDown", esc: "Escape", delete: "Delete", backspace: "Backspace", numpadEnter: "NumpadEnter", pageUp: "PageUp", pageDown: "PageDown", home: "Home", end: "End" }, MD = ["", "default", "small", "large"];
  var Sw = typeof global == "object" && global && global.Object === Object && global, LD = typeof self == "object" && self && self.Object === Object && self, ur = Sw || LD || Function("return this")(), Or = ur.Symbol, bw = Object.prototype, xD = bw.hasOwnProperty, OD = bw.toString, Ia = Or ? Or.toStringTag : void 0;
  function PD(e) {
    var t = xD.call(e, Ia), n = e[Ia];
    try {
      e[Ia] = void 0;
      var o = true;
    } catch {
    }
    var a = OD.call(e);
    return o && (t ? e[Ia] = n : delete e[Ia]), a;
  }
  var ID = Object.prototype, RD = ID.toString;
  function FD(e) {
    return RD.call(e);
  }
  var ND = "[object Null]", WD = "[object Undefined]", wg = Or ? Or.toStringTag : void 0;
  function mo(e) {
    return e == null ? e === void 0 ? WD : ND : wg && wg in Object(e) ? PD(e) : FD(e);
  }
  function Ss(e) {
    return e != null && typeof e == "object";
  }
  var BD = "[object Symbol]";
  function kf(e) {
    return typeof e == "symbol" || Ss(e) && mo(e) == BD;
  }
  function UD(e, t) {
    for (var n = -1, o = e == null ? 0 : e.length, a = Array(o); ++n < o; ) a[n] = t(e[n], n, e);
    return a;
  }
  var zf = Array.isArray, Sg = Or ? Or.prototype : void 0, bg = Sg ? Sg.toString : void 0;
  function _w(e) {
    if (typeof e == "string") return e;
    if (zf(e)) return UD(e, _w) + "";
    if (kf(e)) return bg ? bg.call(e) : "";
    var t = e + "";
    return t == "0" && 1 / e == -1 / 0 ? "-0" : t;
  }
  function Aw(e) {
    var t = typeof e;
    return e != null && (t == "object" || t == "function");
  }
  var jD = "[object AsyncFunction]", HD = "[object Function]", VD = "[object GeneratorFunction]", qD = "[object Proxy]";
  function $D(e) {
    if (!Aw(e)) return false;
    var t = mo(e);
    return t == HD || t == VD || t == jD || t == qD;
  }
  var nd = ur["__core-js_shared__"], _g = (function() {
    var e = /[^.]+$/.exec(nd && nd.keys && nd.keys.IE_PROTO || "");
    return e ? "Symbol(src)_1." + e : "";
  })();
  function GD(e) {
    return !!_g && _g in e;
  }
  var KD = Function.prototype, YD = KD.toString;
  function ho(e) {
    if (e != null) {
      try {
        return YD.call(e);
      } catch {
      }
      try {
        return e + "";
      } catch {
      }
    }
    return "";
  }
  var ZD = /[\\^$.*+?()[\]{}|]/g, QD = /^\[object .+?Constructor\]$/, JD = Function.prototype, XD = Object.prototype, eM = JD.toString, tM = XD.hasOwnProperty, nM = RegExp("^" + eM.call(tM).replace(ZD, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$");
  function iM(e) {
    if (!Aw(e) || GD(e)) return false;
    var t = $D(e) ? nM : QD;
    return t.test(ho(e));
  }
  function rM(e, t) {
    return e == null ? void 0 : e[t];
  }
  function go(e, t) {
    var n = rM(e, t);
    return iM(n) ? n : void 0;
  }
  var Ld = go(ur, "WeakMap"), Ag = (function() {
    try {
      var e = go(Object, "defineProperty");
      return e({}, "", {}), e;
    } catch {
    }
  })();
  function oM(e, t, n) {
    t == "__proto__" && Ag ? Ag(e, t, { configurable: true, enumerable: true, value: n, writable: true }) : e[t] = n;
  }
  function aM(e, t) {
    return e === t || e !== e && t !== t;
  }
  var sM = Object.prototype, rR = sM.hasOwnProperty, lM = 9007199254740991;
  function cM(e) {
    return typeof e == "number" && e > -1 && e % 1 == 0 && e <= lM;
  }
  var oR = Object.prototype, uM = "[object Arguments]";
  function Cg(e) {
    return Ss(e) && mo(e) == uM;
  }
  var Cw = Object.prototype, dM = Cw.hasOwnProperty, fM = Cw.propertyIsEnumerable, aR = Cg(/* @__PURE__ */ (function() {
    return arguments;
  })()) ? Cg : function(e) {
    return Ss(e) && dM.call(e, "callee") && !fM.call(e, "callee");
  }, Tw = typeof nr == "object" && nr && !nr.nodeType && nr, Tg = Tw && typeof ir == "object" && ir && !ir.nodeType && ir, pM = Tg && Tg.exports === Tw, Eg = pM ? ur.Buffer : void 0, sR = Eg ? Eg.isBuffer : void 0, mM = "[object Arguments]", hM = "[object Array]", gM = "[object Boolean]", yM = "[object Date]", vM = "[object Error]", wM = "[object Function]", SM = "[object Map]", bM = "[object Number]", _M = "[object Object]", AM = "[object RegExp]", CM = "[object Set]", TM = "[object String]", EM = "[object WeakMap]", kM = "[object ArrayBuffer]", zM = "[object DataView]", DM = "[object Float32Array]", MM = "[object Float64Array]", LM = "[object Int8Array]", xM = "[object Int16Array]", OM = "[object Int32Array]", PM = "[object Uint8Array]", IM = "[object Uint8ClampedArray]", RM = "[object Uint16Array]", FM = "[object Uint32Array]", At = {};
  At[DM] = At[MM] = At[LM] = At[xM] = At[OM] = At[PM] = At[IM] = At[RM] = At[FM] = true;
  At[mM] = At[hM] = At[kM] = At[gM] = At[zM] = At[yM] = At[vM] = At[wM] = At[SM] = At[bM] = At[_M] = At[AM] = At[CM] = At[TM] = At[EM] = false;
  function NM(e) {
    return Ss(e) && cM(e.length) && !!At[mo(e)];
  }
  function WM(e) {
    return function(t) {
      return e(t);
    };
  }
  var Ew = typeof nr == "object" && nr && !nr.nodeType && nr, Ya = Ew && typeof ir == "object" && ir && !ir.nodeType && ir, BM = Ya && Ya.exports === Ew, id = BM && Sw.process, kg = (function() {
    try {
      var e = Ya && Ya.require && Ya.require("util").types;
      return e || id && id.binding && id.binding("util");
    } catch {
    }
  })(), zg = kg && kg.isTypedArray, lR = zg ? WM(zg) : NM, UM = Object.prototype, cR = UM.hasOwnProperty;
  function kw(e, t) {
    return function(n) {
      return e(t(n));
    };
  }
  var uR = kw(Object.keys, Object), jM = Object.prototype, dR = jM.hasOwnProperty, HM = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/, VM = /^\w*$/;
  function qM(e, t) {
    if (zf(e)) return false;
    var n = typeof e;
    return n == "number" || n == "symbol" || n == "boolean" || e == null || kf(e) ? true : VM.test(e) || !HM.test(e) || t != null && e in Object(t);
  }
  var rs = go(Object, "create");
  function $M() {
    this.__data__ = rs ? rs(null) : {}, this.size = 0;
  }
  function GM(e) {
    var t = this.has(e) && delete this.__data__[e];
    return this.size -= t ? 1 : 0, t;
  }
  var KM = "__lodash_hash_undefined__", YM = Object.prototype, ZM = YM.hasOwnProperty;
  function QM(e) {
    var t = this.__data__;
    if (rs) {
      var n = t[e];
      return n === KM ? void 0 : n;
    }
    return ZM.call(t, e) ? t[e] : void 0;
  }
  var JM = Object.prototype, XM = JM.hasOwnProperty;
  function eL(e) {
    var t = this.__data__;
    return rs ? t[e] !== void 0 : XM.call(t, e);
  }
  var tL = "__lodash_hash_undefined__";
  function nL(e, t) {
    var n = this.__data__;
    return this.size += this.has(e) ? 0 : 1, n[e] = rs && t === void 0 ? tL : t, this;
  }
  function co(e) {
    var t = -1, n = e == null ? 0 : e.length;
    for (this.clear(); ++t < n; ) {
      var o = e[t];
      this.set(o[0], o[1]);
    }
  }
  co.prototype.clear = $M;
  co.prototype.delete = GM;
  co.prototype.get = QM;
  co.prototype.has = eL;
  co.prototype.set = nL;
  function iL() {
    this.__data__ = [], this.size = 0;
  }
  function dc(e, t) {
    for (var n = e.length; n--; ) if (aM(e[n][0], t)) return n;
    return -1;
  }
  var rL = Array.prototype, oL = rL.splice;
  function aL(e) {
    var t = this.__data__, n = dc(t, e);
    if (n < 0) return false;
    var o = t.length - 1;
    return n == o ? t.pop() : oL.call(t, n, 1), --this.size, true;
  }
  function sL(e) {
    var t = this.__data__, n = dc(t, e);
    return n < 0 ? void 0 : t[n][1];
  }
  function lL(e) {
    return dc(this.__data__, e) > -1;
  }
  function cL(e, t) {
    var n = this.__data__, o = dc(n, e);
    return o < 0 ? (++this.size, n.push([e, t])) : n[o][1] = t, this;
  }
  function dr(e) {
    var t = -1, n = e == null ? 0 : e.length;
    for (this.clear(); ++t < n; ) {
      var o = e[t];
      this.set(o[0], o[1]);
    }
  }
  dr.prototype.clear = iL;
  dr.prototype.delete = aL;
  dr.prototype.get = sL;
  dr.prototype.has = lL;
  dr.prototype.set = cL;
  var os = go(ur, "Map");
  function uL() {
    this.size = 0, this.__data__ = { hash: new co(), map: new (os || dr)(), string: new co() };
  }
  function dL(e) {
    var t = typeof e;
    return t == "string" || t == "number" || t == "symbol" || t == "boolean" ? e !== "__proto__" : e === null;
  }
  function fc(e, t) {
    var n = e.__data__;
    return dL(t) ? n[typeof t == "string" ? "string" : "hash"] : n.map;
  }
  function fL(e) {
    var t = fc(this, e).delete(e);
    return this.size -= t ? 1 : 0, t;
  }
  function pL(e) {
    return fc(this, e).get(e);
  }
  function mL(e) {
    return fc(this, e).has(e);
  }
  function hL(e, t) {
    var n = fc(this, e), o = n.size;
    return n.set(e, t), this.size += n.size == o ? 0 : 1, this;
  }
  function fr(e) {
    var t = -1, n = e == null ? 0 : e.length;
    for (this.clear(); ++t < n; ) {
      var o = e[t];
      this.set(o[0], o[1]);
    }
  }
  fr.prototype.clear = uL;
  fr.prototype.delete = fL;
  fr.prototype.get = pL;
  fr.prototype.has = mL;
  fr.prototype.set = hL;
  var gL = "Expected a function";
  function Df(e, t) {
    if (typeof e != "function" || t != null && typeof t != "function") throw new TypeError(gL);
    var n = function() {
      var o = arguments, a = t ? t.apply(this, o) : o[0], s = n.cache;
      if (s.has(a)) return s.get(a);
      var c = e.apply(this, o);
      return n.cache = s.set(a, c) || s, c;
    };
    return n.cache = new (Df.Cache || fr)(), n;
  }
  Df.Cache = fr;
  var yL = 500;
  function vL(e) {
    var t = Df(e, function(o) {
      return n.size === yL && n.clear(), o;
    }), n = t.cache;
    return t;
  }
  var wL = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g, SL = /\\(\\)?/g, bL = vL(function(e) {
    var t = [];
    return e.charCodeAt(0) === 46 && t.push(""), e.replace(wL, function(n, o, a, s) {
      t.push(a ? s.replace(SL, "$1") : o || n);
    }), t;
  });
  function _L(e) {
    return e == null ? "" : _w(e);
  }
  function AL(e, t) {
    return zf(e) ? e : qM(e, t) ? [e] : bL(_L(e));
  }
  function CL(e) {
    if (typeof e == "string" || kf(e)) return e;
    var t = e + "";
    return t == "0" && 1 / e == -1 / 0 ? "-0" : t;
  }
  function TL(e, t) {
    t = AL(t, e);
    for (var n = 0, o = t.length; e != null && n < o; ) e = e[CL(t[n++])];
    return n && n == o ? e : void 0;
  }
  function EL(e, t, n) {
    var o = e == null ? void 0 : TL(e, t);
    return o === void 0 ? n : o;
  }
  var kL = kw(Object.getPrototypeOf, Object), zL = "[object Object]", DL = Function.prototype, ML = Object.prototype, zw = DL.toString, LL = ML.hasOwnProperty, xL = zw.call(Object);
  function OL(e) {
    if (!Ss(e) || mo(e) != zL) return false;
    var t = kL(e);
    if (t === null) return true;
    var n = LL.call(t, "constructor") && t.constructor;
    return typeof n == "function" && n instanceof n && zw.call(n) == xL;
  }
  function PL() {
    this.__data__ = new dr(), this.size = 0;
  }
  function IL(e) {
    var t = this.__data__, n = t.delete(e);
    return this.size = t.size, n;
  }
  function RL(e) {
    return this.__data__.get(e);
  }
  function FL(e) {
    return this.__data__.has(e);
  }
  var NL = 200;
  function WL(e, t) {
    var n = this.__data__;
    if (n instanceof dr) {
      var o = n.__data__;
      if (!os || o.length < NL - 1) return o.push([e, t]), this.size = ++n.size, this;
      n = this.__data__ = new fr(o);
    }
    return n.set(e, t), this.size = n.size, this;
  }
  function bs(e) {
    var t = this.__data__ = new dr(e);
    this.size = t.size;
  }
  bs.prototype.clear = PL;
  bs.prototype.delete = IL;
  bs.prototype.get = RL;
  bs.prototype.has = FL;
  bs.prototype.set = WL;
  var BL = Object.prototype, fR = BL.propertyIsEnumerable, xd = go(ur, "DataView"), Od = go(ur, "Promise"), Pd = go(ur, "Set"), Dg = "[object Map]", UL = "[object Object]", Mg = "[object Promise]", Lg = "[object Set]", xg = "[object WeakMap]", Og = "[object DataView]", jL = ho(xd), HL = ho(os), VL = ho(Od), qL = ho(Pd), $L = ho(Ld), Ko = mo;
  (xd && Ko(new xd(new ArrayBuffer(1))) != Og || os && Ko(new os()) != Dg || Od && Ko(Od.resolve()) != Mg || Pd && Ko(new Pd()) != Lg || Ld && Ko(new Ld()) != xg) && (Ko = function(e) {
    var t = mo(e), n = t == UL ? e.constructor : void 0, o = n ? ho(n) : "";
    if (o) switch (o) {
      case jL:
        return Og;
      case HL:
        return Dg;
      case VL:
        return Mg;
      case qL:
        return Lg;
      case $L:
        return xg;
    }
    return t;
  });
  var pR = ur.Uint8Array, GL = "__lodash_hash_undefined__";
  function KL(e) {
    return this.__data__.set(e, GL), this;
  }
  function YL(e) {
    return this.__data__.has(e);
  }
  function Id(e) {
    var t = -1, n = e == null ? 0 : e.length;
    for (this.__data__ = new fr(); ++t < n; ) this.add(e[t]);
  }
  Id.prototype.add = Id.prototype.push = KL;
  Id.prototype.has = YL;
  var Pg = Or ? Or.prototype : void 0, mR = Pg ? Pg.valueOf : void 0, ZL = Object.prototype, hR = ZL.hasOwnProperty, QL = Object.prototype, gR = QL.hasOwnProperty;
  function Dw(e) {
    for (var t = -1, n = e == null ? 0 : e.length, o = {}; ++t < n; ) {
      var a = e[t];
      oM(o, a[0], a[1]);
    }
    return o;
  }
  function JL(e) {
    return e == null;
  }
  const rd = (e) => typeof e == "boolean", uo = (e) => typeof e == "number", XL = (e) => typeof Element > "u" ? false : e instanceof Element, ex = (e) => ht(e) ? !Number.isNaN(Number(e)) : false, Ig = (e) => Object.keys(e), tx = "__epPropKey", yn = (e) => e, nx = (e) => ot(e) && !!e.__epPropKey, Mw = (e, t) => {
    if (!ot(e) || nx(e)) return e;
    const { values: n, required: o, default: a, type: s, validator: c } = e, u = { type: s, required: !!o, validator: n || c ? (f) => {
      let m = false, h = [];
      if (n && (h = Array.from(n), et(e, "default") && h.push(a), m || (m = h.includes(f))), c && (m || (m = c(f))), !m && h.length > 0) {
        const v = [...new Set(h)].map((C) => JSON.stringify(C)).join(", ");
        ek(`Invalid prop: validation failed${t ? ` for prop "${t}"` : ""}. Expected one of [${v}], got value ${JSON.stringify(f)}.`);
      }
      return m;
    } : void 0, [tx]: true };
    return et(e, "default") && (u.default = a), u;
  }, _s = (e) => Dw(Object.entries(e).map(([t, n]) => [t, Mw(n, t)]));
  var ix = class extends Error {
    constructor(e) {
      super(e), this.name = "ElementPlusError";
    }
  };
  function As(e, t) {
    {
      const n = ht(e) ? new ix(`[${e}] ${t}`) : e;
      console.warn(n);
    }
  }
  function Lw(e, t) {
    return tf() ? (Ry(e, t), true) : false;
  }
  const yo = typeof window < "u" && typeof document < "u";
  typeof WorkerGlobalScope < "u" && globalThis instanceof WorkerGlobalScope;
  const rx = Object.prototype.toString, ox = (e) => rx.call(e) === "[object Object]";
  function od(e) {
    return Array.isArray(e) ? e : [e];
  }
  function ax(e, t, n = {}) {
    const { immediate: o = true, immediateCallback: a = false } = n, s = cf(false);
    let c;
    function u() {
      c && (clearTimeout(c), c = void 0);
    }
    function f() {
      s.value = false, u();
    }
    function m(...h) {
      a && e(), u(), s.value = true, c = setTimeout(() => {
        s.value = false, c = void 0, e(...h);
      }, na(t));
    }
    return o && (s.value = true, yo && m()), Lw(f), { isPending: PE(s), start: m, stop: f };
  }
  function sx(e, t, n) {
    return vi(e, t, { ...n, immediate: true });
  }
  const xw = yo ? window : void 0, yR = yo ? window.document : void 0;
  function Rd(e) {
    var t;
    const n = na(e);
    return (t = n == null ? void 0 : n.$el) !== null && t !== void 0 ? t : n;
  }
  function lx(...e) {
    const t = (o, a, s, c) => (o.addEventListener(a, s, c), () => o.removeEventListener(a, s, c)), n = We(() => {
      const o = od(na(e[0])).filter((a) => a != null);
      return o.every((a) => typeof a != "string") ? o : void 0;
    });
    return sx(() => {
      var o, a;
      return [(o = (a = n.value) === null || a === void 0 ? void 0 : a.map((s) => Rd(s))) !== null && o !== void 0 ? o : [xw].filter((s) => s != null), od(na(n.value ? e[1] : e[0])), od(Je(n.value ? e[2] : e[1])), na(n.value ? e[3] : e[2])];
    }, ([o, a, s, c], u, f) => {
      if (!(o != null && o.length) || !(a != null && a.length) || !(s != null && s.length)) return;
      const m = ox(c) ? { ...c } : c, h = o.flatMap((v) => a.flatMap((C) => s.map((D) => t(v, C, D, m))));
      f(() => {
        h.forEach((v) => v());
      });
    }, { flush: "post" });
  }
  function cx() {
    const e = cf(false), t = On();
    return t && ps(() => {
      e.value = true;
    }, t), e;
  }
  function ux(e) {
    const t = cx();
    return We(() => (t.value, !!e()));
  }
  const vR = /* @__PURE__ */ Symbol("vueuse-ssr-width");
  function dx(e, t, n = {}) {
    const { window: o = xw, ...a } = n;
    let s;
    const c = ux(() => o && "ResizeObserver" in o), u = () => {
      s && (s.disconnect(), s = void 0);
    }, f = vi(We(() => {
      const h = na(e);
      return Array.isArray(h) ? h.map((v) => Rd(v)) : [Rd(h)];
    }), (h) => {
      if (u(), c.value && o) {
        s = new ResizeObserver(t);
        for (const v of h) v && s.observe(v, a);
      }
    }, { immediate: true, flush: "post" }), m = () => {
      u(), f();
    };
    return Lw(m), { isSupported: c, stop: m };
  }
  const fx = () => yo && /android/i.test(window.navigator.userAgent), px = "utils/dom/style";
  function Fd(e, t = "px") {
    if (!e && e !== 0) return "";
    if (uo(e) || ex(e)) return `${e}${t}`;
    if (ht(e)) return e;
    As(px, "binding value must be a string or number");
  }
  var mx = { name: "en", el: { breadcrumb: { label: "Breadcrumb" }, colorpicker: { confirm: "OK", clear: "Clear", defaultLabel: "color picker", description: "current color is {color}. press enter to select a new color.", alphaLabel: "pick alpha value", alphaDescription: "alpha {alpha}, current color is {color}", hueLabel: "pick hue value", hueDescription: "hue {hue}, current color is {color}", svLabel: "pick saturation and brightness value", svDescription: "saturation {saturation}, brightness {brightness}, current color is {color}", predefineDescription: "select {value} as the color" }, datepicker: { now: "Now", today: "Today", cancel: "Cancel", clear: "Clear", confirm: "OK", dateTablePrompt: "Use the arrow keys and enter to select the day of the month", monthTablePrompt: "Use the arrow keys and enter to select the month", yearTablePrompt: "Use the arrow keys and enter to select the year", selectedDate: "Selected date", selectDate: "Select date", selectTime: "Select time", startDate: "Start Date", startTime: "Start Time", endDate: "End Date", endTime: "End Time", prevYear: "Previous Year", nextYear: "Next Year", prevMonth: "Previous Month", nextMonth: "Next Month", year: "", month1: "January", month2: "February", month3: "March", month4: "April", month5: "May", month6: "June", month7: "July", month8: "August", month9: "September", month10: "October", month11: "November", month12: "December", weeks: { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" }, weeksFull: { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" }, months: { jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun", jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec" } }, inputNumber: { decrease: "decrease number", increase: "increase number" }, select: { loading: "Loading", noMatch: "No matching data", noData: "No data", placeholder: "Select" }, mention: { loading: "Loading" }, dropdown: { toggleDropdown: "Toggle Dropdown" }, cascader: { noMatch: "No matching data", loading: "Loading", placeholder: "Select", noData: "No data" }, pagination: { goto: "Go to", pagesize: "/page", total: "Total {total}", pageClassifier: "", page: "Page", prev: "Go to previous page", next: "Go to next page", currentPage: "page {pager}", prevPages: "Previous {pager} pages", nextPages: "Next {pager} pages", deprecationWarning: "Deprecated usages detected, please refer to the el-pagination documentation for more details" }, dialog: { close: "Close this dialog" }, drawer: { close: "Close this dialog" }, messagebox: { title: "Message", confirm: "OK", cancel: "Cancel", error: "Illegal input", close: "Close this dialog" }, upload: { deleteTip: "press delete to remove", delete: "Delete", preview: "Preview", continue: "Continue" }, slider: { defaultLabel: "slider between {min} and {max}", defaultRangeStartLabel: "pick start value", defaultRangeEndLabel: "pick end value" }, table: { emptyText: "No Data", confirmFilter: "Confirm", resetFilter: "Reset", clearFilter: "All", sumText: "Sum", selectAllLabel: "Select all rows", selectRowLabel: "Select this row", expandRowLabel: "Expand this row", collapseRowLabel: "Collapse this row", sortLabel: "Sort by {column}", filterLabel: "Filter by {column}" }, tag: { close: "Close this tag" }, tour: { next: "Next", previous: "Previous", finish: "Finish", close: "Close this dialog" }, tree: { emptyText: "No Data" }, transfer: { noMatch: "No matching data", noData: "No data", titles: ["List 1", "List 2"], filterPlaceholder: "Enter keyword", noCheckedFormat: "{total} items", hasCheckedFormat: "{checked}/{total} checked" }, image: { error: "FAILED" }, pageHeader: { title: "Back" }, popconfirm: { confirmButtonText: "Yes", cancelButtonText: "No" }, carousel: { leftArrow: "Carousel arrow left", rightArrow: "Carousel arrow right", indicator: "Carousel switch to index {index}" }, inputOTP: { groupLabel: "OTP Input", defaultLabel: "Please enter OTP character {index}" } } };
  const hx = (e) => (t, n) => gx(t, n, Je(e)), gx = (e, t, n) => EL(n, e, e).replace(/\{(\w+)\}/g, (o, a) => `${(t == null ? void 0 : t[a]) ?? `{${a}}`}`), yx = (e) => ({ lang: We(() => Je(e).name), locale: bt(e) ? e : Ln(e), t: hx(e) }), Ow = /* @__PURE__ */ Symbol("localeContextKey"), vx = (e) => {
    const t = e || ri(Ow, Ln());
    return yx(We(() => t.value || mx));
  }, wx = "is-", Jr = (e, t, n, o, a) => {
    let s = `${e}-${t}`;
    return n && (s += `-${n}`), o && (s += `__${o}`), a && (s += `--${a}`), s;
  }, Pw = /* @__PURE__ */ Symbol("namespaceContextKey"), Sx = (e) => {
    const t = e || (On() ? ri(Pw, Ln("el")) : Ln("el"));
    return We(() => Je(t) || "el");
  }, Mf = (e, t) => {
    const n = Sx(t);
    return { namespace: n, b: (E = "") => Jr(n.value, e, E, "", ""), e: (E) => E ? Jr(n.value, e, "", E, "") : "", m: (E) => E ? Jr(n.value, e, "", "", E) : "", be: (E, L) => E && L ? Jr(n.value, e, E, L, "") : "", em: (E, L) => E && L ? Jr(n.value, e, "", E, L) : "", bm: (E, L) => E && L ? Jr(n.value, e, E, "", L) : "", bem: (E, L, b) => E && L && b ? Jr(n.value, e, E, L, b) : "", is: (E, ...L) => {
      const b = L.length >= 1 ? L[0] : true;
      return E && b ? `${wx}${E}` : "";
    }, cssVar: (E) => {
      const L = {};
      for (const b in E) E[b] && (L[`--${n.value}-${b}`] = E[b]);
      return L;
    }, cssVarName: (E) => `--${n.value}-${E}`, cssVarBlock: (E) => {
      const L = {};
      for (const b in E) E[b] && (L[`--${n.value}-${e}-${b}`] = E[b]);
      return L;
    }, cssVarBlockName: (E) => `--${n.value}-${e}-${E}` };
  }, bx = (e) => {
    if (e.code && e.code !== "Unidentified") return e.code;
    const t = _x(e);
    if (t) {
      if (Object.values(Md).includes(t)) return t;
      switch (t) {
        case " ":
          return Md.space;
        default:
          return "";
      }
    }
    return "";
  }, _x = (e) => {
    let t = e.key && e.key !== "Unidentified" ? e.key : "";
    if (!t && e.type === "keyup" && fx()) {
      const n = e.target;
      t = n.value.charAt(n.selectionStart - 1);
    }
    return t;
  }, Rg = { current: 0 }, Fg = Ln(0), Iw = 2e3, Ng = /* @__PURE__ */ Symbol("elZIndexContextKey"), Rw = /* @__PURE__ */ Symbol("zIndexContextKey"), Ax = (e) => {
    const t = On() ? ri(Ng, Rg) : Rg, n = e || (On() ? ri(Rw, void 0) : void 0), o = We(() => {
      const c = Je(n);
      return uo(c) ? c : Iw;
    }), a = We(() => o.value + Fg.value), s = () => (t.current++, Fg.value = t.current, a.value);
    return !yo && !ri(Ng) && As("ZIndexInjection", `Looks like you are using server rendering, you must provide a z-index provider to ensure the hydration process to be succeed
usage: app.provide(ZINDEX_INJECTION_KEY, { current: 0 })`), { initialZIndex: o, currentZIndex: a, nextZIndex: s };
  }, Cx = Mw({ type: String, values: MD, required: false }), Tx = /* @__PURE__ */ Symbol("size"), Ex = /* @__PURE__ */ Symbol("emptyValuesContextKey"), kx = _s({ emptyValues: Array, valueOnClear: { type: yn([String, Number, Boolean, Function]), default: void 0, validator: (e) => (e = Pe(e) ? e() : e, xe(e) ? e.every((t) => !t) : !e) } }), zx = (e) => {
    const t = e.props, n = xe(t) ? Dw(t.map((o) => [o, {}])) : t;
    e.setPropsDefaults = (o) => {
      if (n) {
        for (const [a, s] of Object.entries(o)) {
          const c = n[a];
          if (et(n, a)) {
            if (OL(c)) {
              n[a] = { ...c, default: s };
              continue;
            }
            n[a] = { type: c, default: s };
          }
        }
        e.props = n;
      }
    };
  }, Fw = (e, t) => {
    if (e.install = (n) => {
      for (const o of [e, ...Object.values(t ?? {})]) n.component(o.name, o);
    }, t) for (const [n, o] of Object.entries(t)) e[n] = o;
    return zx(e), e;
  }, Dx = (e, t) => (e.install = (n) => {
    e._context = n._context, n.config.globalProperties[t] = e;
  }, e);
  /*! Element Plus Icons Vue v2.3.2 */
  var Mx = Si({ name: "CircleCloseFilled", __name: "circle-close-filled", setup(e) {
    return (t, n) => (Gt(), Ri("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024" }, [lr("path", { fill: "currentColor", d: "M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m0 393.664L407.936 353.6a38.4 38.4 0 1 0-54.336 54.336L457.664 512 353.6 616.064a38.4 38.4 0 1 0 54.336 54.336L512 566.336 616.064 670.4a38.4 38.4 0 1 0 54.336-54.336L566.336 512 670.4 407.936a38.4 38.4 0 1 0-54.336-54.336z" })]));
  } }), Nw = Mx, Lx = Si({ name: "Close", __name: "close", setup(e) {
    return (t, n) => (Gt(), Ri("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024" }, [lr("path", { fill: "currentColor", d: "M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z" })]));
  } }), xx = Lx, Ox = Si({ name: "InfoFilled", __name: "info-filled", setup(e) {
    return (t, n) => (Gt(), Ri("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024" }, [lr("path", { fill: "currentColor", d: "M512 64a448 448 0 1 1 0 896.064A448 448 0 0 1 512 64m67.2 275.072c33.28 0 60.288-23.104 60.288-57.344s-27.072-57.344-60.288-57.344c-33.28 0-60.16 23.104-60.16 57.344s26.88 57.344 60.16 57.344M590.912 699.2c0-6.848 2.368-24.64 1.024-34.752l-52.608 60.544c-10.88 11.456-24.512 19.392-30.912 17.28a12.99 12.99 0 0 1-8.256-14.72l87.68-276.992c7.168-35.136-12.544-67.2-54.336-71.296-44.096 0-108.992 44.736-148.48 101.504 0 6.784-1.28 23.68.064 33.792l52.544-60.608c10.88-11.328 23.552-19.328 29.952-17.152a12.8 12.8 0 0 1 7.808 16.128L388.48 728.576c-10.048 32.256 8.96 63.872 55.04 71.04 67.84 0 107.904-43.648 147.456-100.416z" })]));
  } }), Nd = Ox, Px = Si({ name: "SuccessFilled", __name: "success-filled", setup(e) {
    return (t, n) => (Gt(), Ri("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024" }, [lr("path", { fill: "currentColor", d: "M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m-55.808 536.384-99.52-99.584a38.4 38.4 0 1 0-54.336 54.336l126.72 126.72a38.27 38.27 0 0 0 54.336 0l262.4-262.464a38.4 38.4 0 1 0-54.272-54.336z" })]));
  } }), Ww = Px, Ix = Si({ name: "WarningFilled", __name: "warning-filled", setup(e) {
    return (t, n) => (Gt(), Ri("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 1024 1024" }, [lr("path", { fill: "currentColor", d: "M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896m0 192a58.43 58.43 0 0 0-58.24 63.744l23.36 256.384a35.072 35.072 0 0 0 69.76 0l23.296-256.384A58.43 58.43 0 0 0 512 256m0 512a51.2 51.2 0 1 0 0-102.4 51.2 51.2 0 0 0 0 102.4" })]));
  } }), Bw = Ix;
  const Rx = yn([String, Object, Function]), Fx = { Close: xx, SuccessFilled: Ww, InfoFilled: Nd, WarningFilled: Bw, CircleCloseFilled: Nw }, Wg = { primary: Nd, success: Ww, warning: Bw, error: Nw, info: Nd }, Nx = _s({ size: { type: yn([Number, String]) }, color: { type: String } });
  var Wx = Si({ name: "ElIcon", inheritAttrs: false, __name: "icon", props: Nx, setup(e) {
    const t = e, n = Mf("icon"), o = We(() => {
      const { size: a, color: s } = t, c = Fd(a);
      return !c && !s ? {} : { fontSize: c, "--color": s };
    });
    return (a, s) => (Gt(), Ri("i", jv({ class: Je(n).b(), style: o.value }, a.$attrs), [Rl(a.$slots, "default")], 16));
  } }), Bx = Wx;
  const Bg = Fw(Bx), Ux = (e) => e, jx = _s({ value: { type: [String, Number], default: "" }, max: { type: Number, default: 99 }, isDot: Boolean, hidden: Boolean, type: { type: String, values: ["primary", "success", "warning", "info", "danger"], default: "danger" }, showZero: { type: Boolean, default: true }, color: String, badgeStyle: { type: yn([String, Object, Array, Boolean]), default: void 0 }, offset: { type: yn(Array), default: () => [0, 0] }, badgeClass: { type: String } });
  var Hx = Si({ name: "ElBadge", __name: "badge", props: jx, setup(e, { expose: t }) {
    const n = e, o = Mf("badge"), a = We(() => n.isDot ? "" : uo(n.value) && uo(n.max) ? n.max < n.value ? `${n.max}+` : `${n.value}` : `${n.value}`), s = We(() => [{ backgroundColor: n.color, marginRight: Fd(-n.offset[0]), marginTop: Fd(n.offset[1]) }, n.badgeStyle ?? {}]);
    return t({ content: a }), (c, u) => (Gt(), Ri("div", { class: mi(Je(o).b()) }, [Rl(c.$slots, "default"), Kt(Gv, { name: `${Je(o).namespace.value}-zoom-in-center` }, { default: Va(() => [!e.hidden && (a.value || e.isDot || c.$slots.content) ? (Gt(), Ri("sup", { key: 0, class: mi([Je(o).e("content"), Je(o).em("content", e.type), Je(o).is("fixed", !!c.$slots.default), Je(o).is("dot", e.isDot), Je(o).is("hide-zero", !e.showZero && e.value === 0), e.badgeClass]), style: ds(s.value) }, [Rl(c.$slots, "content", { value: a.value }, () => [hf(ef(a.value), 1)])], 6)) : Xo("v-if", true)]), _: 3 }, 8, ["name"])], 2));
  } }), Vx = Hx;
  const qx = Fw(Vx), Uw = /* @__PURE__ */ Symbol(), jl = Ln();
  function jw(e, t = void 0) {
    const n = On() ? ri(Uw, jl) : jl;
    return e ? We(() => {
      var o;
      return ((o = n.value) == null ? void 0 : o[e]) ?? t;
    }) : n;
  }
  function $x(e, t) {
    const n = jw(), o = Mf(e, We(() => {
      var u;
      return ((u = n.value) == null ? void 0 : u.namespace) || "el";
    })), a = vx(We(() => {
      var u;
      return (u = n.value) == null ? void 0 : u.locale;
    })), s = Ax(We(() => {
      var f;
      const u = (f = n.value) == null ? void 0 : f.zIndex;
      return JL(u) || Number.isNaN(u) ? Iw : u;
    })), c = We(() => {
      var u;
      return Je(t) || ((u = n.value) == null ? void 0 : u.size) || "";
    });
    return Gx(We(() => Je(n) || {})), { ns: o, locale: a, zIndex: s, size: c };
  }
  const Gx = (e, t, n = false) => {
    const o = !!On(), a = o ? jw() : void 0, s = o ? lv : void 0;
    if (!s) {
      As("provideGlobalConfig", "provideGlobalConfig() can only be used inside setup().");
      return;
    }
    const c = We(() => {
      const u = Je(e);
      return a != null && a.value ? Kx(a.value, u) : u;
    });
    return s(Uw, c), s(Ow, We(() => c.value.locale)), s(Pw, We(() => c.value.namespace)), s(Rw, We(() => c.value.zIndex)), s(Tx, { size: We(() => c.value.size || "") }), s(Ex, We(() => ({ emptyValues: c.value.emptyValues, valueOnClear: c.value.valueOnClear }))), (n || !jl.value) && (jl.value = c.value), c;
  }, Kx = (e, t) => {
    const n = [.../* @__PURE__ */ new Set([...Ig(e), ...Ig(t)])], o = {};
    for (const a of n) o[a] = t[a] !== void 0 ? t[a] : e[a];
    return o;
  }, wR = _s({ a11y: { type: Boolean, default: true }, locale: { type: yn(Object) }, size: Cx, button: { type: yn(Object) }, card: { type: yn(Object) }, dialog: { type: yn(Object) }, link: { type: yn(Object) }, experimentalFeatures: { type: yn(Object) }, keyboardNavigation: { type: Boolean, default: true }, message: { type: yn(Object) }, zIndex: Number, namespace: { type: String, default: "el" }, table: { type: yn(Object) }, ...kx }), gn = { placement: "top" };
  var Qo = typeof globalThis < "u" ? globalThis : typeof window < "u" ? window : typeof global < "u" ? global : typeof self < "u" ? self : {}, Hw = { exports: {} };
  (function(e, t) {
    (function(n, o) {
      e.exports = o();
    })(Qo, function() {
      var n = 1e3, o = 6e4, a = 36e5, s = "millisecond", c = "second", u = "minute", f = "hour", m = "day", h = "week", v = "month", C = "quarter", D = "year", W = "date", E = "Invalid Date", L = /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/, b = /\[([^\]]+)]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/g, P = { name: "en", weekdays: "Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday".split("_"), months: "January_February_March_April_May_June_July_August_September_October_November_December".split("_"), ordinal: function(fe) {
        var ce = ["th", "st", "nd", "rd"], G = fe % 100;
        return "[" + fe + (ce[(G - 20) % 10] || ce[G] || ce[0]) + "]";
      } }, B = function(fe, ce, G) {
        var oe = String(fe);
        return !oe || oe.length >= ce ? fe : "" + Array(ce + 1 - oe.length).join(G) + fe;
      }, k = { s: B, z: function(fe) {
        var ce = -fe.utcOffset(), G = Math.abs(ce), oe = Math.floor(G / 60), ie = G % 60;
        return (ce <= 0 ? "+" : "-") + B(oe, 2, "0") + ":" + B(ie, 2, "0");
      }, m: function fe(ce, G) {
        if (ce.date() < G.date()) return -fe(G, ce);
        var oe = 12 * (G.year() - ce.year()) + (G.month() - ce.month()), ie = ce.clone().add(oe, v), pe = G - ie < 0, we = ce.clone().add(oe + (pe ? -1 : 1), v);
        return +(-(oe + (G - ie) / (pe ? ie - we : we - ie)) || 0);
      }, a: function(fe) {
        return fe < 0 ? Math.ceil(fe) || 0 : Math.floor(fe);
      }, p: function(fe) {
        return { M: v, y: D, w: h, d: m, D: W, h: f, m: u, s: c, ms: s, Q: C }[fe] || String(fe || "").toLowerCase().replace(/s$/, "");
      }, u: function(fe) {
        return fe === void 0;
      } }, j = "en", $ = {};
      $[j] = P;
      var q = "$isDayjsObject", ue = function(fe) {
        return fe instanceof re || !(!fe || !fe[q]);
      }, ee = function fe(ce, G, oe) {
        var ie;
        if (!ce) return j;
        if (typeof ce == "string") {
          var pe = ce.toLowerCase();
          $[pe] && (ie = pe), G && ($[pe] = G, ie = pe);
          var we = ce.split("-");
          if (!ie && we.length > 1) return fe(we[0]);
        } else {
          var Te = ce.name;
          $[Te] = ce, ie = Te;
        }
        return !oe && ie && (j = ie), ie || !oe && j;
      }, se = function(fe, ce) {
        if (ue(fe)) return fe.clone();
        var G = typeof ce == "object" ? ce : {};
        return G.date = fe, G.args = arguments, new re(G);
      }, le = k;
      le.l = ee, le.i = ue, le.w = function(fe, ce) {
        return se(fe, { locale: ce.$L, utc: ce.$u, x: ce.$x, $offset: ce.$offset });
      };
      var re = (function() {
        function fe(G) {
          this.$L = ee(G.locale, null, true), this.parse(G), this.$x = this.$x || G.x || {}, this[q] = true;
        }
        var ce = fe.prototype;
        return ce.parse = function(G) {
          this.$d = (function(oe) {
            var ie = oe.date, pe = oe.utc;
            if (ie === null) return /* @__PURE__ */ new Date(NaN);
            if (le.u(ie)) return /* @__PURE__ */ new Date();
            if (ie instanceof Date) return new Date(ie);
            if (typeof ie == "string" && !/Z$/i.test(ie)) {
              var we = ie.match(L);
              if (we) {
                var Te = we[2] - 1 || 0, ke = (we[7] || "0").substring(0, 3);
                return pe ? new Date(Date.UTC(we[1], Te, we[3] || 1, we[4] || 0, we[5] || 0, we[6] || 0, ke)) : new Date(we[1], Te, we[3] || 1, we[4] || 0, we[5] || 0, we[6] || 0, ke);
              }
            }
            return new Date(ie);
          })(G), this.init();
        }, ce.init = function() {
          var G = this.$d;
          this.$y = G.getFullYear(), this.$M = G.getMonth(), this.$D = G.getDate(), this.$W = G.getDay(), this.$H = G.getHours(), this.$m = G.getMinutes(), this.$s = G.getSeconds(), this.$ms = G.getMilliseconds();
        }, ce.$utils = function() {
          return le;
        }, ce.isValid = function() {
          return this.$d.toString() !== E;
        }, ce.isSame = function(G, oe) {
          var ie = se(G);
          return this.startOf(oe) <= ie && ie <= this.endOf(oe);
        }, ce.isAfter = function(G, oe) {
          return se(G) < this.startOf(oe);
        }, ce.isBefore = function(G, oe) {
          return this.endOf(oe) < se(G);
        }, ce.$g = function(G, oe, ie) {
          return le.u(G) ? this[oe] : this.set(ie, G);
        }, ce.unix = function() {
          return Math.floor(this.valueOf() / 1e3);
        }, ce.valueOf = function() {
          return this.$d.getTime();
        }, ce.startOf = function(G, oe) {
          var ie = this, pe = !!le.u(oe) || oe, we = le.p(G), Te = function(pt, be) {
            var Ae = le.w(ie.$u ? Date.UTC(ie.$y, be, pt) : new Date(ie.$y, be, pt), ie);
            return pe ? Ae : Ae.endOf(m);
          }, ke = function(pt, be) {
            return le.w(ie.toDate()[pt].apply(ie.toDate("s"), (pe ? [0, 0, 0, 0] : [23, 59, 59, 999]).slice(be)), ie);
          }, tt = this.$W, Me = this.$M, it = this.$D, Re = "set" + (this.$u ? "UTC" : "");
          switch (we) {
            case D:
              return pe ? Te(1, 0) : Te(31, 11);
            case v:
              return pe ? Te(1, Me) : Te(0, Me + 1);
            case h:
              var ft = this.$locale().weekStart || 0, Ie = (tt < ft ? tt + 7 : tt) - ft;
              return Te(pe ? it - Ie : it + (6 - Ie), Me);
            case m:
            case W:
              return ke(Re + "Hours", 0);
            case f:
              return ke(Re + "Minutes", 1);
            case u:
              return ke(Re + "Seconds", 2);
            case c:
              return ke(Re + "Milliseconds", 3);
            default:
              return this.clone();
          }
        }, ce.endOf = function(G) {
          return this.startOf(G, false);
        }, ce.$set = function(G, oe) {
          var ie, pe = le.p(G), we = "set" + (this.$u ? "UTC" : ""), Te = (ie = {}, ie[m] = we + "Date", ie[W] = we + "Date", ie[v] = we + "Month", ie[D] = we + "FullYear", ie[f] = we + "Hours", ie[u] = we + "Minutes", ie[c] = we + "Seconds", ie[s] = we + "Milliseconds", ie)[pe], ke = pe === m ? this.$D + (oe - this.$W) : oe;
          if (pe === v || pe === D) {
            var tt = this.clone().set(W, 1);
            tt.$d[Te](ke), tt.init(), this.$d = tt.set(W, Math.min(this.$D, tt.daysInMonth())).$d;
          } else Te && this.$d[Te](ke);
          return this.init(), this;
        }, ce.set = function(G, oe) {
          return this.clone().$set(G, oe);
        }, ce.get = function(G) {
          return this[le.p(G)]();
        }, ce.add = function(G, oe) {
          var ie, pe = this;
          G = Number(G);
          var we = le.p(oe), Te = function(Me) {
            var it = se(pe);
            return le.w(it.date(it.date() + Math.round(Me * G)), pe);
          };
          if (we === v) return this.set(v, this.$M + G);
          if (we === D) return this.set(D, this.$y + G);
          if (we === m) return Te(1);
          if (we === h) return Te(7);
          var ke = (ie = {}, ie[u] = o, ie[f] = a, ie[c] = n, ie)[we] || 1, tt = this.$d.getTime() + G * ke;
          return le.w(tt, this);
        }, ce.subtract = function(G, oe) {
          return this.add(-1 * G, oe);
        }, ce.format = function(G) {
          var oe = this, ie = this.$locale();
          if (!this.isValid()) return ie.invalidDate || E;
          var pe = G || "YYYY-MM-DDTHH:mm:ssZ", we = le.z(this), Te = this.$H, ke = this.$m, tt = this.$M, Me = ie.weekdays, it = ie.months, Re = ie.meridiem, ft = function(be, Ae, _, z) {
            return be && (be[Ae] || be(oe, pe)) || _[Ae].slice(0, z);
          }, Ie = function(be) {
            return le.s(Te % 12 || 12, be, "0");
          }, pt = Re || function(be, Ae, _) {
            var z = be < 12 ? "AM" : "PM";
            return _ ? z.toLowerCase() : z;
          };
          return pe.replace(b, function(be, Ae) {
            return Ae || (function(_) {
              switch (_) {
                case "YY":
                  return String(oe.$y).slice(-2);
                case "YYYY":
                  return le.s(oe.$y, 4, "0");
                case "M":
                  return tt + 1;
                case "MM":
                  return le.s(tt + 1, 2, "0");
                case "MMM":
                  return ft(ie.monthsShort, tt, it, 3);
                case "MMMM":
                  return ft(it, tt);
                case "D":
                  return oe.$D;
                case "DD":
                  return le.s(oe.$D, 2, "0");
                case "d":
                  return String(oe.$W);
                case "dd":
                  return ft(ie.weekdaysMin, oe.$W, Me, 2);
                case "ddd":
                  return ft(ie.weekdaysShort, oe.$W, Me, 3);
                case "dddd":
                  return Me[oe.$W];
                case "H":
                  return String(Te);
                case "HH":
                  return le.s(Te, 2, "0");
                case "h":
                  return Ie(1);
                case "hh":
                  return Ie(2);
                case "a":
                  return pt(Te, ke, true);
                case "A":
                  return pt(Te, ke, false);
                case "m":
                  return String(ke);
                case "mm":
                  return le.s(ke, 2, "0");
                case "s":
                  return String(oe.$s);
                case "ss":
                  return le.s(oe.$s, 2, "0");
                case "SSS":
                  return le.s(oe.$ms, 3, "0");
                case "Z":
                  return we;
              }
              return null;
            })(be) || we.replace(":", "");
          });
        }, ce.utcOffset = function() {
          return 15 * -Math.round(this.$d.getTimezoneOffset() / 15);
        }, ce.diff = function(G, oe, ie) {
          var pe, we = this, Te = le.p(oe), ke = se(G), tt = (ke.utcOffset() - this.utcOffset()) * o, Me = this - ke, it = function() {
            return le.m(we, ke);
          };
          switch (Te) {
            case D:
              pe = it() / 12;
              break;
            case v:
              pe = it();
              break;
            case C:
              pe = it() / 3;
              break;
            case h:
              pe = (Me - tt) / 6048e5;
              break;
            case m:
              pe = (Me - tt) / 864e5;
              break;
            case f:
              pe = Me / a;
              break;
            case u:
              pe = Me / o;
              break;
            case c:
              pe = Me / n;
              break;
            default:
              pe = Me;
          }
          return ie ? pe : le.a(pe);
        }, ce.daysInMonth = function() {
          return this.endOf(v).$D;
        }, ce.$locale = function() {
          return $[this.$L];
        }, ce.locale = function(G, oe) {
          if (!G) return this.$L;
          var ie = this.clone(), pe = ee(G, oe, true);
          return pe && (ie.$L = pe), ie;
        }, ce.clone = function() {
          return le.w(this.$d, this);
        }, ce.toDate = function() {
          return new Date(this.valueOf());
        }, ce.toJSON = function() {
          return this.isValid() ? this.toISOString() : null;
        }, ce.toISOString = function() {
          return this.$d.toISOString();
        }, ce.toString = function() {
          return this.$d.toUTCString();
        }, fe;
      })(), Ee = re.prototype;
      return se.prototype = Ee, [["$ms", s], ["$s", c], ["$m", u], ["$H", f], ["$W", m], ["$M", v], ["$y", D], ["$D", W]].forEach(function(fe) {
        Ee[fe[1]] = function(ce) {
          return this.$g(ce, fe[0], fe[1]);
        };
      }), se.extend = function(fe, ce) {
        return fe.$i || (fe(ce, re, se), fe.$i = true), se;
      }, se.locale = ee, se.isDayjs = ue, se.unix = function(fe) {
        return se(1e3 * fe);
      }, se.en = $[j], se.Ls = $, se.p = {}, se;
    });
  })(Hw);
  var SR = Hw.exports;
  const Vw = ["primary", "success", "info", "warning", "error"], qw = ["top", "top-left", "top-right", "bottom", "bottom-left", "bottom-right"], rn = Ux({ customClass: "", dangerouslyUseHTMLString: false, duration: 3e3, icon: void 0, id: "", message: "", onClose: void 0, showClose: false, type: "info", plain: false, offset: 16, placement: void 0, zIndex: 0, grouping: false, repeatNum: 1, appendTo: yo ? document.body : void 0 }), Yx = _s({ customClass: { type: String, default: rn.customClass }, dangerouslyUseHTMLString: { type: Boolean, default: rn.dangerouslyUseHTMLString }, duration: { type: Number, default: rn.duration }, icon: { type: Rx, default: rn.icon }, id: { type: String, default: rn.id }, message: { type: yn([String, Object, Function]), default: rn.message }, onClose: { type: yn(Function), default: rn.onClose }, showClose: { type: Boolean, default: rn.showClose }, type: { type: String, values: Vw, default: rn.type }, plain: { type: Boolean, default: rn.plain }, offset: { type: Number, default: rn.offset }, placement: { type: String, values: qw, default: rn.placement }, zIndex: { type: Number, default: rn.zIndex }, grouping: { type: Boolean, default: rn.grouping }, repeatNum: { type: Number, default: rn.repeatNum } }), Zx = { destroy: () => true }, wi = lf({}), Qx = (e) => (wi[e] || (wi[e] = lf([])), wi[e]), Jx = (e, t) => {
    const n = wi[t] || [], o = n.findIndex((c) => c.id === e), a = n[o];
    let s;
    return o > 0 && (s = n[o - 1]), { current: a, prev: s };
  }, Xx = (e, t) => {
    const { prev: n } = Jx(e, t);
    return n ? n.vm.exposed.bottom.value : 0;
  }, eO = (e, t, n) => (wi[n] || []).findIndex((o) => o.id === e) > 0 ? 16 : t, tO = ["id"], nO = ["innerHTML"];
  var iO = Si({ name: "ElMessage", __name: "message", props: Yx, emits: Zx, setup(e, { expose: t, emit: n }) {
    const { Close: o } = Fx, a = e, s = n, c = Ln(false), { ns: u, zIndex: f } = $x("message"), { currentZIndex: m, nextZIndex: h } = f, v = Ln(), C = Ln(false), D = Ln(0);
    let W;
    const E = We(() => a.type ? a.type === "error" ? "danger" : a.type : "info"), L = We(() => {
      const Ee = a.type;
      return { [u.bm("icon", Ee)]: Ee && Wg[Ee] };
    }), b = We(() => a.icon || Wg[a.type] || ""), P = We(() => a.placement || "top"), B = We(() => Xx(a.id, P.value)), k = We(() => Math.max(eO(a.id, a.offset, P.value) + B.value, a.offset)), j = We(() => D.value + k.value), $ = We(() => P.value.includes("left") ? u.is("left") : P.value.includes("right") ? u.is("right") : u.is("center")), q = We(() => P.value.startsWith("top") ? "top" : "bottom"), ue = We(() => ({ [q.value]: `${k.value}px`, zIndex: m.value }));
    function ee() {
      a.duration !== 0 && ({ stop: W } = ax(() => {
        le();
      }, a.duration));
    }
    function se() {
      W == null || W();
    }
    function le() {
      C.value = false, uf(() => {
        var Ee;
        c.value || ((Ee = a.onClose) == null || Ee.call(a), s("destroy"));
      });
    }
    function re(Ee) {
      bx(Ee) === Md.esc && le();
    }
    return ps(() => {
      ee(), h(), C.value = true;
    }), vi(() => a.repeatNum, () => {
      se(), ee();
    }), lx(document, "keydown", re), dx(v, () => {
      D.value = v.value.getBoundingClientRect().height;
    }), t({ visible: C, bottom: j, close: le }), (Ee, fe) => (Gt(), Mr(Gv, { name: Je(u).b("fade"), onBeforeEnter: fe[0] || (fe[0] = (ce) => c.value = true), onBeforeLeave: e.onClose, onAfterLeave: fe[1] || (fe[1] = (ce) => Ee.$emit("destroy")), persisted: "" }, { default: Va(() => [KE(lr("div", { id: e.id, ref_key: "messageRef", ref: v, class: mi([Je(u).b(), { [Je(u).m(e.type)]: e.type }, Je(u).is("closable", e.showClose), Je(u).is("plain", e.plain), Je(u).is("bottom", q.value === "bottom"), $.value, e.customClass]), style: ds(ue.value), role: "alert", onMouseenter: se, onMouseleave: ee }, [e.repeatNum > 1 ? (Gt(), Mr(Je(qx), { key: 0, value: e.repeatNum, type: E.value, class: mi(Je(u).e("badge")) }, null, 8, ["value", "type", "class"])) : Xo("v-if", true), b.value ? (Gt(), Mr(Je(Bg), { key: 1, class: mi([Je(u).e("icon"), L.value]) }, { default: Va(() => [(Gt(), Mr(p2(b.value)))]), _: 1 }, 8, ["class"])) : Xo("v-if", true), !e.dangerouslyUseHTMLString || Ee.$slots.default ? (Gt(), Ri("p", { key: 2, class: mi(Je(u).e("content")) }, [Rl(Ee.$slots, "default", {}, () => [hf(ef(e.message), 1)])], 2)) : (Gt(), Ri(an, { key: 3 }, [Xo(" Caution here, message could've been compromised, never use user's input as message "), lr("p", { class: mi(Je(u).e("content")), innerHTML: e.message }, null, 10, nO)], 2112)), e.showClose ? (Gt(), Mr(Je(Bg), { key: 4, class: mi(Je(u).e("closeBtn")), onClick: Dk(le, ["stop"]) }, { default: Va(() => [Kt(Je(o))]), _: 1 }, 8, ["class"])) : Xo("v-if", true)], 46, tO), [[dk, C.value]])]), _: 3 }, 8, ["name", "onBeforeLeave"]));
  } }), rO = iO;
  let oO = 1;
  const aO = (e) => {
    if (!e.appendTo) e.appendTo = document.body;
    else if (ht(e.appendTo)) {
      let t = document.querySelector(e.appendTo);
      XL(t) || (As("ElMessage", "the appendTo option is not an HTMLElement. Falling back to document.body."), t = document.body), e.appendTo = t;
    }
  }, sO = (e) => {
    !e.placement && ht(gn.placement) && gn.placement && (e.placement = gn.placement), e.placement || (e.placement = "top"), qw.includes(e.placement) || (As("ElMessage", `Invalid placement: ${e.placement}. Falling back to 'top'.`), e.placement = "top");
  }, $w = (e) => {
    const t = !e || ht(e) || ao(e) || Pe(e) ? { message: e } : e, n = { ...rn, ...t };
    return aO(n), sO(n), rd(gn.grouping) && !n.grouping && (n.grouping = gn.grouping), uo(gn.duration) && n.duration === 3e3 && (n.duration = gn.duration), uo(gn.offset) && n.offset === 16 && (n.offset = gn.offset), rd(gn.showClose) && !n.showClose && (n.showClose = gn.showClose), rd(gn.plain) && !n.plain && (n.plain = gn.plain), n;
  }, lO = (e) => {
    const t = wi[e.props.placement || "top"], n = t.indexOf(e);
    if (n === -1) return;
    t.splice(n, 1);
    const { handler: o } = e;
    o.close();
  }, cO = ({ appendTo: e, ...t }, n) => {
    const o = `message_${oO++}`, a = t.onClose, s = document.createElement("div"), c = { ...t, id: o, onClose: () => {
      a == null || a(), lO(m);
    }, onDestroy: () => {
      tg(null, s);
    } }, u = Kt(rO, c, Pe(c.message) || ao(c.message) ? { default: Pe(c.message) ? c.message : () => c.message } : null);
    u.appContext = n || fo._context, tg(u, s), e.appendChild(s.firstElementChild);
    const f = u.component, m = { id: o, vnode: u, vm: f, handler: { close: () => {
      f.exposed.close();
    } }, props: u.component.props };
    return m;
  }, fo = (e = {}, t) => {
    if (!yo) return { close: () => {
    } };
    const n = $w(e), o = Qx(n.placement || "top");
    if (n.grouping && o.length) {
      const s = o.find(({ vnode: c }) => {
        var u;
        return ((u = c.props) == null ? void 0 : u.message) === n.message;
      });
      if (s) return s.props.repeatNum += 1, s.props.type = n.type, s.handler;
    }
    if (uo(gn.max) && o.length >= gn.max) return { close: () => {
    } };
    const a = cO(n, t);
    return o.push(a), a.handler;
  };
  Vw.forEach((e) => {
    fo[e] = (t = {}, n) => fo({ ...$w(t), type: e }, n);
  });
  function uO(e) {
    for (const t in wi) if (et(wi, t)) {
      const n = [...wi[t]];
      for (const o of n) (!e || e === o.props.type) && o.handler.close();
    }
  }
  function dO(e) {
    wi[e] && [...wi[e]].forEach((t) => t.handler.close());
  }
  fo.closeAll = uO;
  fo.closeAllByPlacement = dO;
  fo._context = null;
  const fO = Dx(fo, "$message");
  /*!
  * shared v10.0.7
  * (c) 2025 kazuya kawaguchi
  * Released under the MIT License.
  */
  const Hl = typeof window < "u", Pr = (e, t = false) => t ? Symbol.for(e) : Symbol(e), pO = (e, t, n) => mO({ l: e, k: t, s: n }), mO = (e) => JSON.stringify(e).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029").replace(/\u0027/g, "\\u0027"), Ft = (e) => typeof e == "number" && isFinite(e), hO = (e) => Lf(e) === "[object Date]", aa = (e) => Lf(e) === "[object RegExp]", pc = (e) => $e(e) && Object.keys(e).length === 0, Ht = Object.assign, gO = Object.create, mt = (e = null) => gO(e);
  let Ug;
  const no = () => Ug || (Ug = typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : typeof window < "u" ? window : typeof global < "u" ? global : mt());
  function jg(e) {
    return e.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  const yO = Object.prototype.hasOwnProperty;
  function hi(e, t) {
    return yO.call(e, t);
  }
  const xt = Array.isArray, Ct = (e) => typeof e == "function", ye = (e) => typeof e == "string", rt = (e) => typeof e == "boolean", st = (e) => e !== null && typeof e == "object", vO = (e) => st(e) && Ct(e.then) && Ct(e.catch), Gw = Object.prototype.toString, Lf = (e) => Gw.call(e), $e = (e) => Lf(e) === "[object Object]", wO = (e) => e == null ? "" : xt(e) || $e(e) && e.toString === Gw ? JSON.stringify(e, null, 2) : String(e);
  function xf(e, t = "") {
    return e.reduce((n, o, a) => a === 0 ? n + o : n + t + o, "");
  }
  function SO(e, t) {
    typeof console < "u" && (console.warn("[intlify] " + e), t && console.warn(t.stack));
  }
  const _l = (e) => !st(e) || xt(e);
  function Dl(e, t) {
    if (_l(e) || _l(t)) throw new Error("Invalid value");
    const n = [{ src: e, des: t }];
    for (; n.length; ) {
      const { src: o, des: a } = n.pop();
      Object.keys(o).forEach((s) => {
        s !== "__proto__" && (st(o[s]) && !st(a[s]) && (a[s] = Array.isArray(o[s]) ? [] : mt()), _l(a[s]) || _l(o[s]) ? a[s] = o[s] : n.push({ src: o[s], des: a[s] }));
      });
    }
  }
  /*!
  * message-compiler v10.0.7
  * (c) 2025 kazuya kawaguchi
  * Released under the MIT License.
  */
  function bO(e, t, n) {
    return { line: e, column: t, offset: n };
  }
  function Wd(e, t, n) {
    return { start: e, end: t };
  }
  const dt = { EXPECTED_TOKEN: 1, INVALID_TOKEN_IN_PLACEHOLDER: 2, UNTERMINATED_SINGLE_QUOTE_IN_PLACEHOLDER: 3, UNKNOWN_ESCAPE_SEQUENCE: 4, INVALID_UNICODE_ESCAPE_SEQUENCE: 5, UNBALANCED_CLOSING_BRACE: 6, UNTERMINATED_CLOSING_BRACE: 7, EMPTY_PLACEHOLDER: 8, NOT_ALLOW_NEST_PLACEHOLDER: 9, INVALID_LINKED_FORMAT: 10, MUST_HAVE_MESSAGES_IN_PLURAL: 11, UNEXPECTED_EMPTY_LINKED_MODIFIER: 12, UNEXPECTED_EMPTY_LINKED_KEY: 13, UNEXPECTED_LEXICAL_ANALYSIS: 14 }, _O = 17;
  function mc(e, t, n = {}) {
    const { domain: o, messages: a, args: s } = n, c = e, u = new SyntaxError(String(c));
    return u.code = e, t && (u.location = t), u.domain = o, u;
  }
  function AO(e) {
    throw e;
  }
  const Yi = " ", CO = "\r", hn = `
`, TO = "\u2028", EO = "\u2029";
  function kO(e) {
    const t = e;
    let n = 0, o = 1, a = 1, s = 0;
    const c = (q) => t[q] === CO && t[q + 1] === hn, u = (q) => t[q] === hn, f = (q) => t[q] === EO, m = (q) => t[q] === TO, h = (q) => c(q) || u(q) || f(q) || m(q), v = () => n, C = () => o, D = () => a, W = () => s, E = (q) => c(q) || f(q) || m(q) ? hn : t[q], L = () => E(n), b = () => E(n + s);
    function P() {
      return s = 0, h(n) && (o++, a = 0), c(n) && n++, n++, a++, t[n];
    }
    function B() {
      return c(n + s) && s++, s++, t[n + s];
    }
    function k() {
      n = 0, o = 1, a = 1, s = 0;
    }
    function j(q = 0) {
      s = q;
    }
    function $() {
      const q = n + s;
      for (; q !== n; ) P();
      s = 0;
    }
    return { index: v, line: C, column: D, peekOffset: W, charAt: E, currentChar: L, currentPeek: b, next: P, peek: B, reset: k, resetPeek: j, skipToPeek: $ };
  }
  const kr = void 0, zO = ".", Hg = "'", DO = "tokenizer";
  function MO(e, t = {}) {
    const n = t.location !== false, o = kO(e), a = () => o.index(), s = () => bO(o.line(), o.column(), o.index()), c = s(), u = a(), f = { currentType: 13, offset: u, startLoc: c, endLoc: c, lastType: 13, lastOffset: u, lastStartLoc: c, lastEndLoc: c, braceNest: 0, inLinked: false, text: "" }, m = () => f, { onError: h } = t;
    function v(w, S, x, ...N) {
      const de = m();
      if (S.column += x, S.offset += x, h) {
        const Z = n ? Wd(de.startLoc, S) : null, O = mc(w, Z, { domain: DO, args: N });
        h(O);
      }
    }
    function C(w, S, x) {
      w.endLoc = s(), w.currentType = S;
      const N = { type: S };
      return n && (N.loc = Wd(w.startLoc, w.endLoc)), x != null && (N.value = x), N;
    }
    const D = (w) => C(w, 13);
    function W(w, S) {
      return w.currentChar() === S ? (w.next(), S) : (v(dt.EXPECTED_TOKEN, s(), 0, S), "");
    }
    function E(w) {
      let S = "";
      for (; w.currentPeek() === Yi || w.currentPeek() === hn; ) S += w.currentPeek(), w.peek();
      return S;
    }
    function L(w) {
      const S = E(w);
      return w.skipToPeek(), S;
    }
    function b(w) {
      if (w === kr) return false;
      const S = w.charCodeAt(0);
      return S >= 97 && S <= 122 || S >= 65 && S <= 90 || S === 95;
    }
    function P(w) {
      if (w === kr) return false;
      const S = w.charCodeAt(0);
      return S >= 48 && S <= 57;
    }
    function B(w, S) {
      const { currentType: x } = S;
      if (x !== 2) return false;
      E(w);
      const N = b(w.currentPeek());
      return w.resetPeek(), N;
    }
    function k(w, S) {
      const { currentType: x } = S;
      if (x !== 2) return false;
      E(w);
      const N = w.currentPeek() === "-" ? w.peek() : w.currentPeek(), de = P(N);
      return w.resetPeek(), de;
    }
    function j(w, S) {
      const { currentType: x } = S;
      if (x !== 2) return false;
      E(w);
      const N = w.currentPeek() === Hg;
      return w.resetPeek(), N;
    }
    function $(w, S) {
      const { currentType: x } = S;
      if (x !== 7) return false;
      E(w);
      const N = w.currentPeek() === ".";
      return w.resetPeek(), N;
    }
    function q(w, S) {
      const { currentType: x } = S;
      if (x !== 8) return false;
      E(w);
      const N = b(w.currentPeek());
      return w.resetPeek(), N;
    }
    function ue(w, S) {
      const { currentType: x } = S;
      if (!(x === 7 || x === 11)) return false;
      E(w);
      const N = w.currentPeek() === ":";
      return w.resetPeek(), N;
    }
    function ee(w, S) {
      const { currentType: x } = S;
      if (x !== 9) return false;
      const N = () => {
        const Z = w.currentPeek();
        return Z === "{" ? b(w.peek()) : Z === "@" || Z === "|" || Z === ":" || Z === "." || Z === Yi || !Z ? false : Z === hn ? (w.peek(), N()) : le(w, false);
      }, de = N();
      return w.resetPeek(), de;
    }
    function se(w) {
      E(w);
      const S = w.currentPeek() === "|";
      return w.resetPeek(), S;
    }
    function le(w, S = true) {
      const x = (de = false, Z = "") => {
        const O = w.currentPeek();
        return O === "{" || O === "@" || !O ? de : O === "|" ? !(Z === Yi || Z === hn) : O === Yi ? (w.peek(), x(true, Yi)) : O === hn ? (w.peek(), x(true, hn)) : true;
      }, N = x();
      return S && w.resetPeek(), N;
    }
    function re(w, S) {
      const x = w.currentChar();
      return x === kr ? kr : S(x) ? (w.next(), x) : null;
    }
    function Ee(w) {
      const S = w.charCodeAt(0);
      return S >= 97 && S <= 122 || S >= 65 && S <= 90 || S >= 48 && S <= 57 || S === 95 || S === 36;
    }
    function fe(w) {
      return re(w, Ee);
    }
    function ce(w) {
      const S = w.charCodeAt(0);
      return S >= 97 && S <= 122 || S >= 65 && S <= 90 || S >= 48 && S <= 57 || S === 95 || S === 36 || S === 45;
    }
    function G(w) {
      return re(w, ce);
    }
    function oe(w) {
      const S = w.charCodeAt(0);
      return S >= 48 && S <= 57;
    }
    function ie(w) {
      return re(w, oe);
    }
    function pe(w) {
      const S = w.charCodeAt(0);
      return S >= 48 && S <= 57 || S >= 65 && S <= 70 || S >= 97 && S <= 102;
    }
    function we(w) {
      return re(w, pe);
    }
    function Te(w) {
      let S = "", x = "";
      for (; S = ie(w); ) x += S;
      return x;
    }
    function ke(w) {
      let S = "";
      for (; ; ) {
        const x = w.currentChar();
        if (x === "{" || x === "}" || x === "@" || x === "|" || !x) break;
        if (x === Yi || x === hn) if (le(w)) S += x, w.next();
        else {
          if (se(w)) break;
          S += x, w.next();
        }
        else S += x, w.next();
      }
      return S;
    }
    function tt(w) {
      L(w);
      let S = "", x = "";
      for (; S = G(w); ) x += S;
      return w.currentChar() === kr && v(dt.UNTERMINATED_CLOSING_BRACE, s(), 0), x;
    }
    function Me(w) {
      L(w);
      let S = "";
      return w.currentChar() === "-" ? (w.next(), S += `-${Te(w)}`) : S += Te(w), w.currentChar() === kr && v(dt.UNTERMINATED_CLOSING_BRACE, s(), 0), S;
    }
    function it(w) {
      return w !== Hg && w !== hn;
    }
    function Re(w) {
      L(w), W(w, "'");
      let S = "", x = "";
      for (; S = re(w, it); ) S === "\\" ? x += ft(w) : x += S;
      const N = w.currentChar();
      return N === hn || N === kr ? (v(dt.UNTERMINATED_SINGLE_QUOTE_IN_PLACEHOLDER, s(), 0), N === hn && (w.next(), W(w, "'")), x) : (W(w, "'"), x);
    }
    function ft(w) {
      const S = w.currentChar();
      switch (S) {
        case "\\":
        case "'":
          return w.next(), `\\${S}`;
        case "u":
          return Ie(w, S, 4);
        case "U":
          return Ie(w, S, 6);
        default:
          return v(dt.UNKNOWN_ESCAPE_SEQUENCE, s(), 0, S), "";
      }
    }
    function Ie(w, S, x) {
      W(w, S);
      let N = "";
      for (let de = 0; de < x; de++) {
        const Z = we(w);
        if (!Z) {
          v(dt.INVALID_UNICODE_ESCAPE_SEQUENCE, s(), 0, `\\${S}${N}${w.currentChar()}`);
          break;
        }
        N += Z;
      }
      return `\\${S}${N}`;
    }
    function pt(w) {
      return w !== "{" && w !== "}" && w !== Yi && w !== hn;
    }
    function be(w) {
      L(w);
      let S = "", x = "";
      for (; S = re(w, pt); ) x += S;
      return x;
    }
    function Ae(w) {
      let S = "", x = "";
      for (; S = fe(w); ) x += S;
      return x;
    }
    function _(w) {
      const S = (x) => {
        const N = w.currentChar();
        return N === "{" || N === "@" || N === "|" || N === "(" || N === ")" || !N || N === Yi ? x : (x += N, w.next(), S(x));
      };
      return S("");
    }
    function z(w) {
      L(w);
      const S = W(w, "|");
      return L(w), S;
    }
    function U(w, S) {
      let x = null;
      switch (w.currentChar()) {
        case "{":
          return S.braceNest >= 1 && v(dt.NOT_ALLOW_NEST_PLACEHOLDER, s(), 0), w.next(), x = C(S, 2, "{"), L(w), S.braceNest++, x;
        case "}":
          return S.braceNest > 0 && S.currentType === 2 && v(dt.EMPTY_PLACEHOLDER, s(), 0), w.next(), x = C(S, 3, "}"), S.braceNest--, S.braceNest > 0 && L(w), S.inLinked && S.braceNest === 0 && (S.inLinked = false), x;
        case "@":
          return S.braceNest > 0 && v(dt.UNTERMINATED_CLOSING_BRACE, s(), 0), x = Y(w, S) || D(S), S.braceNest = 0, x;
        default: {
          let de = true, Z = true, O = true;
          if (se(w)) return S.braceNest > 0 && v(dt.UNTERMINATED_CLOSING_BRACE, s(), 0), x = C(S, 1, z(w)), S.braceNest = 0, S.inLinked = false, x;
          if (S.braceNest > 0 && (S.currentType === 4 || S.currentType === 5 || S.currentType === 6)) return v(dt.UNTERMINATED_CLOSING_BRACE, s(), 0), S.braceNest = 0, J(w, S);
          if (de = B(w, S)) return x = C(S, 4, tt(w)), L(w), x;
          if (Z = k(w, S)) return x = C(S, 5, Me(w)), L(w), x;
          if (O = j(w, S)) return x = C(S, 6, Re(w)), L(w), x;
          if (!de && !Z && !O) return x = C(S, 12, be(w)), v(dt.INVALID_TOKEN_IN_PLACEHOLDER, s(), 0, x.value), L(w), x;
          break;
        }
      }
      return x;
    }
    function Y(w, S) {
      const { currentType: x } = S;
      let N = null;
      const de = w.currentChar();
      switch ((x === 7 || x === 8 || x === 11 || x === 9) && (de === hn || de === Yi) && v(dt.INVALID_LINKED_FORMAT, s(), 0), de) {
        case "@":
          return w.next(), N = C(S, 7, "@"), S.inLinked = true, N;
        case ".":
          return L(w), w.next(), C(S, 8, ".");
        case ":":
          return L(w), w.next(), C(S, 9, ":");
        default:
          return se(w) ? (N = C(S, 1, z(w)), S.braceNest = 0, S.inLinked = false, N) : $(w, S) || ue(w, S) ? (L(w), Y(w, S)) : q(w, S) ? (L(w), C(S, 11, Ae(w))) : ee(w, S) ? (L(w), de === "{" ? U(w, S) || N : C(S, 10, _(w))) : (x === 7 && v(dt.INVALID_LINKED_FORMAT, s(), 0), S.braceNest = 0, S.inLinked = false, J(w, S));
      }
    }
    function J(w, S) {
      let x = { type: 13 };
      if (S.braceNest > 0) return U(w, S) || D(S);
      if (S.inLinked) return Y(w, S) || D(S);
      switch (w.currentChar()) {
        case "{":
          return U(w, S) || D(S);
        case "}":
          return v(dt.UNBALANCED_CLOSING_BRACE, s(), 0), w.next(), C(S, 3, "}");
        case "@":
          return Y(w, S) || D(S);
        default: {
          if (se(w)) return x = C(S, 1, z(w)), S.braceNest = 0, S.inLinked = false, x;
          if (le(w)) return C(S, 0, ke(w));
          break;
        }
      }
      return x;
    }
    function X() {
      const { currentType: w, offset: S, startLoc: x, endLoc: N } = f;
      return f.lastType = w, f.lastOffset = S, f.lastStartLoc = x, f.lastEndLoc = N, f.offset = a(), f.startLoc = s(), o.currentChar() === kr ? C(f, 13) : J(o, f);
    }
    return { nextToken: X, currentOffset: a, currentPosition: s, context: m };
  }
  const LO = "parser", xO = /(?:\\\\|\\'|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{6}))/g;
  function OO(e, t, n) {
    switch (e) {
      case "\\\\":
        return "\\";
      case "\\'":
        return "'";
      default: {
        const o = parseInt(t || n, 16);
        return o <= 55295 || o >= 57344 ? String.fromCodePoint(o) : "�";
      }
    }
  }
  function PO(e = {}) {
    const t = e.location !== false, { onError: n } = e;
    function o(b, P, B, k, ...j) {
      const $ = b.currentPosition();
      if ($.offset += k, $.column += k, n) {
        const q = t ? Wd(B, $) : null, ue = mc(P, q, { domain: LO, args: j });
        n(ue);
      }
    }
    function a(b, P, B) {
      const k = { type: b };
      return t && (k.start = P, k.end = P, k.loc = { start: B, end: B }), k;
    }
    function s(b, P, B, k) {
      t && (b.end = P, b.loc && (b.loc.end = B));
    }
    function c(b, P) {
      const B = b.context(), k = a(3, B.offset, B.startLoc);
      return k.value = P, s(k, b.currentOffset(), b.currentPosition()), k;
    }
    function u(b, P) {
      const B = b.context(), { lastOffset: k, lastStartLoc: j } = B, $ = a(5, k, j);
      return $.index = parseInt(P, 10), b.nextToken(), s($, b.currentOffset(), b.currentPosition()), $;
    }
    function f(b, P) {
      const B = b.context(), { lastOffset: k, lastStartLoc: j } = B, $ = a(4, k, j);
      return $.key = P, b.nextToken(), s($, b.currentOffset(), b.currentPosition()), $;
    }
    function m(b, P) {
      const B = b.context(), { lastOffset: k, lastStartLoc: j } = B, $ = a(9, k, j);
      return $.value = P.replace(xO, OO), b.nextToken(), s($, b.currentOffset(), b.currentPosition()), $;
    }
    function h(b) {
      const P = b.nextToken(), B = b.context(), { lastOffset: k, lastStartLoc: j } = B, $ = a(8, k, j);
      return P.type !== 11 ? (o(b, dt.UNEXPECTED_EMPTY_LINKED_MODIFIER, B.lastStartLoc, 0), $.value = "", s($, k, j), { nextConsumeToken: P, node: $ }) : (P.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, B.lastStartLoc, 0, Di(P)), $.value = P.value || "", s($, b.currentOffset(), b.currentPosition()), { node: $ });
    }
    function v(b, P) {
      const B = b.context(), k = a(7, B.offset, B.startLoc);
      return k.value = P, s(k, b.currentOffset(), b.currentPosition()), k;
    }
    function C(b) {
      const P = b.context(), B = a(6, P.offset, P.startLoc);
      let k = b.nextToken();
      if (k.type === 8) {
        const j = h(b);
        B.modifier = j.node, k = j.nextConsumeToken || b.nextToken();
      }
      switch (k.type !== 9 && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(k)), k = b.nextToken(), k.type === 2 && (k = b.nextToken()), k.type) {
        case 10:
          k.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(k)), B.key = v(b, k.value || "");
          break;
        case 4:
          k.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(k)), B.key = f(b, k.value || "");
          break;
        case 5:
          k.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(k)), B.key = u(b, k.value || "");
          break;
        case 6:
          k.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(k)), B.key = m(b, k.value || "");
          break;
        default: {
          o(b, dt.UNEXPECTED_EMPTY_LINKED_KEY, P.lastStartLoc, 0);
          const j = b.context(), $ = a(7, j.offset, j.startLoc);
          return $.value = "", s($, j.offset, j.startLoc), B.key = $, s(B, j.offset, j.startLoc), { nextConsumeToken: k, node: B };
        }
      }
      return s(B, b.currentOffset(), b.currentPosition()), { node: B };
    }
    function D(b) {
      const P = b.context(), B = P.currentType === 1 ? b.currentOffset() : P.offset, k = P.currentType === 1 ? P.endLoc : P.startLoc, j = a(2, B, k);
      j.items = [];
      let $ = null;
      do {
        const ee = $ || b.nextToken();
        switch ($ = null, ee.type) {
          case 0:
            ee.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(ee)), j.items.push(c(b, ee.value || ""));
            break;
          case 5:
            ee.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(ee)), j.items.push(u(b, ee.value || ""));
            break;
          case 4:
            ee.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(ee)), j.items.push(f(b, ee.value || ""));
            break;
          case 6:
            ee.value == null && o(b, dt.UNEXPECTED_LEXICAL_ANALYSIS, P.lastStartLoc, 0, Di(ee)), j.items.push(m(b, ee.value || ""));
            break;
          case 7: {
            const se = C(b);
            j.items.push(se.node), $ = se.nextConsumeToken || null;
            break;
          }
        }
      } while (P.currentType !== 13 && P.currentType !== 1);
      const q = P.currentType === 1 ? P.lastOffset : b.currentOffset(), ue = P.currentType === 1 ? P.lastEndLoc : b.currentPosition();
      return s(j, q, ue), j;
    }
    function W(b, P, B, k) {
      const j = b.context();
      let $ = k.items.length === 0;
      const q = a(1, P, B);
      q.cases = [], q.cases.push(k);
      do {
        const ue = D(b);
        $ || ($ = ue.items.length === 0), q.cases.push(ue);
      } while (j.currentType !== 13);
      return $ && o(b, dt.MUST_HAVE_MESSAGES_IN_PLURAL, B, 0), s(q, b.currentOffset(), b.currentPosition()), q;
    }
    function E(b) {
      const P = b.context(), { offset: B, startLoc: k } = P, j = D(b);
      return P.currentType === 13 ? j : W(b, B, k, j);
    }
    function L(b) {
      const P = MO(b, Ht({}, e)), B = P.context(), k = a(0, B.offset, B.startLoc);
      return t && k.loc && (k.loc.source = b), k.body = E(P), e.onCacheKey && (k.cacheKey = e.onCacheKey(b)), B.currentType !== 13 && o(P, dt.UNEXPECTED_LEXICAL_ANALYSIS, B.lastStartLoc, 0, b[B.offset] || ""), s(k, P.currentOffset(), P.currentPosition()), k;
    }
    return { parse: L };
  }
  function Di(e) {
    if (e.type === 13) return "EOF";
    const t = (e.value || "").replace(/\r?\n/gu, "\\n");
    return t.length > 10 ? t.slice(0, 9) + "…" : t;
  }
  function IO(e, t = {}) {
    const n = { ast: e, helpers: /* @__PURE__ */ new Set() };
    return { context: () => n, helper: (s) => (n.helpers.add(s), s) };
  }
  function Vg(e, t) {
    for (let n = 0; n < e.length; n++) Of(e[n], t);
  }
  function Of(e, t) {
    switch (e.type) {
      case 1:
        Vg(e.cases, t), t.helper("plural");
        break;
      case 2:
        Vg(e.items, t);
        break;
      case 6: {
        Of(e.key, t), t.helper("linked"), t.helper("type");
        break;
      }
      case 5:
        t.helper("interpolate"), t.helper("list");
        break;
      case 4:
        t.helper("interpolate"), t.helper("named");
        break;
    }
  }
  function RO(e, t = {}) {
    const n = IO(e);
    n.helper("normalize"), e.body && Of(e.body, n);
    const o = n.context();
    e.helpers = Array.from(o.helpers);
  }
  function FO(e) {
    const t = e.body;
    return t.type === 2 ? qg(t) : t.cases.forEach((n) => qg(n)), e;
  }
  function qg(e) {
    if (e.items.length === 1) {
      const t = e.items[0];
      (t.type === 3 || t.type === 9) && (e.static = t.value, delete t.value);
    } else {
      const t = [];
      for (let n = 0; n < e.items.length; n++) {
        const o = e.items[n];
        if (!(o.type === 3 || o.type === 9) || o.value == null) break;
        t.push(o.value);
      }
      if (t.length === e.items.length) {
        e.static = xf(t);
        for (let n = 0; n < e.items.length; n++) {
          const o = e.items[n];
          (o.type === 3 || o.type === 9) && delete o.value;
        }
      }
    }
  }
  function Jo(e) {
    switch (e.t = e.type, e.type) {
      case 0: {
        const t = e;
        Jo(t.body), t.b = t.body, delete t.body;
        break;
      }
      case 1: {
        const t = e, n = t.cases;
        for (let o = 0; o < n.length; o++) Jo(n[o]);
        t.c = n, delete t.cases;
        break;
      }
      case 2: {
        const t = e, n = t.items;
        for (let o = 0; o < n.length; o++) Jo(n[o]);
        t.i = n, delete t.items, t.static && (t.s = t.static, delete t.static);
        break;
      }
      case 3:
      case 9:
      case 8:
      case 7: {
        const t = e;
        t.value && (t.v = t.value, delete t.value);
        break;
      }
      case 6: {
        const t = e;
        Jo(t.key), t.k = t.key, delete t.key, t.modifier && (Jo(t.modifier), t.m = t.modifier, delete t.modifier);
        break;
      }
      case 5: {
        const t = e;
        t.i = t.index, delete t.index;
        break;
      }
      case 4: {
        const t = e;
        t.k = t.key, delete t.key;
        break;
      }
    }
    delete e.type;
  }
  function NO(e, t) {
    const { filename: n, breakLineCode: o, needIndent: a } = t, s = t.location !== false, c = { filename: n, code: "", column: 1, line: 1, offset: 0, map: void 0, breakLineCode: o, needIndent: a, indentLevel: 0 };
    s && e.loc && (c.source = e.loc.source);
    const u = () => c;
    function f(E, L) {
      c.code += E;
    }
    function m(E, L = true) {
      const b = L ? o : "";
      f(a ? b + "  ".repeat(E) : b);
    }
    function h(E = true) {
      const L = ++c.indentLevel;
      E && m(L);
    }
    function v(E = true) {
      const L = --c.indentLevel;
      E && m(L);
    }
    function C() {
      m(c.indentLevel);
    }
    return { context: u, push: f, indent: h, deindent: v, newline: C, helper: (E) => `_${E}`, needIndent: () => c.needIndent };
  }
  function WO(e, t) {
    const { helper: n } = e;
    e.push(`${n("linked")}(`), sa(e, t.key), t.modifier ? (e.push(", "), sa(e, t.modifier), e.push(", _type")) : e.push(", undefined, _type"), e.push(")");
  }
  function BO(e, t) {
    const { helper: n, needIndent: o } = e;
    e.push(`${n("normalize")}([`), e.indent(o());
    const a = t.items.length;
    for (let s = 0; s < a && (sa(e, t.items[s]), s !== a - 1); s++) e.push(", ");
    e.deindent(o()), e.push("])");
  }
  function UO(e, t) {
    const { helper: n, needIndent: o } = e;
    if (t.cases.length > 1) {
      e.push(`${n("plural")}([`), e.indent(o());
      const a = t.cases.length;
      for (let s = 0; s < a && (sa(e, t.cases[s]), s !== a - 1); s++) e.push(", ");
      e.deindent(o()), e.push("])");
    }
  }
  function jO(e, t) {
    t.body ? sa(e, t.body) : e.push("null");
  }
  function sa(e, t) {
    const { helper: n } = e;
    switch (t.type) {
      case 0:
        jO(e, t);
        break;
      case 1:
        UO(e, t);
        break;
      case 2:
        BO(e, t);
        break;
      case 6:
        WO(e, t);
        break;
      case 8:
        e.push(JSON.stringify(t.value), t);
        break;
      case 7:
        e.push(JSON.stringify(t.value), t);
        break;
      case 5:
        e.push(`${n("interpolate")}(${n("list")}(${t.index}))`, t);
        break;
      case 4:
        e.push(`${n("interpolate")}(${n("named")}(${JSON.stringify(t.key)}))`, t);
        break;
      case 9:
        e.push(JSON.stringify(t.value), t);
        break;
      case 3:
        e.push(JSON.stringify(t.value), t);
        break;
    }
  }
  const HO = (e, t = {}) => {
    const n = ye(t.mode) ? t.mode : "normal", o = ye(t.filename) ? t.filename : "message.intl";
    t.sourceMap;
    const a = t.breakLineCode != null ? t.breakLineCode : n === "arrow" ? ";" : `
`, s = t.needIndent ? t.needIndent : n !== "arrow", c = e.helpers || [], u = NO(e, { filename: o, breakLineCode: a, needIndent: s });
    u.push(n === "normal" ? "function __msg__ (ctx) {" : "(ctx) => {"), u.indent(s), c.length > 0 && (u.push(`const { ${xf(c.map((h) => `${h}: _${h}`), ", ")} } = ctx`), u.newline()), u.push("return "), sa(u, e), u.deindent(s), u.push("}"), delete e.helpers;
    const { code: f, map: m } = u.context();
    return { ast: e, code: f, map: m ? m.toJSON() : void 0 };
  };
  function VO(e, t = {}) {
    const n = Ht({}, t), o = !!n.jit, a = !!n.minify, s = n.optimize == null ? true : n.optimize, u = PO(n).parse(e);
    return o ? (s && FO(u), a && Jo(u), { ast: u, code: "" }) : (RO(u, n), HO(u, n));
  }
  /*!
  * core-base v10.0.7
  * (c) 2025 kazuya kawaguchi
  * Released under the MIT License.
  */
  function qO() {
    typeof __INTLIFY_PROD_DEVTOOLS__ != "boolean" && (no().__INTLIFY_PROD_DEVTOOLS__ = false), typeof __INTLIFY_DROP_MESSAGE_COMPILER__ != "boolean" && (no().__INTLIFY_DROP_MESSAGE_COMPILER__ = false);
  }
  function Ii(e) {
    return st(e) && Pf(e) === 0 && (hi(e, "b") || hi(e, "body"));
  }
  const Kw = ["b", "body"];
  function $O(e) {
    return Ir(e, Kw);
  }
  const Yw = ["c", "cases"];
  function GO(e) {
    return Ir(e, Yw, []);
  }
  const Zw = ["s", "static"];
  function KO(e) {
    return Ir(e, Zw);
  }
  const Qw = ["i", "items"];
  function YO(e) {
    return Ir(e, Qw, []);
  }
  const Jw = ["t", "type"];
  function Pf(e) {
    return Ir(e, Jw);
  }
  const Xw = ["v", "value"];
  function Al(e, t) {
    const n = Ir(e, Xw);
    if (n != null) return n;
    throw as(t);
  }
  const eS = ["m", "modifier"];
  function ZO(e) {
    return Ir(e, eS);
  }
  const tS = ["k", "key"];
  function QO(e) {
    const t = Ir(e, tS);
    if (t) return t;
    throw as(6);
  }
  function Ir(e, t, n) {
    for (let o = 0; o < t.length; o++) {
      const a = t[o];
      if (hi(e, a) && e[a] != null) return e[a];
    }
    return n;
  }
  const nS = [...Kw, ...Yw, ...Zw, ...Qw, ...tS, ...eS, ...Xw, ...Jw];
  function as(e) {
    return new Error(`unhandled node type: ${e}`);
  }
  function ad(e) {
    return (n) => JO(n, e);
  }
  function JO(e, t) {
    const n = $O(t);
    if (n == null) throw as(0);
    if (Pf(n) === 1) {
      const s = GO(n);
      return e.plural(s.reduce((c, u) => [...c, $g(e, u)], []));
    } else return $g(e, n);
  }
  function $g(e, t) {
    const n = KO(t);
    if (n != null) return e.type === "text" ? n : e.normalize([n]);
    {
      const o = YO(t).reduce((a, s) => [...a, Bd(e, s)], []);
      return e.normalize(o);
    }
  }
  function Bd(e, t) {
    const n = Pf(t);
    switch (n) {
      case 3:
        return Al(t, n);
      case 9:
        return Al(t, n);
      case 4: {
        const o = t;
        if (hi(o, "k") && o.k) return e.interpolate(e.named(o.k));
        if (hi(o, "key") && o.key) return e.interpolate(e.named(o.key));
        throw as(n);
      }
      case 5: {
        const o = t;
        if (hi(o, "i") && Ft(o.i)) return e.interpolate(e.list(o.i));
        if (hi(o, "index") && Ft(o.index)) return e.interpolate(e.list(o.index));
        throw as(n);
      }
      case 6: {
        const o = t, a = ZO(o), s = QO(o);
        return e.linked(Bd(e, s), a ? Bd(e, a) : void 0, e.type);
      }
      case 7:
        return Al(t, n);
      case 8:
        return Al(t, n);
      default:
        throw new Error(`unhandled node on format message part: ${n}`);
    }
  }
  const XO = (e) => e;
  let Cl = mt();
  function eP(e, t = {}) {
    let n = false;
    const o = t.onError || AO;
    return t.onError = (a) => {
      n = true, o(a);
    }, { ...VO(e, t), detectError: n };
  }
  function tP(e, t) {
    if (!__INTLIFY_DROP_MESSAGE_COMPILER__ && ye(e)) {
      rt(t.warnHtmlMessage) && t.warnHtmlMessage;
      const o = (t.onCacheKey || XO)(e), a = Cl[o];
      if (a) return a;
      const { ast: s, detectError: c } = eP(e, { ...t, location: false, jit: true }), u = ad(s);
      return c ? u : Cl[o] = u;
    } else {
      const n = e.cacheKey;
      if (n) {
        const o = Cl[n];
        return o || (Cl[n] = ad(e));
      } else return ad(e);
    }
  }
  let ss = null;
  function nP(e) {
    ss = e;
  }
  function iP(e, t, n) {
    ss && ss.emit("i18n:init", { timestamp: Date.now(), i18n: e, version: t, meta: n });
  }
  const rP = oP("function:translate");
  function oP(e) {
    return (t) => ss && ss.emit(e, t);
  }
  const er = { INVALID_ARGUMENT: _O, INVALID_DATE_ARGUMENT: 18, INVALID_ISO_DATE_ARGUMENT: 19, NOT_SUPPORT_LOCALE_PROMISE_VALUE: 21, NOT_SUPPORT_LOCALE_ASYNC_FUNCTION: 22, NOT_SUPPORT_LOCALE_TYPE: 23 }, aP = 24;
  function tr(e) {
    return mc(e, null, void 0);
  }
  function If(e, t) {
    return t.locale != null ? Gg(t.locale) : Gg(e.locale);
  }
  let sd;
  function Gg(e) {
    if (ye(e)) return e;
    if (Ct(e)) {
      if (e.resolvedOnce && sd != null) return sd;
      if (e.constructor.name === "Function") {
        const t = e();
        if (vO(t)) throw tr(er.NOT_SUPPORT_LOCALE_PROMISE_VALUE);
        return sd = t;
      } else throw tr(er.NOT_SUPPORT_LOCALE_ASYNC_FUNCTION);
    } else throw tr(er.NOT_SUPPORT_LOCALE_TYPE);
  }
  function sP(e, t, n) {
    return [.../* @__PURE__ */ new Set([n, ...xt(t) ? t : st(t) ? Object.keys(t) : ye(t) ? [t] : [n]])];
  }
  function iS(e, t, n) {
    const o = ye(n) ? n : ls, a = e;
    a.__localeChainCache || (a.__localeChainCache = /* @__PURE__ */ new Map());
    let s = a.__localeChainCache.get(o);
    if (!s) {
      s = [];
      let c = [n];
      for (; xt(c); ) c = Kg(s, c, t);
      const u = xt(t) || !$e(t) ? t : t.default ? t.default : null;
      c = ye(u) ? [u] : u, xt(c) && Kg(s, c, false), a.__localeChainCache.set(o, s);
    }
    return s;
  }
  function Kg(e, t, n) {
    let o = true;
    for (let a = 0; a < t.length && rt(o); a++) {
      const s = t[a];
      ye(s) && (o = lP(e, t[a], n));
    }
    return o;
  }
  function lP(e, t, n) {
    let o;
    const a = t.split("-");
    do {
      const s = a.join("-");
      o = cP(e, s, n), a.splice(-1, 1);
    } while (a.length && o === true);
    return o;
  }
  function cP(e, t, n) {
    let o = false;
    if (!e.includes(t) && (o = true, t)) {
      o = t[t.length - 1] !== "!";
      const a = t.replace(/!/g, "");
      e.push(a), (xt(n) || $e(n)) && n[a] && (o = n[a]);
    }
    return o;
  }
  const Rr = [];
  Rr[0] = { w: [0], i: [3, 0], "[": [4], o: [7] };
  Rr[1] = { w: [1], ".": [2], "[": [4], o: [7] };
  Rr[2] = { w: [2], i: [3, 0], 0: [3, 0] };
  Rr[3] = { i: [3, 0], 0: [3, 0], w: [1, 1], ".": [2, 1], "[": [4, 1], o: [7, 1] };
  Rr[4] = { "'": [5, 0], '"': [6, 0], "[": [4, 2], "]": [1, 3], o: 8, l: [4, 0] };
  Rr[5] = { "'": [4, 0], o: 8, l: [5, 0] };
  Rr[6] = { '"': [4, 0], o: 8, l: [6, 0] };
  const uP = /^\s?(?:true|false|-?[\d.]+|'[^']*'|"[^"]*")\s?$/;
  function dP(e) {
    return uP.test(e);
  }
  function fP(e) {
    const t = e.charCodeAt(0), n = e.charCodeAt(e.length - 1);
    return t === n && (t === 34 || t === 39) ? e.slice(1, -1) : e;
  }
  function pP(e) {
    if (e == null) return "o";
    switch (e.charCodeAt(0)) {
      case 91:
      case 93:
      case 46:
      case 34:
      case 39:
        return e;
      case 95:
      case 36:
      case 45:
        return "i";
      case 9:
      case 10:
      case 13:
      case 160:
      case 65279:
      case 8232:
      case 8233:
        return "w";
    }
    return "i";
  }
  function mP(e) {
    const t = e.trim();
    return e.charAt(0) === "0" && isNaN(parseInt(e)) ? false : dP(t) ? fP(t) : "*" + t;
  }
  function hP(e) {
    const t = [];
    let n = -1, o = 0, a = 0, s, c, u, f, m, h, v;
    const C = [];
    C[0] = () => {
      c === void 0 ? c = u : c += u;
    }, C[1] = () => {
      c !== void 0 && (t.push(c), c = void 0);
    }, C[2] = () => {
      C[0](), a++;
    }, C[3] = () => {
      if (a > 0) a--, o = 4, C[0]();
      else {
        if (a = 0, c === void 0 || (c = mP(c), c === false)) return false;
        C[1]();
      }
    };
    function D() {
      const W = e[n + 1];
      if (o === 5 && W === "'" || o === 6 && W === '"') return n++, u = "\\" + W, C[0](), true;
    }
    for (; o !== null; ) if (n++, s = e[n], !(s === "\\" && D())) {
      if (f = pP(s), v = Rr[o], m = v[f] || v.l || 8, m === 8 || (o = m[0], m[1] !== void 0 && (h = C[m[1]], h && (u = s, h() === false)))) return;
      if (o === 7) return t;
    }
  }
  const Yg = /* @__PURE__ */ new Map();
  function gP(e, t) {
    return st(e) ? e[t] : null;
  }
  function yP(e, t) {
    if (!st(e)) return null;
    let n = Yg.get(t);
    if (n || (n = hP(t), n && Yg.set(t, n)), !n) return null;
    const o = n.length;
    let a = e, s = 0;
    for (; s < o; ) {
      const c = n[s];
      if (nS.includes(c) && Ii(a)) return null;
      const u = a[c];
      if (u === void 0 || Ct(a)) return null;
      a = u, s++;
    }
    return a;
  }
  const vP = "10.0.7", hc = -1, ls = "en-US", Zg = "", Qg = (e) => `${e.charAt(0).toLocaleUpperCase()}${e.substr(1)}`;
  function wP() {
    return { upper: (e, t) => t === "text" && ye(e) ? e.toUpperCase() : t === "vnode" && st(e) && "__v_isVNode" in e ? e.children.toUpperCase() : e, lower: (e, t) => t === "text" && ye(e) ? e.toLowerCase() : t === "vnode" && st(e) && "__v_isVNode" in e ? e.children.toLowerCase() : e, capitalize: (e, t) => t === "text" && ye(e) ? Qg(e) : t === "vnode" && st(e) && "__v_isVNode" in e ? Qg(e.children) : e };
  }
  let rS;
  function SP(e) {
    rS = e;
  }
  let oS;
  function bP(e) {
    oS = e;
  }
  let aS;
  function _P(e) {
    aS = e;
  }
  let sS = null;
  const AP = (e) => {
    sS = e;
  }, CP = () => sS;
  let lS = null;
  const Jg = (e) => {
    lS = e;
  }, TP = () => lS;
  let Xg = 0;
  function EP(e = {}) {
    const t = Ct(e.onWarn) ? e.onWarn : SO, n = ye(e.version) ? e.version : vP, o = ye(e.locale) || Ct(e.locale) ? e.locale : ls, a = Ct(o) ? ls : o, s = xt(e.fallbackLocale) || $e(e.fallbackLocale) || ye(e.fallbackLocale) || e.fallbackLocale === false ? e.fallbackLocale : a, c = $e(e.messages) ? e.messages : ld(a), u = $e(e.datetimeFormats) ? e.datetimeFormats : ld(a), f = $e(e.numberFormats) ? e.numberFormats : ld(a), m = Ht(mt(), e.modifiers, wP()), h = e.pluralRules || mt(), v = Ct(e.missing) ? e.missing : null, C = rt(e.missingWarn) || aa(e.missingWarn) ? e.missingWarn : true, D = rt(e.fallbackWarn) || aa(e.fallbackWarn) ? e.fallbackWarn : true, W = !!e.fallbackFormat, E = !!e.unresolving, L = Ct(e.postTranslation) ? e.postTranslation : null, b = $e(e.processor) ? e.processor : null, P = rt(e.warnHtmlMessage) ? e.warnHtmlMessage : true, B = !!e.escapeParameter, k = Ct(e.messageCompiler) ? e.messageCompiler : rS, j = Ct(e.messageResolver) ? e.messageResolver : oS || gP, $ = Ct(e.localeFallbacker) ? e.localeFallbacker : aS || sP, q = st(e.fallbackContext) ? e.fallbackContext : void 0, ue = e, ee = st(ue.__datetimeFormatters) ? ue.__datetimeFormatters : /* @__PURE__ */ new Map(), se = st(ue.__numberFormatters) ? ue.__numberFormatters : /* @__PURE__ */ new Map(), le = st(ue.__meta) ? ue.__meta : {};
    Xg++;
    const re = { version: n, cid: Xg, locale: o, fallbackLocale: s, messages: c, modifiers: m, pluralRules: h, missing: v, missingWarn: C, fallbackWarn: D, fallbackFormat: W, unresolving: E, postTranslation: L, processor: b, warnHtmlMessage: P, escapeParameter: B, messageCompiler: k, messageResolver: j, localeFallbacker: $, fallbackContext: q, onWarn: t, __meta: le };
    return re.datetimeFormats = u, re.numberFormats = f, re.__datetimeFormatters = ee, re.__numberFormatters = se, __INTLIFY_PROD_DEVTOOLS__ && iP(re, n, le), re;
  }
  const ld = (e) => ({ [e]: mt() });
  function Rf(e, t, n, o, a) {
    const { missing: s, onWarn: c } = e;
    if (s !== null) {
      const u = s(e, n, t, a);
      return ye(u) ? u : t;
    } else return t;
  }
  function Ra(e, t, n) {
    const o = e;
    o.__localeChainCache = /* @__PURE__ */ new Map(), e.localeFallbacker(e, n, t);
  }
  function kP(e, t) {
    return e === t ? false : e.split("-")[0] === t.split("-")[0];
  }
  function zP(e, t) {
    const n = t.indexOf(e);
    if (n === -1) return false;
    for (let o = n + 1; o < t.length; o++) if (kP(e, t[o])) return true;
    return false;
  }
  function ey(e, ...t) {
    const { datetimeFormats: n, unresolving: o, fallbackLocale: a, onWarn: s, localeFallbacker: c } = e, { __datetimeFormatters: u } = e, [f, m, h, v] = Ud(...t), C = rt(h.missingWarn) ? h.missingWarn : e.missingWarn;
    rt(h.fallbackWarn) ? h.fallbackWarn : e.fallbackWarn;
    const D = !!h.part, W = If(e, h), E = c(e, a, W);
    if (!ye(f) || f === "") return new Intl.DateTimeFormat(W, v).format(m);
    let L = {}, b, P = null;
    const B = "datetime format";
    for (let $ = 0; $ < E.length && (b = E[$], L = n[b] || {}, P = L[f], !$e(P)); $++) Rf(e, f, b, C, B);
    if (!$e(P) || !ye(b)) return o ? hc : f;
    let k = `${b}__${f}`;
    pc(v) || (k = `${k}__${JSON.stringify(v)}`);
    let j = u.get(k);
    return j || (j = new Intl.DateTimeFormat(b, Ht({}, P, v)), u.set(k, j)), D ? j.formatToParts(m) : j.format(m);
  }
  const cS = ["localeMatcher", "weekday", "era", "year", "month", "day", "hour", "minute", "second", "timeZoneName", "formatMatcher", "hour12", "timeZone", "dateStyle", "timeStyle", "calendar", "dayPeriod", "numberingSystem", "hourCycle", "fractionalSecondDigits"];
  function Ud(...e) {
    const [t, n, o, a] = e, s = mt();
    let c = mt(), u;
    if (ye(t)) {
      const f = t.match(/(\d{4}-\d{2}-\d{2})(T|\s)?(.*)/);
      if (!f) throw tr(er.INVALID_ISO_DATE_ARGUMENT);
      const m = f[3] ? f[3].trim().startsWith("T") ? `${f[1].trim()}${f[3].trim()}` : `${f[1].trim()}T${f[3].trim()}` : f[1].trim();
      u = new Date(m);
      try {
        u.toISOString();
      } catch {
        throw tr(er.INVALID_ISO_DATE_ARGUMENT);
      }
    } else if (hO(t)) {
      if (isNaN(t.getTime())) throw tr(er.INVALID_DATE_ARGUMENT);
      u = t;
    } else if (Ft(t)) u = t;
    else throw tr(er.INVALID_ARGUMENT);
    return ye(n) ? s.key = n : $e(n) && Object.keys(n).forEach((f) => {
      cS.includes(f) ? c[f] = n[f] : s[f] = n[f];
    }), ye(o) ? s.locale = o : $e(o) && (c = o), $e(a) && (c = a), [s.key || "", u, s, c];
  }
  function ty(e, t, n) {
    const o = e;
    for (const a in n) {
      const s = `${t}__${a}`;
      o.__datetimeFormatters.has(s) && o.__datetimeFormatters.delete(s);
    }
  }
  function ny(e, ...t) {
    const { numberFormats: n, unresolving: o, fallbackLocale: a, onWarn: s, localeFallbacker: c } = e, { __numberFormatters: u } = e, [f, m, h, v] = jd(...t), C = rt(h.missingWarn) ? h.missingWarn : e.missingWarn;
    rt(h.fallbackWarn) ? h.fallbackWarn : e.fallbackWarn;
    const D = !!h.part, W = If(e, h), E = c(e, a, W);
    if (!ye(f) || f === "") return new Intl.NumberFormat(W, v).format(m);
    let L = {}, b, P = null;
    const B = "number format";
    for (let $ = 0; $ < E.length && (b = E[$], L = n[b] || {}, P = L[f], !$e(P)); $++) Rf(e, f, b, C, B);
    if (!$e(P) || !ye(b)) return o ? hc : f;
    let k = `${b}__${f}`;
    pc(v) || (k = `${k}__${JSON.stringify(v)}`);
    let j = u.get(k);
    return j || (j = new Intl.NumberFormat(b, Ht({}, P, v)), u.set(k, j)), D ? j.formatToParts(m) : j.format(m);
  }
  const uS = ["localeMatcher", "style", "currency", "currencyDisplay", "currencySign", "useGrouping", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "minimumSignificantDigits", "maximumSignificantDigits", "compactDisplay", "notation", "signDisplay", "unit", "unitDisplay", "roundingMode", "roundingPriority", "roundingIncrement", "trailingZeroDisplay"];
  function jd(...e) {
    const [t, n, o, a] = e, s = mt();
    let c = mt();
    if (!Ft(t)) throw tr(er.INVALID_ARGUMENT);
    const u = t;
    return ye(n) ? s.key = n : $e(n) && Object.keys(n).forEach((f) => {
      uS.includes(f) ? c[f] = n[f] : s[f] = n[f];
    }), ye(o) ? s.locale = o : $e(o) && (c = o), $e(a) && (c = a), [s.key || "", u, s, c];
  }
  function iy(e, t, n) {
    const o = e;
    for (const a in n) {
      const s = `${t}__${a}`;
      o.__numberFormatters.has(s) && o.__numberFormatters.delete(s);
    }
  }
  const DP = (e) => e, MP = (e) => "", LP = "text", xP = (e) => e.length === 0 ? "" : xf(e), OP = wO;
  function ry(e, t) {
    return e = Math.abs(e), t === 2 ? e ? e > 1 ? 1 : 0 : 1 : e ? Math.min(e, 2) : 0;
  }
  function PP(e) {
    const t = Ft(e.pluralIndex) ? e.pluralIndex : -1;
    return e.named && (Ft(e.named.count) || Ft(e.named.n)) ? Ft(e.named.count) ? e.named.count : Ft(e.named.n) ? e.named.n : t : t;
  }
  function IP(e, t) {
    t.count || (t.count = e), t.n || (t.n = e);
  }
  function RP(e = {}) {
    const t = e.locale, n = PP(e), o = st(e.pluralRules) && ye(t) && Ct(e.pluralRules[t]) ? e.pluralRules[t] : ry, a = st(e.pluralRules) && ye(t) && Ct(e.pluralRules[t]) ? ry : void 0, s = (b) => b[o(n, b.length, a)], c = e.list || [], u = (b) => c[b], f = e.named || mt();
    Ft(e.pluralIndex) && IP(n, f);
    const m = (b) => f[b];
    function h(b, P) {
      const B = Ct(e.messages) ? e.messages(b, !!P) : st(e.messages) ? e.messages[b] : false;
      return B || (e.parent ? e.parent.message(b) : MP);
    }
    const v = (b) => e.modifiers ? e.modifiers[b] : DP, C = $e(e.processor) && Ct(e.processor.normalize) ? e.processor.normalize : xP, D = $e(e.processor) && Ct(e.processor.interpolate) ? e.processor.interpolate : OP, W = $e(e.processor) && ye(e.processor.type) ? e.processor.type : LP, L = { list: u, named: m, plural: s, linked: (b, ...P) => {
      const [B, k] = P;
      let j = "text", $ = "";
      P.length === 1 ? st(B) ? ($ = B.modifier || $, j = B.type || j) : ye(B) && ($ = B || $) : P.length === 2 && (ye(B) && ($ = B || $), ye(k) && (j = k || j));
      const q = h(b, true)(L), ue = j === "vnode" && xt(q) && $ ? q[0] : q;
      return $ ? v($)(ue, j) : ue;
    }, message: h, type: W, interpolate: D, normalize: C, values: Ht(mt(), c, f) };
    return L;
  }
  const oy = () => "", ni = (e) => Ct(e);
  function ay(e, ...t) {
    const { fallbackFormat: n, postTranslation: o, unresolving: a, messageCompiler: s, fallbackLocale: c, messages: u } = e, [f, m] = Hd(...t), h = rt(m.missingWarn) ? m.missingWarn : e.missingWarn, v = rt(m.fallbackWarn) ? m.fallbackWarn : e.fallbackWarn, C = rt(m.escapeParameter) ? m.escapeParameter : e.escapeParameter, D = !!m.resolvedMessage, W = ye(m.default) || rt(m.default) ? rt(m.default) ? s ? f : () => f : m.default : n ? s ? f : () => f : null, E = n || W != null && (ye(W) || Ct(W)), L = If(e, m);
    C && FP(m);
    let [b, P, B] = D ? [f, L, u[L] || mt()] : dS(e, f, L, c, v, h), k = b, j = f;
    if (!D && !(ye(k) || Ii(k) || ni(k)) && E && (k = W, j = k), !D && (!(ye(k) || Ii(k) || ni(k)) || !ye(P))) return a ? hc : f;
    let $ = false;
    const q = () => {
      $ = true;
    }, ue = ni(k) ? k : fS(e, f, P, k, j, q);
    if ($) return k;
    const ee = BP(e, P, B, m), se = RP(ee), le = NP(e, ue, se), re = o ? o(le, f) : le;
    if (__INTLIFY_PROD_DEVTOOLS__) {
      const Ee = { timestamp: Date.now(), key: ye(f) ? f : ni(k) ? k.key : "", locale: P || (ni(k) ? k.locale : ""), format: ye(k) ? k : ni(k) ? k.source : "", message: re };
      Ee.meta = Ht({}, e.__meta, CP() || {}), rP(Ee);
    }
    return re;
  }
  function FP(e) {
    xt(e.list) ? e.list = e.list.map((t) => ye(t) ? jg(t) : t) : st(e.named) && Object.keys(e.named).forEach((t) => {
      ye(e.named[t]) && (e.named[t] = jg(e.named[t]));
    });
  }
  function dS(e, t, n, o, a, s) {
    const { messages: c, onWarn: u, messageResolver: f, localeFallbacker: m } = e, h = m(e, o, n);
    let v = mt(), C, D = null;
    const W = "translate";
    for (let E = 0; E < h.length && (C = h[E], v = c[C] || mt(), (D = f(v, t)) === null && (D = v[t]), !(ye(D) || Ii(D) || ni(D))); E++) if (!zP(C, h)) {
      const L = Rf(e, t, C, s, W);
      L !== t && (D = L);
    }
    return [D, C, v];
  }
  function fS(e, t, n, o, a, s) {
    const { messageCompiler: c, warnHtmlMessage: u } = e;
    if (ni(o)) {
      const m = o;
      return m.locale = m.locale || n, m.key = m.key || t, m;
    }
    if (c == null) {
      const m = () => o;
      return m.locale = n, m.key = t, m;
    }
    const f = c(o, WP(e, n, a, o, u, s));
    return f.locale = n, f.key = t, f.source = o, f;
  }
  function NP(e, t, n) {
    return t(n);
  }
  function Hd(...e) {
    const [t, n, o] = e, a = mt();
    if (!ye(t) && !Ft(t) && !ni(t) && !Ii(t)) throw tr(er.INVALID_ARGUMENT);
    const s = Ft(t) ? String(t) : (ni(t), t);
    return Ft(n) ? a.plural = n : ye(n) ? a.default = n : $e(n) && !pc(n) ? a.named = n : xt(n) && (a.list = n), Ft(o) ? a.plural = o : ye(o) ? a.default = o : $e(o) && Ht(a, o), [s, a];
  }
  function WP(e, t, n, o, a, s) {
    return { locale: t, key: n, warnHtmlMessage: a, onError: (c) => {
      throw s && s(c), c;
    }, onCacheKey: (c) => pO(t, n, c) };
  }
  function BP(e, t, n, o) {
    const { modifiers: a, pluralRules: s, messageResolver: c, fallbackLocale: u, fallbackWarn: f, missingWarn: m, fallbackContext: h } = e, C = { locale: t, modifiers: a, pluralRules: s, messages: (D, W) => {
      let E = c(n, D);
      if (E == null && (h || W)) {
        const [, , L] = dS(h || e, D, t, u, f, m);
        E = c(L, D);
      }
      if (ye(E) || Ii(E)) {
        let L = false;
        const P = fS(e, D, t, E, D, () => {
          L = true;
        });
        return L ? oy : P;
      } else return ni(E) ? E : oy;
    } };
    return e.processor && (C.processor = e.processor), o.list && (C.list = o.list), o.named && (C.named = o.named), Ft(o.plural) && (C.pluralIndex = o.plural), C;
  }
  qO();
  /*!
  * vue-i18n v10.0.7
  * (c) 2025 kazuya kawaguchi
  * Released under the MIT License.
  */
  const UP = "10.0.7";
  function jP() {
    typeof __VUE_I18N_FULL_INSTALL__ != "boolean" && (no().__VUE_I18N_FULL_INSTALL__ = true), typeof __VUE_I18N_LEGACY_API__ != "boolean" && (no().__VUE_I18N_LEGACY_API__ = true), typeof __INTLIFY_DROP_MESSAGE_COMPILER__ != "boolean" && (no().__INTLIFY_DROP_MESSAGE_COMPILER__ = false), typeof __INTLIFY_PROD_DEVTOOLS__ != "boolean" && (no().__INTLIFY_PROD_DEVTOOLS__ = false);
  }
  const _n = { UNEXPECTED_RETURN_TYPE: aP, INVALID_ARGUMENT: 25, MUST_BE_CALL_SETUP_TOP: 26, NOT_INSTALLED: 27, REQUIRED_VALUE: 28, INVALID_VALUE: 29, NOT_INSTALLED_WITH_PROVIDE: 31, UNEXPECTED_ERROR: 32 };
  function Pn(e, ...t) {
    return mc(e, null, void 0);
  }
  const Vd = Pr("__translateVNode"), qd = Pr("__datetimeParts"), $d = Pr("__numberParts"), pS = Pr("__setPluralRules"), mS = Pr("__injectWithOption"), Gd = Pr("__dispose");
  function cs(e) {
    if (!st(e) || Ii(e)) return e;
    for (const t in e) if (hi(e, t)) if (!t.includes(".")) st(e[t]) && cs(e[t]);
    else {
      const n = t.split("."), o = n.length - 1;
      let a = e, s = false;
      for (let c = 0; c < o; c++) {
        if (n[c] === "__proto__") throw new Error(`unsafe key: ${n[c]}`);
        if (n[c] in a || (a[n[c]] = mt()), !st(a[n[c]])) {
          s = true;
          break;
        }
        a = a[n[c]];
      }
      if (s || (Ii(a) ? nS.includes(n[o]) || delete e[t] : (a[n[o]] = e[t], delete e[t])), !Ii(a)) {
        const c = a[n[o]];
        st(c) && cs(c);
      }
    }
    return e;
  }
  function Ff(e, t) {
    const { messages: n, __i18n: o, messageResolver: a, flatJson: s } = t, c = $e(n) ? n : xt(o) ? mt() : { [e]: mt() };
    if (xt(o) && o.forEach((u) => {
      if ("locale" in u && "resource" in u) {
        const { locale: f, resource: m } = u;
        f ? (c[f] = c[f] || mt(), Dl(m, c[f])) : Dl(m, c);
      } else ye(u) && Dl(JSON.parse(u), c);
    }), a == null && s) for (const u in c) hi(c, u) && cs(c[u]);
    return c;
  }
  function hS(e) {
    return e.type;
  }
  function gS(e, t, n) {
    let o = st(t.messages) ? t.messages : mt();
    "__i18nGlobal" in n && (o = Ff(e.locale.value, { messages: o, __i18n: n.__i18nGlobal }));
    const a = Object.keys(o);
    a.length && a.forEach((s) => {
      e.mergeLocaleMessage(s, o[s]);
    });
    {
      if (st(t.datetimeFormats)) {
        const s = Object.keys(t.datetimeFormats);
        s.length && s.forEach((c) => {
          e.mergeDateTimeFormat(c, t.datetimeFormats[c]);
        });
      }
      if (st(t.numberFormats)) {
        const s = Object.keys(t.numberFormats);
        s.length && s.forEach((c) => {
          e.mergeNumberFormat(c, t.numberFormats[c]);
        });
      }
    }
  }
  function sy(e) {
    return Kt(ms, null, e, 0);
  }
  const ly = "__INTLIFY_META__", cy = () => [], HP = () => false;
  let uy = 0;
  function dy(e) {
    return (t, n, o, a) => e(n, o, On() || void 0, a);
  }
  const VP = () => {
    const e = On();
    let t = null;
    return e && (t = hS(e)[ly]) ? { [ly]: t } : null;
  };
  function Nf(e = {}) {
    const { __root: t, __injectWithOption: n } = e, o = t === void 0, a = e.flatJson, s = Hl ? Ln : cf;
    let c = rt(e.inheritLocale) ? e.inheritLocale : true;
    const u = s(t && c ? t.locale.value : ye(e.locale) ? e.locale : ls), f = s(t && c ? t.fallbackLocale.value : ye(e.fallbackLocale) || xt(e.fallbackLocale) || $e(e.fallbackLocale) || e.fallbackLocale === false ? e.fallbackLocale : u.value), m = s(Ff(u.value, e)), h = s($e(e.datetimeFormats) ? e.datetimeFormats : { [u.value]: {} }), v = s($e(e.numberFormats) ? e.numberFormats : { [u.value]: {} });
    let C = t ? t.missingWarn : rt(e.missingWarn) || aa(e.missingWarn) ? e.missingWarn : true, D = t ? t.fallbackWarn : rt(e.fallbackWarn) || aa(e.fallbackWarn) ? e.fallbackWarn : true, W = t ? t.fallbackRoot : rt(e.fallbackRoot) ? e.fallbackRoot : true, E = !!e.fallbackFormat, L = Ct(e.missing) ? e.missing : null, b = Ct(e.missing) ? dy(e.missing) : null, P = Ct(e.postTranslation) ? e.postTranslation : null, B = t ? t.warnHtmlMessage : rt(e.warnHtmlMessage) ? e.warnHtmlMessage : true, k = !!e.escapeParameter;
    const j = t ? t.modifiers : $e(e.modifiers) ? e.modifiers : {};
    let $ = e.pluralRules || t && t.pluralRules, q;
    q = (() => {
      o && Jg(null);
      const O = { version: UP, locale: u.value, fallbackLocale: f.value, messages: m.value, modifiers: j, pluralRules: $, missing: b === null ? void 0 : b, missingWarn: C, fallbackWarn: D, fallbackFormat: E, unresolving: true, postTranslation: P === null ? void 0 : P, warnHtmlMessage: B, escapeParameter: k, messageResolver: e.messageResolver, messageCompiler: e.messageCompiler, __meta: { framework: "vue" } };
      O.datetimeFormats = h.value, O.numberFormats = v.value, O.__datetimeFormatters = $e(q) ? q.__datetimeFormatters : void 0, O.__numberFormatters = $e(q) ? q.__numberFormatters : void 0;
      const H = EP(O);
      return o && Jg(H), H;
    })(), Ra(q, u.value, f.value);
    function ee() {
      return [u.value, f.value, m.value, h.value, v.value];
    }
    const se = We({ get: () => u.value, set: (O) => {
      u.value = O, q.locale = u.value;
    } }), le = We({ get: () => f.value, set: (O) => {
      f.value = O, q.fallbackLocale = f.value, Ra(q, u.value, O);
    } }), re = We(() => m.value), Ee = We(() => h.value), fe = We(() => v.value);
    function ce() {
      return Ct(P) ? P : null;
    }
    function G(O) {
      P = O, q.postTranslation = O;
    }
    function oe() {
      return L;
    }
    function ie(O) {
      O !== null && (b = dy(O)), L = O, q.missing = b;
    }
    const pe = (O, H, ge, ze, Fe, Ke) => {
      ee();
      let Qe;
      try {
        __INTLIFY_PROD_DEVTOOLS__, o || (q.fallbackContext = t ? TP() : void 0), Qe = O(q);
      } finally {
        __INTLIFY_PROD_DEVTOOLS__, o || (q.fallbackContext = void 0);
      }
      if (ge !== "translate exists" && Ft(Qe) && Qe === hc || ge === "translate exists" && !Qe) {
        const [Et, vt] = H();
        return t && W ? ze(t) : Fe(Et);
      } else {
        if (Ke(Qe)) return Qe;
        throw Pn(_n.UNEXPECTED_RETURN_TYPE);
      }
    };
    function we(...O) {
      return pe((H) => Reflect.apply(ay, null, [H, ...O]), () => Hd(...O), "translate", (H) => Reflect.apply(H.t, H, [...O]), (H) => H, (H) => ye(H));
    }
    function Te(...O) {
      const [H, ge, ze] = O;
      if (ze && !st(ze)) throw Pn(_n.INVALID_ARGUMENT);
      return we(H, ge, Ht({ resolvedMessage: true }, ze || {}));
    }
    function ke(...O) {
      return pe((H) => Reflect.apply(ey, null, [H, ...O]), () => Ud(...O), "datetime format", (H) => Reflect.apply(H.d, H, [...O]), () => Zg, (H) => ye(H));
    }
    function tt(...O) {
      return pe((H) => Reflect.apply(ny, null, [H, ...O]), () => jd(...O), "number format", (H) => Reflect.apply(H.n, H, [...O]), () => Zg, (H) => ye(H));
    }
    function Me(O) {
      return O.map((H) => ye(H) || Ft(H) || rt(H) ? sy(String(H)) : H);
    }
    const Re = { normalize: Me, interpolate: (O) => O, type: "vnode" };
    function ft(...O) {
      return pe((H) => {
        let ge;
        const ze = H;
        try {
          ze.processor = Re, ge = Reflect.apply(ay, null, [ze, ...O]);
        } finally {
          ze.processor = null;
        }
        return ge;
      }, () => Hd(...O), "translate", (H) => H[Vd](...O), (H) => [sy(H)], (H) => xt(H));
    }
    function Ie(...O) {
      return pe((H) => Reflect.apply(ny, null, [H, ...O]), () => jd(...O), "number format", (H) => H[$d](...O), cy, (H) => ye(H) || xt(H));
    }
    function pt(...O) {
      return pe((H) => Reflect.apply(ey, null, [H, ...O]), () => Ud(...O), "datetime format", (H) => H[qd](...O), cy, (H) => ye(H) || xt(H));
    }
    function be(O) {
      $ = O, q.pluralRules = $;
    }
    function Ae(O, H) {
      return pe(() => {
        if (!O) return false;
        const ge = ye(H) ? H : u.value, ze = U(ge), Fe = q.messageResolver(ze, O);
        return Ii(Fe) || ni(Fe) || ye(Fe);
      }, () => [O], "translate exists", (ge) => Reflect.apply(ge.te, ge, [O, H]), HP, (ge) => rt(ge));
    }
    function _(O) {
      let H = null;
      const ge = iS(q, f.value, u.value);
      for (let ze = 0; ze < ge.length; ze++) {
        const Fe = m.value[ge[ze]] || {}, Ke = q.messageResolver(Fe, O);
        if (Ke != null) {
          H = Ke;
          break;
        }
      }
      return H;
    }
    function z(O) {
      const H = _(O);
      return H ?? (t ? t.tm(O) || {} : {});
    }
    function U(O) {
      return m.value[O] || {};
    }
    function Y(O, H) {
      if (a) {
        const ge = { [O]: H };
        for (const ze in ge) hi(ge, ze) && cs(ge[ze]);
        H = ge[O];
      }
      m.value[O] = H, q.messages = m.value;
    }
    function J(O, H) {
      m.value[O] = m.value[O] || {};
      const ge = { [O]: H };
      if (a) for (const ze in ge) hi(ge, ze) && cs(ge[ze]);
      H = ge[O], Dl(H, m.value[O]), q.messages = m.value;
    }
    function X(O) {
      return h.value[O] || {};
    }
    function w(O, H) {
      h.value[O] = H, q.datetimeFormats = h.value, ty(q, O, H);
    }
    function S(O, H) {
      h.value[O] = Ht(h.value[O] || {}, H), q.datetimeFormats = h.value, ty(q, O, H);
    }
    function x(O) {
      return v.value[O] || {};
    }
    function N(O, H) {
      v.value[O] = H, q.numberFormats = v.value, iy(q, O, H);
    }
    function de(O, H) {
      v.value[O] = Ht(v.value[O] || {}, H), q.numberFormats = v.value, iy(q, O, H);
    }
    uy++, t && Hl && (vi(t.locale, (O) => {
      c && (u.value = O, q.locale = O, Ra(q, u.value, f.value));
    }), vi(t.fallbackLocale, (O) => {
      c && (f.value = O, q.fallbackLocale = O, Ra(q, u.value, f.value));
    }));
    const Z = { id: uy, locale: se, fallbackLocale: le, get inheritLocale() {
      return c;
    }, set inheritLocale(O) {
      c = O, O && t && (u.value = t.locale.value, f.value = t.fallbackLocale.value, Ra(q, u.value, f.value));
    }, get availableLocales() {
      return Object.keys(m.value).sort();
    }, messages: re, get modifiers() {
      return j;
    }, get pluralRules() {
      return $ || {};
    }, get isGlobal() {
      return o;
    }, get missingWarn() {
      return C;
    }, set missingWarn(O) {
      C = O, q.missingWarn = C;
    }, get fallbackWarn() {
      return D;
    }, set fallbackWarn(O) {
      D = O, q.fallbackWarn = D;
    }, get fallbackRoot() {
      return W;
    }, set fallbackRoot(O) {
      W = O;
    }, get fallbackFormat() {
      return E;
    }, set fallbackFormat(O) {
      E = O, q.fallbackFormat = E;
    }, get warnHtmlMessage() {
      return B;
    }, set warnHtmlMessage(O) {
      B = O, q.warnHtmlMessage = O;
    }, get escapeParameter() {
      return k;
    }, set escapeParameter(O) {
      k = O, q.escapeParameter = O;
    }, t: we, getLocaleMessage: U, setLocaleMessage: Y, mergeLocaleMessage: J, getPostTranslationHandler: ce, setPostTranslationHandler: G, getMissingHandler: oe, setMissingHandler: ie, [pS]: be };
    return Z.datetimeFormats = Ee, Z.numberFormats = fe, Z.rt = Te, Z.te = Ae, Z.tm = z, Z.d = ke, Z.n = tt, Z.getDateTimeFormat = X, Z.setDateTimeFormat = w, Z.mergeDateTimeFormat = S, Z.getNumberFormat = x, Z.setNumberFormat = N, Z.mergeNumberFormat = de, Z[mS] = n, Z[Vd] = ft, Z[qd] = pt, Z[$d] = Ie, Z;
  }
  function qP(e) {
    const t = ye(e.locale) ? e.locale : ls, n = ye(e.fallbackLocale) || xt(e.fallbackLocale) || $e(e.fallbackLocale) || e.fallbackLocale === false ? e.fallbackLocale : t, o = Ct(e.missing) ? e.missing : void 0, a = rt(e.silentTranslationWarn) || aa(e.silentTranslationWarn) ? !e.silentTranslationWarn : true, s = rt(e.silentFallbackWarn) || aa(e.silentFallbackWarn) ? !e.silentFallbackWarn : true, c = rt(e.fallbackRoot) ? e.fallbackRoot : true, u = !!e.formatFallbackMessages, f = $e(e.modifiers) ? e.modifiers : {}, m = e.pluralizationRules, h = Ct(e.postTranslation) ? e.postTranslation : void 0, v = ye(e.warnHtmlInMessage) ? e.warnHtmlInMessage !== "off" : true, C = !!e.escapeParameterHtml, D = rt(e.sync) ? e.sync : true;
    let W = e.messages;
    if ($e(e.sharedMessages)) {
      const j = e.sharedMessages;
      W = Object.keys(j).reduce((q, ue) => {
        const ee = q[ue] || (q[ue] = {});
        return Ht(ee, j[ue]), q;
      }, W || {});
    }
    const { __i18n: E, __root: L, __injectWithOption: b } = e, P = e.datetimeFormats, B = e.numberFormats, k = e.flatJson;
    return { locale: t, fallbackLocale: n, messages: W, flatJson: k, datetimeFormats: P, numberFormats: B, missing: o, missingWarn: a, fallbackWarn: s, fallbackRoot: c, fallbackFormat: u, modifiers: f, pluralRules: m, postTranslation: h, warnHtmlMessage: v, escapeParameter: C, messageResolver: e.messageResolver, inheritLocale: D, __i18n: E, __root: L, __injectWithOption: b };
  }
  function Kd(e = {}) {
    const t = Nf(qP(e)), { __extender: n } = e, o = { id: t.id, get locale() {
      return t.locale.value;
    }, set locale(a) {
      t.locale.value = a;
    }, get fallbackLocale() {
      return t.fallbackLocale.value;
    }, set fallbackLocale(a) {
      t.fallbackLocale.value = a;
    }, get messages() {
      return t.messages.value;
    }, get datetimeFormats() {
      return t.datetimeFormats.value;
    }, get numberFormats() {
      return t.numberFormats.value;
    }, get availableLocales() {
      return t.availableLocales;
    }, get missing() {
      return t.getMissingHandler();
    }, set missing(a) {
      t.setMissingHandler(a);
    }, get silentTranslationWarn() {
      return rt(t.missingWarn) ? !t.missingWarn : t.missingWarn;
    }, set silentTranslationWarn(a) {
      t.missingWarn = rt(a) ? !a : a;
    }, get silentFallbackWarn() {
      return rt(t.fallbackWarn) ? !t.fallbackWarn : t.fallbackWarn;
    }, set silentFallbackWarn(a) {
      t.fallbackWarn = rt(a) ? !a : a;
    }, get modifiers() {
      return t.modifiers;
    }, get formatFallbackMessages() {
      return t.fallbackFormat;
    }, set formatFallbackMessages(a) {
      t.fallbackFormat = a;
    }, get postTranslation() {
      return t.getPostTranslationHandler();
    }, set postTranslation(a) {
      t.setPostTranslationHandler(a);
    }, get sync() {
      return t.inheritLocale;
    }, set sync(a) {
      t.inheritLocale = a;
    }, get warnHtmlInMessage() {
      return t.warnHtmlMessage ? "warn" : "off";
    }, set warnHtmlInMessage(a) {
      t.warnHtmlMessage = a !== "off";
    }, get escapeParameterHtml() {
      return t.escapeParameter;
    }, set escapeParameterHtml(a) {
      t.escapeParameter = a;
    }, get pluralizationRules() {
      return t.pluralRules || {};
    }, __composer: t, t(...a) {
      return Reflect.apply(t.t, t, [...a]);
    }, rt(...a) {
      return Reflect.apply(t.rt, t, [...a]);
    }, tc(...a) {
      const [s, c, u] = a, f = { plural: 1 };
      let m = null, h = null;
      if (!ye(s)) throw Pn(_n.INVALID_ARGUMENT);
      const v = s;
      return ye(c) ? f.locale = c : Ft(c) ? f.plural = c : xt(c) ? m = c : $e(c) && (h = c), ye(u) ? f.locale = u : xt(u) ? m = u : $e(u) && (h = u), Reflect.apply(t.t, t, [v, m || h || {}, f]);
    }, te(a, s) {
      return t.te(a, s);
    }, tm(a) {
      return t.tm(a);
    }, getLocaleMessage(a) {
      return t.getLocaleMessage(a);
    }, setLocaleMessage(a, s) {
      t.setLocaleMessage(a, s);
    }, mergeLocaleMessage(a, s) {
      t.mergeLocaleMessage(a, s);
    }, d(...a) {
      return Reflect.apply(t.d, t, [...a]);
    }, getDateTimeFormat(a) {
      return t.getDateTimeFormat(a);
    }, setDateTimeFormat(a, s) {
      t.setDateTimeFormat(a, s);
    }, mergeDateTimeFormat(a, s) {
      t.mergeDateTimeFormat(a, s);
    }, n(...a) {
      return Reflect.apply(t.n, t, [...a]);
    }, getNumberFormat(a) {
      return t.getNumberFormat(a);
    }, setNumberFormat(a, s) {
      t.setNumberFormat(a, s);
    }, mergeNumberFormat(a, s) {
      t.mergeNumberFormat(a, s);
    } };
    return o.__extender = n, o;
  }
  function $P(e, t, n) {
    return { beforeCreate() {
      const o = On();
      if (!o) throw Pn(_n.UNEXPECTED_ERROR);
      const a = this.$options;
      if (a.i18n) {
        const s = a.i18n;
        if (a.__i18n && (s.__i18n = a.__i18n), s.__root = t, this === this.$root) this.$i18n = fy(e, s);
        else {
          s.__injectWithOption = true, s.__extender = n.__vueI18nExtend, this.$i18n = Kd(s);
          const c = this.$i18n;
          c.__extender && (c.__disposer = c.__extender(this.$i18n));
        }
      } else if (a.__i18n) if (this === this.$root) this.$i18n = fy(e, a);
      else {
        this.$i18n = Kd({ __i18n: a.__i18n, __injectWithOption: true, __extender: n.__vueI18nExtend, __root: t });
        const s = this.$i18n;
        s.__extender && (s.__disposer = s.__extender(this.$i18n));
      }
      else this.$i18n = e;
      a.__i18nGlobal && gS(t, a, a), this.$t = (...s) => this.$i18n.t(...s), this.$rt = (...s) => this.$i18n.rt(...s), this.$tc = (...s) => this.$i18n.tc(...s), this.$te = (s, c) => this.$i18n.te(s, c), this.$d = (...s) => this.$i18n.d(...s), this.$n = (...s) => this.$i18n.n(...s), this.$tm = (s) => this.$i18n.tm(s), n.__setInstance(o, this.$i18n);
    }, mounted() {
    }, unmounted() {
      const o = On();
      if (!o) throw Pn(_n.UNEXPECTED_ERROR);
      const a = this.$i18n;
      delete this.$t, delete this.$rt, delete this.$tc, delete this.$te, delete this.$d, delete this.$n, delete this.$tm, a.__disposer && (a.__disposer(), delete a.__disposer, delete a.__extender), n.__deleteInstance(o), delete this.$i18n;
    } };
  }
  function fy(e, t) {
    e.locale = t.locale || e.locale, e.fallbackLocale = t.fallbackLocale || e.fallbackLocale, e.missing = t.missing || e.missing, e.silentTranslationWarn = t.silentTranslationWarn || e.silentFallbackWarn, e.silentFallbackWarn = t.silentFallbackWarn || e.silentFallbackWarn, e.formatFallbackMessages = t.formatFallbackMessages || e.formatFallbackMessages, e.postTranslation = t.postTranslation || e.postTranslation, e.warnHtmlInMessage = t.warnHtmlInMessage || e.warnHtmlInMessage, e.escapeParameterHtml = t.escapeParameterHtml || e.escapeParameterHtml, e.sync = t.sync || e.sync, e.__composer[pS](t.pluralizationRules || e.pluralizationRules);
    const n = Ff(e.locale, { messages: t.messages, __i18n: t.__i18n });
    return Object.keys(n).forEach((o) => e.mergeLocaleMessage(o, n[o])), t.datetimeFormats && Object.keys(t.datetimeFormats).forEach((o) => e.mergeDateTimeFormat(o, t.datetimeFormats[o])), t.numberFormats && Object.keys(t.numberFormats).forEach((o) => e.mergeNumberFormat(o, t.numberFormats[o])), e;
  }
  const Wf = { tag: { type: [String, Object] }, locale: { type: String }, scope: { type: String, validator: (e) => e === "parent" || e === "global", default: "parent" }, i18n: { type: Object } };
  function GP({ slots: e }, t) {
    return t.length === 1 && t[0] === "default" ? (e.default ? e.default() : []).reduce((o, a) => [...o, ...a.type === an ? a.children : [a]], []) : t.reduce((n, o) => {
      const a = e[o];
      return a && (n[o] = a()), n;
    }, mt());
  }
  function yS() {
    return an;
  }
  const KP = Si({ name: "i18n-t", props: Ht({ keypath: { type: String, required: true }, plural: { type: [Number, String], validator: (e) => Ft(e) || !isNaN(e) } }, Wf), setup(e, t) {
    const { slots: n, attrs: o } = t, a = e.i18n || Bf({ useScope: e.scope, __useComponent: true });
    return () => {
      const s = Object.keys(n).filter((v) => v !== "_"), c = mt();
      e.locale && (c.locale = e.locale), e.plural !== void 0 && (c.plural = ye(e.plural) ? +e.plural : e.plural);
      const u = GP(t, s), f = a[Vd](e.keypath, u, c), m = Ht(mt(), o), h = ye(e.tag) || st(e.tag) ? e.tag : yS();
      return yf(h, m, f);
    };
  } }), py = KP;
  function YP(e) {
    return xt(e) && !ye(e[0]);
  }
  function vS(e, t, n, o) {
    const { slots: a, attrs: s } = t;
    return () => {
      const c = { part: true };
      let u = mt();
      e.locale && (c.locale = e.locale), ye(e.format) ? c.key = e.format : st(e.format) && (ye(e.format.key) && (c.key = e.format.key), u = Object.keys(e.format).reduce((C, D) => n.includes(D) ? Ht(mt(), C, { [D]: e.format[D] }) : C, mt()));
      const f = o(e.value, c, u);
      let m = [c.key];
      xt(f) ? m = f.map((C, D) => {
        const W = a[C.type], E = W ? W({ [C.type]: C.value, index: D, parts: f }) : [C.value];
        return YP(E) && (E[0].key = `${C.type}-${D}`), E;
      }) : ye(f) && (m = [f]);
      const h = Ht(mt(), s), v = ye(e.tag) || st(e.tag) ? e.tag : yS();
      return yf(v, h, m);
    };
  }
  const ZP = Si({ name: "i18n-n", props: Ht({ value: { type: Number, required: true }, format: { type: [String, Object] } }, Wf), setup(e, t) {
    const n = e.i18n || Bf({ useScope: e.scope, __useComponent: true });
    return vS(e, t, uS, (...o) => n[$d](...o));
  } }), my = ZP, QP = Si({ name: "i18n-d", props: Ht({ value: { type: [Number, Date], required: true }, format: { type: [String, Object] } }, Wf), setup(e, t) {
    const n = e.i18n || Bf({ useScope: e.scope, __useComponent: true });
    return vS(e, t, cS, (...o) => n[qd](...o));
  } }), hy = QP;
  function JP(e, t) {
    const n = e;
    if (e.mode === "composition") return n.__getInstance(t) || e.global;
    {
      const o = n.__getInstance(t);
      return o != null ? o.__composer : e.global.__composer;
    }
  }
  function XP(e) {
    const t = (c) => {
      const { instance: u, value: f } = c;
      if (!u || !u.$) throw Pn(_n.UNEXPECTED_ERROR);
      const m = JP(e, u.$), h = gy(f);
      return [Reflect.apply(m.t, m, [...yy(h)]), m];
    };
    return { created: (c, u) => {
      const [f, m] = t(u);
      Hl && e.global === m && (c.__i18nWatcher = vi(m.locale, () => {
        u.instance && u.instance.$forceUpdate();
      })), c.__composer = m, c.textContent = f;
    }, unmounted: (c) => {
      Hl && c.__i18nWatcher && (c.__i18nWatcher(), c.__i18nWatcher = void 0, delete c.__i18nWatcher), c.__composer && (c.__composer = void 0, delete c.__composer);
    }, beforeUpdate: (c, { value: u }) => {
      if (c.__composer) {
        const f = c.__composer, m = gy(u);
        c.textContent = Reflect.apply(f.t, f, [...yy(m)]);
      }
    }, getSSRProps: (c) => {
      const [u] = t(c);
      return { textContent: u };
    } };
  }
  function gy(e) {
    if (ye(e)) return { path: e };
    if ($e(e)) {
      if (!("path" in e)) throw Pn(_n.REQUIRED_VALUE, "path");
      return e;
    } else throw Pn(_n.INVALID_VALUE);
  }
  function yy(e) {
    const { path: t, locale: n, args: o, choice: a, plural: s } = e, c = {}, u = o || {};
    return ye(n) && (c.locale = n), Ft(a) && (c.plural = a), Ft(s) && (c.plural = s), [t, u, c];
  }
  function eI(e, t, ...n) {
    const o = $e(n[0]) ? n[0] : {};
    (rt(o.globalInstall) ? o.globalInstall : true) && ([py.name, "I18nT"].forEach((s) => e.component(s, py)), [my.name, "I18nN"].forEach((s) => e.component(s, my)), [hy.name, "I18nD"].forEach((s) => e.component(s, hy))), e.directive("t", XP(t));
  }
  const tI = Pr("global-vue-i18n");
  function nI(e = {}, t) {
    const n = __VUE_I18N_LEGACY_API__ && rt(e.legacy) ? e.legacy : __VUE_I18N_LEGACY_API__, o = rt(e.globalInjection) ? e.globalInjection : true, a = /* @__PURE__ */ new Map(), [s, c] = iI(e, n), u = Pr("");
    function f(C) {
      return a.get(C) || null;
    }
    function m(C, D) {
      a.set(C, D);
    }
    function h(C) {
      a.delete(C);
    }
    const v = { get mode() {
      return __VUE_I18N_LEGACY_API__ && n ? "legacy" : "composition";
    }, async install(C, ...D) {
      if (C.__VUE_I18N_SYMBOL__ = u, C.provide(C.__VUE_I18N_SYMBOL__, v), $e(D[0])) {
        const L = D[0];
        v.__composerExtend = L.__composerExtend, v.__vueI18nExtend = L.__vueI18nExtend;
      }
      let W = null;
      !n && o && (W = dI(C, v.global)), __VUE_I18N_FULL_INSTALL__ && eI(C, v, ...D), __VUE_I18N_LEGACY_API__ && n && C.mixin($P(c, c.__composer, v));
      const E = C.unmount;
      C.unmount = () => {
        W && W(), v.dispose(), E();
      };
    }, get global() {
      return c;
    }, dispose() {
      s.stop();
    }, __instances: a, __getInstance: f, __setInstance: m, __deleteInstance: h };
    return v;
  }
  function Bf(e = {}) {
    const t = On();
    if (t == null) throw Pn(_n.MUST_BE_CALL_SETUP_TOP);
    if (!t.isCE && t.appContext.app != null && !t.appContext.app.__VUE_I18N_SYMBOL__) throw Pn(_n.NOT_INSTALLED);
    const n = rI(t), o = aI(n), a = hS(t), s = oI(e, a);
    if (s === "global") return gS(o, e, a), o;
    if (s === "parent") {
      let f = sI(n, t, e.__useComponent);
      return f == null && (f = o), f;
    }
    const c = n;
    let u = c.__getInstance(t);
    if (u == null) {
      const f = Ht({}, e);
      "__i18n" in a && (f.__i18n = a.__i18n), o && (f.__root = o), u = Nf(f), c.__composerExtend && (u[Gd] = c.__composerExtend(u)), cI(c, t, u), c.__setInstance(t, u);
    }
    return u;
  }
  function iI(e, t, n) {
    const o = Iy(), a = __VUE_I18N_LEGACY_API__ && t ? o.run(() => Kd(e)) : o.run(() => Nf(e));
    if (a == null) throw Pn(_n.UNEXPECTED_ERROR);
    return [o, a];
  }
  function rI(e) {
    const t = ri(e.isCE ? tI : e.appContext.app.__VUE_I18N_SYMBOL__);
    if (!t) throw Pn(e.isCE ? _n.NOT_INSTALLED_WITH_PROVIDE : _n.UNEXPECTED_ERROR);
    return t;
  }
  function oI(e, t) {
    return pc(e) ? "__i18n" in t ? "local" : "global" : e.useScope ? e.useScope : "local";
  }
  function aI(e) {
    return e.mode === "composition" ? e.global : e.global.__composer;
  }
  function sI(e, t, n = false) {
    let o = null;
    const a = t.root;
    let s = lI(t, n);
    for (; s != null; ) {
      const c = e;
      if (e.mode === "composition") o = c.__getInstance(s);
      else if (__VUE_I18N_LEGACY_API__) {
        const u = c.__getInstance(s);
        u != null && (o = u.__composer, n && o && !o[mS] && (o = null));
      }
      if (o != null || a === s) break;
      s = s.parent;
    }
    return o;
  }
  function lI(e, t = false) {
    return e == null ? null : t && e.vnode.ctx || e.parent;
  }
  function cI(e, t, n) {
    ps(() => {
    }, t), ff(() => {
      const o = n;
      e.__deleteInstance(t);
      const a = o[Gd];
      a && (a(), delete o[Gd]);
    }, t);
  }
  const uI = ["locale", "fallbackLocale", "availableLocales"], vy = ["t", "rt", "d", "n", "tm", "te"];
  function dI(e, t) {
    const n = /* @__PURE__ */ Object.create(null);
    return uI.forEach((a) => {
      const s = Object.getOwnPropertyDescriptor(t, a);
      if (!s) throw Pn(_n.UNEXPECTED_ERROR);
      const c = bt(s.value) ? { get() {
        return s.value.value;
      }, set(u) {
        s.value.value = u;
      } } : { get() {
        return s.get && s.get();
      } };
      Object.defineProperty(n, a, c);
    }), e.config.globalProperties.$i18n = n, vy.forEach((a) => {
      const s = Object.getOwnPropertyDescriptor(t, a);
      if (!s || !s.value) throw Pn(_n.UNEXPECTED_ERROR);
      Object.defineProperty(e.config.globalProperties, `$${a}`, s);
    }), () => {
      delete e.config.globalProperties.$i18n, vy.forEach((a) => {
        delete e.config.globalProperties[`$${a}`];
      });
    };
  }
  jP();
  SP(tP);
  bP(yP);
  _P(iS);
  if (__INTLIFY_PROD_DEVTOOLS__) {
    const e = no();
    e.__INTLIFY__ = true, nP(e.__INTLIFY_DEVTOOLS_GLOBAL_HOOK__);
  }
  const fI = { common: { prompt: "提示", refresh: "刷新", cancel: "取消", close: "关闭", restore: "恢复默认", iKnowIt: "我知道了", notAdminRunning: "该操作需要管理员权限，请退出本应用后鼠标右键选择以“以管理员身份运行”重启应用后再试", clickLogin: "点击登录", cloudEqTip: "登录后即可使用云端功能（更多配置分享功能开发中，敬请期待）", editNickname: "修改昵称", changeAvatar: "修改头像", avatarTip: "支持JPG，PNG格式，文件大小不超过2MB", logout: "退出登录", autoWechatLogin: "勾选下方选项后将自动跳转至微信登录", privacyPrefix: "登录即表示同意", userAgreement: "用户协议", loginSuccess: "登录成功", emailLoginSuccess: "登录成功", bindWechatAction: "绑定微信", bindWechatSuccess: "微信绑定成功", bindWechatFailed: "绑定微信失败", wechatAlreadyBoundOtherEmail: "微信账号已经绑定了其他邮箱", emailAlreadyBoundOtherWechat: "邮箱账号已经绑定了其他微信", unbindEmail: "解绑邮箱", unbindEmailGetCode: "获取验证码", unbindEmailSuccess: "解绑成功", unbindEmailCodeInvalid: "无效验证码", accountBindWechat: "去绑定微信", accountBindEmail: "去绑定邮箱", accountUnbindEmail: "解绑邮箱", bindEmailSuccess: "绑定成功", logoutSuccess: "已退出登录", changesSubmitted: "修改已提交，请耐心等待审核", nicknameEmpty: "昵称不能为空", enterNickname: "请输入昵称", confirm: "确定", official: "官方预设", game: "游戏", music: "音乐", cloud: "云端社区", cloudShared: "云端共享", favorited: "已收藏", myShares: "我分享的", search: "搜索", latest: "最新", topUsed: "使用最多", topLiked: "点赞最多", topFav: "收藏最多", author: "作者", import: "导入", imported: "已导入", favoritedStatus: "已收藏", removedFromFavorites: "已取消收藏", liked: "已点赞", unliked: "已取消点赞", importedToCustom: "已导入到自定义", importFailed: "导入失败，最多可导入20个", pleaseLogin: "请登录后再进行操作", maxFavorites: "最多收藏20个", noUserUploads: "还没有用户上传过", noSearchResults: "未搜索到相关内容，换个词试试吧～", noFavorites: "暂无收藏", noSharesYet: "还未分享过哦", cancelSharing: "取消分享", notice: "提示", confirmCancelShare: '确定取消<strong>"{name}"</strong>的分享吗？', delete: "删除", custom: "自定义", myPresets: "我创建的", localImport: "本地导入", cloudImports: "云端导入的", confirmDelete: '确定删除"xxx"吗？删除后不可恢复，如有需要建议导出本分到本地后再删除。', confirmDeleteReview: '确定删除<strong>"{name}"</strong>吗？该EQ正在审核中，若审核通过将依旧在云端展示', confirmDeleteSimple: '确定删除<strong>"{name}"</strong>吗？', fromAuthor: "来自作者：", shareToCloud: "分享到云端", shareSuccess: "分享成功", sharingCanceled: "已取消分享", maxSharesPerUser: "每人最多分享10条", selectCategory: "选择分类", other: "其他", selectGameTag: "请选择游戏标签", enterPresetTitle: "输入配置标题", shareTitlePlaceholder: "给分享到云端的EQ标题写个响亮的名字吧", maxSharesPerUserSimple: "每人最多分享10条", shareSuccessful: "分享成功", confirmShareOverwrite: "此EQ之前分享过，再次分享为覆盖之前的旧EQ，确定分享吗？", share: "分享", restoreDefault: "恢复默认", restoreDefaultSuccess: "已恢复默认设置", underReview: "审核中", export: "导出", underReviewTryLater: "审核中，请稍后再进行操作", underReviewDeleteWarning: "审核中，若删除将会自动中断审核", shareFailTitle: "分享失败，标题违规", shared: "已分享", exitPreview: "退出预览", nicknameViolation: "昵称违规", nicknameViolationTip: "昵称违规，请修改", rename: "重命名", copy: "复制", copied: "已复制", noCloudImport: "暂无云端导入的EQ", unknown: "未知", noDescription: "暂无描述", shareRequestSubmitted: "分享请求已提交", copySuffix: "的副本", view: "去查看", sysChanged: "调整后的EQ还未保存，请点击上方的<strong>【另存为自定义】</strong>按钮以防切换页面后丢失数据", cmdENOENT: "检测到系统缺少cmd.exe，请修复系统后再试", batchOperation: "批量操作", selectAll: "全选", exitBatch: "退出批量", confirmBatchDeleteAll: '确定删除<strong class="delete_name">全部</strong>EQ吗？', confirmBatchDeleteSelected: "确定删除选中的EQ吗？", using: "使用中", clickToUse: "点击使用", expert: "大神配置", applySuccess: "已激活选中的EQ", noData: "暂无数据" }, tray: { open: "打开M HUB", quit: "退出" }, commonHeader: { officialStore: "官方商城", myDevice: "我的设备", back: "返回", backHome: "返回主页", popoverTheme: "换肤", popoverSetting: "设置", popoverRelatedApp: "关联游戏/应用，自动切换板载", popoverMin: "最小化", popoverUnmax: "还原", popoverMax: "最大化", popoverClose: "关闭", offline: "当前服务器不在线，请稍后重启驱动再试", performanceOnDesc: "关闭性能模式后，将会打开透明背景、毛玻璃、边框圆角效果，外观更美观，对电脑性能有一定要求。", performanceOffDesc: "开启性能模式后，将会去掉透明背景、毛玻璃、边框圆角的效果，操作更流畅，若使用应用时卡顿，那么建议开启。", feedback: "反馈", prizeQuiz: "有奖调研" }, themeSetting: { pageName: "主题", white: "霜茶白", black: "玄潭黑", followSys: "跟随系统", bg: "背景", followTheme: "跟随主题", customizeText: "自定义背景（仅对首页生效）", changeBg: "更换背景", defaultBg: "默认背景", uploadImg: "上传图片", blurCard: "设备卡片模糊度", blurBg: "图片背景模糊度" }, setting: { version: "当前版本", startup: "启动", startAuto: "开机自启动", startAutoMini: "启动时最小化到系统托盘", language: "语言", closePanel: "关闭面板时", exit: "退出程序", minimize: "最小化到托盘，不退出程序", copyright: "版权所有" }, menus: { AudioConfiguration: "音频配置", LightingSettings: "灯光设置", ScreenSettings: "屏幕显示", OtherSettings: "其他设置", GeneralParameters: "常规参数", Equalizer: "均衡器", SoundMode: "音效模式", VirtualSurround: "虚拟7.1环绕", CommonParams: "常用参数", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "音量均衡", volumeBalanceTip: "根据使用场景调节左右声道与动态范围，获得更均衡的听感。", trebleEnhancement: "高频增强", trebleEnhancementTip: "提升高频细节，过高可能导致刺耳。", vocalEnhancement: "人声增强", vocalEnhancementTip: "增强语音清晰度并抑制环境噪声。", alertMode: "警戒模式", alertModeTip: "调整麦克风拾音指向，便于关注特定方向的声音。", bassEnhancement: "低音增强", bassEnhancementTip: "增强低频量感，可配合频段截取避免浑浊。", intensity: "强度", clarityStrength: "清晰强度", noiseSuppression: "噪音抑制", bassStrength: "低音强度", freqCutoff: "频段截取", musicModeDynamic: "音乐模式 (高动态)", voiceModeDynamic: "语音模式 (低动态)", omnidirectionalMode: "全向模式", rearMode: "后方模式", unitDb: "（dB）", unitHz: "（Hz）" }, index: { screenNotice: "检测到您的屏幕设置可能会影响桌面端的显示，请前往修改屏幕缩放与布局比例，获得最佳显示效果。", gotoSet: "去修改", needAdminNotice: "部分功能可能因权限不足无法使用，请退出本应用后鼠标右键选择以“以管理员身份运行”重新启动应用", loadFail: "加载失败", loadFailDesc: "请点击刷新按钮以重新加载，或检查网络连接、重启驱动" }, devicePage: { needOtaNotice: "检测到新固件版本，升级后才可正常使用驱动！请下载并更新固件。", needOtaNoticeTip: "提示：下载后，前往保存路径打开工具包，按照教程进行升级即可。", downloadNow: "立即下载", restartNotice: "驱动安装后，需重启电脑才可正常使用驱动。重启后，若驱动未能生效，请联系客服协助。", restartNow: "立即重启", speakerDisabled: "检测到扬声器已被禁用，导致不能正常打开驱动", step: "解决方法步骤：", step1: "1.请点击下方【Windows声音设备】按钮。", step2: "2.在弹出的系统声音控制面板弹窗里（可参考下方示意图）选择“播放”，在列表内找到对应的设备后，“右键”并“启用”该扬声器，再点“确认”。", step3: "3.启用完成后点击下方【刷新】按钮。", isSleep: `若已进入休眠状态请重新启动耳机 
 或检查连接模式是否为2.4G（可尝试重新插拔接收器）
 注：插入音频线或蓝牙模式都不可使用驱动`, deviceLostLink: "驱动连接已断开", headphoneSleepStatus: "耳机已休眠", headphoneSleepStatusTips: "请按键唤醒或重新启动耳机", needLinkWireless: "驱动仅支持2.4G连接", needLinkWirelessHeadphoneTips: "请确认接收器已插入，且未插入音频线或使用蓝牙模式", wiredMode: "有线连接", lessThan: "低于{val}", charging: "充电中", sufficientCharge: "电量充足", wiredVersion: "有线版", notAdminRunningHeadset: "音频设备需管理员权限，请退出本应用后鼠标右键选择以“以管理员身份运行”重新启动应用", thxInstallDialogTitle: "正在安装音效组件", thxInstallDialogTitleUpgrade: "正在更新音效组件", thxInstallDialogDesc1: "预计需要 1-2 分钟，请耐心等待。", thxInstallDialogDesc2: "安装期间请勿退出驱动，完成后将自动进入设备详情页。" }, routine: { UserManual: "使用说明", beepTitle: "语音提示", beepTitleDesc: "调节耳机语音播报的音量大小，不影响媒体音量。", UserManualFull: "使用说明", Volume: "音量", Microphone: "麦克风", MicAI: "开启AI降噪", MicAIDesc: "过滤环境噪音，保留清晰原声，让采集的声音更干净、音质更好。", MicNoiseReduction: "稳态噪声抑制", MicNoiseReductionDesc: "对特定频段的稳定噪声成分进行衰减，针对性地降低该频段的信号强度，例如空调、风扇的噪音。", MicListen: "麦克风监听", MicListenDesc: "实时听到自己的声音，方便快速调节麦克风实际音量，让通话更清晰稳定。", MoYin: "魔幻音效：", MoYin_0: "怪兽", MoYin_1: "卡通", MoYin_2: "男声", MoYin_3: "女声", WindowsAudioDevices: "Windows声音设备", soundModeTitle: "声音模式", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "模式{n}", soundModeActive: "当前生效", soundModeInactive: "未启用", soundModeSwitched: "已切换到模式{n}", eqItemHoverApply: "应用", soundModeRename: "重命名", soundModeEditEq: "编辑均衡器", eqEditorAutoSaved: "已自动保存", eqEditorModifiedAutoSaved: "已修改，已自动保存", eqEditorCollapse: "收起", eqEditorResetFactory: "恢复出厂均衡器", eqEditorResetFactoryConfirm: "【{mode}】将覆盖当前均衡器设置，恢复为出厂默认状态。", eqEditorResetFactoryDone: "模式{n}已恢复为出厂默认均衡器", eqSwitchUnsavedHint: "您已修改当前模式的均衡器，若直接应用，当前编辑内容将被覆盖。", eqSwitchApplyDirect: "直接应用", eqSwitchSaveThenApply: "另存后应用", AudioBright: "音频明亮化", AudioBrightDesc: "提升音频高频部分，使声音更清晰，细节更丰富，有效增强音频整体的明亮质感与表现力。", SurroundAmplification: "环绕扩增", SurroundAmplificationDesc: "增强音频空间感，把声音的“地盘”拓宽，模拟声音的反射、扩散，感觉像置身更广阔、被扬声器环绕的空间。", DynamicLF: "动态低频", DynamicLFDesc: "智能调控低频，强节奏时强化力度与深度，鼓点更有力。低频少则减弱，让声音自然平衡，带来灵动多变的低频听觉感受。", SmartVolume: "智能音量", SmartVolumeDesc: "自动感知音频音量变化，智能均衡至适宜水平，避免忽大忽小，提供稳定聆听体验，无需手动频繁调音量。", VocalClarity: "人声清晰化", VocalClarityDesc: "精准优化人声频段，降低噪音与背景音干扰，突出纯净人声，让您清晰捕捉吐字发音，听歌、追剧、通话皆享出色听觉体验。", MusicMode: "音乐模式 (高动态)", VoiceMode: "语音模式 (低动态)", NCut: "噪音抑制", Freqtrap: "频段截取", Intensity: "强度", DYIntensity: "低音强度", QXIntensity: "清晰强度", Speech: "语音播报", SpeechDesc: "音箱操作时的语音播报（同时按下音箱实体按键的“+”和“G”{time}秒也可开启或关闭语音播报）", SpeechDescK20Pro: "音箱操作时的语音播报（按下音箱实体按键的麦克风键{time}秒，也可开启或关闭语音播报）", micDisabled: "检测到麦克风已被禁用", micDisabledTitle: "检测到麦克风已被禁用，导致不能正常使用麦克风", step: "解决方法步骤：", step1: "1.请点击下方【Windows声音设备】按钮。", step2: "2.在弹出的系统声音控制面板弹窗里（可参考下方示意图）选择“录制”，在列表内找到对应的设备后，“右键”并“启用”该麦克风，再点“确认”。", step3: "3.启用完成后点击下方【刷新】图标。" }, eq: { title: "均衡器", game1: "EQ 模式 1", game2: "EQ 模式 2", game3: "EQ 模式 3", eqSlotDefaultDesc: "板载预设槽位", popover2: "均衡器如调音台，能调节音频频率音量，可依喜好调节高低音频段。例如游戏时，提低频强化爆炸、脚步声，升高频使枪声、碰撞声更清晰，依习惯打造专属声效，增沉浸感与竞技优势。", popover: "均衡器可调节不同频段的声音强弱，用于定制更适合你的听感。", import: "本地导入", 默认: "默认", 音乐清脆风: "音乐清脆风", 音乐清脆风1: "音乐清脆风1", 音乐清脆风2: "音乐清脆风2", "3D影视": "3D影视", 舞曲: "舞曲", 饶舌曲: "饶舌曲", 重金属: "重金属", 爵士: "爵士", 抒情摇滚: "抒情摇滚", 摇滚: "摇滚", 现场: "现场", 高音: "高音", 低音: "低音", bandBass: "低音", bandLowMid: "低中音", bandMid: "中音", bandHighMid: "中高音", bandHigh: "高音", 古典乐: "古典乐", 声乐: "声乐", 无畏契约: "无畏契约", 无畏契约1: "无畏契约1", 无畏契约2: "无畏契约2", 无畏契约3: "无畏契约3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "绝地求生", 绝地求生1: "绝地求生1", 绝地求生2: "绝地求生2", 绝地求生3: "绝地求生3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "三角洲", 三角洲1: "三角洲1", 三角洲2: "三角洲2", 三角洲3: "三角洲3", add: "自定义", more: "更多", empty: "没有选中任何特效", renamePlaceholder: "请输入名称", export: "导出", delete: "删除", saveAs: "另存为自定义", reset: "恢复默认", newNameTitle: "自定义", newNamePlaceholder: "请输入自定义名称", duplicate: "该名称已存在，请重新输入", ok: "确定", importSuccess: "导入成功", importFail: "导入失败，请重试", importFailName: "导入失败，名称重复，请修改", exportSuccess: "导出成功", exportFail: "导出失败，请重试", deleteTitle: "提示", delPre: '确定删除"', delAfter: '"吗？删除后不可恢复，如有需要建议导出到本地后再删除。', expertListTip: "大神配置与音效模式绑定，使用时不建议更换音效模式，以获得最佳听感。" }, wechatLogin: { privacyPrefix: "登录即表示同意", privacyPolicy: "《隐私政策》", privacySuffix: "《用户协议》", privacyPolicyTitle: "隐私政策", privacyAnd: "和", privacyEnd: "", accountMergeHint: "绑定后，微信和邮箱都可登录同一账号，微信和邮箱账号内的数据将合并", accountUnbindEmailHint: "解绑后，数据依然存在微信账号内，可通过微信登录继续使用", userAgreement: "用户协议", privacyWelcome: "欢迎您使用迈从微信授权登录服务！我们非常重视您的个人信息和隐私保护。本《隐私政策》旨在说明深圳市迈从科技有限公司（以下简称“迈从”或“我们”）在您使用通过微信授权登录的云端服务时，如何收集、使用、存储和保护您的个人信息，以及您所享有的相关权利。", privacyReadNotice: "请您在使用服务前，务必仔细阅读并理解本政策全部内容。一旦您使用本服务，即表示您已阅读、理解并同意本隐私政策的所有内容。", privacySection1Title: "一. 我们收集的信息", privacySection1Desc: "在您使用本服务过程中，我们可能会收集以下信息：", privacyWechatInfo: `1.微信授权信息
当您通过微信登录时，我们会根据微信平台接口收集您的微信昵称、头像、openid、unionid等基础信息，以用于账号识别和个性化服务。`, privacyCloudData: `2. 云端使用数据
您上传、保存、调用的配置文件将保存在我们的云端服务器中，以支持您的跨设备同步使用。`, privacySection2Title: "二. 我们如何使用信息", privacySection2Desc: "我们收集您的信息，仅用于以下合法、正当、必要的目的：", privacyServiceFunction: `1.实现服务功能
提供微信授权登录、云端存储与调用等核心服务。`, privacyServiceSecurity: `2.保障服务安全
用于身份校验、异常检测、故障排查等，提高系统稳定性与安全性。`, privacySection3Title: "三. 信息的存储与保护", privacyStorageLocation: `1.存储位置与期限
所有用户数据均存储于中国大陆境内服务器。我们仅在为实现上述目的所必需的时间内保留您的信息，超出期限后将进行删除或匿名化处理。`, privacySecurityMeasures: `2.信息安全措施
我们采用多重加密、访问控制、日志审计等技术手段保障数据安全，防止未经授权的访问、泄露、篡改或破坏。`, privacySection4Title: "四.您的权利", privacyRightsDesc: "根据适用法律法规，您拥有以下权利：", privacyQueryAccess: `1.查询与访问
您有权查询我们是否存储您的相关信息，并有权访问您的个人信息。`, privacyCorrectionDelete: `2.更正与删除
如果您发现我们持有的信息不准确或无效，您可以请求更正或删除。`, privacyCancelWithdraw: `3.注销与撤回授权
您可以通过微信平台或联系我们的方式注销账号或撤回授权，届时我们将不再处理您的信息，但法律法规另有规定的除外。`, privacySection5Title: "五. 政策更新", privacyPolicyUpdate: "我们可能根据业务发展、法律法规变化适时更新本隐私政策。更新后的政策将通过微信小程序公告或其他合理方式告知您。如您继续使用服务，即表示接受更新内容。", privacySection6Title: "六. 联系我们", privacyContactDesc: "如您对本隐私政策有任何疑问、建议或投诉，可通过以下方式与我们联系：", privacyServiceHotline: "1.服务热线：400-816-8986", privacyServiceTime: "2.服务时间：周一至周五 9:00 - 19:00", privacyConclusion: "感谢您信任并使用迈从微信授权登录服务。我们将持续努力，保障您的信息安全与隐私权益。", userAgreementWelcome: "欢迎您使用迈从微信授权登录服务！本《用户协议》（下称“本协议”）由深圳市迈从科技有限公司（下称“我们”或“迈从”）与用户（下称“您”）就迈从通过微信授权登录方式所提供的服务（以下简称“本服务”）所订立的权利义务规范。", userAgreementReadNotice: "请您务必在使用前认真阅读并理解本协议的全部内容，特别是涉及免责条款及限制您权利的部分。", userAgreementSection1Title: "一. 使用本服务的要求", userAgreementSection1Desc: "1.您明确声明并保证：", userAgreementLegalCapacity: "· 具备签署本协议并使用本服务的法律资格；", userAgreementMinorNotice: "· 如您为未成年人，须在监护人指导并获得监护人同意后方可使用本服务；若您不满十四周岁，应由法定监护人明确同意或指导后方可使用。", userAgreementRequirements: "2. 使用本服务需具备可连接网络的兼容设备及安装微信应用，并通过微信授权登录。", userAgreementSection2Title: "二. 账号登录与使用", userAgreementLoginProcess: "1.本服务依托微信平台提供授权登录，您在首次使用时需同意并完成微信授权流程，以创建或识别您的迈从服务账号。", userAgreementInfoAccuracy: "2.您应保证授权信息的真实性、准确性，并及时更新信息以确保服务正常使用。", userAgreementAccountSecurity: "3.您应妥善保管您的微信帐号及相关信息，因微信账号遗失、泄露等原因导致的损失，由您自行承担。", userAgreementSection3Title: "三. 本服务内容", userAgreementCloudService: "1.云端服务：上传配置文件至云端保存、同步及管理；", userAgreementConfigCall: "2.配置调用：导入用户上传的配置文件，实现个性化体验；", userAgreementOfficialSync: "3.官方配置文件的同步：将最新的官方配置文件实时同步。", userAgreementServiceAdjustment: "迈从有权根据业务发展对服务内容进行增减或调整，恕不另行通知。", userAgreementSection4Title: "四. 用户行为规范", userAgreementBehaviorRule1: "1.您在使用本服务时不得从事任何违法、侵权、破坏系统安全的行为；", userAgreementBehaviorRule2: "2.包括但不限于：传播违法信息、侵害他人权益、实施欺诈、干扰平台系统等；", userAgreementBehaviorRule3: "3.对于上述行为，迈从有权采取警告、限制使用、封禁帐号、追究法律责任等措施。", userAgreementSection5Title: "五. 知识产权", userAgreementIPOwnership: "1.本服务的所有内容、界面设计、代码、接口、图形、布局等，归迈从或授权方所有；", userAgreementIPRestriction: "2.未经授权，您不得复制、传播、修改、转让或用于商业用途。", userAgreementSection6Title: "六. 隐私保护", userAgreementPrivacyNotice1: "1.我们高度重视您的隐私保护。有关如何收集、使用、存储及保护您的个人信息，请详见《隐私政策》。", userAgreementPrivacyNotice2: "2.请您在使用服务前仔细阅读该政策，了解您的权利及我们的义务。", userAgreementSection7Title: "七. 免责声明", userAgreementDisclaimer1: "1.我们将尽最大努力保障服务稳定与数据安全，但对因不可抗力或系统故障等原因造成的服务中断、数据丢失等不承担责任；", userAgreementDisclaimer2: "2.因用户自身原因造成的损失，由用户自行承担。", userAgreementSection8Title: "八. 协议更新与变更", userAgreementUpdate1: "1.迈从有权根据法律法规及业务调整对本协议进行更新，并通过微信公告或其他合理方式通知；", userAgreementUpdate2: "2.若您继续使用本服务，则视为接受更新后的协议内容。", userAgreementSection9Title: "九. 法律适用与争议解决", userAgreementLaw1: "1.本协议适用中华人民共和国法律；", userAgreementLaw2: "2.如发生争议，双方应协商解决；协商不成的，任何一方可向深圳市龙岗区有管辖权的法院提起诉讼。", userAgreementSection10Title: "十. 联系我们", userAgreementContactDesc: "如您对本隐私政策有任何疑问、建议或投诉，可通过以下方式与我们联系：", userAgreementServiceHotline: "1.服务热线：400-816-8986", userAgreementServiceTime: "2.服务时间：周一至周五 9:00 - 19:00", userAgreementConclusion: "感谢您信任并使用迈从微信授权登录服务。我们将持续努力，保障您的信息安全与隐私权益。", emailPlaceholder: "请输入邮箱", emailFormatError: "邮箱格式有误，请检查", emailSendCode: "获取验证码", emailResend: "重新发送", emailResendCountdown: "重新发送（{n}s）", bindEmailGetCode: "获取验证码", switchToWechatAria: "切换到微信登录", switchToEmailAria: "切换到邮箱登录", cornerTooltipWechat: "点击切换为微信登录", cornerTooltipEmail: "点击切换为邮箱登录", titleEmailLogin: "邮箱登录", titleWechatLogin: "微信登录", titleBindEmail: "绑定邮箱", testEnvLoginTitle: "测试环境登录", testEnvSuffix: " (测试)", testCodePlaceholder: "请输入授权码 (code)", btnLogin: "登录", codeStepBack: "返回", enterVerificationCode: "输入验证码", codeEmailCheckTitle: "请检查你的邮件", codeEmailSentLine: "我们已经给您发送了一个验证码", codeEmailInboxLine: "请查看您 {email} 的收件箱", devOpenDevtools: "打开调试工具", devInspectPage: "检查页面", msgSendCodeFailRetry: "验证码获取失败", msgOtpSixDigits: "请输入6位验证码", msgWxConfigInitFail: "微信配置初始化失败，请检查网络连接", msgLoginPageLoadFail: "登录页面加载失败，请重试", msgLoginFailRetry: "登录失败，请重试", msgTestEnterAuthCode: "请输入授权码", msgBindFailGeneric: "绑定失败" }, user: { nicknamePlaceholder: "请输入新的昵称", nicknameTip: "昵称长度限制为1-10个字符", nicknameEmpty: "昵称不能为空", nicknameLengthError: "昵称长度必须在1-10个字符之间", nicknameUpdateSuccess: "昵称修改成功", nicknameUpdateFail: "昵称修改失败", selectImage: "选择图片", avatarEmpty: "请选择要上传的头像图片", avatarUpdateSuccess: "头像修改成功", avatarUpdateFail: "头像修改失败" }, mode: { modeDesc: "不同模式，一键切换，为您带来专属极致听觉体验", gameMode: "游戏模式", gameMode1: "游戏模式1", gameMode2: "游戏模式2", musicMode: "音乐模式", movieMode: "电影模式", gameModeDesc: "强调枪声脚步细节，适用于竞技类FPS游戏", musicModeDesc: "专业调教还原声音细节，适用于沉浸音乐场景", movieModeDesc: "打造影院级音效体验，适用于沉浸式电影场景", gameModeDesc2: "强调战场环境音效，适用于战场类FPS游戏" }, light: { switch: "灯光", switchOn: "灯光开启", switchOff: "灯光关闭", title: "灯光效果", static: "常亮模式", breath: "呼吸模式", cyclicDiscolor: "繁星流彩", goFlow: "随波逐流", continue: "连续", duan: "短", chang: "长", an: "暗", guang: "亮", direction: "方向", clockwise: "顺时针", anticlockwise: "逆时针", loop: "循环变色", music: "音乐律动", flowing_s: "流光-慢", sync_in_effect: "神光同步生效中", syncClosed: "已关闭当前设备的神光同步，并启用选中的灯效", flowing_f: "流光-快", speed: "速度", fast: "快", slow: "慢", colorjoe: "调色盘", reset: "恢复默认", notView: " 该灯效不支持预览", color: "颜色", lightShow: "灯光显示", lightShow1: "灯光全开", lightShow2: "关闭中间", lightShow3: "关闭两边", smartLight: "智能灯光", smartLightDesc: "开启后，设备连续30分钟无操作且无播放时，屏幕及氛围灯将自动进入低亮度模式", k20Mode1: "单色凝光", k20Mode2: "幻彩逐浪", k20Mode3: "氛围呼吸", k20Mode4: "音乐律动", k20Mode5: "炫彩漾波", k20Mode6: "纯色旋影", k20Mode7: "华光漫延", speedAndBrightness: "速度和亮度", brightness: "亮度" }, surround: { switch: "Xear虚拟7.1环绕", popover: "模拟7.1声道环绕声，开启后，能让您感觉声音从多个方向传来，置身于游戏场景或电影情节之中，精准地定位声音的方向和距离，为您带来更加立体、沉浸式的听觉体验。", popoverGame: "虚拟7.1音效不适用FPS游戏，适用于3A游戏及影音。", mode: "模式选择", music: "音乐/游戏模式", movie: "电影模式", test: "喇叭测试", start: "开始测试", stop: "停止测试", size: "房间大小", small: "小", mid: "中", big: "大" }, otherSettings: { alreadyLatest: "固件已为最新版本，无需更新", v9TurboHeadset: "请使用2.4G模式连接进行升级", latest: "已最新", baseV: "底座固件版本：", goUpdate: "去升级", usbV: "设备USB版本：", firmwareV: "设备固件版本：", headsetV: "耳机固件版本：", dongleV: "接收器固件版本：", findNew: "检测到最新版：", speakerShutdown: "设备关机", speakerShutdownDesc: "驱动仅能关机，不能开机", shutdown: "关机", speakerShutdownConfirm: "确定要将设备关机吗？", speakerShutdownSuccess: "音箱已关机", speakerShutdownDeviceError: "设备未连接，请检查设备", speakerShutdownFailed: "关机失败", and: "、", restoreFactory: "恢复出厂设置", restoreFactoryDesc: "所有设置将恢复到出厂状态，请谨慎操作", restore: "恢复出厂", restoreSuccess: "恢复出厂设置成功", downloading: "正在下载固件文件…", updating: "固件升级中…", updatingNote: "升级过程中请勿退出程序或插拔设备！", inDevelopment: "功能开发中，敬请期待...", readBinFail: "读取固件文件失败", downloadBinFail: "下载固件文件失败", otaFail: "固件升级失败", otaFailResult: "固件升级失败，可尝试拔插设备后重试", deviceReconnectFail: "设备重新连接超时，请拔插设备后重试", otaSuc: "固件升级成功", otaSucDongle: "固件升级成功，等待{deviceType}自动重启后生效（约耗时30秒）", otaSucHeadset: "固件升级成功，请等待约30秒后将耳机手动开机生效", otaSucBoth: "耳机与接收器固件升级成功，请等待设备自动重启后生效（约30秒）", deviceTypeDong: "接收器", deviceTypeDevice: "设备", confirmFactoryReset: "该操作将会清空所有设置项，确定恢复出厂设置吗？", powerManagement: "电源管理", autoShutdown: "耳机省电关机：", autoShutdownDesc: "耳机离开底座（非充电状态），闲置无播放并超过所选时间后，耳机将自动关闭。", minutes: "分钟", downloadTips1: "1.固件包建议下载保存至桌面。", downloadTips2Exe: "2.双击固件包即可自动升级。", downloadTips2Zip: "2.解压后双击固件包即可自动升级。", betterOtaTitle: "检测到新固件版本，为了更好的使用体验，建议升级到最新固件版本" }, screenSettings: { screenOTAing: "屏幕升级中，请稍候", screenDisplay: "屏幕显示", screenOn: "屏幕开启", screenOff: "屏幕关闭", screenColor: "屏幕颜色", presetSettings: "壁纸切换设置", personalizedPreset: "屏幕壁纸", customText: "文本", custom: "自定义", digitalClock: "数字时钟", musicSpectrum: "音乐频谱", campusDaily: "校园日常", workplaceLife: "职场生活", cutePets: "可爱萌宠", electronicGames: "电玩游戏", cyberTech: "赛博科技", networkMeme: "网络热梗", customImage: "自定义图片", customImageOTAWarning: "请先更新固件，再使用此功能", addImage: "添加图片", uploadImage: "上传图片", reuploadImage: "重新上传", supportImageFormat: "支持PNG、JPG、GIF格式。注：GIF仅支持前30帧。", previewImage: "效果预览", text: "文字", scenery: "风景", character: "人物", uploadingToScreen: "正在上传到屏幕", reverseColor: "反转颜色", scaleScreen: "缩放屏幕", scaleImage: "缩放图片", blackWhiteRatio: "黑白比例", deleteImageConfirm: "确定删除此自定义图片吗？删除后不可恢复", deleteImage: "删除", batchDeleteImage: "批量删除", selectAll: "全选", cancelSelectAll: "取消全选", processImage: "处理图片", exitBatch: "退出批量", deleteSelectedImageConfirm: "确定删除选中的自定义图片吗？删除后不可恢复", textContent: "文本内容", textLengthLimit: "输入的字符已达上限", save: "保存", savedSuccess: "已保存", historyRecords: "历史记录", clearHistory: "一键清空历史记录", historyTip: "仅显示最近20条历史记录", textEffect: "文字效果", staticDisplay: "静态显示", dynamicDisplay: "动态显示", alignment: "对齐方式", leftAlign: "左对齐", centerAlign: "居中对齐", rightAlign: "右对齐", justifyAlign: "两端对齐", scrollEffect: "滚动效果", scrollToRight: "从左往右", scrollToLeft: "从右往左", customColors: "自定义颜色", clearCustomColors: "清空自定义颜色", syncToLight: "将当前颜色同步到灯光", shortPress: "短按", lyrics: "歌词", lyricsDisplay: "歌词显示（BETA）", lyricsDisplayHintLead: "播放支持歌词的音频时，屏幕将显示当前歌词内容。", lyricsDisplayCantSeeLink: "看不到歌词？", lyricsDisplayCantSeeTooltip: "暂支持部分音乐平台，请先将音乐平台升级至最新版本，完成后刷新 M HUB", lyricsOn: "开启", lyricsOff: "关闭", lyricsAnimation: "歌词动画", notSupportSyncToLight: "当前灯光效果为多色效果，不支持颜色同步", syncToLightSuccess: "同步成功", uploadToScreenTip: "预计{time}s，请勿退出", deleteCustomColorConfirm: "确定删除当前颜色吗？", deleteAllCustomColorsConfirm: "确定删除所有自定义颜色吗？", minimumSelectionToast: "最少选择2个", textVerifyFailed: "像素屏暂不支持表情、特殊符号等非常规字符，请使用纯文本输入", lyricsAnimationOption1: "入场：从下到上。退场：从下到上", lyricsAnimationOption2: "入场：从中间展开。退场：从中间收缩", lyricsAnimationOption3: "入场：从左到右。退场：从右到左", lyricsAnimationOption4: "入场：从下到上。退场：从上到下", lyricsAnimationOption5: "入场：从上到下。退场：从右到左", lyricsAnimationDemo: "歌词动画演示", uploadingImgTip: "有正在上传的图片，请稍后再试" }, update: { alreadyNew: "已是最新版本", findNew: "检测到最新版", ignore: "忽略", update: "升级", showHistory: "查看历史版本", updating: "驱动升级中...", rollingBack: "正在回到历史版本{version}", updateContentTitle: "驱动升级", updateContent: "驱动更新内容：", updateNow: "立即升级", back: "返回", historyTitle: "历史版本", version: "版本号", date: "更新日期", backToList: "返回上一级", only30: "保留最近30个历史版本", operation: "操作", watchContent: "查看更新内容", rollTo: "回到该版本", currentVersion: "当前版本", updateTo: "升级到该版本", updateSuccess: "驱动升级成功", revertSuccess: "已回到历史版本{version}", updatePre: "升级准备中，请稍等…", updateAfter: "应用即将自动重启，请稍等", inviteUpdate1: "发现新版本", inviteUpdate2: "邀您立即升级", inviteUpdate3: "", notAdminRunning: "升级过程需要管理员权限，请退出本应用后在应用图标上点击鼠标右键选择“以管理员身份运行”，待启动后再次尝试升级", updateResultFail: "更新失败，可能导致某些功能不可用，请卸载后前往迈从官网下载最新安装包安装", updateFailAfter: "压缩包制作阶段异常，请卸载后前往迈从官网下载最新安装包安装", updateFailPre: "升级预处理阶段异常，请稍后重试，如仍失败请卸载驱动后前往迈从官网下载最新驱动安装包重新安装", updateUpFailDefault: "驱动升级失败，请稍后再试", updateBackFailDefault: "回退到旧版本失败，请稍后再试", notSupportUpdate: "当前版本不支持在线升级，请前往迈从官网下载最新版安装包重新安装", restartFinishUpdate: "重启驱动完成升级" }, musicDance: { settingPanel: "音乐律动控制面板", scaleEffect: "缩放律动", scaleKeyboard: "缩放键盘", showEffect: "展示律动", showKeyboard: "展示键盘", reset: "恢复默认", needWinVcTitle: "检测到系统缺少Windows MSVC运行库，部分功能使用受限", needWinVcDesc: "请下载安装微软官方库vc_redist.x64.exe后重启应用：", needWinVcLink1: "微软官方下载地址：", needWinVcLink2: "备用下载地址：", download: "点击下载", needWinVcNotice: "安装后如仍提示此弹窗可能是您的系统暂不兼容此功能" } }, pI = { common: { prompt: "Prompt", refresh: "Refresh", cancel: "Cancel", close: "Close", restore: "Restore defaults", iKnowIt: "I see", notAdminRunning: "This operation requires administrator privileges. Please exit the application, right-click the icon, select “Run as administrator”, then restart and try again.", clickLogin: "Log in", cloudEqTip: "After logging in, you can use cloud features (more configuration sharing functions are under development, stay tuned).", editNickname: "Edit nickname", changeAvatar: "Change avatar", avatarTip: "Supports JPG and PNG formats, file size must not exceed 2MB", logout: "Log out", autoWechatLogin: "Check the box below to log in via WeChat automatically", privacyPrefix: "By logging in, you agree to the", userAgreement: "User Agreement", loginSuccess: "Login successful", emailLoginSuccess: "Login successful", bindWechatAction: "Link WeChat", bindWechatSuccess: "WeChat linked", bindWechatFailed: "Failed to link WeChat", wechatAlreadyBoundOtherEmail: "WeChat is already linked to another email", emailAlreadyBoundOtherWechat: "Email is already linked to another WeChat", unbindEmail: "Unbind email", unbindEmailGetCode: "Get code", unbindEmailSuccess: "Unbind successful", unbindEmailCodeInvalid: "Invalid code", accountBindWechat: "Bind WeChat", accountBindEmail: "Bind email", accountUnbindEmail: "Unbind email", bindEmailSuccess: "Bind successful", logoutSuccess: "Logged out", changesSubmitted: "Changes submitted. Please wait for approval", nicknameEmpty: "Nickname cannot be empty", enterNickname: "Please enter a nickname", confirm: "Confirm", official: "Official Presets", game: "Game", music: "Music", cloud: "Cloud Community", cloudShared: "Cloud Sharing", favorited: "Favorited", myShares: "My Shares", search: "Search", latest: "Latest", topUsed: "Top Used", topLiked: "Top Liked", topFav: "Top Fav", author: "Author", import: "Import", imported: "Imported", favoritedStatus: "Favorited", removedFromFavorites: "Removed from favorites", liked: "Liked", unliked: "Unliked", importedToCustom: "Imported to Custom", importFailed: "Import failed. Maximum 20 allowed", pleaseLogin: "Please log in to continue", maxFavorites: "You can favorite up to 20 items", noUserUploads: "No user uploads yet", noSearchResults: "No results found. Try another keyword~", noFavorites: "No favorites yet", noSharesYet: "You haven't shared anything yet", cancelSharing: "Cancel sharing", notice: "Prompt", confirmCancelShare: 'Cancel sharing <strong>"{name}"</strong>?', delete: "Delete", custom: "Custom", myPresets: "My Created", localImport: "Local Import", cloudImports: "Cloud Imports", confirmDelete: 'Are you sure you want to delete "xxx"? This action cannot be undone. Export to local storage before deleting if needed.', confirmDeleteReview: 'Are you sure you want to delete <strong>"{name}"</strong>? This EQ is under review and may still appear in the cloud if the review passes.', confirmDeleteSimple: 'Are you sure you want to delete <strong>"{name}"</strong>?', fromAuthor: "From the author:", shareToCloud: "Share to Cloud", shareSuccess: "Shared successfully", sharingCanceled: "Sharing canceled", maxSharesPerUser: "Up to 10 shares per user", selectCategory: "Select Category", other: "Other", selectGameTag: "Please select a game tag", enterPresetTitle: "Enter preset title", shareTitlePlaceholder: "Give your cloud EQ share a catchy title", maxSharesPerUserSimple: "Up to 10 shares per user", shareSuccessful: "Share successful", confirmShareOverwrite: "This EQ has already been shared. Sharing again will overwrite the previous one. Proceed?", share: "Share", restoreDefault: "Restore Default", restoreDefaultSuccess: "Restored to default settings", underReview: "Under Review", export: "Export", underReviewTryLater: "Under review, please try again later", underReviewDeleteWarning: "Deleting now will cancel the ongoing review process", shareFailTitle: "Share failed: Title violates policy", shared: "Shared", exitPreview: "Exit Preview", nicknameViolation: "Invalid nickname", nicknameViolationTip: "Invalid nickname. Please modify it", rename: "Rename", copy: "Copy", copied: "Copied", noCloudImport: "No EQ to import from cloud", unknown: "Unknown", noDescription: "No description", shareRequestSubmitted: "Share request submitted", copySuffix: "copy", view: "View", sysChanged: "EQ not saved. Click <strong>[Save as Custom]</strong> to prevent data loss.", cmdENOENT: "System is missing cmd.exe. Please repair the system and try again.", batchOperation: "Batch operation", selectAll: "Select All", exitBatch: "Exit batch mode", confirmBatchDeleteAll: "Delete all configurations?", confirmBatchDeleteSelected: "Delete selected configurations?", using: "In Use", clickToUse: "Use Now", expert: "Pro Settings", applySuccess: "Selected EQ activated", noData: "No data" }, tray: { open: "Open M HUB", quit: "Exit" }, commonHeader: { officialStore: "Official Store", myDevice: "My device", back: "Return", backHome: "Back to Home", popoverTheme: "Change Skin", popoverSetting: "Set up", popoverRelatedApp: "Link game/app to auto switch onboard", popoverMin: "Minimize", popoverUnmax: "Restore", popoverMax: "Maximize", popoverClose: "Close", offline: "The current server is offline. Please restart the driver later and try again", performanceOnDesc: "After disabling the performance mode, the transparent background, frosted - glass, and rounded - corner border effects will be enabled, enhancing the aesthetic appeal. However, this places certain demands on the computer's performance.", performanceOffDesc: "After enabling the performance mode, effects like transparent backgrounds, frosted glass, and rounded corners of the border will be removed. This will lead to smoother operations. If you experience lag while using an app, it is recommended to enable this mode.", feedback: "Feedback", prizeQuiz: "Reward Survey" }, themeSetting: { pageName: "Theme", white: "White", black: "Black", followSys: "Follow the system", bg: "Background", followTheme: "Follow the theme", customizeText: "Custom background (only for the homepage)", changeBg: "Bg Change", defaultBg: "Default background ", uploadImg: "Upload image", blurCard: "Device Card Blur", blurBg: "Image Background Blur" }, setting: { version: "Current version", startup: "Startup", startAuto: "Startup automatically", startAutoMini: "Minimize to system tray on startup", language: "Language", closePanel: "When closing the panel", exit: "Exit the program", minimize: "Minimize to the tray, do not exit the program", copyright: "" }, menus: { AudioConfiguration: "Audio configuration", LightingSettings: "Lighting settings", ScreenSettings: "Screen Display", OtherSettings: "Other settings", GeneralParameters: "Regular parameters", Equalizer: "Equalizer", SoundMode: "Sound mode", VirtualSurround: "Virtual 7.1 Surround", CommonParams: "Common parameters", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "It is detected that your screen settings may affect the display on the desktop. Please go to modify the screen zoom and layout ratio for the best display effect.", gotoSet: "Edit", needAdminNotice: "Some features may be unavailable due to insufficient permissions. Please exit the application, right-click the icon, and select “Run as administrator” to restart the app", loadFail: "Loading failed", loadFailDesc: "Please click the refresh button to reload, or check your network connection and restart the driver." }, devicePage: { needOtaNotice: "A new firmware version has been detected. You need to upgrade it to use the driver normally. Please download and update the firmware.", needOtaNoticeTip: "Tip: After downloading, go to the save location, open the toolkit, and follow the instructions to complete the upgrade.", downloadNow: "Download Now", restartNotice: "After installing the driver, you need to restart your computer to use the driver properly. If the driver does not take effect after the restart, please contact customer support for assistance.", restartNow: "Restart Now", speakerDisabled: "Speaker Disabled Detected, Unable to Open Driver", step: "Solution Steps:", step1: "1. Click the [Windows Sound Devices] button below.", step2: '2. In the pop-up System Sound Control Panel (refer to the diagram below), select "Playback." Find the corresponding device in the list, right-click and enable the speaker, then click OK.', step3: "3. Once enabled, click the [Refresh] button below.", isSleep: `If it has entered sleep mode,please restart the headset 
 or check whether the connection mode is 2.4G (you can try to re-plug the receiver) 
 Note: The driver cannot be used when the audio cable is plugged in or in the Bluetooth mode`, deviceLostLink: "Driver connection lost", headphoneSleepStatus: "Headset is in sleep mode", headphoneSleepStatusTips: "Press a button or restart it", needLinkWireless: "Driver only supports 2.4G connection", needLinkWirelessHeadphoneTips: "Make sure the receiver is plugged in and do not use audio cable or Bluetooth mode", wiredMode: "Wired", lessThan: "Less than {val}", charging: "Charging", sufficientCharge: "Fully charged", wiredVersion: "wired", notAdminRunningHeadset: "Administrator privileges are required for audio devices. Please exit the application, right-click the icon, and select “Run as administrator” to restart the app", thxInstallDialogTitle: "Installing audio components", thxInstallDialogTitleUpgrade: "Updating audio components", thxInstallDialogDesc1: "This will take 1–2 minutes, please wait", thxInstallDialogDesc2: "Do not exit the driver during installation. The device page will open automatically when finished" }, routine: { UserManual: "Manual", beepTitle: "Sound Notification", beepTitleDesc: "Adjust headset voice prompt volume (no effect on media)", UserManualFull: "User Manual", Volume: "Volume", Microphone: "Microphone", MicAI: "Enable AI noise reduction", MicAIDesc: "Filters noise and improves clarity", MicNoiseReduction: "Steady-State Noise Suppression", MicNoiseReductionDesc: "Attenuates steady noise components in specific frequency bands, targeting and reducing the signal strength of sounds like air conditioners or fans.", MicListen: "Microphone monitoring", MicListenDesc: "Hear yourself in real time", MoYin: "Magic Sound Effects:", MoYin_0: "Monster", MoYin_1: "Cartoon", MoYin_2: "Male Voice", MoYin_3: "Female Voice", WindowsAudioDevices: "Windows sound device", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Modified, auto-saved", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Restore factory EQ", eqEditorResetFactoryConfirm: "[{mode}] will overwrite the current equalizer settings and restore factory defaults.", eqEditorResetFactoryDone: "Mode {n} has been restored to the factory default equalizer.", eqSwitchUnsavedHint: "You have modified the equalizer for the current mode. Applying another EQ directly will overwrite your edits.", eqSwitchApplyDirect: "Apply directly", eqSwitchSaveThenApply: "Save as custom, then apply", AudioBright: "Audio brightening", AudioBrightDesc: "Enhance the high frequencies of the audio to make the sound clearer and richer in detail, effectively improving the overall brightness and expressiveness of the audio.", SurroundAmplification: "Surround Enhancement", SurroundAmplificationDesc: 'Enhances the audio spatial effect, widening the "territory" of sound, simulating reflections and diffusion, creating the sensation of being in a larger space surrounded by speakers.', DynamicLF: "Dynamic Low Frequency", DynamicLFDesc: "Intelligent adjustment of low frequencies, enhancing strength and depth during strong rhythms, making the beats more powerful. Reducing low frequencies to weaken them allows the sound to achieve natural balance, bringing a dynamic and varied low-frequency auditory experience.", SmartVolume: "Intelligent volume", SmartVolumeDesc: "Automatically senses changes in audio volume, intelligently balances to an appropriate level, avoids sudden increases and decreases, and provides a stable listening experience, without the need for frequent manual volume adjustments.", VocalClarity: "Vocal Clarity", VocalClarityDesc: "Precisely optimize the human voice frequency band, reduce noise and background sound interference, and highlight the pure human voice, allowing you to clearly capture articulation and enjoy an excellent auditory experience while listening to music, watching dramas, or on calls.", MusicMode: "Music: High Dyn.", VoiceMode: "Speech: Low Dyn.", NCut: "Noise suppression", Freqtrap: "Band segmentation", Intensity: "Intensity", DYIntensity: "Intensity", QXIntensity: "Intensity", Speech: "Speech Notifications", SpeechDesc: `Voice feedback during speaker operation (you can also enable or disable the voice feedback by pressing the speaker's physical "+" and "G" buttons for {time} seconds simultaneously).`, SpeechDescK20Pro: "Voice prompts during speaker operation (press and hold the speaker’s mic button for {time} s to enable or disable voice prompts)", micDisabled: "Microphone disabled", micDisabledTitle: "Microphone Disabled Detected, Unable to Use Microphone Properly", step: "Solution Steps:", step1: "1. Click the [Windows Sound Devices] button below.", step2: '2. In the pop-up System Sound Control Panel (refer to the diagram below), select "Recording." Find the corresponding device in the list, right-click and enable the microphone, then click OK.', step3: "3. Once enabled, click the [Refresh] icon below." }, eq: { title: "Equalizer", game1: "EQ mode 1", game2: "EQ mode 2", game3: "EQ mode 3", eqSlotDefaultDesc: "Onboard preset slot", popover2: "An equalizer, like a mixing console, can adjust the audio frequency and volume, allowing you to modify the high and low-frequency bands according to your preference. For example, during gaming, you can boost low frequencies to enhance explosions and footsteps and increase high frequencies to make gunshots and collisions clearer, creating a custom sound effect based on your habits, which enhances immersion and competitive advantage", popover: "Equalizer adjusts frequency bands", import: "import", 默认: "default", 音乐清脆风: "Crisp style", 音乐清脆风1: "Crisp style1", 音乐清脆风2: "Crisp style2", "3D影视": "3D Movies", 舞曲: "Dance", 饶舌曲: "Rap", 重金属: "Heavy metal", 爵士: "Jazz", 抒情摇滚: "Soft rock", 摇滚: "Rock", 现场: "Live", 高音: "High pitch", 低音: "Low pitch", bandBass: "Bass", bandLowMid: "Low-mid", bandMid: "Mid", bandHighMid: "Mid-high", bandHigh: "High", 古典乐: "Classical", 声乐: "Vocal", 无畏契约: "valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Custom", more: "More", empty: "No effects selected", renamePlaceholder: "Please enter a custom name", export: "Export", delete: "Delete", saveAs: "Save as custom", reset: "Restore Default", newNameTitle: "Custom", newNamePlaceholder: "Please enter a custom name", duplicate: "The name already exists, please re-enter", ok: "Confirm", importSuccess: "Import successful", importFail: "Import Failed, Please Retry", importFailName: "The import failed due to a duplicate name. Please make modifications", exportSuccess: "Export successful", exportFail: "The export failed, please try again", deleteTitle: "Prompt", delPre: 'Are you sure you want to delete "', delAfter: "? This action cannot be undone. Export to local storage before deleting if needed.", expertListTip: "Pro presets are bound to sound modes. Do not change the sound mode for best audio quality." }, wechatLogin: { privacyPrefix: "By logging in, you agree to the", privacyPolicy: "“Privacy Policy”", privacySuffix: "“User Agreement”", privacyAnd: "and", privacyEnd: "", accountMergeHint: "After binding, login via WeChat/email; data merged.", accountUnbindEmailHint: "After unbinding, data remains in WeChat.", privacyPolicyTitle: "Privacy Policy", userAgreement: "User Agreement", privacyWelcome: "Welcome to the WeChat Authorized Login Service of MCSHOSE! We value your personal information and privacy. This Privacy Policy is intended to explain how Shenzhen MCSHOSE Technology Co., Ltd. (hereinafter referred to as “MCSHOSE”, “we”, or “us”) collects, uses, stores, and protects your personal information when you use our cloud-based service via WeChat login, as well as the rights you are entitled to.", privacyReadNotice: "Please read and fully understand this policy before using the service. By using this service, you are deemed to have read, understood, and agreed to all the contents of this Privacy Policy.", privacySection1Title: "1. Information We Collect", privacySection1Desc: "During your use of the service, we may collect the following information:", privacyWechatInfo: `1.1 WeChat Authorization Information
When you log in via WeChat, we collect basic information such as your WeChat nickname, profile picture, OpenID, and UnionID through the WeChat platform interface, in order to identify your account and provide personalized services.`, privacyCloudData: `1.2 Cloud Usage Data
Configuration files you upload, save, or call upon will be stored on our cloud servers to support cross-device synchronization.`, privacySection2Title: "2. How We Use the Information", privacySection2Desc: "We collect your information only for the following legal, legitimate, and necessary purposes:", privacyServiceFunction: `2.1 To Deliver Service Functions
To provide core services such as WeChat login authorization, cloud storage, and configuration file access.`, privacyServiceSecurity: `2.2 To Ensure Service Security
To perform identity verification, detect anomalies, troubleshoot system issues, and enhance system stability and security.`, privacySection3Title: "3. Storage and Protection of Information", privacyStorageLocation: `3.1 Storage Location and Retention Period
All user data is stored on servers located in mainland China. We retain your information only for the time necessary to fulfill the purposes described above. After that period, your data will be deleted or anonymized.`, privacySecurityMeasures: `3.2 Information Security Measures
We adopt multiple security technologies such as encryption, access control, and log audits to protect your data against unauthorized access, disclosure, alteration, or destruction.`, privacySection4Title: "4. Your Rights", privacyRightsDesc: "In accordance with applicable laws and regulations, you have the following rights:", privacyQueryAccess: `4.1 Inquiry and Access
You have the right to know whether we store your personal information and to access that information.`, privacyCorrectionDelete: `4.2 Correction and Deletion
If you find that the information we hold is inaccurate or invalid, you have the right to request correction or deletion.`, privacyCancelWithdraw: `4.3 Account Cancellation and Withdrawal of Authorization
You may cancel your account or withdraw your authorization via the WeChat platform or by contacting us. Once canceled, we will stop processing your information, unless otherwise required by law.`, privacySection5Title: "5. Updates to the Policy", privacyPolicyUpdate: "We may update this Privacy Policy from time to time in response to changes in business operations or legal requirements. We will notify you of such updates through WeChat mini program announcements or other reasonable means. Continued use of the service constitutes acceptance of the updated policy.", privacySection6Title: "6. Contact Us", privacyContactDesc: "If you have any questions, suggestions, or complaints regarding this Privacy Policy, you can contact us through the following channels:", privacyServiceHotline: "6.1 Customer Service Hotline: 400-816-8986", privacyServiceTime: "6.2 Service Hours: Monday to Friday, 9:00 AM – 7:00 PM", privacyConclusion: "Thank you for trusting and using the WeChat login service of MCHOSE. We will continue to make every effort to safeguard your information and protect your privacy rights.", userAgreementWelcome: "Welcome to MCHOSE WeChat Authorized Login Service! This User Agreement (“Agreement”) is entered into by Shenzhen MCHOSE Technology Co., Ltd. (hereinafter referred to as “we” or “MCHOSE”) and you (hereinafter referred to as “you” or “user”) regarding the rights and obligations related to the WeChat authorized login service provided by MCHOSE (hereinafter referred to as “the Service”).", userAgreementReadNotice: "Please read this Agreement carefully before using the Service, especially the terms concerning disclaimers and limitations of your rights.", userAgreementSection1Title: "1. Requirements for Using the Service", userAgreementSection1Desc: "1.1 You expressly declare and warrant that:", userAgreementLegalCapacity: "· You have the legal capacity to enter into this Agreement and use the Service;", userAgreementMinorNotice: "· If you are a minor, you must use the Service under the guidance and with the consent of a guardian. If you are under the age of 14, you must obtain clear consent or supervision from your legal guardian before use.", userAgreementRequirements: "1.2 To use the Service, you must have a compatible device with network connectivity, install the WeChat application, and complete WeChat authorization login.", userAgreementSection2Title: "2. Account Login and Use", userAgreementLoginProcess: "2.1 The Service relies on the WeChat platform for authorized login. You must complete the WeChat authorization process on first use to create or identify your MCHOSE service account.", userAgreementInfoAccuracy: "2.2 You must ensure that the authorization information is true and accurate, and promptly update the information to ensure normal use of the Service.", userAgreementAccountSecurity: "2.3 You are responsible for safeguarding your WeChat account and related information. Any loss resulting from account loss or information leakage shall be borne by you.", userAgreementSection3Title: "3. Scope of the Service", userAgreementCloudService: "3.1 Cloud Services: Upload, save, synchronize, and manage configuration files in the cloud;", userAgreementConfigCall: "3.2 Configuration Activation: Import user-uploaded configuration files for personalized experiences;", userAgreementOfficialSync: "3.3 Official Configuration Synchronization: Real-time synchronization of the latest official configuration files.", userAgreementServiceAdjustment: "MCHOSE reserves the right to add, remove, or adjust service content as needed without prior notice.", userAgreementSection4Title: "4. User Code of Conduct", userAgreementBehaviorRule1: "4.1 You shall not engage in any illegal, infringing, or system-damaging behavior while using the Service;", userAgreementBehaviorRule2: "4.2 This includes but is not limited to: spreading illegal information, infringing on others' rights, committing fraud, or interfering with platform systems;", userAgreementBehaviorRule3: "4.3 For such violations, MCHOSE has the right to take actions such as warnings, usage restrictions, account bans, or legal proceedings.", userAgreementSection5Title: "5. Intellectual Property", userAgreementIPOwnership: "5.1 All content of the Service, including interface design, code, APIs, graphics, and layouts, belongs to MCHOSE or its licensors;", userAgreementIPRestriction: "5.2 Without authorization, you may not copy, distribute, modify, transfer, or use such content for commercial purposes.", userAgreementSection6Title: "6. Privacy Protection", userAgreementPrivacyNotice1: "6.1 We highly value the protection of your privacy. For details on how we collect, use, store, and protect your personal information, please refer to our Privacy Policy.", userAgreementPrivacyNotice2: "6.2 Please read the policy carefully before using the Service to understand your rights and our obligations.", userAgreementSection7Title: "7. Disclaimers", userAgreementDisclaimer1: "7.1 We will make every effort to maintain service stability and data security, but shall not be liable for service interruptions, data loss, or other issues caused by force majeure or system failures;", userAgreementDisclaimer2: "7.2 Losses caused by the user's own actions shall be borne by the user.", userAgreementSection8Title: "8. Agreement Updates and Changes", userAgreementUpdate1: "8.1 MCHOSE reserves the right to update this Agreement based on legal requirements or business adjustments and will notify users via WeChat announcements or other reasonable methods;", userAgreementUpdate2: "8.2 Your continued use of the Service constitutes acceptance of the updated Agreement.", userAgreementSection9Title: "9. Governing Law and Dispute Resolution", userAgreementLaw1: "9.1 This Agreement shall be governed by the laws of the People's Republic of China;", userAgreementLaw2: "9.2 In case of any dispute, both parties shall attempt to resolve it through negotiation. If negotiation fails, either party may file a lawsuit with a court of competent jurisdiction in Longgang District, Shenzhen.", userAgreementSection10Title: "10. Contact Us", userAgreementContactDesc: "If you have any questions, suggestions, or complaints regarding this Privacy Policy, you may contact us through:", userAgreementServiceHotline: "10.1 Customer Service Hotline: 400-816-8986", userAgreementServiceTime: "10.2 Service Hours: Monday to Friday, 9:00 AM - 7:00 PM", userAgreementConclusion: "Thank you for trusting and using the MCHOSE WeChat Authorized Login Service. We will continue our efforts to protect your information security and privacy rights.", emailPlaceholder: "Enter email", emailFormatError: "Invalid email format", emailSendCode: "Get code", emailResend: "Resend", emailResendCountdown: "Resend ({n}s)", bindEmailGetCode: "Get code", switchToWechatAria: "Tap to use WeChat", switchToEmailAria: "Tap to use email", cornerTooltipWechat: "Tap to use WeChat", cornerTooltipEmail: "Tap to use email", titleEmailLogin: "Email login", titleWechatLogin: "WeChat login", titleBindEmail: "Bind email", testEnvLoginTitle: "Test environment login", testEnvSuffix: " (test)", testCodePlaceholder: "Enter authorization code (code)", btnLogin: "Log in", codeStepBack: "Back", enterVerificationCode: "Enter code", codeEmailCheckTitle: "Check your email", codeEmailSentLine: "Code sent.", codeEmailInboxLine: "Check {email}.", devOpenDevtools: "Open DevTools", devInspectPage: "Inspect page", msgSendCodeFailRetry: "Failed to get code", msgOtpSixDigits: "Please enter the 6-digit code", msgWxConfigInitFail: "WeChat config initialization failed. Check your network.", msgLoginPageLoadFail: "Login page failed to load. Please try again.", msgLoginFailRetry: "Login failed. Please try again.", msgTestEnterAuthCode: "Please enter the authorization code", msgBindFailGeneric: "Binding failed" }, user: { modifyNickname: "Modify Nickname", modifyAvatar: "Modify Avatar", nicknamePlaceholder: "Please enter new nickname", nicknameTip: "Nickname length is limited to 1-10 characters", nicknameEmpty: "Nickname cannot be empty", nicknameLengthError: "Nickname length must be between 1-10 characters", nicknameUpdateSuccess: "Nickname updated successfully", nicknameUpdateFail: "Failed to update nickname", selectImage: "Select Image", avatarEmpty: "Please select an avatar image to upload", avatarUpdateSuccess: "Avatar updated successfully", avatarUpdateFail: "Failed to update avatar" }, mode: { modeDesc: `Different modes can be switched with one click, 
 bringing you an exclusive and ultimate auditory experience`, gameMode: "Game mode", gameMode1: "Game mode 1", gameMode2: "Game mode 2", musicMode: "Music mode", movieMode: "Movie mode", gameModeDesc: "Enhances gunfire and footsteps details, ideal for competitive FPS games", musicModeDesc: "Professionally tuned for detailed sound reproduction, ideal for immersive music scenes", movieModeDesc: "Delivers cinema-grade audio, ideal for immersive movie experiences", gameModeDesc2: "Enhances battlefield ambient sound, ideal for war-themed FPS games" }, light: { switch: "Lighting", switchOn: "Lights On", switchOff: "Lights Off", title: "Lighting effects", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Stars", goFlow: "Waves", continue: "Lasting", duan: "Short", chang: "Long", an: "Dark", guang: "Bright", direction: "Direction", clockwise: "Clockwise", anticlockwise: "counterclockwise", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB Sync active", syncClosed: "RGB Sync disabled on this device. Selected lighting effect applied.", flowing_f: "Flowing Light - Fast", speed: "Speed", fast: "Fast", slow: "Slow", colorjoe: "Palette", reset: "Restore defaults", notView: " This lighting effect does not support a preview", color: "Color", lightShow: "Light display", lightShow1: "All lights on", lightShow2: "Turn off the middle lights", lightShow3: "Turn off the lights on both sides", smartLight: "Smart lighting", smartLightDesc: "When enabled, after 30 minutes of no activity or playback, the screen and ambient lighting will automatically enter low brightness mode", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Speed ​​and brightness", brightness: "Brightness" }, surround: { switch: "Virtual 7.1 Surround", popover: "Simulates 7.1-channel surround sound. Once activated, it allows you to feel the sound coming from multiple directions, immersing you in game scenes or movie plots, accurately locating the direction and distance of sounds, and providing you with a more three-dimensional, immersive auditory experience.", popoverGame: "Virtual 7.1 sound is not suitable for FPS games; recommended for AAA games and media.", mode: "Mode selection", music: "Music/Game Mode", movie: "Movie Mode", test: "Speaker test", start: "Start test", stop: "Stop test", size: "Room size", small: "Small", mid: "Medium", big: "Large" }, otherSettings: { alreadyLatest: "The firmware is already up to date, no update is needed.", v9TurboHeadset: "Please use the 2.4G mode to connect for the update.", latest: "Latest", goUpdate: "Upgrade", baseV: "Base Firmware Version:", usbV: "Device USB Version:", firmwareV: "Device Firmware Version:", headsetV: "Headphone firmware version:", dongleV: "Receiver Firmware Version:", findNew: "Detected latest version：", speakerShutdown: "Device Off", speakerShutdownDesc: "The driver can only turn off, cannot turn on", shutdown: "Turn Off", speakerShutdownConfirm: "Are you sure you want to turn off the device?", speakerShutdownSuccess: "Speaker has been turned off", speakerShutdownDeviceError: "Device not connected, please check the device", speakerShutdownFailed: "Turn off failed", and: ", ", restoreFactory: "Restore factory settings", restoreFactoryDesc: "All settings will be restored to factory defaults, please proceed with caution.", restore: "Restore", restoreSuccess: "Factory reset completed successfully", downloading: "Downloading firmware file…", updating: "The firmware is being upgraded...", updatingNote: "Please do not exit the program or plug and unplug the device during the upgrade process!", inDevelopment: "The feature is under development...", readBinFail: "Failed to read the firmware file", downloadBinFail: "Failed to download firmware file", otaFail: "The firmware upgrade failed", otaFailResult: "The firmware upgrade failed. You can try unplugging and replugging the device and then try again", deviceReconnectFail: "Device reconnection timed out. Please unplug and replug the device and try again", otaSuc: "The firmware upgrade was successful", otaSucDongle: "Firmware upgrade successful. Please wait for {deviceType} to automatically restart for the changes to take effect (approximately 30 seconds).", otaSucHeadset: "Firmware upgrade successful. Please wait for approximately 30 seconds, then manually power on the headphones for the changes to take effect.", otaSucBoth: "Headphone and receiver firmware upgrade successful. Please wait for the device to automatically restart (approximately 30 seconds).", deviceTypeDong: "Receiver", deviceTypeDevice: "Device", confirmFactoryReset: "This operation will clear all settings. Are you sure you want to restore factory settings?", powerManagement: "Power Management", autoShutdown: "Auto Power Off:", autoShutdownDesc: "When the headset is removed from the dock (not charging) and idle with no playback beyond the selected time, it will turn off automatically.", minutes: "Minutes", downloadTips1: "1.Save the firmware package to your desktop.", downloadTips2Exe: "2.Double-click it to start the upgrade automatically.", downloadTips2Zip: "2.After extracting it, double-click the firmware package to start the automatic upgrade.", betterOtaTitle: "New firmware detected. Updating is recommended." }, screenSettings: { screenOTAing: "Updating screen, please wait", screenDisplay: "Screen Display", screenOn: "Screen on", screenOff: "Screen off", screenColor: "Screen Color", presetSettings: "Wallpaper switch settings", personalizedPreset: "Screen wallpaper", customText: "Text", custom: "Custom", digitalClock: "Digital Clock", musicSpectrum: "Music Spectrum", campusDaily: "Campus Life", workplaceLife: "Workplace Life", cutePets: "Cute Pets", electronicGames: "Video Games", cyberTech: "Cyber Technology", networkMeme: "Internet Memes", customImage: "Custom image", customImageOTAWarning: "Please update the firmware before using this feature", addImage: "Add image", uploadImage: "Upload image", reuploadImage: "Re-upload", supportImageFormat: "Supports PNG/JPG/GIF. GIF only first 30 frames", previewImage: "Preview", text: "Text", scenery: "Landscape", character: "Portrait", uploadingToScreen: "Uploading to screen", reverseColor: "Invert colors", scaleScreen: "Scale screen", scaleImage: "Scale image", blackWhiteRatio: "Black/white ratio", deleteImageConfirm: "Delete this image? Cannot be restored", deleteImage: "Delete", batchDeleteImage: "Batch delete", selectAll: "Select all", cancelSelectAll: "Deselect all", processImage: "Process image", exitBatch: "Exit batch", deleteSelectedImageConfirm: "Delete selected images? Cannot be restored", textContent: "Text Content", textLengthLimit: "Character limit reached", save: "Save", savedSuccess: "Saved", historyRecords: "History", clearHistory: "Clear History with One Click", historyTip: "Show Only the Latest 20 Records", textEffect: "Text Effect", staticDisplay: "Static Display", dynamicDisplay: "Dynamic Display", alignment: "Alignment", leftAlign: "Align Left", centerAlign: "Align Center", rightAlign: "Align Right", justifyAlign: "Justify", scrollEffect: "Scrolling Effect", scrollToRight: "Left to Right", scrollToLeft: "Right to Left", customColors: "Custom Color", clearCustomColors: "Clear Custom Colors", syncToLight: "Sync Current Color to Lighting", shortPress: "Short Press", lyrics: "Lyrics", lyricsDisplay: "Lyrics Display（BETA）", lyricsDisplayHintLead: "When playing audio that supports lyrics, the screen shows the current lyrics.", lyricsDisplayCantSeeLink: "Can't see lyrics?", lyricsDisplayCantSeeTooltip: "Only some music apps are currently supported. Update them and refresh M HUB", lyricsOn: "On", lyricsOff: "Off", lyricsAnimation: "Lyrics Animation", notSupportSyncToLight: "Current lighting effect is multicolor, color sync not supported", syncToLightSuccess: "Sync Successful", uploadToScreenTip: "Estimated {time}s, do not exit", deleteCustomColorConfirm: "Delete the current color?", deleteAllCustomColorsConfirm: "Delete all custom colors?", minimumSelectionToast: "Select at least 2", textVerifyFailed: "Pixel display does not support emojis or special characters. Please use plain text", lyricsAnimationOption1: "Entrance: From bottom to top. Exit: From bottom to top", lyricsAnimationOption2: "Entrance: Expand from center. Exit: Collapse to center", lyricsAnimationOption3: "Entrance: From left to right. Exit: From right to left", lyricsAnimationOption4: "Entrance: From bottom to top. Exit: From top to bottom", lyricsAnimationOption5: "Entrance: From top to bottom. Exit: From right to left", lyricsAnimationDemo: "Lyrics animation demo", uploadingImgTip: "Image uploading, please try again later" }, update: { alreadyNew: "The latest version", findNew: "Latest version detected", ignore: "Ignore", update: "Upgrade", showHistory: "View historical versions", updating: "Driver upgrade in progress…", rollingBack: "Returning to historical version {version}", updateContentTitle: "Driver upgrade", updateContent: "Driver update content:", updateNow: "Upgrade immediately", back: "Return", historyTitle: "Historical version", version: "Version number", date: "Update date", backToList: "Return to the previous level", only30: "Retain the last 30 historical versions.", operation: "Operation", watchContent: "View updates", rollTo: "Return to this version", currentVersion: "Current version", updateTo: "Upgrade to this version", updateSuccess: "Driver upgrade completed", revertSuccess: "Returned to historical version {version}", updatePre: "Upgrade in Progress, Please Wait…", updateAfter: "The application will restart automatically shortly. Please wait", inviteUpdate1: "Discover a new version,", inviteUpdate2: "we invite you to", inviteUpdate3: "upgrade immediately.", notAdminRunning: "Administrator privileges are required for the upgrade process. Please exit the application, right-click the app icon, and select “Run as administrator.” After it starts, try upgrading again", updateResultFail: "The update failed, which may cause some functions to be unavailable. Please uninstall it and then go to the Maicong official website to download the latest installation package for installation", updateFailAfter: "There was an anomaly during the creation of the compressed package. Please uninstall it and then go to the Maicong official website to download the latest installation package for installation", updateFailPre: "There was an anomaly during the pre-upgrade processing stage. Please try again later. If it still fails, please uninstall the driver and then go to the Maicong official website to download the latest driver installation package for reinstallation", updateUpFailDefault: "The driver upgrade failed. Please try again later", updateBackFailDefault: "Failed to roll back to the old version. Please try again later", notSupportUpdate: "The current version does not support online upgrade. Please go to the Maicong official website to download the latest version of the installation package for reinstallation", restartFinishUpdate: "Restart driver" }, musicDance: { settingPanel: "Music Rhythm Control Panel", scaleEffect: "Zoom Rhythm", scaleKeyboard: "Zoom Keyboard", showEffect: "Show Rhythm", showKeyboard: "Show Kbd", reset: "Restore defaults", needWinVcTitle: "Windows MSVC runtime library is missing from the system, and some features may be limited", needWinVcDesc: "Please download and install the official Microsoft library vc_redist.x64.exe, and then restart the application：", needWinVcLink1: "Official Microsoft download address:", needWinVcLink2: "Alternative download address:", download: "Click to download", needWinVcNotice: "If this pop-up window still appears after installation, your system may not currently support this feature" } }, mI = { common: { prompt: "Подсказка", refresh: "Обновить", cancel: "Отмена", close: " Закрыть", restore: "Сброс", iKnowIt: "Я понимаю", notAdminRunning: "Для выполнения этой операции требуются права администратора. Пожалуйста, закройте приложение, щёлкните правой кнопкой мыши по значку и выберите «Запуск от имени администратора», затем перезапустите и повторите попытку.", clickLogin: "Войти", cloudEqTip: "После входа будут доступны облачные функции (разрабатываются дополнительные возможности обмена настройками, ожидайте).", editNickname: "Изменить имя", changeAvatar: "Изменить аватар", avatarTip: "Поддерживаются форматы JPG и PNG, размер файла не должен превышать 2 МБ", logout: "Выйти", autoWechatLogin: "После установки галочки произойдет автоматический вход через WeChat", privacyPrefix: "Вход означает согласие с", userAgreement: "Пользовательским соглашением", loginSuccess: "Вход выполнен", emailLoginSuccess: "Вход выполнен", bindWechatAction: "Привязать WeChat", bindWechatSuccess: "WeChat привязан", bindWechatFailed: "Не удалось привязать WeChat", wechatAlreadyBoundOtherEmail: "WeChat уже привязан к другой почте", emailAlreadyBoundOtherWechat: "Почта уже привязана к другому WeChat", unbindEmail: "Отвязать почту", unbindEmailGetCode: "Получить код", unbindEmailSuccess: "Отвязка успешна", unbindEmailCodeInvalid: "Неверный код", accountBindWechat: "Привязать WeChat", accountBindEmail: "Привязать почту", accountUnbindEmail: "Отвязать почту", bindEmailSuccess: "Привязка успешна", logoutSuccess: "Выход выполнен", changesSubmitted: "Изменения отправлены, ожидайте проверки", nicknameEmpty: "Имя не может быть пустым", enterNickname: "Введите имя", confirm: "ОК", official: "Официальные", game: "Игры", music: "Музыка", cloud: "Облачное сообщество", cloudShared: "Общий доступ", favorited: "Избранное", myShares: "Контент", search: "Поиск", latest: "Новое", topUsed: "Часто", topLiked: "Топ", topFav: "Избранное", author: "Автор", import: "Импорт", imported: "Импортировано", favoritedStatus: "В избранном", removedFromFavorites: "Удалено из избранного", liked: "Отметили как понравившееся", unliked: 'Сняли отметку "нравится"', importedToCustom: "Импортировано в «Мое»", importFailed: "Не удалось импортировать — максимум 20", pleaseLogin: "Пожалуйста, войдите в систему", maxFavorites: "Максимум 20 в избранном", noUserUploads: "Еще никто не загрузил", noSearchResults: "Ничего не найдено, попробуйте другой запрос~", noFavorites: "Нет избранного", noSharesYet: "Вы еще ничего не опубликовали", cancelSharing: "Отменить доступ", notice: "Подсказка", confirmCancelShare: "Отменить общий доступ к <strong>«{name}»</strong>?", delete: "Удал", custom: "Моё", myPresets: "Создано мной", localImport: "Импорт", cloudImports: "Импорт из облака", confirmDelete: "? После удаления восстановление будет невозможно. Рекомендуем сначала экспортировать", confirmDeleteReview: '"Удалить <strong>«{name}»</strong>? Этот EQ находится на модерации и может по-прежнему отображаться в облаке после одобрения."', confirmDeleteSimple: "Удалить <strong>«{name}»</strong>?", fromAuthor: "От автора:", shareToCloud: "Поделиться", shareSuccess: "Успешно поделено", sharingCanceled: "Общий доступ отменён", maxSharesPerUser: "До 10 публикаций на пользователя", selectCategory: "Выбрать категорию", other: "Другое", selectGameTag: "Пожалуйста, выберите тег игры", enterPresetTitle: "Введите название настройки", shareTitlePlaceholder: "Придумайте яркое название для вашего эквалайзера", maxSharesPerUserSimple: "Максимум 10 публикаций", shareSuccessful: "Успешно опубликовано", confirmShareOverwrite: "Этот эквалайзер уже опубликован. Повторная публикация перезапишет старую версию. Продолжить?", share: "Шер", restoreDefault: "Сброс", restoreDefaultSuccess: "Установлены стандартные настройки.", underReview: "На проверке", export: "Эксп", underReviewTryLater: "На проверке, попробуйте позже", underReviewDeleteWarning: "Удаление прервет текущую проверку", shareFailTitle: "Ошибка публикации: некорректный заголовок", shared: "Опубл.", exitPreview: "Выйти из просмотра", nicknameViolation: "Недопустимо", nicknameViolationTip: "Недопустимый никнейм. Пожалуйста, измените его", rename: "Переименовать", copy: "Коп", copied: "Скопировано", noCloudImport: "Нет EQ в облаке", unknown: "Неизвестно", noDescription: "Нет описания", shareRequestSubmitted: "Запрос на общий доступ отправлен", copySuffix: "copy", view: "Посмотреть", sysChanged: "EQ не сохранён. Нажмите <strong>[Сохранить как пользовательский]</strong>.", cmdENOENT: "В системе отсутствует cmd.exe. Пожалуйста, восстановите систему и попробуйте снова.", batchOperation: "Массовые действия", selectAll: "Выбрать все", exitBatch: "Выйти из массового режима", confirmBatchDeleteAll: 'Вы уверены, что хотите удалить <strong class="delete_name">все</strong> EQ?', confirmBatchDeleteSelected: "Удалить выбранные конфигурации?", using: "In Use", clickToUse: "Use Now", expert: "Профи настройки", applySuccess: "Выбранный EQ активирован", noData: "Нет данных" }, tray: { open: "Открыть M HUB", quit: "Выйти" }, commonHeader: { officialStore: "Официальный магазин", myDevice: "Моё устройство", back: "Вернуться", backHome: "Вернуться на главную", popoverTheme: "Очистить", popoverSetting: "Установить", popoverRelatedApp: "Связать игру/приложение и автоматически переключать профиль", popoverMin: "Свернуть", popoverUnmax: "Восстановить", popoverMax: "Развернуть", popoverClose: " Закрыть", offline: "Текущий сервер не подключен к сети. Пожалуйста, перезапустите драйвер позже и попробуйте снова", performanceOnDesc: "После отключения режима производительности будут включены эффекты прозрачного фона, матового стекла и закругления углов рамки. Это сделает внешний вид более привлекательным, но потребует определенных мощностей компьютера.", performanceOffDesc: "После включения производительности будут отключены эффекты прозрачного фона, матового стекла и закругленных углов рамки. Это обеспечит более плавную работу. Если возникают задержки при использовании приложений, рекомендуется включить этот режим.", feedback: "Обратная связь", prizeQuiz: "Платный опрос" }, themeSetting: { pageName: "Тема", white: "Светлая", black: "Темная", followSys: "Системная", bg: "Фон", followTheme: "Соответствует теме", customizeText: "Пользовательский фон (только для главной страницы)", changeBg: "Изменить фон", defaultBg: " Фон по умолчанию ", uploadImg: "Загрузить изображение", blurCard: "Размытие карточки устройства", blurBg: "Размытие фонового изображения" }, setting: { version: "Текущая версия", startup: "Запуск", startAuto: "Автоматический запуск", startAutoMini: "Сворачивать в системный трей при запуске", language: "Язык", closePanel: "При закрытии панели", exit: "выйти из программы", minimize: "свернуть в трей, не выходить из программы", copyright: "" }, menus: { AudioConfiguration: "Конфигурация звука", LightingSettings: "Настройки oсвещения", ScreenSettings: "Отображение экрана", OtherSettings: "Другие настройки", GeneralParameters: "Стандарт", Equalizer: "Эквалайзер", SoundMode: "Режим звука", VirtualSurround: "7.1 - виртуальный звук", CommonParams: "Основные параметры", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "Обнаружено, что настройки экрана могут повлиять на отображение на десктопе. Измените масштаб и макет для наилучшего отображения.", gotoSet: "Редактировать", needAdminNotice: "Некоторые функции могут быть недоступны из-за недостаточных прав. Пожалуйста, закройте приложение, щёлкните правой кнопкой мыши по значку и выберите «Запуск от имени администратора», чтобы перезапустить приложение", loadFail: "Загрузка не удалась", loadFailDesc: "Нажмите кнопку обновления, чтобы перезагрузить, или проверьте сетевое подключение и перезапустите драйвер." }, devicePage: { needOtaNotice: "Обнаружена новая версия прошивки. Чтобы нормально использовать драйвер, необходимо выполнить обновление. Пожалуйста, скачайте и обновите прошивку.", needOtaNoticeTip: "Совет: После загрузки перейдите в папку сохранения, откройте набор инструментов и следуйте инструкции для обновления.", downloadNow: "Скачать сейчас", restartNotice: "   После установки драйвера вам необходимо перезагрузить компьютер, чтобы использовать драйвер должным образом. Если драйвер не работает после перезапуска, обратитесь в службу поддержки клиентов за помощью.", restartNow: "Перезагрузить сейчас", speakerDisabled: "Динамик отключен, невозможно открыть драйвер", step: "Шаги решения:", step1: "1. Нажмите кнопку [Звуковые устройства Windows] ниже.", step2: "2. Во всплывающей панели управления звуком системы (см. схему ниже) выберите «Воспроизведение». Найдите соответствующее устройство в списке, щелкните правой кнопкой мыши и включите динамик, затем нажмите кнопку ОК.", step3: "3. После включения нажмите кнопку [Обновить] ниже.", isSleep: `Если в спящий режим — перезагрузить или проверить 2.4G-соединение (переподключить приемник).
Примечание: с подключенным аудиокабельом или в Bluetooth-меcca не использовать драйвер.`, deviceLostLink: "Подключение драйвера разорвано", headphoneSleepStatus: "Наушники в спящем режиме", headphoneSleepStatusTips: "Нажмите кнопку или перезапустите наушники", needLinkWireless: "Драйвер поддерживает только 2.4G подключение", needLinkWirelessHeadphoneTips: "Проверьте, подключён ли приёмник, и не используйте аудиокабель или Bluetooth", wiredMode: "Кабельный", lessThan: "Меньше {val}", charging: "Зарядка", sufficientCharge: "достаточный", wiredVersion: "кабель", notAdminRunningHeadset: "Для работы с аудиоустройствами требуются права администратора. Пожалуйста, закройте приложение, щёлкните правой кнопкой мыши по значку и выберите «Запуск от имени администратора», чтобы перезапустить приложение", thxInstallDialogTitle: "Установка аудиокомпонентов", thxInstallDialogTitleUpgrade: "Обновление аудиокомпонентов", thxInstallDialogDesc1: "Займёт 1–2 минуты, пожалуйста, подождите", thxInstallDialogDesc2: "Не закрывайте драйвер во время установки. После завершения откроется страница устройства" }, routine: { UserManual: "инструкция", beepTitle: "Голосовой сигнал", beepTitleDesc: "Регулировка громкости голосовых подсказок гарнитуры (не влияет на мультимедиа)", UserManualFull: "Инструкция по использованию", Volume: "Громкость", Microphone: "Микрофон", MicAI: "Включить AI-шумоподавление", MicAIDesc: "Фильтрует шумы и сохраняет чистый звук, улучшая качество записи.", MicNoiseReduction: "Подавления постоянного шума", MicNoiseReductionDesc: "Ослабляет компоненты постоянного шума в определенных частотных диапазонах, нацеливаясь и уменьшая силу сигнала звуков, таких как кондиционеры или вентиляторы.", MicListen: "Мониторинг микрофона", MicListenDesc: "Позволяет слышать себя в реальном времени для удобной настройки громкости и повышения качества связи.", MoYin: "Магические звуки:", MoYin_0: "Монстр", MoYin_1: "Мультфильм", MoYin_2: "Мужской голос", MoYin_3: "Женский голос", WindowsAudioDevices: "Звуковое устройство Windows", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Изменено, автосохранено", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Восстановить заводской EQ", eqEditorResetFactoryConfirm: "[{mode}] перезапишет текущие настройки эквалайзера и восстановит заводские значения.", eqEditorResetFactoryDone: "Режим {n} восстановлен к заводским настройкам эквалайзера по умолчанию.", eqSwitchUnsavedHint: "Вы изменили эквалайзер текущего режима. Прямое применение другого EQ перезапишет правки.", eqSwitchApplyDirect: "Применить сразу", eqSwitchSaveThenApply: "Сохранить, затем применить", AudioBright: "Яснение аудио", AudioBrightDesc: "Увеличивайте высокие частоты звука, чтобы сделать его более чётким и насыщенным деталями. Это эффективно повысит общую яркость и выразительность звучания.", SurroundAmplification: "Улучш. объем. звук ", SurroundAmplificationDesc: "Усиливает эффект пространственного звука, расширяя «территорию» звука, имитируя отражения и диффузию, создавая ощущение нахождения в большем пространстве, окруженном динамиками.", DynamicLF: "Динамический LF", DynamicLFDesc: " Интеллектуальная настройка низких частот позволяет усилить их звучание во время мощных ритмов, делая удары более ощутимыми. В то же время, снижение низких частот для их ослабления создает естественный баланс звука, создавая ощущение динамичного и разнообразного баса.", SmartVolume: "Умная громкость", SmartVolumeDesc: "Автоматически распознает изменения уровня громкости звука и регулирует его до необходимого значения. Это позволяет избежать резких скачков громкости и обеспечивает стабильное качество звучания, избавляя от необходимости часто корректировать громкость вручную.", VocalClarity: "Четкость голоса", VocalClarityDesc: "Тщательно настройте частотный диапазон человеческого голоса, чтобы уменьшить шум и фоновые помехи. Это позволит вам чётко слышать речь и наслаждаться качественным звуком во время прослушивания музыки, просмотра драматических фильмов или телефонных разговоров.", MusicMode: "Музыка (ВД)", VoiceMode: "Голос (НД)", NCut: `Шумоподавле
ние`, Freqtrap: "Отрезание ФД", Intensity: "Интенсивность", DYIntensity: "Интенсивность", QXIntensity: "Интенсивность", Speech: "Речевые уведомления", SpeechDesc: "Голосовая обратная связь во время работы динамика (вы также можете включить или отключить голосовую обратную связь, нажав физические кнопки «+» и «G» динамика в течение {time} секунд одновременно).", SpeechDescK20Pro: "Голосовые подсказки при работе динамика (нажмите и удерживайте кнопку микрофона на динамике {time} секунды, чтобы включить или выключить подсказки)", micDisabled: "Микрофон отключен", micDisabledTitle: "Микрофон отключен, невозможно использовать микрофон", step: "Шаги решения:", step1: "1. Нажмите кнопку [Звуковые устройства Windows] ниже.", step2: "2. Во всплывающей панели управления звуком системы (см. схему ниже) выберите «Запись». Найдите соответствующее устройство в списке, щелкните правой кнопкой мыши и включите микрофон, затем нажмите «ОК».", step3: "3. После включения нажмите на значок [Обновить] ниже." }, eq: { title: "Эквалайзер", game1: "Режим EQ 1", game2: "Режим EQ 2", game3: "Режим EQ 3", eqSlotDefaultDesc: "Слот встроенного пресета", popover2: "Эквалайзер, как микшерный пульт, регулирует частоту и громкость звука. Можно настраивать диапазоны высоких и низких частот по вкусу. Во время игры, усиление низких частот делает звуки взрывов и шагов мощнее, повышение высоких - выстрелы и столкновения - четче. Это создает уникальный звуковой эффект, повышает погружение в игру и дает конкурентное преимущество.", popover: "Эквалайзер позволяет настраивать громкость различных частот для персонализации звучания.", import: "Импорт", 默认: "По умолчанию", 音乐清脆风: "Чистый стиль", 音乐清脆风1: "Чистый стиль1", 音乐清脆风2: "Чистый стиль2", "3D影视": "3D Фильмы", 舞曲: "танц. музыка", 饶舌曲: "рэп", 重金属: "хэви-метал", 爵士: "джаз", 抒情摇滚: "софт-рок", 摇滚: "рок", 现场: "концертная", 高音: "выс. тона", 低音: "низ. тона", bandBass: "Низкие", bandLowMid: "Низко-средние", bandMid: "Средние", bandHighMid: "Высоко-средние", bandHigh: "Высокие", 古典乐: "класс. музыка", 声乐: "вокал", 无畏契约: "Valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Cамонастройка", more: "Еще", empty: "Эффекты не выбраны", renamePlaceholder: "Пожалуйста, введите пользовательское имя", export: "Экспорт", delete: "Удалить", saveAs: "Сохранить как пользовательский", reset: "Сброс", newNameTitle: "Cамонастройка", newNamePlaceholder: "Пожалуйста, введите пользовательское имя", duplicate: "Это имя уже есть, введите повторно.", ok: "OK", importSuccess: "Импорт выполнен успешно", importFail: "Импорт не удался, повторите попытку", importFailName: "Импорт не удался из-за повторяющегося имени. Пожалуйста, внесите изменения", exportSuccess: "Экспорт выполнен успешно", exportFail: "Не удалось выполнить экспорт. Пожалуйста, попробуйте ещё раз", deleteTitle: "Подсказка", delPre: "Вы действительно хотите удалить «", delAfter: "? После удаления восстановление будет невозможно. Рекомендуем сначала экспортировать", expertListTip: "Профессиональные пресеты привязаны к звуковым режимам. Для лучшего звучания не рекомендуется менять режим." }, mode: { modeDesc: `Разные режимы можно переключить одним нажатием,
что даст вам эксклюзивный и превосходный аудитивный опыт`, gameMode: "игровой режим", gameMode1: "игровой режим 1", gameMode2: "игровой режим 2", musicMode: "музыкальный режим", movieMode: "режим просмотра фильмов", gameModeDesc: "Подчеркивает детали выстрелов и шагов, подходит для соревновательных FPS-игр", musicModeDesc: "Профессиональная настройка для точной передачи звука, подходит для музыкальных сцен", movieModeDesc: "Создает кинематографическое звучание, подходит для погружения в фильмы", gameModeDesc2: "Подчеркивает звуки боевого окружения, подходит для военных FPS-игр" }, light: { switch: "Подсветка", switchOn: "Подсветка вкл", switchOff: "Подсветка выкл", title: "Световые эффекты", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Звездный поток", goFlow: "Waves", continue: "Продл", duan: "Короткий", chang: "Длинный", an: "Темный", guang: "Яркий", direction: "Hапр", clockwise: "по час", anticlockwise: "против час", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB Sync: Вкл", syncClosed: "Синхронизация RGB на устройстве отключена, выбранный эффект применён", flowing_f: "Flowing Light - Fast", speed: "Скорость", fast: "быстрая", slow: "медленная", colorjoe: "Палитра", reset: "Сброс", notView: "Этот световой эффект не доступен для предварительного просмотра", color: "Цвет", lightShow: "Показание света", lightShow1: "Все светильники включены", lightShow2: "Выключить средние светильники", lightShow3: "Выключить свет с двух сторон", smartLight: "Умная подсветка", smartLightDesc: "После включения при отсутствии действий и воспроизведения 30 минут экран и подсветка перейдут в режим низкой яркости", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Скорость и яркость", brightness: "яркость" }, surround: { switch: "7.1 - виртуальный звук", popover: "Имитация 7.1-канального объемного звука. После активации вы сможете почувствовать, как звук исходит из разных направлений, погружая вас в игровые сцены или фильмы. Он точно определяет направление и расстояние до источников звука, создавая более объемное восприятие и эффект полного погружения.", popoverGame: "Виртуальный 7.1 звук не подходит для FPS-игр; рекомендуется для AAA-игр и мультимедиа.", mode: "Выбор режима", music: "музыкальный / игровой режим", movie: "режим просмотра фильмов", test: "Проверка динамика", start: "запуск теста", stop: "остановка теста", size: "Размер комн.", small: "маленькая", mid: "средняя", big: "большая" }, otherSettings: { alreadyLatest: "Последняя версия уже установлена, обновлений не требуется.", v9TurboHeadset: "Пожалуйста, используйте 2.4G-режим для подключения к обновлению.", latest: "Последняя", goUpdate: "Обновлять", baseV: "Версия прошивки базы:", usbV: "Версия USB устройства:", firmwareV: "Версия прошивки устройства:", headsetV: "Версия прошивки наушников:", dongleV: "Версия прошивки приемника:", findNew: "Обнаружена последняя версия:", speakerShutdown: "Устройство выключить", speakerShutdownDesc: "Драйвер может только выключать, включить нельзя", shutdown: "Выключить", speakerShutdownConfirm: "Вы уверены, что хотите выключить устройство?", speakerShutdownSuccess: "Колонка выключена", speakerShutdownDeviceError: "Устройство не подключено, пожалуйста, проверьте устройство", speakerShutdownFailed: "Выключение колонки не удалось", and: ", ", restoreFactory: "Восстановление заводских настроек", restoreFactoryDesc: "Все настройки - в заводские. Будьте осторожны с операцией.", restore: `Фабричный
сброс`, restoreSuccess: "Сброс к заводским настройкам выполнен успешно", downloading: "Загрузка файла прошивки…", updating: "Обновление прошивки в процессе...", updatingNote: "Пожалуйста, не выходите из программы и не вынимайте или не вставляйте устройство во время процесса обновления!", inDevelopment: "Функция в процессе разработки...", readBinFail: "Не удалось прочитать файл прошивки", downloadBinFail: "Не удалось загрузить файл прошивки", otaFail: "Обновление прошивки не удалось", otaFailResult: "Обновление прошивки не удалось. Попробуйте извлечь и вставить устройство, а затем повторить попытку", otaSuc: "Обновление прошивки выполнено успешно", otaSucDongle: "Обновление прошивки прошло успешно. Пожалуйста, подождите, пока {deviceType} автоматически перезагрузится, чтобы изменения вступили в силу (примерно 30 секунд).", otaSucHeadset: "Обновление прошивки прошло успешно. Пожалуйста, подождите примерно 30 секунд, а затем вручную включите наушники, чтобы изменения вступили в силу.", otaSucBoth: "Обновление прошивки наушников и приемника прошло успешно. Дождитесь автоматической перезагрузки устройства (примерно 30 секунд).", deviceTypeDong: "приемника", deviceTypeDevice: "устройства", confirmFactoryReset: "Эта операция приведет к сбросу всех настроек. Вы уверены, что хотите восстановить заводские настройки?", powerManagement: "Управление питанием", autoShutdown: "Автоотключение:", autoShutdownDesc: "Если наушники извлечены из док-станции (не заряжаются) и нет воспроизведения дольше выбранного времени, они автоматически выключатся.", minutes: "Минуты", downloadTips1: "1.Рекомендуется сохранить файл прошивки на рабочий стол.", downloadTips2Exe: "2.Дважды щёлкните файл, чтобы начать автоматическое обновление.", downloadTips2Zip: "2.После распаковки дважды щёлкните файл прошивки, чтобы начать автоматическое обновление.", betterOtaTitle: "Обнаружена новая прошивка. Рекомендуется обновить." }, screenSettings: { screenOTAing: "Обновление экрана, подождите", screenDisplay: "Отображение экрана", screenOn: "Экран включён", screenOff: "Экран выключен", screenColor: "Цвет экрана", presetSettings: "Настройки смены обоев", personalizedPreset: "Обои экрана", customText: "Текст", custom: "Пользовательский", digitalClock: "Цифровые часы", musicSpectrum: "Музыкальный спектр", campusDaily: "Студенческая жизнь", workplaceLife: "Рабочая жизнь", cutePets: "Милые питомцы", electronicGames: "Видеоигры", cyberTech: "Кибертехнологии", networkMeme: "Интернет-мемы", customImage: "Пользовательское изображение", customImageOTAWarning: "Сначала обновите прошивку, затем используйте эту функцию", addImage: "Добавить изображение", uploadImage: "Загрузить изображение", reuploadImage: "Повторная загрузка", supportImageFormat: "Поддержка PNG/JPG/GIF. GIF — только первые 30 кадров", previewImage: "Предпросмотр", text: "Текст", scenery: "Пейзаж", character: "Персонаж", uploadingToScreen: "Загрузка на экран", reverseColor: "Инверсия цветов", scaleScreen: "Масштаб экрана", scaleImage: "Масштаб изображения", blackWhiteRatio: "Ч/Б баланс", deleteImageConfirm: "Удалить это изображение? После удаления восстановление невозможно", deleteImage: "Удалить", batchDeleteImage: "Массовое удаление", selectAll: "Выбрать всё", cancelSelectAll: "Снять выбор", processImage: "Обработка изображения", exitBatch: "Выйти из режима", deleteSelectedImageConfirm: "Удалить выбранные изображения? После удаления восстановление невозможно", textContent: "Текстовое содержимое", textLengthLimit: "Достигнут лимит символов", save: "Сохранить", savedSuccess: "Сохранено", historyRecords: "История", clearHistory: "Очистить историю за один клик", historyTip: "Показывать только последние 20 записей", textEffect: "Эффект текста", staticDisplay: "Статичное", dynamicDisplay: "Динамичное", alignment: "Выравнивание", leftAlign: "По левому краю", centerAlign: "По центру", rightAlign: "По правому краю", justifyAlign: "По ширине", scrollEffect: "Эффект прокрутки", scrollToRight: "Слева направо", scrollToLeft: "Справа налево", customColors: "Свои цвета", clearCustomColors: "Очистить цвета", syncToLight: "Синхронить цвет с подсветкой", shortPress: "Короткое нажатие", lyrics: "Текст песни", lyricsDisplay: "Отображение текста песни（BETA）", lyricsDisplayHintLead: "При воспроизведении аудио с поддержкой текста песни на экран выводится текущий текст.", lyricsDisplayCantSeeLink: "Не видно текст?", lyricsDisplayCantSeeTooltip: "Пока поддерживаются только некоторые музыкальные приложения. Обновите их и обновите M HUB", lyricsOn: "Вкл.", lyricsOff: "Выкл.", lyricsAnimation: "Анимация текста песни", notSupportSyncToLight: "Текущий эффект подсветки — многоцветный, синхронизация цвета не поддерживается", syncToLightSuccess: "Синхронизация успешна", uploadToScreenTip: "Около {time} секунд, не выходите", deleteCustomColorConfirm: "Вы уверены, что хотите удалить текущий цвет?", deleteAllCustomColorsConfirm: "Вы уверены, что хотите удалить все пользовательские цвета?", minimumSelectionToast: "Выберите не менее 2", textVerifyFailed: "Пиксельный экран не поддерживает эмодзи и спецсимволы. Используйте только текст", lyricsAnimationOption1: "Вход: снизу вверх. Выход: снизу вверх", lyricsAnimationOption2: "Вход: разворачивание из центра. Выход: сжатие к центру", lyricsAnimationOption3: "Вход: слева направо. Выход: справа налево", lyricsAnimationOption4: "Вход: снизу вверх. Выход: сверху вниз", lyricsAnimationOption5: "Вход: сверху вниз. Выход: справа налево", lyricsAnimationDemo: "Демо анимации текста", uploadingImgTip: "Есть загружаемое изображение, попробуйте позже" }, update: { alreadyNew: "Самая последняя версия", findNew: "Найдена последняя версия", ignore: "Игнорировать", update: "обновить", showHistory: "Просмотр предыдущих версий", updating: "Выполняется обновление драйвера…", rollingBack: "Возвращаемся к предыдущей версии {version}...", updateContentTitle: "Обновление драйвера", updateContent: "Содержание обновления драйвера:", updateNow: "Обновить сейчас", back: "Вернуться", historyTitle: "Прошлая версия", version: "Номер версии", date: "Дата обновления", backToList: "Вернитесь на предыдущий уровень", only30: "Сохраните последние 30 предыдущих версий", operation: "Действие", watchContent: "просмотреть обновление", rollTo: "Вернуться к этой версии", currentVersion: "Текущая версия", updateTo: "Обновитесь до этой версии", updateSuccess: "Обновление драйвера выполнено", revertSuccess: "Возвращен к предыдущей версии {version}", updatePre: "Выполняется обновление, пожалуйста, подождите...", updateAfter: "Приложение скоро автоматически перезапустится. Пожалуйста, подождите", inviteUpdate1: "Есть новое обновление, ", inviteUpdate2: "рекомендуем обновить", inviteUpdate3: "устройство", notAdminRunning: "Для обновления требуются права администратора. Пожалуйста, закройте приложение, щёлкните правой кнопкой мыши по его значку и выберите «Запуск от имени администратора». После запуска повторите попытку обновления", updateResultFail: "Обновление не удалось, что может привести к недоступности некоторых функций. Пожалуйста, удалите его и затем перейдите на официальный сайт Maicong для загрузки последнего пакета установки и его установки", updateFailAfter: "Во время создания сжатого пакета произошло аномалия. Пожалуйста, удалите его и затем перейдите на официальный сайт Maicong для загрузки последнего пакета установки и его установки", updateFailPre: "Во время предварительной обработки обновления произошло аномалия. Пожалуйста, попробуйте позже. Если это по-прежнему не работает, удалите драйвер и затем перейдите на официальный сайт Maicong для загрузки последнего пакета установки драйвера и его повторной установки", updateUpFailDefault: "Обновление драйвера не удалось. Пожалуйста, попробуйте позже", updateBackFailDefault: "Не удалось вернуться к более ранней версии. Пожалуйста, попробуйте позже", notSupportUpdate: "Текущая версия не поддерживает онлайн-обновление. Пожалуйста, перейдите на официальный сайт Maicong для загрузки последней версии пакета установки и его повторной установки", restartFinishUpdate: "Перезапуск" }, musicDance: { settingPanel: "Панель управления муз.ритмом", scaleEffect: "Масштабирование ритма", scaleKeyboard: "Масштабирование клавиатуры", showEffect: "Показ ритма", showKeyboard: "Показ клав.", reset: "Сброс", needWinVcTitle: "В системе отсутствует библиотека выполнения Windows MSVC, поэтому некоторые функции могут быть ограничены", needWinVcDesc: "Скачайте и установите официальную библиотеку Microsoft vc_redist.x64.exe, а затем перезапустите приложение：", needWinVcLink1: "Официальный адрес скачивания от Microsoft:", needWinVcLink2: "Запасной адрес скачивания:", download: "Нажмите для скачивания", needWinVcNotice: "Если это сообщение продолжает появляться после установки, возможно, ваша система пока не поддерживает данную функцию" }, wechatLogin: { privacyPrefix: "Вход означает согласие с", privacyPolicy: "«Политикой конфиденц.»", privacySuffix: "«Польз. соглашением»", privacyAnd: "и", privacyEnd: "", accountMergeHint: "После привязки вход через WeChat/почту, данные объединяются", accountUnbindEmailHint: "После отвязки данные сохраняются в WeChat, вход через WeChat", privacyPolicyTitle: "Политика конфиденциальности", userAgreement: "Пользовательское соглашение", privacyWelcome: "Добро пожаловать в сервис авторизации через WeChat от MCHOSE! Настоящее Пользовательское соглашение (далее – «Соглашение») заключается между Shenzhen MCHOSE Technology Co., Ltd. (далее – «мы» или «MCHOSE») и вами (далее – «вы» или «Пользователь») и регулирует права и обязанности в отношении предоставляемого MCHOSE сервиса авторизации через WeChat (далее – «Сервис»).", privacyReadNotice: "Перед использованием сервиса внимательно ознакомьтесь с данной политикой. Если вы начинаете пользоваться сервисом, это означает, что вы прочитали, поняли и согласны со всеми условиями настоящей Политики конфиденциальности.", privacySection1Title: "1. Информация, которую мы собираем", privacySection1Desc: "Во время использования вами нашего сервиса мы можем собирать следующую информацию:", privacyWechatInfo: `1.1 Информация авторизации WeChat
При входе через WeChat мы получаем такие основные данные, как ваш никнейм, аватар, OpenID, UnionID, через интерфейс платформы WeChat. Эти данные используются для идентификации аккаунта и предоставления персонализированного сервиса.`, privacyCloudData: `1.2 Данные использования облака
Загружаемые, сохраняемые или вызываемые вами конфигурационные файлы сохраняются на наших облачных серверах для поддержки синхронизации между устройствами.`, privacySection2Title: "2. Как мы используем информацию", privacySection2Desc: "Мы используем собранную информацию исключительно в рамках законных, обоснованных и необходимых целей:", privacyServiceFunction: `2.1 Обеспечение работы сервиса
Предоставление основных функций: авторизация через WeChat, облачное хранение и загрузка конфигураций.`, privacyServiceSecurity: `2.2 Обеспечение безопасности сервиса
Используется для проверки личности, обнаружения аномалий, устранения неисправностей и повышения стабильности и безопасности системы.`, privacySection3Title: "3. Хранение и защита информации", privacyStorageLocation: `3.1 Местоположение хранения и срок
Вся информация хранится на серверах, расположенных на территории материкового Китая. Мы храним данные только в течение времени, необходимого для достижения указанных целей, после чего информация удаляется или обезличивается.`, privacySecurityMeasures: `3.2 Меры по обеспечению безопасности
Мы применяем многоуровневое шифрование, контроль доступа, аудит журналов и другие технические меры для защиты ваших данных от несанкционированного доступа, утечки, подделки или уничтожения.`, privacySection4Title: "4. Ваши права", privacyRightsDesc: "В соответствии с действующим законодательством вы обладаете следующими правами:", privacyQueryAccess: `4.1 Доступ и ознакомление
Вы имеете право узнать, храним ли мы ваши персональные данные, и получить к ним доступ.`, privacyCorrectionDelete: `4.2 Корректировка и удаление
Если вы обнаружите, что информация является неточной или недействительной, вы можете запросить ее исправление или удаление.`, privacyCancelWithdraw: `4.3 Удаление аккаунта и отзыв согласия
Вы можете удалить аккаунт или отозвать согласие через платформу WeChat или связавшись с нами. После этого мы прекратим обработку вашей информации, за исключением случаев, предусмотренных законодательством.`, privacySection5Title: "5. Обновления политики", privacyPolicyUpdate: "Мы можем вносить изменения в данную Политику конфиденциальности в соответствии с развитием нашего бизнеса или изменениями законодательства. Обновления будут сообщаться через уведомления в мини-программе WeChat или иным разумным способом. Продолжение использования сервиса означает согласие с обновленной политикой.", privacySection6Title: "6. Контакты", privacyContactDesc: "Если у вас есть вопросы, предложения или жалобы по поводу данной политики, свяжитесь с нами следующим образом:", privacyServiceHotline: "6.1 Горячая линия службы поддержки: 400-816-8986", privacyServiceTime: "6.2 Время работы: с понедельника по пятницу, с 9:00 до 19:00", privacyConclusion: "Спасибо за доверие и использование сервиса авторизации через WeChat от MCHOSE. Мы будем продолжать прилагать усилия для защиты вашей информации и обеспечения вашей конфиденциальности.", userAgreementWelcome: "Добро пожаловать в сервис авторизации через WeChat от MCHOSE! Настоящее Пользовательское соглашение (далее – «Соглашение») заключается между Shenzhen MCHOSE Technology Co., Ltd. (далее – «мы» или «MCHOSE») и вами (далее – «вы» или «Пользователь») и регулирует права и обязанности в отношении предоставляемого MCHOSE сервиса авторизации через WeChat (далее – «Сервис»).", userAgreementReadNotice: "Перед использованием сервиса обязательно внимательно прочитайте и полностью поймите содержание настоящего Соглашения, особенно разделы, касающиеся отказа от ответственности и ограничения ваших прав.", userAgreementSection1Title: "1. Требования к использованию Сервиса", userAgreementSection1Desc: "1.1 Вы явно заявляете и гарантируете:", userAgreementLegalCapacity: "· Имеете юридическую правоспособность для заключения настоящего Соглашения и использования Сервиса;", userAgreementMinorNotice: "· Если вы являетесь несовершеннолетним, использование Сервиса возможно только под руководством и с согласия вашего законного представителя. Если вам менее 14 лет, вы должны использовать Сервис только с явного согласия или под контролем законного представителя.", userAgreementRequirements: "1.2 Для использования Сервиса необходимо иметь совместимое устройство с подключением к сети, установить приложение WeChat и выполнить авторизацию через WeChat.", userAgreementSection2Title: "2. Вход в аккаунт и использование", userAgreementLoginProcess: "2.1 Сервис основывается на платформе WeChat для авторизации входа. При первом использовании вы должны согласиться с процессом авторизации WeChat и успешно его пройти для создания или идентификации вашего аккаунта MCHOSE.", userAgreementInfoAccuracy: "2.2 Вы обязуетесь предоставлять достоверную и точную информацию для авторизации, а также своевременно обновлять её для обеспечения нормальной работы Сервиса.", userAgreementAccountSecurity: "2.3 Вы несёте ответственность за сохранность своего аккаунта WeChat и связанной с ним информации. Все убытки, возникшие вследствие потери или утечки аккаунта, ложатся на вас.", userAgreementSection3Title: "3. Содержание Сервиса", userAgreementCloudService: "3.1 Облачный сервис: загрузка конфигурационных файлов в облако для сохранения, синхронизации и управления;", userAgreementConfigCall: "3.2 Использование конфигураций: импорт загруженных пользователем конфигурационных файлов для персонализации;", userAgreementOfficialSync: "3.3 Синхронизация официальных конфигураций: своевременная синхронизация актуальных официальных конфигурационных файлов.", userAgreementServiceAdjustment: "MCHOSE оставляет за собой право изменять, дополнять или сокращать содержание Сервиса без дополнительного уведомления.", userAgreementSection4Title: "4. Правила поведения Пользователя", userAgreementBehaviorRule1: "4.1 Вы не должны совершать любые незаконные, нарушающие права или угрожающие безопасности системы действия при использовании Сервиса;", userAgreementBehaviorRule2: "4.2 Включая, но не ограничиваясь: распространением запрещённой информации, нарушением прав других лиц, мошенничеством, вмешательством в работу платформы и т.п.;", userAgreementBehaviorRule3: "4.3 В случае подобных действий MCHOSE вправе применять меры, включая предупреждения, ограничение доступа, блокировку аккаунта и привлечение к юридической ответственности.", userAgreementSection5Title: "5. Интеллектуальная собственность", userAgreementIPOwnership: "5.1 Все материалы Сервиса, включая дизайн интерфейса, код, API, графику и расположение элементов, принадлежат MCHOSE или правообладателям;", userAgreementIPRestriction: "5.2 Без разрешения запрещается копирование, распространение, изменение, передача или коммерческое использование данных материалов.", userAgreementSection6Title: "6. Защита конфиденциальности", userAgreementPrivacyNotice1: "6.1 Мы придаём большое значение защите вашей конфиденциальности. Подробности о сборе, использовании, хранении и защите вашей личной информации изложены в нашей Политике конфиденциальности.", userAgreementPrivacyNotice2: "6.2 Пожалуйста, внимательно ознакомьтесь с этой политикой перед использованием Сервиса, чтобы понять ваши права и наши обязанности.", userAgreementSection7Title: "7. Отказ от ответственности", userAgreementDisclaimer1: "7.1 Мы прилагаем максимальные усилия для обеспечения стабильности работы Сервиса и безопасности данных, однако не несем ответственности за перебои в работе, потерю данных или иные проблемы, вызванные форс-мажорными обстоятельствами или сбоями системы;", userAgreementDisclaimer2: "7.2 Пользователь несёт ответственность за убытки, возникшие по его собственной вине.", userAgreementSection8Title: "8. Обновление и изменение Соглашения", userAgreementUpdate1: "8.1 MCHOSE имеет право обновлять настоящее Соглашение в соответствии с требованиями законодательства и изменениями в бизнесе, уведомляя пользователей посредством объявлений в WeChat или другими разумными способами;", userAgreementUpdate2: "8.2 Продолжение использования Сервиса означает принятие вами обновлённого Соглашения.", userAgreementSection9Title: "9. Применимое право и разрешение споров", userAgreementLaw1: "9.1 Настоящее Соглашение регулируется законодательством Китайской Народной Республики;", userAgreementLaw2: "9.2 В случае споров стороны должны стремиться к их урегулированию путём переговоров; при невозможности согласования любой из сторон вправе обратиться в суд по месту юрисдикции в районе Лунган, город Шэньчжэнь.", userAgreementSection10Title: "10. Связаться с нами", userAgreementContactDesc: "Если у вас есть вопросы, предложения или жалобы по поводу данной политики, свяжитесь с нами следующим образом:", userAgreementServiceHotline: "10.1 Горячая линия службы поддержки: 400-816-8986", userAgreementServiceTime: "10.2 Время работы: с понедельника по пятницу, с 9:00 до 19:00", userAgreementConclusion: "Благодарим вас за доверие и использование сервиса авторизации через WeChat от MCHOSE. Мы продолжим прилагать усилия для защиты безопасности вашей информации и прав на конфиденциальность.", emailPlaceholder: "Введите почту", emailFormatError: "Неверный формат почты", emailSendCode: "Получить код", emailResend: "Отправить снова", emailResendCountdown: "Отправить снова ({n}с)", bindEmailGetCode: "Получить код", switchToWechatAria: "Нажмите, чтобы войти через WeChat", switchToEmailAria: "Нажмите, чтобы войти по email", cornerTooltipWechat: "Нажмите, чтобы войти через WeChat", cornerTooltipEmail: "Нажмите, чтобы войти по email", titleEmailLogin: "Вход по почте", titleWechatLogin: "Вход через WeChat", titleBindEmail: "Привязка почты", testEnvLoginTitle: "Вход в тестовой среде", testEnvSuffix: " (тест)", testCodePlaceholder: "Введите код авторизации (code)", btnLogin: "Войти", codeStepBack: "Назад", enterVerificationCode: "Введите код", codeEmailCheckTitle: "Проверьте почту", codeEmailSentLine: "Код отправлен.", codeEmailInboxLine: "Проверьте {email}", devOpenDevtools: "Открыть инструменты разработчика", devInspectPage: "Проверить страницу", msgSendCodeFailRetry: "Ошибка получения кода", msgOtpSixDigits: "Введите 6-значный код", msgWxConfigInitFail: "Не удалось инициализировать WeChat. Проверьте сеть.", msgLoginPageLoadFail: "Не удалось загрузить страницу входа.", msgLoginFailRetry: "Вход не выполнен. Повторите попытку.", msgTestEnterAuthCode: "Введите код авторизации", msgBindFailGeneric: "Не удалось привязать" }, user: { modifyNickname: "Изменить никнейм", modifyAvatar: "Изменить аватар", nicknamePlaceholder: "Введите новый никнейм", nicknameTip: "Длина никнейма ограничена 1-10 символами", nicknameEmpty: "Никнейм не может быть пустым", nicknameLengthError: "Длина никнейма должна быть от 1 до 10 символов", nicknameUpdateSuccess: "Никнейм успешно изменён", avatarUpdateSuccess: "Аватар успешно обновлён" } }, hI = { common: { prompt: "Hinweis", refresh: "Aktualisieren", cancel: "Abbrechen", close: "Schließen", restore: "Auf Standard zurücksetzen", iKnowIt: "Verstanden", notAdminRunning: "Für diesen Vorgang sind Administratorrechte erforderlich. Bitte beenden Sie die Anwendung, klicken Sie mit der rechten Maustaste auf das Symbol und wählen Sie „Als Administrator ausführen“, starten Sie dann neu und versuchen Sie es erneut.", clickLogin: "Anmelden", cloudEqTip: "Nach der Anmeldung stehen Cloud-Funktionen zur Verfügung (weitere Konfigurationsfreigabefunktionen sind in Entwicklung, bitte haben Sie Geduld).", editNickname: "Spitzname bearbeiten", changeAvatar: "Avatar ändern", avatarTip: "Unterstützt JPG- und PNG-Formate, Dateigröße darf 2 MB nicht überschreiten", logout: "Abmelden", autoWechatLogin: "Nach Auswahl springt die Anmeldung automatisch zu WeChat", privacyPrefix: "Mit dem Login stimmen Sie den", userAgreement: "Nutzungsbedingungen", loginSuccess: "Anmeldung erfolgreich", emailLoginSuccess: "Anmeldung erfolgreich", bindWechatAction: "WeChat verknüpfen", bindWechatSuccess: "WeChat verknüpft", bindWechatFailed: "WeChat konnte nicht verknüpft werden", wechatAlreadyBoundOtherEmail: "WeChat ist bereits mit anderer E-Mail verknüpft", emailAlreadyBoundOtherWechat: "E-Mail ist bereits mit anderem WeChat verknüpft", unbindEmail: "E-Mail trennen", unbindEmailGetCode: "Code anfordern", unbindEmailSuccess: "Trennung erfolgreich", unbindEmailCodeInvalid: "Ungültiger Code", accountBindWechat: "WeChat verknüpfen", accountBindEmail: "E-Mail verknüpfen", accountUnbindEmail: "E-Mail trennen", bindEmailSuccess: "Verknüpfung erfolgreich", logoutSuccess: "Abmeldung erfolgreich", changesSubmitted: "Änderung übermittelt, bitte auf Freigabe warten", nicknameEmpty: "Spitzname darf nicht leer sein", enterNickname: "Bitte gib einen Spitznamen ein", confirm: "Bestätigen", official: "Offiziell", game: "Spiel", music: "Musik", cloud: "Cloud-Community", cloudShared: "Cloud", favorited: "Favoriten", myShares: "Meine", search: "Suche", latest: "Neueste", topUsed: "Häufig", topLiked: "Beliebt", topFav: "Favoriten", author: "Autor", import: "Importieren", imported: "Importiert", favoritedStatus: "Zu Favoriten hinzugefügt", removedFromFavorites: "Aus Favoriten entfernt", liked: "Gefällt mir markiert", unliked: '"Gefällt mir" entfernt', importedToCustom: "Benutzer", importFailed: "Import fehlgeschlagen, max. 20 erlaubt", pleaseLogin: "Bitte zuerst anmelden", maxFavorites: "Maximal 20 Favoriten erlaubt", noUserUploads: "Noch keine Inhalte von Nutzern hochgeladen", noSearchResults: "Keine Ergebnisse gefunden, bitte anderen Begriff versuchen~", noFavorites: "Keine Favoriten vorhanden", noSharesYet: "Noch nichts geteilt", cancelSharing: "Freigabe aufheben", notice: "Hinweis", confirmCancelShare: 'Freigabe von „<strong>{name}"</strong> aufheben?', delete: "Del", custom: "Benutzer", myPresets: "Von mir erstellt", localImport: "Importieren", cloudImports: "Aus der Cloud importiert", confirmDelete: '„xxx" wirklich löschen? Nach dem Löschen nicht wiederherstellbar. Exportiere vorher bei Bedarf', confirmDeleteReview: '„<strong>{name}"</strong> wirklich löschen? Dieser EQ wird derzeit überprüft und könnte nach Genehmigung weiterhin in der Cloud angezeigt werden.', confirmDeleteSimple: '„<strong>{name}"</strong> wirklich löschen?', fromAuthor: "Vom Autor:", shareToCloud: "Cloud teilen", shareSuccess: "Erfolgreich geteilt", sharingCanceled: "Freigabe abgebrochen", maxSharesPerUser: "Max. 10 Freigaben pro Person", selectCategory: "Kategorie wählen", other: "Sonstiges", selectGameTag: "Bitte wähle ein Spiel-Tag", enterPresetTitle: "Titel eingeben", shareTitlePlaceholder: "Gib deinem Cloud-EQ einen passenden Titel", maxSharesPerUserSimple: "Max. 10 Freigaben pro Person", shareSuccessful: "Erfolgreich geteilt", confirmShareOverwrite: "Dieser EQ wurde bereits geteilt. Durch erneutes Teilen wird der alte überschrieben. Fortfahren?", share: "Teilen", restoreDefault: "Zurücksetzen", restoreDefaultSuccess: "Auf Standard zurückgesetzt", underReview: "Wird überprüft", export: "Export", underReviewTryLater: "Wird überprüft, bitte später erneut versuchen", underReviewDeleteWarning: "Löschen bricht die Überprüfung ab", shareFailTitle: "Teilen fehlgeschlagen: Titel unzulässig", shared: "Geteilt", exitPreview: "Vorschau beenden", nicknameViolation: "Unzulässig", nicknameViolationTip: "Unzulässiger Spitzname. Bitte ändern Sie ihn", rename: "Umbenennen", copy: "Kop", copied: "Kopiert", noCloudImport: "Kein EQ in der Cloud", unknown: "Unbekannt", noDescription: "Keine Beschreibung", shareRequestSubmitted: "Freigabeanfrage gesendet", copySuffix: "copy", view: "Ansehen", sysChanged: "EQ nicht gespeichert. <strong>[Als benutzerdefiniert speichern]</strong> klicken.", cmdENOENT: "cmd.exe fehlt im System. Bitte reparieren Sie das System und versuchen Sie es erneut.", batchOperation: "Stapelverarbeitung", selectAll: "Alle auswählen", exitBatch: "Stapelmodus beenden", confirmBatchDeleteAll: "Alle Konfigurationen löschen?", confirmBatchDeleteSelected: "Ausgewählte Konfigurationen löschen?", using: "In Use", clickToUse: "Use Now", expert: "Profi-Einstellungen", applySuccess: "Ausgewählten EQ aktiviert" }, tray: { open: "M HUB öffnen", quit: "Beenden" }, commonHeader: { officialStore: "Offizieller Store", myDevice: "Mein Gerät", back: "Zurück", backHome: "Zur Startseite", popoverTheme: "Skin wechseln", popoverSetting: "Einstellungen", popoverRelatedApp: "Spiel/App verknüpfen und Profil automatisch wechseln", popoverMin: "Minimieren", popoverUnmax: "Wiederherstellen", popoverMax: "Maximieren", popoverClose: "Schließen", offline: "Der aktuelle Server ist offline. Bitte starten Sie den Treiber später neu und versuchen Sie es erneut", performanceOnDesc: "Wenn der Leistungsmodus deaktiviert wird, werden die Effekte des transparenten Hintergrunds, des Mattglases und der abgerundeten Ecken des Rahmens aktiviert, und das Aussehen wird schöner. Dies stellt bestimmte Anforderungen an die Leistung des Computers.", performanceOffDesc: "Wenn der Leistungsmodus aktiviert wird, werden die Effekte des transparenten Hintergrunds, des Mattglases und der abgerundeten Ecken des Rahmens entfernt, und die Bedienung wird flüssiger. Wenn die Anwendung ruckelt, wird die Aktivierung des Leistungsmodus empfohlen.", feedback: "Feedback", prizeQuiz: "Prämienumfrage" }, themeSetting: { pageName: "Thema", white: "Weiß", black: "Schwarz", followSys: "Systemabhängig", bg: "Hintergrund", followTheme: "Themenabhängig", customizeText: "Benutzerdefinierter Hintergrund (nur auf der Startseite wirksam)", changeBg: "Bgr. wechseln", defaultBg: "Standardhintergrund ", uploadImg: "Bild hochladen", blurCard: "Unschärfe der Gerätekarte", blurBg: "Unschärfe des Bildhintergrunds" }, setting: { version: "Aktuelle Version", startup: "Start", startAuto: "Automatischer Systemstart", startAutoMini: "Beim Start in den Systemtray minimieren", language: "Sprache", closePanel: "Beim Schließen des Panels", exit: "Programm beenden", minimize: "In den Infobereich minimieren, Programm nicht beenden", copyright: "" }, menus: { AudioConfiguration: "Audio-Konfiguration", LightingSettings: "Beleuchtungsanordnung", ScreenSettings: "Bildschirmanzeige", OtherSettings: "Andere Einstellungen", GeneralParameters: "Allg. Parameter", Equalizer: "Equalizer", SoundMode: "Schallmodus", VirtualSurround: "Virtueller 7.1 Surround", CommonParams: "Häufige Parameter", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "Bildschirmeinstellungen können die Desktopanzeige beeinträchtigen. Ändern Sie Vergrößerung und Layout für optimales Anzeigeergebnis.", gotoSet: "Bearbeiten", needAdminNotice: "Einige Funktionen sind möglicherweise aufgrund unzureichender Berechtigungen nicht verfügbar. Bitte schließen Sie die Anwendung, klicken Sie mit der rechten Maustaste auf das Symbol und wählen Sie „Als Administrator ausführen“, um die App neu zu starten", loadFail: "Laden fehlgeschlagen", loadFailDesc: "Klicken Sie auf die Schaltfläche „Aktualisieren“, um erneut zu laden, oder überprüfen Sie die Netzwerkverbindung und starten Sie den Treiber neu." }, devicePage: { needOtaNotice: "Es wurde eine neue Firmware - Version erkannt. Um den Treiber normal zu verwenden, müssen Sie ihn aktualisieren. Laden Sie die Firmware herunter und aktualisieren Sie sie.", needOtaNoticeTip: "Hinweis: Nach dem Herunterladen öffnen Sie das Toolkit im Speicherpfad und folgen der Anleitung, um das Upgrade durchzuführen.", downloadNow: "Jetzt herunterladen", restartNotice: "Nach der Installation des Treibers muss der Computer neu gestartet werden, damit der Treiber ordnungsgemäß funktioniert. Falls der Treiber nach dem Neustart nicht funktioniert, wenden Sie sich bitte an den Kundensupport.", restartNow: "Sofort neu starten", speakerDisabled: "Es wurde festgestellt, dass der Lautsprecher deaktiviert wurde, wodurch der Treiber nicht ordnungsgemäß gestartet werden kann", step: "Lösungsanleitung:", step1: "1. Klicken Sie auf die Schaltfläche [Windows-Soundgeräte] unten.", step2: "2. Wählen Sie im erscheinenden System-Soundsteuerungsfenster (siehe das untenstehende Diagramm) unter „Wiedergabe“ das entsprechende Gerät aus, klicken Sie mit der rechten Maustaste darauf, aktivieren Sie den Lautsprecher und bestätigen Sie mit „OK“.", step3: "3. Nach der Aktivierung klicken Sie auf die Schaltfläche [Aktualisieren] unten.", isSleep: `Falls Gerät im Energiesparmodus, starten Sie Headset 
 neu oder prüfen Sie 2.4G-Verbindungsmodus (empfohlen: Neustart des Empfängers). Hinweis: Treiber funktioniert nicht bei angeschlossenem Audiokabel oder aktivem Bluetooth-Modus.`, deviceLostLink: "Treiberverbindung getrennt", headphoneSleepStatus: "Headset im Ruhezustand", headphoneSleepStatusTips: "Taste drücken oder neu starten", needLinkWireless: "Treiber unterstützt nur 2.4G-Verbindung", needLinkWirelessHeadphoneTips: "Bitte prüfen, ob der Empfänger angeschlossen ist und kein Audiokabel oder Bluetooth verwendet wird", wiredMode: "Kabelgebunden ", lessThan: "Unter {val}", charging: "Wird geladen", sufficientCharge: "Batterie genug", wiredVersion: "kabel", notAdminRunningHeadset: "Für Audiogeräte sind Administratorrechte erforderlich. Bitte schließen Sie die Anwendung, klicken Sie mit der rechten Maustaste auf das Symbol und wählen Sie „Als Administrator ausführen“, um die App neu zu starten", thxInstallDialogTitle: "Audio-Komponenten werden installiert", thxInstallDialogTitleUpgrade: "Audio-Komponenten werden aktualisiert", thxInstallDialogDesc1: "Dauert ca. 1–2 Minuten, bitte warten", thxInstallDialogDesc2: "Treiber während der Installation nicht schließen. Danach wird die Geräteansicht geöffnet" }, routine: { UserManual: "Anleitung", beepTitle: "Benachrichtigungston", beepTitleDesc: "Sprachlautstärke anpassen (kein Einfluss auf Medien)", UserManualFull: "Anleitung zum Gebrauch", Volume: "Lautstärke", Microphone: "Mikrofon", MicAI: "KI-Rauschunterdrückung aktivieren", MicAIDesc: "Filtert Geräusche, verbessert Klang", MicNoiseReduction: "Statische Geräuschunterdrückung", MicNoiseReductionDesc: "Stabile Geräuschkomponenten in bestimmten Frequenzbereichen werden abgeschwächt, um gezielt die Signalstärke in diesen Bereichen zu reduzieren, beispielsweise bei Geräuschen von Klimaanlagen oder Ventilatoren.", MicListen: "Mikrofon-Monitoring", MicListenDesc: "Eigenstimme in Echtzeit hören", MoYin: "Soundeffekte:", MoYin_0: "Monster", MoYin_1: "Cartoon", MoYin_2: "Männliche Stimme", MoYin_3: "Weibliche Stimme", WindowsAudioDevices: "Windows-Soundgeräte", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Geändert, automatisch gespeichert", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Werkseinstellungen EQ", eqEditorResetFactoryConfirm: "[{mode}] überschreibt die aktuellen EQ-Einstellungen und stellt den Werkstandard wieder her.", eqEditorResetFactoryDone: "Modus {n} wurde auf den werkseitigen EQ-Standard zurückgesetzt.", eqSwitchUnsavedHint: "Sie haben den Equalizer für den aktuellen Modus geändert. Direktes Anwenden eines anderen EQ überschreibt Ihre Bearbeitung.", eqSwitchApplyDirect: "Direkt anwenden", eqSwitchSaveThenApply: "Speichern, dann anwenden", AudioBright: "Audio-Aufhellung", AudioBrightDesc: "Die hohen Frequenzen des Audios werden verstärkt, um den Klang klarer und detailreicher zu machen, wodurch die Gesamthelligkeit und Ausdruckskraft des Audios effektiv verbessert wird.", SurroundAmplification: "Surround-Verstärkung", SurroundAmplificationDesc: "Der räumliche Klangeindruck wird verstärkt, indem das Klangfeld verbreitert wird. Dies simuliert Reflexionen und Diffusionen, sodass Sie das Gefühl haben, in einem größeren Raum zu sein, der von Lautsprechern umgeben ist.", DynamicLF: "Dynamische Tieffrequenz", DynamicLFDesc: "Die Tieffrequenzen werden intelligent geregelt: Bei starkem Rhythmus werden Stärke und Tiefe verstärkt, sodass die Schlagzeugklänge kraftvoller werden. Bei reduzierten Tieffrequenzen entsteht ein natürlicher Klang, der ein dynamisches und abwechslungsreiches Bass-Erlebnis bietet.", SmartVolume: "Intelligente Lautstärke", SmartVolumeDesc: "Änderungen der Audio-Lautstärke werden automatisch erkannt und intelligent auf ein angemessenes Niveau ausgeglichen, um plötzliche Lautstärkeschwankungen zu vermeiden und ein stabiles Hörerlebnis zu bieten, ohne dass eine manuelle, häufige Lautstärkeanpassung erforderlich ist.", VocalClarity: "Stimmklarheit", VocalClarityDesc: "Die menschliche Stimme wird präzise optimiert, wobei Hintergrundgeräusche und Störungen reduziert werden, sodass die reine Stimme hervorsticht und Sie eine klare Artikulation erfassen können, um Musik, Filme und Anrufe in herausragender Klangqualität zu genießen.", MusicMode: "Music M (HD)", VoiceMode: "Spra. M(ND)", NCut: "Geräusch - UD", Freqtrap: "FBS", Intensity: "Intensität", DYIntensity: "Intensität", QXIntensity: "Intensität", Speech: "Sprachbenachrichtigung", SpeechDesc: "Sprachbenachrichtigung bei Lautsprecherbedienung (Sie können die Sprachbenachrichtigung auch durch gleichzeitiges Drücken der physischen „+“ und „G“-Tasten des Lautsprechers für {time} Sekunden ein- oder ausschalten).", SpeechDescK20Pro: "Sprachansage bei der Lautsprecherbedienung (halten Sie die Mikrofontaste am Lautsprecher {time} Sekunden gedrückt, um die Sprachansage ein- oder auszuschalten)", micDisabled: "Mikrofon deaktiviert ", micDisabledTitle: "Es wurde festgestellt, dass das Mikrofon deaktiviert wurde, wodurch es nicht ordnungsgemäß genutzt werden kann", step: "Lösungsanleitung:", step1: "1. Klicken Sie auf die Schaltfläche [Windows-Soundgeräte] unten.", step2: "2. Wählen Sie im erscheinenden System-Soundsteuerungsfenster (siehe das untenstehende Diagramm) unter „Aufnahme“ das entsprechende Gerät aus, klicken Sie mit der rechten Maustaste darauf, aktivieren Sie das Mikrofon und bestätigen Sie mit „OK“.", step3: "3. Nach der Aktivierung klicken Sie auf das Symbol [Aktualisieren] unten." }, eq: { title: "Equalizer", game1: "EQ-Modus 1", game2: "EQ-Modus 2", game3: "EQ-Modus 3", eqSlotDefaultDesc: "Onboard-Preset-Slot", popover2: "Ein Equalizer funktioniert wie ein Mischpult und ermöglicht die Anpassung von Frequenz und Lautstärke des Audios. Sie können die Höhen- und Tiefenfrequenzen nach Belieben einstellen. Zum Beispiel können Sie im Spiel die Tieffrequenzen anheben, um Explosionen und Schritte zu verstärken, und die Höhenfrequenzen erhöhen, damit Schüsse und Schritte klarer hörbar sind, um so ein individuelles Klangerlebnis zu schaffen, das die Immersion und den Wettbewerbsvorteil steigert.", popover: "Equalizer zur Frequenzanpassung", import: "Importieren", 默认: "Standard", 音乐清脆风: "Klarer Stil", 音乐清脆风1: "Klarer Stil1", 音乐清脆风2: "Klarer Stil2", "3D影视": "3D-Filme", 舞曲: "Dance", 饶舌曲: "Rap", 重金属: "Heavy Metal", 爵士: "Jazz", 抒情摇滚: "Soft Rock", 摇滚: "Rock", 现场: "Live", 高音: "Hohe Töne", 低音: "Tiefe Töne", bandBass: "Bass", bandLowMid: "Mitteltief", bandMid: "Mitte", bandHighMid: "Mittelhoch", bandHigh: "Hoch", 古典乐: "Klassische Musik", 声乐: "Vokal", 无畏契约: "Valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Benutzerdefiniert", more: "Mehr", empty: "Keine Effekte ausgewählt.", renamePlaceholder: "Bitte geben Sie einen benutzerdefinierten Namen ein", export: "Exportieren", delete: "Löschen", saveAs: "Als benutzerdefiniert speichern", reset: "Zurücksetzen", newNameTitle: "Benutzerdefiniert", newNamePlaceholder: "Bitte geben Sie einen benutzerdefinierten Namen ein", duplicate: "Der Name existiert bereits, bitte geben Sie einen anderen ein", ok: "Bestätigen", importSuccess: "Import erfolgreich", importFail: "Import fehlgeschlagen, bitte versuchen Sie es erneut", importFailName: "Der Import ist fehlgeschlagen, da der Name doppelt ist. Bitte machen Sie Änderungen", exportSuccess: "Export erfolgreich", exportFail: "Export fehlgeschlagen, bitte versuchen Sie es erneut", deleteTitle: "Hinweis", delPre: 'Sind Sie sicher, dass Sie "', delAfter: "? Nach dem Löschen nicht wiederherstellbar. Exportiere vorher bei Bedarf", expertListTip: "Profi-Presets sind an den Soundmodus gebunden. Für beste Klangqualität den Modus nicht ändern." }, mode: { modeDesc: `Verschiedene Modi können mit einem Klick umgeschaltet werden, 
 was Ihnen ein exklusives und erstklassiges Hörerlebnis bietet`, gameMode: "Spielmodus", gameMode1: "Spielmodus 1", gameMode2: "Spielmodus 2", musicMode: "Musikmodus", movieMode: "Filmmodus", gameModeDesc: "Betont Schuss- und Schrittgeräusche, ideal für kompetitive FPS-Spiele", musicModeDesc: "Professionell abgestimmt für detailreichen Klang, ideal für immersive Musikszenen", movieModeDesc: "Bietet Kino-Sounderlebnis, ideal für immersive Filmszenen", gameModeDesc2: "Betont Umgebungsgeräusche des Schlachtfelds, ideal für Kriegs-FPS-Spiele" }, light: { switch: "Beleuchtung", switchOn: "Licht an", switchOff: "Licht aus", title: "B - Effekte", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Stars", goFlow: "Waves", continue: "Dauer", duan: "Kurz", chang: "Lang", an: "Dunkel", guang: "Hell", direction: "Richtung", clockwise: "i. UZS.", anticlockwise: "g. d. UZS.", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB-Sync aktiv", syncClosed: "RGB-Synchronisation auf diesem Gerät wurde deaktiviert und der ausgewählte Lichteffekt angewendet", flowing_f: "Flowing Light - Fast", speed: "Geschwindigkeit", fast: "schnell", slow: "langsam", colorjoe: "Palette", reset: "Auf Standard zurücksetzen", notView: "Dieser Lichteffekt unterstützt keine Vorschau.", color: "Färben", lightShow: "Lichtanzeige", lightShow1: "Alle Lichter einschalten", lightShow2: "Die mittleren Lichter ausschalten", lightShow3: "Ausschalten Sie die Lichter beidseits", smartLight: "Intelligente Beleuchtung", smartLightDesc: "Nach Aktivierung wechseln Bildschirm und Ambientlicht nach 30 Minuten ohne Nutzung oder Wiedergabe automatisch in den Energiesparmodus", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Geschwindigkeit und Helligkeit", brightness: "Helligkeit" }, surround: { switch: "Xear Virtueller 7.1 Surround", popover: "Simuliert einen 7.1-Kanal-Raumklang. Sobald aktiviert, vermittelt es das Gefühl, als käme der Klang aus mehreren Richtungen, sodass Sie sich mitten in Spielszenen oder Filmen befinden und die Richtung sowie Entfernung der Geräusche präzise lokalisieren können, was ein dreidimensionales und immersives Hörerlebnis ermöglicht.", popoverGame: "Virtueller 7.1-Sound ist für FPS-Spiele ungeeignet, empfohlen für AAA-Spiele und Medien.", mode: "Moduswahl", music: "Musik-/Spielmodus", movie: "Filmmodus", test: "Lautsprechertest", start: "Test starten", stop: "Test beenden", size: "Raumgröße", small: "klein", mid: "mittel", big: "groß" }, otherSettings: { v9TurboHeadset: "Bitte verwenden Sie den 2.4G-Modus, um die Aktualisierung zu verbinden.", alreadyLatest: "Die Firmware ist bereits auf dem neuesten Stand, ein Update ist nicht erforderlich.", latest: "Aktuell", baseV: "Basis-Firmware-Version:", goUpdate: `Jetzt
aktualisieren`, usbV: "Geräte-USB-Version:", firmwareV: "Geräte-Firmware-Version:", headsetV: "Headset-Firmware-Version:", dongleV: "Empfänger-Firmware-Version:", findNew: "Neueste Version erkannt: ", speakerShutdown: "Gerät Aus", speakerShutdownDesc: "Der Treiber kann nur ausschalten, nicht einschalten", shutdown: "Ausschalten", speakerShutdownConfirm: "Möchten Sie das Gerät wirklich ausschalten?", speakerShutdownSuccess: "Der Lautsprecher wurde ausgeschaltet", speakerShutdownDeviceError: "Das Gerät ist nicht verbunden, bitte überprüfen Sie das Gerät", speakerShutdownFailed: "Ausschalten des Lautsprechers fehlgeschlagen", and: ", ", restoreFactory: "Auf Werkseinstellungen zurücksetzen", restoreFactoryDesc: "Alle Einstellungen werden auf Werkseinstellungen zurückgesetzt, bitte vorsichtig vorgehen.", restore: "Zurücksetzen", restoreSuccess: "Zurücksetzen auf Werkseinstellungen erfolgreich abgeschlossen", downloading: "Firmware-Datei wird heruntergeladen…", updating: "Das Firmware wird aktualisiert...", updatingNote: "Bitte beenden Sie das Programm oder ziehen Sie das Gerät nicht aus oder stecken Sie es nicht ein, während der Aktualisierungsprozess!", inDevelopment: "Funktion in Entwicklung...", readBinFail: "Es ist fehlgeschlagen, die Firmware-Datei zu lesen", downloadBinFail: "Firmware-Datei konnte nicht heruntergeladen werden", otaFail: "Das Firmware-Upgrade ist fehlgeschlagen", otaFailResult: "Das Firmware-Upgrade ist fehlgeschlagen. Versuchen Sie es erneut, indem Sie das Gerät ab- und wieder anschließen", otaSuc: "Die Firmware-Upgrade war erfolgreich", otaSucDongle: "Firmware-Upgrade erfolgreich. Bitte warten Sie, bis {deviceType} automatisch neu startet, um die Änderungen wirksam zu machen (ca. 30 Sekunden).", otaSucHeadset: "Firmware-Upgrade erfolgreich. Bitte warten Sie etwa 30 Sekunden und schalten Sie dann die Kopfhörer manuell ein, um die Änderungen wirksam zu machen.", otaSucBoth: "Headset- und Empfänger-Firmware-Upgrade erfolgreich. Bitte warten Sie auf den automatischen Neustart des Geräts (ca. 30 Sekunden).", deviceTypeDong: "Empfänger", deviceTypeDevice: "Geräte", confirmFactoryReset: "Diese Aktion löscht alle Einstellungen. Möchten Sie wirklich auf Werkseinstellungen zurücksetzen?", powerManagement: "Energieverwaltung", autoShutdown: "Automatische Abschaltung:", autoShutdownDesc: "Sind die Kopfhörer aus der Dockingstation entfernt (nicht im Ladevorgang) und ohne Wiedergabe länger als die eingestellte Zeit, schalten sie sich automatisch aus.", minutes: "Minuten", downloadTips1: "1.Speichern Sie das Firmware-Paket am besten auf dem Desktop.", downloadTips2Exe: "2.Doppelklicken Sie darauf, um das automatische Update zu starten.", downloadTips2Zip: "2.Nach dem Entpacken doppelklicken Sie auf das Firmware-Paket, um das automatische Update zu starten.", betterOtaTitle: "Neue Firmware erkannt. Aktualisieren wird empfohlen." }, screenSettings: { screenOTAing: "Bildschirm wird aktualisiert, bitte warten", screenDisplay: "Bildschirmanzeige", screenOn: "Bildschirm an", screenOff: "Bildschirm aus", screenColor: "Bildschirmfarbe", presetSettings: "Hintergrundwechsel", personalizedPreset: "Bildschirmhintergrund", customText: "Text", custom: "Eigen", digitalClock: "Digitale Uhr", musicSpectrum: "Musikspektrum", campusDaily: "Campusleben", workplaceLife: "Arbeitsleben", cutePets: "Süße Haustiere", electronicGames: "Videospiele", cyberTech: "Cyber-Technologie", networkMeme: "Internet-Memes", customImage: "Benutzerbild", customImageOTAWarning: "Bitte aktualisieren Sie zuerst die Firmware, bevor Sie diese Funktion verwenden", addImage: "Bild hinzufügen", uploadImage: "Bild hochladen", reuploadImage: "Neu hochladen", supportImageFormat: "PNG/JPG/GIF unterstützt. GIF nur 30 Frames", previewImage: "Vorschau", text: "Text", scenery: "Landschaft", character: "Person", uploadingToScreen: "Wird auf den Bildschirm hochgeladen", reverseColor: "Farben invertieren", scaleScreen: "Bildschirm skalieren", scaleImage: "Bild skalieren", blackWhiteRatio: "Schwarz-Weiß-Verhältnis", deleteImageConfirm: "Dieses Bild löschen? Nicht wiederherstellbar", deleteImage: "Löschen", batchDeleteImage: "Mehrfach löschen", selectAll: "Alle auswählen", cancelSelectAll: "Auswahl aufheben", processImage: "Bildverarbeitung", exitBatch: "Mehrfachmodus beenden", deleteSelectedImageConfirm: "Ausgewählte Bilder löschen? Nicht wiederherstellbar", textContent: "Textinhalt", textLengthLimit: "Zeichenlimit erreicht", save: "Speichern", savedSuccess: "Gespeichert", historyRecords: "Verlauf", clearHistory: "Verlauf mit einem Klick löschen", historyTip: "Nur die letzten 20 Einträge anzeigen", textEffect: "Text-Effekt", staticDisplay: "Statische Anzeige", dynamicDisplay: "Dynamische Anzeige", alignment: "Ausrichtung", leftAlign: "Linksbündig", centerAlign: "Zentriert", rightAlign: "Rechtsbündig", justifyAlign: "Blocksatz", scrollEffect: "Scroll-Effekt", scrollToRight: "Von links nach rechts", scrollToLeft: "Von rechts nach links", customColors: "Eigene Farbe", clearCustomColors: "Farben löschen", syncToLight: "Sync Farbe & Beleuchtung", shortPress: "Kurzes Drücken", lyrics: "Liedtext", lyricsDisplay: "Liedtextanzeige（BETA）", lyricsDisplayHintLead: "Bei Audiowiedergabe mit Unterstützung für Liedtexte zeigt der Bildschirm den aktuellen Text an.", lyricsDisplayCantSeeLink: "Kein Liedtext sichtbar?", lyricsDisplayCantSeeTooltip: "Derzeit werden nur einige Musik-Apps unterstützt. Bitte aktualisieren und M HUB neu laden", lyricsOn: "Ein", lyricsOff: "Aus", lyricsAnimation: "Liedtextanimation", notSupportSyncToLight: "Der aktuelle Lichteffekt ist mehrfarbig, Farbsynchronisation wird nicht unterstützt", syncToLightSuccess: "Synchronisation erfolgreich", uploadToScreenTip: "Ca. {time}s, bitte nicht beenden", deleteCustomColorConfirm: "Möchten Sie die aktuelle Farbe wirklich löschen?", deleteAllCustomColorsConfirm: "Möchten Sie alle benutzerdefinierten Farben wirklich löschen?", minimumSelectionToast: "Mindestens 2 auswählen", textVerifyFailed: "Pixelanzeige unterstützt keine Emojis oder Sonderzeichen. Nur Text eingeben", lyricsAnimationOption1: "Eingang: von unten nach oben. Ausgang: von unten nach oben", lyricsAnimationOption2: "Eingang: aus der Mitte entfalten. Ausgang: zur Mitte zusammenziehen", lyricsAnimationOption3: "Eingang: von links nach rechts. Ausgang: von rechts nach links", lyricsAnimationOption4: "Eingang: von unten nach oben. Ausgang: von oben nach unten", lyricsAnimationOption5: "Eingang: von oben nach unten. Ausgang: von rechts nach links", lyricsAnimationDemo: "Liedtext-Animationsdemo", uploadingImgTip: "Bild wird hochgeladen, bitte später versuchen" }, update: { alreadyNew: "Neueste Version", findNew: "Neueste Version erkannt", ignore: "Ignorieren", update: "Aktualisieren", showHistory: "Historische Versionen anzeigen", updating: "Treiber-Upgrade läuft...", rollingBack: "Wechsel zu der historischen Version {version}  läuft...", updateContentTitle: "Treiber-Upgrade", updateContent: "Treiber-Update-Inhalte:", updateNow: "Sofort updaten", back: "Zurück", historyTitle: "Historische Versionen", version: "Versionsnummer", date: "Aktualisierungsdatum", backToList: "Zurück zur vorherigen Ebene", only30: "Die letzten 30 historischen Versionen aufbewahren.", operation: "Operation", watchContent: "Update-Inhalte anzeigen", rollTo: "Zurück zu dieser Version", currentVersion: "Aktuelle Version", updateTo: "Auf diese Version updaten", updateSuccess: "Treiber-Upgrade abgeschlossen", revertSuccess: "Zur historischen Version {version} zurückgekehrt", updatePre: "Upgrade wird vorbereitet, bitte warten Sie...", updateAfter: "Die Anwendung wird in Kürze automatisch neu gestartet. Bitte warten Sie", inviteUpdate1: "Neue Version gefunden, ", inviteUpdate2: "bitte aktualisieren Sie sobald", inviteUpdate3: "wie möglich.", notAdminRunning: "Für das Upgrade sind Administratorrechte erforderlich. Bitte beenden Sie die Anwendung, klicken Sie mit der rechten Maustaste auf das Symbol und wählen Sie „Als Administrator ausführen“. Versuchen Sie das Upgrade nach dem Start erneut", updateResultFail: "Das Update ist fehlgeschlagen, was dazu führen kann, dass einige Funktionen nicht verfügbar sind. Entfernen Sie es und gehen Sie dann auf die offizielle Website von Maicong, um das neueste Installationspaket herunterzuladen und zu installieren", updateFailAfter: "Während der Erstellung des Kompressionspakets ist ein Anomalie aufgetreten. Entfernen Sie es und gehen Sie dann auf die offizielle Website von Maicong, um das neueste Installationspaket herunterzuladen und zu installieren", updateFailPre: "Während der Vorverarbeitung der Aktualisierung ist ein Anomalie aufgetreten. Versuchen Sie es später erneut. Wenn es weiterhin fehlschlägt, deinstallieren Sie den Treiber und gehen Sie dann auf die offizielle Website von Maicong, um das neueste Treiberinstallationspaket herunterzuladen und erneut zu installieren", updateUpFailDefault: "Das Treiber-Upgrade ist fehlgeschlagen. Versuchen Sie es später erneut", updateBackFailDefault: "Es ist fehlgeschlagen, zurück zur alten Version zu wechseln. Versuchen Sie es später erneut", notSupportUpdate: "Die aktuelle Version unterstützt keine Onlinemodernisierung. Gehen Sie auf die offizielle Website von Maicong, um die neueste Version des Installationspakets herunterzuladen und erneut zu installieren", restartFinishUpdate: "Treiber neu starten" }, musicDance: { settingPanel: "Musikrhythmus-Steuerungsleiste", scaleEffect: "Zoom-Rhythmus", scaleKeyboard: "Zoom-Tastatur", showEffect: "Zg Rythmus", showKeyboard: "Zg Tast", reset: "Auf Standard zurücksetzen", needWinVcTitle: "Die Windows-MSVC-Laufzeitbibliothek fehlt im System, daher sind einige Funktionen eingeschränkt", needWinVcDesc: "Laden Sie die offizielle Microsoft-Bibliothek vc_redist.x64.exe herunter und installieren Sie sie, und starten Sie dann die Anwendung neu：", needWinVcLink1: "Offizielle Download-Adresse von Microsoft:", needWinVcLink2: "Ersatzdownload-Adresse:", download: "Klicken Sie zum Herunterladen", needWinVcNotice: "Falls dieses Fenster nach der Installation weiterhin angezeigt wird, unterstützt Ihr System diese Funktion möglicherweise derzeit nicht" }, wechatLogin: { privacyPrefix: "Mit dem Login stimmen Sie den", privacyPolicy: "„Datenschutz“", privacySuffix: "„Bedingungen“", privacyAnd: "und", privacyEnd: "zu.", accountMergeHint: "Nach Verknüpfung Login per WeChat/E-Mail, Daten werden zusammengeführt", accountUnbindEmailHint: "Nach Trennung bleiben Daten in WeChat erhalten", privacyPolicyTitle: "Datenschutzrichtlinie", userAgreement: "Nutzungsbedingungen", privacyWelcome: "Willkommen beim WeChat-Login-Dienst von MCHOSE! Diese Nutzungsvereinbarung („Vereinbarung“) wird zwischen Shenzhen MCHOSE Technology Co., Ltd. (nachfolgend „wir“ oder „MCHOSE“) und Ihnen (nachfolgend „Sie“ oder „Nutzer“) geschlossen und regelt die Rechte und Pflichten im Zusammenhang mit dem von MCHOSE bereitgestellten WeChat-Login-Dienst (nachfolgend „der Dienst“).", privacyReadNotice: "Bitte lesen Sie diese Richtlinie vor der Nutzung des Dienstes sorgfältig durch und verstehen Sie deren Inhalt vollständig. Durch die Nutzung dieses Dienstes erklären Sie, dass Sie die gesamte Datenschutzerklärung gelesen, verstanden und akzeptiert haben.", privacySection1Title: "1. Von uns gesammelte Informationen", privacySection1Desc: "Während Ihrer Nutzung des Dienstes können wir folgende Informationen erheben:", privacyWechatInfo: `1.1 WeChat-Autorisierungsinformationen
Wenn Sie sich über WeChat anmelden, erfassen wir grundlegende Informationen wie Ihren WeChat-Nickname, Ihr Profilbild, OpenID und UnionID über die Schnittstelle der WeChat-Plattform, um Ihr Konto zu identifizieren und personalisierte Dienste bereitzustellen.`, privacyCloudData: `1.2 Cloud-Nutzungsdaten
Die von Ihnen hochgeladenen, gespeicherten oder aufgerufenen Konfigurationsdateien werden auf unseren Cloud-Servern gespeichert, um die geräteübergreifende Synchronisation zu unterstützen.`, privacySection2Title: "2. Verwendung der Informationen", privacySection2Desc: "Wir verwenden Ihre Daten nur zu folgenden rechtmäßigen, legitimen und notwendigen Zwecken:", privacyServiceFunction: `2.1 Bereitstellung der Servicefunktionen
Zur Bereitstellung von Kernfunktionen wie WeChat-Login-Autorisierung, Cloud-Speicherung und Zugriff auf Konfigurationsdateien.`, privacyServiceSecurity: `2.2 Gewährleistung der Servicesicherheit
Zur Identitätsprüfung, Anomalieerkennung, Fehlerbehebung und zur Verbesserung der Stabilität und Sicherheit des Systems.`, privacySection3Title: "3. Speicherung und Schutz der Informationen", privacyStorageLocation: `3.1 Speicherort und Aufbewahrungsdauer
Alle Nutzerdaten werden auf Servern innerhalb des chinesischen Festlands gespeichert. Wir bewahren Ihre Daten nur so lange auf, wie es zur Erreichung der oben genannten Zwecke notwendig ist, und löschen oder anonymisieren sie danach.`, privacySecurityMeasures: `3.2 Maßnahmen zur Informationssicherheit
Wir wenden mehrfache Verschlüsselung, Zugriffskontrollen, Protokollprüfungen und weitere technische Maßnahmen an, um Ihre Daten vor unbefugtem Zugriff, Offenlegung, Manipulation oder Zerstörung zu schützen.`, privacySection4Title: "4. Ihre Rechte", privacyRightsDesc: "Gemäß den geltenden Gesetzen und Vorschriften haben Sie folgende Rechte:", privacyQueryAccess: `4.1 Auskunft und Zugriff
Sie haben das Recht zu erfahren, ob wir Ihre personenbezogenen Daten speichern, und auf diese Daten zuzugreifen.`, privacyCorrectionDelete: `4.2 Berichtigung und Löschung
Sollten die von uns gespeicherten Daten ungenau oder ungültig sein, können Sie eine Berichtigung oder Löschung verlangen.`, privacyCancelWithdraw: `4.3 Kontolöschung und Widerruf der Einwilligung
Sie können Ihr Konto über die WeChat-Plattform oder durch Kontaktaufnahme mit uns löschen bzw. Ihre Einwilligung widerrufen. Danach werden wir Ihre Daten nicht mehr verarbeiten, sofern nicht gesetzliche Aufbewahrungspflichten bestehen.`, privacySection5Title: "5. Aktualisierung der Richtlinie", privacyPolicyUpdate: "Wir können diese Datenschutzerklärung entsprechend der geschäftlichen Entwicklung oder gesetzlichen Änderungen aktualisieren. Die aktualisierte Richtlinie wird über WeChat-Miniprogramm-Benachrichtigungen oder andere angemessene Wege bekanntgegeben. Die weitere Nutzung des Dienstes gilt als Zustimmung zur aktualisierten Richtlinie.", privacySection6Title: "6. Kontaktieren Sie uns", privacyContactDesc: "Wenn Sie Fragen, Anregungen oder Beschwerden bezüglich dieser Richtlinie haben, können Sie uns wie folgt kontaktieren:", privacyServiceHotline: "6.1 Kundenservice-Hotline: 400-816-8986", privacyServiceTime: "6.2 Servicezeiten: Montag bis Freitag, 9:00 – 19:00 Uhr", privacyConclusion: "Wir danken Ihnen für Ihr Vertrauen und die Nutzung des WeChat-Login-Services von MCHOSE. Wir werden weiterhin unser Bestes geben, um Ihre Daten und Privatsphäre zu schützen.", userAgreementWelcome: "Willkommen beim WeChat-Login-Dienst von MCHOSE! Diese Nutzungsvereinbarung („Vereinbarung“) wird zwischen Shenzhen MCHOSE Technology Co., Ltd. (nachfolgend „wir“ oder „MCHOSE“) und Ihnen (nachfolgend „Sie“ oder „Nutzer“) geschlossen und regelt die Rechte und Pflichten im Zusammenhang mit dem von MCHOSE bereitgestellten WeChat-Login-Dienst (nachfolgend „der Dienst“)", userAgreementReadNotice: "Bitte lesen Sie diese Vereinbarung sorgfältig durch und machen Sie sich mit allen Bestimmungen vertraut – insbesondere mit Haftungsausschlüssen und Regelungen, die Ihre Rechte einschränken.", userAgreementSection1Title: "1. Voraussetzungen für die Nutzung des Dienstes", userAgreementSection1Desc: "1.1 Sie erklären ausdrücklich und garantieren:", userAgreementLegalCapacity: "· dass Sie rechtsfähig sind, diese Vereinbarung abzuschließen und den Dienst zu nutzen;", userAgreementMinorNotice: "· falls Sie minderjährig sind, dürfen Sie den Dienst nur unter Anleitung und mit Zustimmung eines Erziehungsberechtigten nutzen. Wenn Sie unter 14 Jahre alt sind, ist eine ausdrückliche Zustimmung oder Anleitung durch den gesetzlichen Vertreter erforderlich.", userAgreementRequirements: "1.2 Zur Nutzung des Dienstes benötigen Sie ein internetfähiges, kompatibles Gerät, die WeChat-App und eine Anmeldung über die WeChat-Autorisierung.", userAgreementSection2Title: "2. Kontoanmeldung und -nutzung", userAgreementLoginProcess: "2.1 Der Dienst basiert auf der WeChat-Plattform zur Autorisierung des Logins. Bei der ersten Nutzung müssen Sie dem WeChat-Autorisierungsprozess zustimmen und ihn abschließen, um ein MCHOSE-Konto zu erstellen oder zu identifizieren.", userAgreementInfoAccuracy: "2.2 Sie sind verpflichtet, genaue und wahrheitsgemäße Informationen bereitzustellen und diese bei Änderungen unverzüglich zu aktualisieren, um die ordnungsgemäße Nutzung des Dienstes sicherzustellen.", userAgreementAccountSecurity: "2.3 Sie sind selbst dafür verantwortlich, Ihre WeChat-Zugangsdaten sicher aufzubewahren. Verluste aufgrund von Verlust oder Weitergabe des WeChat-Kontos tragen Sie selbst.", userAgreementSection3Title: "3. Leistungsumfang des Dienstes", userAgreementCloudService: "3.1 Cloud-Dienst: Hochladen, Speichern, Synchronisieren und Verwalten von Konfigurationsdateien in der Cloud;", userAgreementConfigCall: "3.2 Konfigurationsanwendung: Importieren von hochgeladenen Konfigurationsdateien zur Individualisierung der Nutzung;", userAgreementOfficialSync: "3.3 Offizielle Konfigurationssynchronisierung: Echtzeit-Synchronisierung der neuesten offiziellen Konfigurationsdateien.", userAgreementServiceAdjustment: "MCHOSE behält sich das Recht vor, die Inhalte des Dienstes entsprechend der Geschäftsentwicklung zu ändern, zu erweitern oder einzuschränken – ohne vorherige Ankündigung.", userAgreementSection4Title: "4. Verhaltensregeln für Nutzer", userAgreementBehaviorRule1: "4.1 Sie dürfen bei der Nutzung des Dienstes keine rechtswidrigen, rechtsverletzenden oder sicherheitsgefährdenden Handlungen vornehmen.", userAgreementBehaviorRule2: "4.2 Dazu zählen unter anderem: Verbreitung illegaler Inhalte, Verletzung der Rechte Dritter, Betrug, Störung des Systems usw.", userAgreementBehaviorRule3: "4.3 Bei solchen Verstößen ist MCHOSE berechtigt, Maßnahmen wie Verwarnung, Einschränkung der Nutzung, Sperrung des Kontos oder rechtliche Schritte einzuleiten.", userAgreementSection5Title: "5. Geistiges Eigentum", userAgreementIPOwnership: "5.1 Sämtliche Inhalte des Dienstes, einschließlich Layout, Design, Code, Schnittstellen, Grafiken und Struktur, sind Eigentum von MCHOSE oder deren Lizenzgebern.", userAgreementIPRestriction: "5.2 Ohne ausdrückliche Genehmigung dürfen diese Inhalte nicht kopiert, verbreitet, verändert, übertragen oder kommerziell genutzt werden.", userAgreementSection6Title: "6. Datenschutz", userAgreementPrivacyNotice1: "6.1 Der Schutz Ihrer Privatsphäre ist uns sehr wichtig. Informationen darüber, wie wir Ihre personenbezogenen Daten erheben, verwenden, speichern und schützen, finden Sie in unserer Datenschutzerklärung.", userAgreementPrivacyNotice2: "6.2 Bitte lesen Sie diese Erklärung sorgfältig durch, bevor Sie den Dienst nutzen, um Ihre Rechte und unsere Pflichten zu verstehen.", userAgreementSection7Title: "7. Haftungsausschluss", userAgreementDisclaimer1: "7.1 Wir bemühen uns nach besten Kräften um einen stabilen Dienst und sichere Datenverarbeitung. Für Unterbrechungen des Dienstes, Datenverluste oder andere Schäden infolge höherer Gewalt oder Systemfehler übernehmen wir jedoch keine Haftung.", userAgreementDisclaimer2: "7.2 Schäden, die auf eigenes Verschulden des Nutzers zurückzuführen sind, trägt der Nutzer selbst.", userAgreementSection8Title: "8. Änderungen der Vereinbarung", userAgreementUpdate1: "8.1 MCHOSE behält sich das Recht vor, diese Vereinbarung entsprechend gesetzlicher Bestimmungen oder geschäftlicher Anforderungen zu aktualisieren. Die Nutzer werden per WeChat-Mitteilung oder auf anderem angemessenen Weg informiert.", userAgreementUpdate2: "8.2 Wenn Sie den Dienst weiterhin nutzen, gilt dies als Zustimmung zur aktualisierten Vereinbarung.", userAgreementSection9Title: "9. Anwendbares Recht und Streitbeilegung", userAgreementLaw1: "9.1 Für diese Vereinbarung gilt das Recht der Volksrepublik China.", userAgreementLaw2: "9.2 Im Falle von Streitigkeiten bemühen sich beide Parteien zunächst um eine gütliche Einigung. Gelingt dies nicht, kann jede Partei Klage bei einem zuständigen Gericht im Stadtbezirk Longgang, Shenzhen, einreichen.", userAgreementSection10Title: "10. Kontakt", userAgreementContactDesc: "Wenn Sie Fragen, Anregungen oder Beschwerden bezüglich dieser Datenschutzerklärung haben, können Sie uns wie folgt kontaktieren:", userAgreementServiceHotline: "10.1 Kundenservice-Hotline: 400-816-8986", userAgreementServiceTime: "10.2 Servicezeiten: Montag bis Freitag, 9:00–19:00 Uhr", userAgreementConclusion: "Vielen Dank für Ihr Vertrauen in den WeChat-Login-Dienst von MCHOSE. Wir werden uns weiterhin bemühen, Ihre Daten zu schützen und Ihre Privatsphäre zu wahren.", emailPlaceholder: "E-Mail eingeben", emailFormatError: "Ungültiges E-Mail-Format", emailSendCode: "Code anfordern", emailResend: "Erneut senden", emailResendCountdown: "Erneut senden ({n}s)", bindEmailGetCode: "Code anfordern", switchToWechatAria: "Tippen für WeChat-Login", switchToEmailAria: "Tippen für E-Mail-Login", cornerTooltipWechat: "Tippen für WeChat-Login", cornerTooltipEmail: "Tippen für E-Mail-Login", titleEmailLogin: "E-Mail-Anmeldung", titleWechatLogin: "WeChat-Anmeldung", titleBindEmail: "E-Mail verknüpfen", testEnvLoginTitle: "Anmeldung (Testumgebung)", testEnvSuffix: " (Test)", testCodePlaceholder: "Autorisierungscode (code) eingeben", btnLogin: "Anmelden", codeStepBack: "Zurück", enterVerificationCode: "Code eingeben", codeEmailCheckTitle: "Bitte E-Mail prüfen", codeEmailSentLine: "Code gesendet.", codeEmailInboxLine: "Bitte {email} prüfen", devOpenDevtools: "Entwicklertools öffnen", devInspectPage: "Seite untersuchen", msgSendCodeFailRetry: "Code konnte nicht angefordert werden", msgOtpSixDigits: "Bitte den 6-stelligen Code eingeben", msgWxConfigInitFail: "WeChat-Initialisierung fehlgeschlagen. Netzwerk prüfen.", msgLoginPageLoadFail: "Login-Seite konnte nicht geladen werden.", msgLoginFailRetry: "Anmeldung fehlgeschlagen. Bitte erneut versuchen.", msgTestEnterAuthCode: "Bitte Autorisierungscode eingeben", msgBindFailGeneric: "Verknüpfung fehlgeschlagen" }, user: { modifyNickname: "Spitzname ändern", modifyAvatar: "Avatar ändern", nicknamePlaceholder: "Bitte geben Sie einen neuen Spitznamen ein", nicknameTip: "Die Länge des Spitznamens ist auf 1-10 Zeichen begrenzt", nicknameEmpty: "Der Spitzname darf nicht leer sein", nicknameLengthError: "Die Länge des Spitznamens muss zwischen 1 und 10 Zeichen liegen", nicknameUpdateSuccess: "Spitzname aktualisiert", avatarUpdateSuccess: "Avatar erfolgreich aktualisiert" } }, gI = { common: { prompt: "Aviso", refresh: "Actualizar", cancel: "Cancelar", close: "Cerrar", restore: "Restaurar defecto", iKnowIt: "Entendido", notAdminRunning: "Esta operación requiere privilegios de administrador. Salga de la aplicación, haga clic derecho en el icono y seleccione “Ejecutar como administrador”. Luego reinicie e intente nuevamente.", clickLogin: "Iniciar sesión", cloudEqTip: "Después de iniciar sesión, podrá usar las funciones en la nube (más funciones de compartir configuraciones están en desarrollo, próximamente).", editNickname: "Editar nombre", changeAvatar: "Cambiar avatar", avatarTip: "Se admiten formatos JPG y PNG, el archivo no debe superar los 2 MB", logout: "Cerrar sesión", autoWechatLogin: "Marca la casilla para iniciar sesión automáticamente con WeChat", privacyPrefix: "Al iniciar sesión, aceptas el", userAgreement: "Acuerdo de usuario", loginSuccess: "Inicio de sesión exitoso", emailLoginSuccess: "Inicio de sesión exitoso", bindWechatAction: "Vincular WeChat", bindWechatSuccess: "WeChat vinculado", bindWechatFailed: "Error al vincular WeChat", wechatAlreadyBoundOtherEmail: "El WeChat ya está vinculado a otro correo", emailAlreadyBoundOtherWechat: "El correo ya está vinculado a otro WeChat", unbindEmail: "Desvincular correo", unbindEmailGetCode: "Obtener código", unbindEmailSuccess: "Desvinculación exitosa", unbindEmailCodeInvalid: "Código inválido", accountBindWechat: "Vincular WeChat", accountBindEmail: "Vincular correo", accountUnbindEmail: "Desvincular correo", bindEmailSuccess: "Vinculación exitosa", logoutSuccess: "Sesión cerrada", changesSubmitted: "Cambios enviados, espera la revisión", nicknameEmpty: "El nombre no puede estar vacío", enterNickname: "Introduce un nombre", confirm: "Aceptar", official: "Oficiales", game: "Juegos", music: "Música", cloud: "Comunidad en la nube", cloudShared: "Compartido", favorited: "Favoritos", myShares: "Mis datos", search: "Buscar", latest: "Recientes", topUsed: "Usados", topLiked: "Favoritos", topFav: "Guardados", author: "Autor", import: "Importar", imported: "Importado", favoritedStatus: "Añadido a favoritos", removedFromFavorites: "Eliminado de favoritos", liked: "Marcado como me gusta", unliked: '"Me gusta" eliminado', importedToCustom: "Importado a Personalizado", importFailed: "Error al importar, máximo 20", pleaseLogin: "Inicia sesión para continuar", maxFavorites: "Máximo 20 favoritos", noUserUploads: "Ningún usuario ha subido contenido", noSearchResults: "No se encontraron resultados, prueba con otra palabra~", noFavorites: "Sin favoritos", noSharesYet: "Aún no has compartido nada", cancelSharing: "Cancelar compartido", notice: "Aviso", confirmCancelShare: '¿Cancelar el uso compartido de <strong>"{name}"</strong>?', delete: "Del", custom: "Personalizado", myPresets: "Creado por mí", localImport: "Importar", cloudImports: "Importado de la nube", confirmDelete: '¿Eliminar "xxx"? Esta acción no se puede deshacer. Se recomienda exportar primero', confirmDeleteReview: '¿Eliminar <strong>"{name}"</strong>? Este ecualizador está en revisión y podría seguir apareciendo en la nube si se aprueba.', confirmDeleteSimple: '¿Eliminar <strong>"{name}"</strong>?', fromAuthor: "De:", shareToCloud: "Compartir", shareSuccess: "Compartido con éxito", sharingCanceled: "Compartir cancelado", maxSharesPerUser: "Máximo 10 compartidos por usuario", selectCategory: "Seleccionar categoría", other: "Otros", selectGameTag: "Selecciona una etiqueta de juego", enterPresetTitle: "Introduce un título", shareTitlePlaceholder: "Ponle un buen nombre a tu ecualizador compartido", maxSharesPerUserSimple: "Máximo 10 compartidos por usuario", shareSuccessful: "Compartido con éxito", confirmShareOverwrite: "Este ecualizador ya fue compartido. ¿Quieres sobrescribir el anterior?", share: "Comp", restoreDefault: "Restaurar defecto", restoreDefaultSuccess: "Restablecido a configuraciones predeterminadas.", underReview: "En revisión", export: "Exp", underReviewTryLater: "En revisión, inténtalo más tarde", underReviewDeleteWarning: "Eliminar interrumpirá la revisión", shareFailTitle: "Error: título no permitido", shared: "Comp.", exitPreview: "Salir de vista previa", nicknameViolation: "No válido", nicknameViolationTip: "El apodo no es válido. Por favor, modifíquelo", rename: "Renombrar", copy: "Cop", copied: "Copiado", noCloudImport: "Sin EQ en la nube", unknown: "Desconocido", noDescription: "Sin descripción", shareRequestSubmitted: "Solicitud de compartir enviada", copySuffix: "copy", view: "Ver", sysChanged: "EQ no guardado. Pulsa <strong>[Guardar como personalizado]</strong>.", cmdENOENT: "Falta cmd.exe en el sistema. Por favor, repare el sistema e inténtelo de nuevo.", batchOperation: "Operación por lotes", selectAll: "Seleccionar todas", exitBatch: "Salir del modo por lotes", confirmBatchDeleteAll: '¿Eliminar <strong class="delete_name">todas</strong> las configuraciones?', confirmBatchDeleteSelected: "¿Eliminar las configuraciones seleccionadas?", using: "In Use", clickToUse: "Use Now", expert: "Configuración Pro", applySuccess: "EQ seleccionado activado", noData: "Sin datos" }, tray: { open: "Abrir M HUB", quit: "Salir" }, commonHeader: { officialStore: "Tienda Oficial", myDevice: "Mi dispositivo", back: "Regresar", backHome: "Volver al inicio", popoverTheme: "Cambiar fondo", popoverSetting: "Configuración", popoverRelatedApp: "Vincular juego/aplicación y cambiar automáticamente el perfil", popoverMin: "Minimizar", popoverUnmax: "Restaurar", popoverMax: "Maximizar", popoverClose: "Cerrar", offline: "El servidor actual está fuera de línea. Por favor, reinicie el controlador más tarde y vuelva a intentarlo", performanceOnDesc: "Después de desactivar el modo de rendimiento, se activarán los efectos de fondo transparente, vidrio moteado y esquinas redondeadas del borde, lo que hará que la interfaz sea más atractiva visualmente. Sin embargo, esto tiene ciertos requisitos de rendimiento del equipo.", performanceOffDesc: "Después de activar el modo de rendimiento, se eliminarán los efectos de fondo transparente, vidrio moteado y esquinas redondeadas del borde, lo que hará que la operación sea más fluida. Si se produce congelación al usar aplicaciones, se recomienda activarlo.", feedback: "Comentarios", prizeQuiz: "Encuesta con premio" }, themeSetting: { pageName: "Tema", white: "Blanco", black: "Negro", followSys: "Seguir el sistema", bg: "Fondo", followTheme: "Seguir el tema", customizeText: "Fondo personalizado (solo para la página de inicio)", changeBg: "Cambiar fondo", defaultBg: "Fondo predeterminado ", uploadImg: "Subir imagen", blurCard: "Desenfoque de la tarjeta del dispositivo", blurBg: "Desenfoque del fondo de imagen" }, setting: { version: "Versión actual", startup: "Inicio", startAuto: "Inicio automático", startAutoMini: "Minimizar a la bandeja del sistema al iniciar", language: "Idioma", closePanel: "Al cerrar el panel", exit: "Salir del programa", minimize: "Minimizar a la bandeja, no salir del programa", copyright: "" }, menus: { AudioConfiguration: "Configuración de audio", LightingSettings: "Configuración de luces", ScreenSettings: "Pantalla", OtherSettings: "Otros ajustes", GeneralParameters: "Parámetros regulares", Equalizer: "Ecualizador", SoundMode: "Modo de sonido", VirtualSurround: "Sonido virtual 7.1", CommonParams: "Parámetros comunes", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "La configuración de pantalla puede afectar la visualización del escritorio. Modifique el zoom y el diseño para el mejor resultado.", gotoSet: "Editar", needAdminNotice: "Es posible que algunas funciones no estén disponibles debido a permisos insuficientes. Cierre la aplicación, haga clic derecho en el ícono y seleccione “Ejecutar como administrador” para reiniciarla", loadFail: "Error al cargar", loadFailDesc: "Haga clic en el botón de actualizar para volver a cargar, o verifique la conexión de red y reinicie el controlador." }, devicePage: { needOtaNotice: "Se ha detectado una nueva versión de firmware. Debes actualizarla para utilizar el controlador normalmente. Descarga e actualiza el firmware.", needOtaNoticeTip: "Consejo: Después de descargar, dirígete a la ruta de guardado, abre el paquete de herramientas y sigue el tutorial para completar la actualización.", downloadNow: "Descargar ahora", restartNotice: "Después de instalar el controlador, debes reiniciar tu computadora para que funcione correctamente. Si el controlador no funciona después del reinicio, por favor contacta con el soporte técnico.", restartNow: "Reiniciar ahora", speakerDisabled: "Detección de Altavoz Deshabilitado, No se Puede Abrir el Controlador", step: "Pasos de Solución:", step1: "1.Haga clic en el botón [Dispositivos de Sonido de Windows] a continuación.", step2: '2.En el Panel de Control de Sonido del Sistema emergente (consulte el diagrama a continuación), seleccione "Reproducción". Busque el dispositivo correspondiente en la lista, haga clic derecho y habilite el altavoz, luego haga clic en "Aceptar".', step3: "3. Una vez habilitado, haga clic en el botón [Actualizar] a continuación.", isSleep: `Si auriculares en suspensión, reinícialos o verifica si 2.4G (puedes enchufar de nuevo receptor).
 Nota: Ctrl. no func. con cable audio conectado o disp. en Bluetooth.`, deviceLostLink: "Se ha perdido la conexión del driver", headphoneSleepStatus: "Los auriculares están en reposo", headphoneSleepStatusTips: "Use el botón o reinícielos", needLinkWireless: "El driver solo admite conexión 2.4G", needLinkWirelessHeadphoneTips: "Verifique que el receptor esté conectado y no use cable de audio ni Bluetooth", wiredMode: "Alámbrico", lessThan: "Menos del {val}", charging: "Cargando", sufficientCharge: "Suficiente energía", wiredVersion: "cableado", notAdminRunningHeadset: "Se requieren privilegios de administrador para los dispositivos de audio. Salga de la aplicación, haga clic derecho en el icono y seleccione “Ejecutar como administrador” para reiniciar la aplicación", thxInstallDialogTitle: "Instalando componentes de audio", thxInstallDialogTitleUpgrade: "Actualizando componentes de audio", thxInstallDialogDesc1: "Tardará 1–2 minutos, espere", thxInstallDialogDesc2: "No cierre el driver durante la instalación. Al finalizar, se abrirá la página del dispositivo" }, routine: { UserManual: "Manual", beepTitle: "Notificación sonora", beepTitleDesc: "Ajusta volumen de voz del headset (no afecta multimedia)", UserManualFull: "Manual de uso", Volume: "Volumen", Microphone: "Micrófono", MicAI: "Activar reducción de ruido AI", MicAIDesc: "Filtra ruido y mejora la claridad del audio", MicNoiseReduction: "Supresión de ruido estable", MicNoiseReductionDesc: "Atenúa los componentes de ruido constantes en bandas de frecuencia específicas, enfocándose en reducir la intensidad de sonidos como acondicionadores de aire o ventiladores.", MicListen: "Monitoreo de micrófono", MicListenDesc: "Escucha tu voz en tiempo real para ajustar volumen", MoYin: "Efectos mágicos son.:", MoYin_0: "Monstruo", MoYin_1: "Animación", MoYin_2: "Voz masculina", MoYin_3: "Voz femenina", WindowsAudioDevices: "Dispositivos de Sonido de Windows", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Modificado, guardado automáticamente", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Restaurar EQ de fábrica", eqEditorResetFactoryConfirm: "[{mode}] sobrescribirá la configuración actual del ecualizador y restaurará los valores de fábrica.", eqEditorResetFactoryDone: "El modo {n} se ha restaurado al ecualizador predeterminado de fábrica.", eqSwitchUnsavedHint: "Ha modificado el ecualizador del modo actual. Aplicar otro EQ directamente sobrescribirá su edición.", eqSwitchApplyDirect: "Aplicar directamente", eqSwitchSaveThenApply: "Guardar y aplicar", AudioBright: "Mejora brillo audio", AudioBrightDesc: "Realza las frecuencias altas del audio para hacer el sonido más claro y rico en detalles, mejorando de manera efectiva la brillantez y expresividad general del audio.", SurroundAmplification: "Mejora sonido envolvente", SurroundAmplificationDesc: 'Mejora el efecto espacial del audio, ampliando la "zona" de sonido, simulando reflexiones y difusiones, creando la sensación de estar en un espacio más grande rodeado de altavoces.', DynamicLF: "Baja frecuencia dinámica", DynamicLFDesc: "Ajuste inteligente de las frecuencias bajas, mejorando la fuerza y profundidad durante ritmos fuertes, haciendo los graves más potentes. Reducir las frecuencias bajas permite un equilibrio natural del sonido, ofreciendo una experiencia auditiva dinámica y variada.", SmartVolume: "Volumen inteligente", SmartVolumeDesc: "Detecta automáticamente cambios en el volumen de audio, ajustándolo inteligentemente a un nivel adecuado. Evita aumentos y disminuciones repentinas, proporcionando una experiencia de escucha estable sin necesidad de ajustes manuales frecuentes.", VocalClarity: "Claridad vocal", VocalClarityDesc: "Optimiza con precisión la banda de frecuencias de voz humana, reduciendo ruidos e interferencias de fondo, destacando la pureza vocal. Esto permite capturar articulaciones claramente y disfrutar de una experiencia auditiva excelente al escuchar música, ver películas o realizar llamadas.", MusicMode: "Modo música (Alto)", VoiceMode: "Modo Voz (Bajo)", NCut: "Supr. ruido", Freqtrap: "Intercepción", Intensity: "Intensidad", DYIntensity: "Intensidad", QXIntensity: "Intensidad", Speech: "Notificaciones de Voz", SpeechDesc: 'Retroalimentación de voz durante el funcionamiento del altavoz (también puede habilitar o deshabilitar la retroalimentación de voz manteniendo presionados simultáneamente los botones físicos "+" y "G" del altavoz durante {time} segundos).', SpeechDescK20Pro: "Guía de voz durante la operación del altavoz (mantén presionado el botón del micrófono del altavoz durante {time} s para activar o desactivar la guía de voz)", micDisabled: "Micrófono deshabilitado", micDisabledTitle: "Detección de Micrófono Deshabilitado, No se Puede Usar Correctamente", step: "Pasos de Solución:", step1: "1.Haga clic en el botón [Dispositivos de Sonido de Windows] a continuación.", step2: '2.En el Panel de Control de Sonido del Sistema emergente (consulte el diagrama a continuación), seleccione "Grabación". Busque el dispositivo correspondiente en la lista, haga clic derecho y habilite el micrófono, luego haga clic en "Aceptar".', step3: "3.Una vez habilitado, haga clic en el icono [Actualizar] a continuación." }, eq: { title: "Ecualizador", game1: "Modo EQ 1", game2: "Modo EQ 2", game3: "Modo EQ 3", eqSlotDefaultDesc: "Ranura de preset integrada", popover2: "Un ecualizador, similar a una consola de mezclas, permite ajustar la frecuencia y volumen del audio. Puedes modificar las bandas de frecuencias altas y bajas según tu preferencia. Por ejemplo, durante juegos, puedes realzar los graves para enfatizar explosiones y pasos, y aumentar las frecuencias altas para hacer disparos y colisiones más claras, creando un efecto de sonido personalizado que mejora la inmersión y la ventaja competitiva.", popover: "El ecualizador permite ajustar frecuencias", import: "Importar", 默认: "Predeterminado", 音乐清脆风: "Estilo nítido", 音乐清脆风1: "Estilo nítido1", 音乐清脆风2: "Estilo nítido2", "3D影视": "Películas 3D", 舞曲: "Música de baile", 饶舌曲: "Rap", 重金属: "Heavy metal", 爵士: "Jazz", 抒情摇滚: "Soft rock", 摇滚: "Rock", 现场: "En vivo", 高音: "Agudos", 低音: "Graves", bandBass: "Graves", bandLowMid: "Medio-graves", bandMid: "Medios", bandHighMid: "Medio-agudos", bandHigh: "Agudos", 古典乐: "Música clásica", 声乐: "Vocal", 无畏契约: "valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Personalizado", more: "Más opciones.", empty: "Sin efectos seleccionados", renamePlaceholder: "Por favor, introduce un nombre personalizado", export: "Exportar", delete: "Eliminar", saveAs: "Guardar como personalizado", reset: "Restaurar defecto", newNameTitle: "Personalizado", newNamePlaceholder: "Por favor, introduce un nombre personalizado", duplicate: "El nombre ya existe, por favor introduce uno diferente", ok: "Confirmar", importSuccess: "Importación exitosa", importFail: "Error en la importación, por favor intenta de nuevo", importFailName: "La importación falló debido a un nombre duplicado. Por favor, realice modificaciones", exportSuccess: "Exportación exitosa", exportFail: "La exportación falló, por favor intenta de nuevo", deleteTitle: "Aviso", delPre: '¿Estás seguro de que quieres eliminar "', delAfter: "? Esta acción no se puede deshacer. Se recomienda exportar primero", expertListTip: "Los presets profesionales están vinculados al modo de sonido. Para un mejor audio, no se recomienda cambiar el modo." }, mode: { modeDesc: `Los diferentes modos se pueden cambiar con un solo clic,
lo que le brinda una experiencia auditiva exclusiva y extrema`, gameMode: "modo juego", gameMode1: "modo juego 1", gameMode2: "modo juego 2", musicMode: "modo música", movieMode: "modo película", gameModeDesc: "Resalta los detalles de disparos y pasos, ideal para juegos FPS competitivos", musicModeDesc: "Ajuste profesional que restaura los detalles del sonido, ideal para escenas musicales inmersivas", movieModeDesc: "Ofrece una experiencia de sonido de nivel cinematográfico, ideal para películas inmersivas", gameModeDesc2: "Resalta los sonidos ambientales del campo de batalla, ideal para juegos FPS de guerra" }, light: { switch: "Iluminación", switchOn: "Luz activada", switchOff: "Luz desactivada", title: "Efectos de iluminación", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Flujo Estelar", goFlow: "Waves", continue: "Duración", duan: "Corto", chang: "Largo", an: "Oscuro", guang: "Brillante", direction: "Dirección", clockwise: "s. hor.", anticlockwise: "s. antihor.", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB activa", syncClosed: "La sincronización RGB se ha desactivado y se ha aplicado el efecto seleccionado", flowing_f: "Flowing Light - Fast", speed: "Velocidad", fast: "Rápida", slow: "Lenta", colorjoe: "Paleta", reset: "Restaurar defecto", notView: "Este efecto de iluminación no admite vista previa.", color: "Color", lightShow: "Indicación de la iluminación", lightShow1: "Encender todas las luces", lightShow2: "Apagar las luces del medio", lightShow3: "Apagar las luces de los lados", smartLight: "Iluminación inteligente", smartLightDesc: "Al activar, tras 30 min sin uso ni reproducción, la pantalla y la luz ambiental entrarán en brillo bajo automáticamente", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Velocidad y brillo", brightness: "brillo" }, surround: { switch: "Sonido virtual 7.1", popover: "Simula un sonido envolvente de 7.1 canales. Una vez activado, te permite percibir el sonido desde múltiples direcciones, sumergiéndote en escenas de juegos o tramas de películas, localizando con precisión la dirección y distancia de los sonidos, ofreciendo una experiencia auditiva tridimensional e inmersiva.", popoverGame: "El sonido virtual 7.1 no es apto para juegos FPS; recomendado para juegos AAA y medios.", mode: "Selección de modo", music: "Modo música/juego", movie: "Modo película", test: "Prueba de altavoz", start: "Iniciar prueba", stop: "Detener prueba", size: "Tamaño hab.", small: "Pequeño", mid: "Mediano", big: "Grande" }, otherSettings: { alreadyLatest: "El firmware ya está actualizado, no es necesario actualizar", v9TurboHeadset: "Por favor, use el modo 2.4G para conectarse a la actualización.", latest: `Ya está
Actualizado`, goUpdate: "Actualizar", baseV: "Versión del firmware de la base:", usbV: "Versión USB del disp.:", firmwareV: "Versión firmware del disp.:", headsetV: "Versión del firmware del auricular:", dongleV: "Versión del firmware del receptor:", findNew: "Detectada la última versión:", speakerShutdown: "Apagar Dispositivo", speakerShutdownDesc: "El controlador solo puede apagar, no encender", shutdown: "Apagar", speakerShutdownConfirm: "¿Seguro que desea apagar el dispositivo?", speakerShutdownSuccess: "El altavoz ha sido apagado", speakerShutdownDeviceError: "El dispositivo no está conectado, por favor, verifique el dispositivo", speakerShutdownFailed: "Apagar el altavoz falló", and: ", ", restoreFactory: "Restaurar configuración de fábrica", restoreFactoryDesc: "Todos los ajustes se restaurarán a los valores de fábrica, por favor procede con precaución", restore: `Restablecer
a fábrica`, restoreSuccess: "Restablecimiento de fábrica completado con éxito", downloading: "Descargando archivo de firmware…", updating: "Se está actualizando el firmware...", updatingNote: "Por favor, no salga del programa ni desenchufe o enchufe el dispositivo durante el proceso de actualización!", inDevelopment: "La función está en desarrollo...", readBinFail: "No se pudo leer el archivo de firmware", downloadBinFail: "No se pudo descargar el archivo de firmware", otaFail: "La actualización del firmware falló", otaFailResult: "La actualización del firmware falló. Puede intentar desconectar y reconectar el dispositivo y luego intentarlo de nuevo", otaSuc: "La actualización del firmware fue exitosa", otaSucDongle: "Actualización de firmware exitosa. Espere a que {deviceType} se reinicie automáticamente para que los cambios surtan efecto (aproximadamente 30 segundos).", otaSucHeadset: "Actualización de firmware exitosa. Espere aproximadamente 30 segundos, luego encienda manualmente los auriculares para que los cambios surtan efecto.", otaSucBoth: "Actualización de firmware del auricular y del receptor exitosa. Espere a que el dispositivo se reinicie automáticamente (aproximadamente 30 segundos).", deviceTypeDong: "receptor", deviceTypeDevice: "dispositivo", confirmFactoryReset: "Esta operación borrará todas las configuraciones. ¿Estás seguro de que deseas restaurar la configuración de fábrica?", powerManagement: "Gestión de energía", autoShutdown: "Apagado automático:", autoShutdownDesc: "Cuando los auriculares están fuera de la base (sin carga) y no hay reproducción durante el tiempo seleccionado, se apagarán automáticamente.", minutes: "Minutos", downloadTips1: "1.Se recomienda guardar el paquete de firmware en el escritorio.", downloadTips2Exe: "2.Haga doble clic para iniciar la actualización automática.", downloadTips2Zip: "2.Después de descomprimir, haga doble clic en el paquete de firmware para iniciar la actualización automática.", betterOtaTitle: "Se detectó nuevo firmware. Se recomienda actualizar." }, screenSettings: { screenOTAing: "Actualizando pantalla, espere", screenDisplay: "Pantalla", screenOn: "Pantalla encendida", screenOff: "Pantalla apagada", screenColor: "Color de Pantalla", presetSettings: "Configuración de cambio de fondo", personalizedPreset: "Fondo de pantalla", customText: "Texto", custom: "Personalizado", digitalClock: "Reloj Digital", musicSpectrum: "Espectro Musical", campusDaily: "Vida Universitaria", workplaceLife: "Vida Laboral", cutePets: "Mascotas Adorables", electronicGames: "Videojuegos", cyberTech: "Tecnología Cibernética", networkMeme: "Memes de Internet", customImage: "Imagen personalizada", customImageOTAWarning: "Actualice primero el firmware antes de usar esta función", addImage: "Añadir imagen", uploadImage: "Subir imagen", reuploadImage: "Volver a subir", supportImageFormat: "Compatible PNG/JPG/GIF. GIF solo primeros 30 fotogramas", previewImage: "Vista previa", text: "Texto", scenery: "Paisaje", character: "Persona", uploadingToScreen: "Subiendo a la pantalla", reverseColor: "Invertir colores", scaleScreen: "Escalar pantalla", scaleImage: "Escalar imagen", blackWhiteRatio: "Proporción blanco/negro", deleteImageConfirm: "¿Eliminar esta imagen? No se puede recuperar", deleteImage: "Eliminar", batchDeleteImage: "Eliminar en lote", selectAll: "Seleccionar todo", cancelSelectAll: "Deseleccionar todo", processImage: "Procesar imagen", exitBatch: "Salir de lote", deleteSelectedImageConfirm: "¿Eliminar imágenes seleccionadas? No se puede recuperar", textContent: "Contenido de Texto", textLengthLimit: "Se alcanzó el límite de caracteres", save: "Guardar", savedSuccess: "Guardado", historyRecords: "Historial", clearHistory: "Borrar Historial con Un Clic", historyTip: "Mostrar Solo los Últimos 20 Registros", textEffect: "Efecto de Texto", staticDisplay: "Visualización Estática", dynamicDisplay: "Visualización Dinámica", alignment: "Alineación", leftAlign: "Alinear a la Izquierda", centerAlign: "Centrar", rightAlign: "Alinear a la Derecha", justifyAlign: "Justificar", scrollEffect: "Efecto de Desplazamiento", scrollToRight: "De Izquierda a Derecha", scrollToLeft: "De Derecha a Izquierda", customColors: "Color Personalizado", clearCustomColors: "Borrar colores", syncToLight: "Mantener presionado para editar color", shortPress: "Presión Corta", lyrics: "Letra", lyricsDisplay: "Mostrar letra（BETA）", lyricsDisplayHintLead: "Al reproducir audio compatible con la letra, la pantalla mostrará la letra actual.", lyricsDisplayCantSeeLink: "¿No ves la letra?", lyricsDisplayCantSeeTooltip: "Actualmente solo se admiten algunas apps de música. Actualícelas y refresque M HUB", lyricsOn: "Activado", lyricsOff: "Desactivado", lyricsAnimation: "Animación de letra", notSupportSyncToLight: "El efecto de iluminación actual es multicolor, no se admite sincronización de color", syncToLightSuccess: "Sincronización Exitosa", uploadToScreenTip: "Aprox. {time}s, no salga", deleteCustomColorConfirm: "¿Seguro que deseas eliminar el color actual?", deleteAllCustomColorsConfirm: "¿Seguro que deseas eliminar todos los colores personalizados?", minimumSelectionToast: "Выберите не менее 2", textVerifyFailed: "La pantalla de píxeles no admite emojis ni símbolos especiales. Usa solo texto", lyricsAnimationOption1: "Entrada: De abajo hacia arriba. Salida: De abajo hacia arriba", lyricsAnimationOption2: "Entrada: Expandir desde el centro. Salida: Contraer hacia el centro", lyricsAnimationOption3: "Entrada: De izquierda a derecha. Salida: De derecha a izquierda", lyricsAnimationOption4: "Entrada: De abajo hacia arriba. Salida: De arriba hacia abajo", lyricsAnimationOption5: "Entrada: De arriba hacia abajo. Salida: De derecha a izquierda", lyricsAnimationDemo: "Demo de animación de letra", uploadingImgTip: "Hay una imagen en subida, intenta más tarde" }, update: { alreadyNew: "La última versión", findNew: "Última versión detectada", ignore: "Ignorar", update: "Actualizar", showHistory: "Ver versiones históricas", updating: "Actualización del controlador en progreso...", rollingBack: "Volviendo a la versión histórica {version}...", updateContentTitle: "Actualización del controlador", updateContent: "Contenido de la actualización del controlador:", updateNow: "Actualizar ahora", back: "Regresar", historyTitle: "Versión histórica", version: "Número de versión", date: "Fecha de actualización", backToList: "Volver al nivel anterior", only30: "Conservar las últimas 30 versiones históricas", operation: "Operación", watchContent: "Buscar actualizaciones", rollTo: "Volver a esa versión", currentVersion: "Versión actual", updateTo: "Actualizar a esta versión", updateSuccess: "Actualización del controlador completada", revertSuccess: "Regresado a la versión histórica {version}", updatePre: "Actualización en progreso, por favor espera...", updateAfter: "La aplicación se reiniciará automáticamente en breve. Por favor, espere", inviteUpdate1: "Descubre una nueva versión, ", inviteUpdate2: "te invitamos a actualizar ", inviteUpdate3: "de inmediato.", notAdminRunning: "Se requieren privilegios de administrador para realizar la actualización. Salga de la aplicación, haga clic derecho en el icono y seleccione “Ejecutar como administrador”. Una vez iniciada, intente actualizar nuevamente", updateResultFail: "La actualización falló, lo que puede causar que algunas funciones no estén disponibles. Desinstale el programa y luego vaya al sitio web oficial de Maicong para descargar el último paquete de instalación e instalarlo", updateFailAfter: "Hubo una anomalía durante la creación del paquete comprimido. Desinstale el programa y luego vaya al sitio web oficial de Maicong para descargar el último paquete de instalación e instalarlo", updateFailPre: "Hubo una anomalía durante la etapa de pre-procesamiento de la actualización. Intente nuevamente más tarde. Si sigue fallando, desinstale el controlador y luego vaya al sitio web oficial de Maicong para descargar el último paquete de instalación del controlador e instalarlo de nuevo", updateUpFailDefault: "La actualización del controlador falló. Intente nuevamente más tarde", updateBackFailDefault: "No se pudo revertir a la versión anterior. Intente nuevamente más tarde", notSupportUpdate: "La versión actual no admite la actualización en línea. Vaya al sitio web oficial de Maicong para descargar la última versión del paquete de instalación e instalarlo de nuevo", restartFinishUpdate: "Reiniciar driver" }, musicDance: { settingPanel: "Panel de control del ritmo musical", scaleEffect: "Zoom en el ritmo", scaleKeyboard: "Zoom Keyboard", showEffect: "Zoom en el teclado", showKeyboard: "Mr. ritmo", reset: "Mt. teclado", needWinVcTitle: "Falta la biblioteca de ejecución Windows MSVC en el sistema, por lo que algunas funciones pueden estar limitadas", needWinVcDesc: "Descargue e instale la biblioteca oficial de Microsoft, es decir, vc_redist.x64.exe, y luego reinicie la aplicación：", needWinVcLink1: "Dirección oficial de descarga de Microsoft:", needWinVcLink2: "Dirección de descarga de respaldo:", download: "Haga clic para descargar", needWinVcNotice: "Si este mensaje sigue apareciendo después de la instalación, es posible que su sistema aún no sea compatible con esta función" }, wechatLogin: { privacyPrefix: "Al iniciar sesión, aceptas el", privacyPolicy: "“Política de privacidad”", privacySuffix: "“Acuerdo de usuario”", privacyAnd: "y la", privacyEnd: "", accountMergeHint: "Tras vincular, puede iniciar sesión con WeChat/correo; datos combinados", accountUnbindEmailHint: "Tras desvincular, los datos permanecen en WeChat", privacyPolicyTitle: "Política de privacidad", userAgreement: "Acuerdo de usuario", privacyWelcome: "¡Bienvenido al Servicio de Inicio de Sesión Autorizado de WeChat de MCHOSE! Este Acuerdo de Usuario (en adelante, el “Acuerdo”) se celebra entre Shenzhen MCHOSE Technology Co., Ltd. (en adelante, “nosotros” o “MCHOSE”) y usted (en adelante, “usted” o “usuario”) respecto a los derechos y obligaciones relacionados con el servicio de inicio de sesión autorizado a través de WeChat proporcionado por MCHOSE (en adelante, el “Servicio”).", privacyReadNotice: "Le rogamos que lea y comprenda cuidadosamente esta política antes de usar el servicio. Al utilizar este servicio, usted declara haber leído, comprendido y aceptado todos los contenidos de esta Política de Privacidad.", privacySection1Title: "1. Información que recopilamos", privacySection1Desc: "Durante el uso del servicio, podemos recopilar la siguiente información:", privacyWechatInfo: `1.1 Información de autorización de WeChat
Cuando inicia sesión a través de WeChat, recopilamos información básica como su apodo, avatar, OpenID y UnionID mediante la interfaz de la plataforma WeChat, para identificar su cuenta y proporcionar servicios personalizados.`, privacyCloudData: `1.2 Datos de uso en la nube
Los archivos de configuración que cargue, guarde o utilice se almacenarán en nuestros servidores en la nube para permitir la sincronización entre dispositivos.`, privacySection2Title: "2. Cómo usamos la información", privacySection2Desc: "Recopilamos su información solo para los siguientes propósitos legales, legítimos y necesarios:", privacyServiceFunction: `2.1 Para brindar funciones del servicio
Proporcionar servicios principales como inicio de sesión autorizado por WeChat, almacenamiento en la nube y uso de archivos de configuración.`, privacyServiceSecurity: `2.2 Para garantizar la seguridad del servicio
Para verificar la identidad, detectar anomalías, resolver fallas y mejorar la estabilidad y seguridad del sistema.`, privacySection3Title: "3. Almacenamiento y protección de la información", privacyStorageLocation: `3.1 Ubicación y período de almacenamiento
Todos los datos de usuarios se almacenan en servidores ubicados dentro de China continental. Conservamos su información solo durante el tiempo necesario para lograr los propósitos mencionados anteriormente, tras lo cual se eliminará o anonimizará.`, privacySecurityMeasures: `3.2 Medidas de seguridad de la información
Aplicamos múltiples tecnologías de cifrado, control de acceso, auditoría de registros y otras medidas técnicas para proteger los datos contra accesos no autorizados, divulgación, alteración o destrucción.`, privacySection4Title: "4. Sus derechos", privacyRightsDesc: "De acuerdo con las leyes y regulaciones aplicables, usted tiene los siguientes derechos:", privacyQueryAccess: `4.1 Consulta y acceso
Tiene derecho a consultar si almacenamos su información personal y a acceder a ella.`, privacyCorrectionDelete: `4.2 Corrección y eliminación
Si encuentra que la información que poseemos es inexacta o inválida, puede solicitar su corrección o eliminación.`, privacyCancelWithdraw: `4.3 Cancelación de cuenta y retirada de autorización
Puede cancelar su cuenta o retirar su autorización a través de la plataforma WeChat o contactándonos. En tal caso, dejaremos de procesar su información, salvo cuando la ley exija lo contrario.`, privacySection5Title: "5. Actualizaciones de la política", privacyPolicyUpdate: "Podemos actualizar esta Política de Privacidad según el desarrollo del negocio o cambios legales. La política actualizada será comunicada mediante anuncios en la mini aplicación de WeChat u otros medios razonables. El uso continuado del servicio constituye la aceptación de la política actualizada.", privacySection6Title: "6. Contáctenos", privacyContactDesc: "Si tiene alguna pregunta, sugerencia o queja sobre esta política, puede contactarnos a través de:", privacyServiceHotline: "6.1 Línea de atención al cliente: 400-816-8986", privacyServiceTime: "6.2 Horario de atención: lunes a viernes, de 9:00 a 19:00 horas", privacyConclusion: "Gracias por confiar y utilizar el servicio de inicio de sesión autorizado por WeChat de MCHOSE. Seguiremos esforzándonos para proteger su información y su privacidad.", userAgreementWelcome: "¡Bienvenido al Servicio de Inicio de Sesión Autorizado de WeChat de MCHOSE! Este Acuerdo de Usuario (en adelante, el “Acuerdo”) se celebra entre Shenzhen MCHOSE Technology Co., Ltd. (en adelante, “nosotros” o “MCHOSE”) y usted (en adelante, “usted” o “usuario”) respecto a los derechos y obligaciones relacionados con el servicio de inicio de sesión autorizado a través de WeChat proporcionado por MCHOSE (en adelante, el “Servicio”).", userAgreementReadNotice: "Le rogamos que lea detenidamente y comprenda todo el contenido de este Acuerdo antes de utilizar el Servicio, especialmente las cláusulas referentes a limitaciones de responsabilidad y restricciones de sus derechos.", userAgreementSection1Title: "1. Requisitos para el uso del Servicio", userAgreementSection1Desc: "1.1 Usted declara y garantiza expresamente que:", userAgreementLegalCapacity: "· Tiene la capacidad legal para celebrar este Acuerdo y utilizar el Servicio;", userAgreementMinorNotice: "· Si es menor de edad, deberá usar el Servicio bajo la supervisión y con el consentimiento de un tutor legal. Si tiene menos de catorce (14) años, deberá obtener el consentimiento explícito o la supervisión de su tutor legal antes de utilizar el Servicio.", userAgreementRequirements: "1.2 Para usar el Servicio, debe contar con un dispositivo compatible con conexión a internet, instalar la aplicación WeChat y realizar el inicio de sesión autorizado a través de WeChat.", userAgreementSection2Title: "2. Inicio de sesión y uso de la cuenta", userAgreementLoginProcess: "2.1 El Servicio se basa en la plataforma WeChat para el inicio de sesión autorizado. Debe aceptar y completar el proceso de autorización WeChat en su primer uso para crear o identificar su cuenta de servicio MCHOSE.", userAgreementInfoAccuracy: "2.2 Usted debe garantizar la veracidad y exactitud de la información autorizada, y actualizarla oportunamente para asegurar el correcto uso del Servicio.", userAgreementAccountSecurity: "2.3 Debe proteger adecuadamente su cuenta WeChat y la información relacionada. Usted asume toda responsabilidad por pérdidas ocasionadas por pérdida o filtración de su cuenta.", userAgreementSection3Title: "3. Contenido del Servicio", userAgreementCloudService: "3.1 Servicios en la nube: carga, almacenamiento, sincronización y gestión de archivos de configuración en la nube;", userAgreementConfigCall: "3.2 Aplicación de configuración: importar archivos de configuración cargados por el usuario para una experiencia personalizada;", userAgreementOfficialSync: "3.3 Sincronización de archivos de configuración oficiales: sincronización en tiempo real de los últimos archivos oficiales.", userAgreementServiceAdjustment: "MCHOSE se reserva el derecho de añadir, eliminar o ajustar el contenido del Servicio según el desarrollo del negocio, sin previo aviso.", userAgreementSection4Title: "4. Normas de conducta del usuario", userAgreementBehaviorRule1: "4.1 Usted no debe participar en actividades ilegales, infringir derechos ajenos ni dañar la seguridad del sistema durante el uso del Servicio;", userAgreementBehaviorRule2: "4.2 Incluyendo, pero sin limitarse a: difusión de información ilegal, vulneración de derechos de terceros, fraude, interferencia con los sistemas de la plataforma, entre otros;", userAgreementBehaviorRule3: "4.3 Frente a tales conductas, MCHOSE podrá imponer advertencias, restricciones de uso, bloqueo de cuentas y acciones legales.", userAgreementSection5Title: "5. Propiedad intelectual", userAgreementIPOwnership: "5.1 Todo el contenido del Servicio, incluyendo diseño de interfaz, código, interfaces, gráficos y disposiciones, pertenece a MCHOSE o a sus licenciantes;", userAgreementIPRestriction: "5.2 Queda prohibida la copia, distribución, modificación, transferencia o uso comercial sin autorización previa.", userAgreementSection6Title: "6. Protección de la privacidad", userAgreementPrivacyNotice1: "6.1 Valoramos altamente la protección de su privacidad. Para detalles sobre cómo recopilamos, usamos, almacenamos y protegemos su información personal, consulte nuestra Política de Privacidad.", userAgreementPrivacyNotice2: "6.2 Lea cuidadosamente dicha política antes de usar el Servicio para comprender sus derechos y nuestras obligaciones.", userAgreementSection7Title: "7. Exención de responsabilidad", userAgreementDisclaimer1: "7.1 Haremos todo lo posible para mantener la estabilidad del Servicio y la seguridad de los datos, pero no nos responsabilizamos por interrupciones, pérdidas de datos u otros problemas causados por fuerza mayor o fallos del sistema;", userAgreementDisclaimer2: "7.2 Usted asume toda responsabilidad por pérdidas causadas por su propia acción.", userAgreementSection8Title: "8. Actualización y cambios en el Acuerdo", userAgreementUpdate1: "8.1 MCHOSE se reserva el derecho de actualizar este Acuerdo conforme a leyes, regulaciones y ajustes comerciales, notificándolo mediante anuncios en WeChat u otros medios razonables;", userAgreementUpdate2: "8.2 El uso continuado del Servicio se considerará aceptación del Acuerdo actualizado.", userAgreementSection9Title: "9. Ley aplicable y resolución de disputas", userAgreementLaw1: "9.1 Este Acuerdo se rige por las leyes de la República Popular China;", userAgreementLaw2: "9.2 En caso de disputa, ambas partes intentarán resolverla mediante negociación; si no se logra acuerdo, cualquiera podrá presentar demanda ante los tribunales competentes del distrito de Longgang, Shenzhen.", userAgreementSection10Title: "10. Contacto", userAgreementContactDesc: "Si tiene alguna pregunta, sugerencia o queja relacionada con esta Política de Privacidad, puede contactarnos a través de:", userAgreementServiceHotline: "10.1 Línea de atención al cliente: 400-816-8986", userAgreementServiceTime: "10.2 Horario de servicio: lunes a viernes, de 9:00 a 19:00 horas", userAgreementConclusion: "Gracias por confiar y usar el Servicio de Inicio de Sesión Autorizado de WeChat de MCHOSE. Continuaremos esforzándonos para proteger la seguridad de su información y sus derechos de privacidad.", emailPlaceholder: "Ingrese correo", emailFormatError: "Formato de correo incorrecto", emailSendCode: "Obtener código", emailResend: "Reenviar", emailResendCountdown: "Reenviar ({n}s)", bindEmailGetCode: "Obtener código", switchToWechatAria: "Toca para usar WeChat", switchToEmailAria: "Toca para usar correo", cornerTooltipWechat: "Toca para usar WeChat", cornerTooltipEmail: "Toca para usar correo", titleEmailLogin: "Inicio de sesión con correo", titleWechatLogin: "Inicio de sesión con WeChat", titleBindEmail: "Vincular correo", testEnvLoginTitle: "Entorno de prueba", testEnvSuffix: " (prueba)", testCodePlaceholder: "Introduzca el código de autorización (code)", btnLogin: "Iniciar sesión", codeStepBack: "Volver", enterVerificationCode: "Ingrese código", codeEmailCheckTitle: "Revise su correo", codeEmailSentLine: "Código enviado.", codeEmailInboxLine: "Revise {email}", devOpenDevtools: "Abrir DevTools", devInspectPage: "Inspeccionar página", msgSendCodeFailRetry: "Error al obtener código", msgOtpSixDigits: "Introduzca el código de 6 dígitos", msgWxConfigInitFail: "Error al inicializar WeChat. Compruebe la red.", msgLoginPageLoadFail: "Error al cargar la página de inicio. Inténtelo de nuevo.", msgLoginFailRetry: "Error de inicio de sesión. Inténtelo de nuevo.", msgTestEnterAuthCode: "Introduzca el código de autorización", msgBindFailGeneric: "Error al vincular" }, user: { modifyNickname: "Modificar apodo", modifyAvatar: "Modificar avatar", nicknamePlaceholder: "Por favor ingrese un nuevo apodo", nicknameTip: "La longitud del apodo está limitada a 1-10 caracteres", nicknameEmpty: "El apodo no puede estar vacío", nicknameLengthError: "La longitud del apodo debe estar entre 1 y 10 caracteres", nicknameUpdateSuccess: "Apodo actualizado", avatarUpdateSuccess: "Avatar actualizado con éxito" } }, yI = { common: { prompt: "Commande", refresh: "Rafraîchir", cancel: "Annuler", close: "Fermer", restore: "Restore defaults", iKnowIt: "J'ai compris", notAdminRunning: "Cette opération nécessite les droits administrateur. Veuillez quitter l’application, faire un clic droit sur l’icône, sélectionner « Exécuter en tant qu’administrateur », puis redémarrer et réessayer.", clickLogin: "Se connecter", cloudEqTip: "Après connexion, les fonctions cloud seront disponibles (d’autres fonctions de partage de configuration sont en cours de développement, restez à l’écoute).", editNickname: "Modifier le pseudo", changeAvatar: "Changer l'avatar", avatarTip: "Formats JPG et PNG pris en charge, taille max. 2 Mo", logout: "Se déconnecter", autoWechatLogin: "Cochez l'option ci-dessous pour passer automatiquement à la connexion WeChat", privacyPrefix: "En vous connectant, vous acceptez les", userAgreement: "Contrat d'utilisateur", loginSuccess: "Connexion réussie", emailLoginSuccess: "Connexion réussie", bindWechatAction: "Lier WeChat", bindWechatSuccess: "WeChat associé", bindWechatFailed: "Échec de l’association WeChat", wechatAlreadyBoundOtherEmail: "Ce WeChat est déjà lié à un autre e-mail", emailAlreadyBoundOtherWechat: "Cet e-mail est déjà lié à un autre WeChat", unbindEmail: "Délier l'e-mail", unbindEmailGetCode: "Obtenir le code", unbindEmailSuccess: "Déliaison réussie", unbindEmailCodeInvalid: "Code invalide", accountBindWechat: "Lier WeChat", accountBindEmail: "Lier l'e-mail", accountUnbindEmail: "Délier l'e-mail", bindEmailSuccess: "Liaison réussie", logoutSuccess: "Déconnexion réussie", changesSubmitted: "Modification envoyée, en attente de validation", nicknameEmpty: "Le pseudo ne peut pas être vide", enterNickname: "Veuillez saisir un pseudo", confirm: "Confirmer", official: "Officiels", game: "Jeu", music: "Musique", cloud: "Communauté cloud", cloudShared: "Partage cloud", favorited: "Favoris", myShares: "Mes partages", search: "Rechercher", latest: "Récents", topUsed: "Populaires", topLiked: "Aimés", topFav: "Favoris", author: "Auteur", import: "Importer", imported: "Importé", favoritedStatus: "Ajouté aux favoris", removedFromFavorites: "Supprimé des favoris", liked: "Aimé", unliked: `"J'aime" retiré`, importedToCustom: "Importé dans Personnalisé", importFailed: "Échec de l'importation, maximum 20", pleaseLogin: "Veuillez vous connecter pour continuer", maxFavorites: "Maximum 20 favoris", noUserUploads: "Aucun contenu envoyé par les utilisateurs pour l'instant", noSearchResults: "Aucun résultat trouvé, essayez un autre mot~", noFavorites: "Aucun favori", noSharesYet: "Vous n'avez encore rien partagé", cancelSharing: "Annuler le partage", notice: "Notification", confirmCancelShare: 'Annuler le partage de <strong>"{name}"</strong> ?', delete: "Del", custom: "Personnalisé", myPresets: "Créés par moi", localImport: "Import local", cloudImports: "Importé depuis le cloud", confirmDelete: `Supprimer "xxx" ? Cette action est irréversible. Exportez d'abord si nécessaire`, confirmDeleteReview: `Supprimer <strong>"{name}"</strong> ? Cet EQ est en cours d'examen et pourrait toujours apparaître dans le cloud s'il est approuvé.`, confirmDeleteSimple: 'Supprimer <strong>"{name}"</strong> ?', fromAuthor: "Par l'auteur :", shareToCloud: "Partager cloud", shareSuccess: "Partage réussi", sharingCanceled: "Partage annulé", maxSharesPerUser: "Maximum 10 partages par utilisateur", selectCategory: "Choisir une catégorie", other: "Autres", selectGameTag: "Veuillez sélectionner un tag de jeu", enterPresetTitle: "Saisir un titre", shareTitlePlaceholder: "Donnez un bon titre à votre égaliseur partagé", maxSharesPerUserSimple: "Maximum 10 partages par utilisateur", shareSuccessful: "Partage réussi", confirmShareOverwrite: "Cet égaliseur a déjà été partagé. Le nouveau partage remplacera l'ancien. Continuer ?", share: "Partager", restoreDefault: "Restaurer par défaut", restoreDefaultSuccess: "Restauré aux paramètres par défaut", underReview: "En revue", export: "Export", underReviewTryLater: "En validation, veuillez réessayer plus tard", underReviewDeleteWarning: "La suppression interrompra la validation", shareFailTitle: "Échec du partage : titre non autorisé", shared: "Partagé", exitPreview: "Quitter l'aperçu", nicknameViolation: "Non conforme", nicknameViolationTip: "Surnom non conforme. Veuillez le modifier", rename: "Renommer", copy: "Cop", copied: "Copié", noCloudImport: "Aucun EQ dans le cloud", unknown: "Inconnu", noDescription: "Aucune description", shareRequestSubmitted: "Demande de partage envoyée", copySuffix: "copy", view: "Voir", sysChanged: "EQ non enregistré. Cliquez sur <strong>[Enregistrer personnalisé]</strong>.", cmdENOENT: "cmd.exe est manquant dans le système. Veuillez réparer le système, puis réessayer.", batchOperation: "Opération groupée", selectAll: "Tout sélectionner", exitBatch: "Quitter le mode groupé", confirmBatchDeleteAll: 'Supprimer <strong class="delete_name">toutes</strong> les configurations ?', confirmBatchDeleteSelected: "Supprimer les configurations sélectionnées ?", using: "In Use", clickToUse: "Use Now", expert: "Configuration Expert", applySuccess: "EQ sélectionné activé", noData: "Aucune donnée" }, tray: { open: "Ouvrir M HUB", quit: "Quitter" }, commonHeader: { officialStore: "Boutique Officielle", myDevice: "Paramètres clés", back: "Retour", backHome: "Retour à l’accueil", popoverTheme: "Changer de thème", popoverSetting: "Paramètres", popoverRelatedApp: "Associer un jeu/une appli et basculer automatiquement le profil", popoverMin: "Minimiser", popoverUnmax: "Restaurer", popoverMax: "Maximiser", popoverClose: "Fermer", offline: "Le serveur actuel est hors ligne. Veuillez redémarrer le pilote plus tard et réessayer", performanceOnDesc: "Après avoir désactivé le mode de performance, l'effet de fond transparent, de verre dépoli et des coins arrondis de la bordure seront réactivés, ce qui améliore l'apparence esthétique. Cependant, cela impose certaines exigences en termes de performances de l'ordinateur.", performanceOffDesc: "Après avoir activé le mode de performance, l'effet de fond transparent, de verre dépoli et des coins arrondis de la bordure seront supprimés, ce qui permet d'obtenir une utilisation plus fluide. Si vous rencontrez des ralentissements lors de l'utilisation de l'application, il est recommandé d'activer ce mode.", feedback: "Commentaires", prizeQuiz: "Sondage récompensé" }, themeSetting: { pageName: "Thème", white: "Blanc", black: "Noir", followSys: "Suivre le système", bg: "Arrière-plan", followTheme: "Suivre le thème", customizeText: "Arrière-plan personnalisé (uniquement pour la page d'accueil)", changeBg: "Changer de fond", defaultBg: "Arrière-plan par défaut ", uploadImg: "Télécharger une image", blurCard: "Flou de la carte de l’appareil", blurBg: "Flou de l’arrière-plan de l’image" }, setting: { version: "Version actuelle", startup: "Démarrage", startAuto: "Démarrage automatique", startAutoMini: "Réduire dans la barre d’état système au démarrage", language: "Langue", closePanel: "À la fermeture du panneau", exit: "Quitter le programme", minimize: "Réduire dans la barre des tâches, Ne pas quitter le programme", copyright: "" }, menus: { AudioConfiguration: "Configuration audio", LightingSettings: "Régler l'éclairage", ScreenSettings: "Affichage écran", OtherSettings: "Autres réglages", GeneralParameters: "Paramètres standards", Equalizer: "Égaliseur", SoundMode: "Mode sonore", VirtualSurround: "Son surround virtuel 7.1", CommonParams: "Paramètres courants", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "On a détecté que la configuration de votre écran peut affecter l'affichage sur le bureau. Modifiez le ratio de zoom et de disposition pour obtenir le meilleur effet.", gotoSet: "Modifier", needAdminNotice: "Certaines fonctionnalités peuvent ne pas être disponibles en raison de permissions insuffisantes. Veuillez quitter l’application, faire un clic droit sur l’icône et sélectionner « Exécuter en tant qu’administrateur » pour la redémarrer", loadFail: "Échec du chargement", loadFailDesc: "Veuillez cliquer sur le bouton de rafraîchissement pour recharger, ou vérifier votre connexion réseau et redémarrer le pilote." }, devicePage: { needOtaNotice: "Une nouvelle version de micrologiciel a été détectée. Vous devez la mettre à jour pour utiliser le pilote normalement. Téléchargez et mettez à jour le micrologiciel.", needOtaNoticeTip: "Conseil : Après le téléchargement, accédez au chemin d’enregistrement, ouvrez le kit d’outils et suivez le guide pour effectuer la mise à jour.", downloadNow: "Télécharger maintenant", restartNotice: "Après l'installation du pilote, vous devez redémarrer votre ordinateur pour utiliser le pilote correctement. Si le pilote ne fonctionne pas après le redémarrage, veuillez contacter le support client pour obtenir de l'aide.", restartNow: "Redémarrer maintenant", speakerDisabled: "Haut-parleur désactivé détecté, impossible d'ouvrir le pilote", step: "Étapes de solution :", step1: "1.Cliquez sur le bouton [Périphériques audio Windows] ci-dessous.", step2: `2.Dans le panneau de contrôle sonore du système (voir l'illustration ci-dessous), sélectionnez "Lecture". Trouvez le périphérique correspondant dans la liste, faites un clic droit pour activer le haut-parleur, puis cliquez sur OK.`, step3: "3.Une fois activé, cliquez sur le bouton [Rafraîchir] ci-dessous.", isSleep: `Si le casque est en veille, redémarrez-le ou vérifiez que le mode de connexion est bien 2.4G (vous pouvez essayer de rebrancher le récepteur).
Remarque : Le pilote ne peut pas être utilisé si le câble audio est branché ou si le casque est en mode Bluetooth.`, deviceLostLink: "Connexion du pilote interrompue", headphoneSleepStatus: "Casque en veille", headphoneSleepStatusTips: "Appuyez sur un bouton ou redémarrez-le", needLinkWireless: "Le pilote ne prend en charge que la connexion 2.4", needLinkWirelessHeadphoneTips: "Vérifiez que le récepteur est branché et n’utilisez ni câble audio ni Bluetooth", wiredMode: "Filaire", lessThan: "Sous {val}", charging: "En charge", sufficientCharge: "Batterie suffisante", wiredVersion: "câblé", notAdminRunningHeadset: "Les périphériques audio nécessitent des droits d’administrateur. Veuillez quitter l’application, faire un clic droit sur l’icône et sélectionner « Exécuter en tant qu’administrateur » pour redémarrer l’application", thxInstallDialogTitle: "Installation des composants audio", thxInstallDialogTitleUpgrade: "Mise à jour des composants audio", thxInstallDialogDesc1: "Cela prend 1 à 2 minutes, veuillez patienter", thxInstallDialogDesc2: "Ne quittez pas le pilote pendant l’installation. La page appareil s’ouvrira ensuite" }, routine: { UserManual: "Manuel", beepTitle: "Notification sonore", beepTitleDesc: "Volume des annonces réglable (sans affecter les médias)", UserManualFull: "Manuel d'utilisation", Volume: "Volume", Microphone: "Microphone", MicAI: "Activer la réduction de bruit IA", MicAIDesc: "Filtre les bruits, améliore la qualité", MicNoiseReduction: "Suppression du bruit permanent", MicNoiseReductionDesc: "Atténue les composants de bruit constants dans certaines bandes de fréquence, réduisant les sons comme les climatiseurs ou les ventilateurs.", MicListen: "Retour micro", MicListenDesc: "Écoute en temps réel", MoYin: "Effets magiques: ", MoYin_0: "Monstre", MoYin_1: "Dessin animé", MoYin_2: "Voix masculine", MoYin_3: "Voix féminine", WindowsAudioDevices: "Périphérique audio Windows", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Modifié, enregistrement automatique", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Rétablir EQ d’usine", eqEditorResetFactoryConfirm: "[{mode}] remplacera les réglages de l’égaliseur actuels et rétablira les valeurs d’usine.", eqEditorResetFactoryDone: "Le mode {n} a été rétabli à l’égaliseur par défaut d’usine.", eqSwitchUnsavedHint: "Vous avez modifié l’égaliseur du mode actuel. Appliquer directement un autre EQ écrasera vos modifications.", eqSwitchApplyDirect: "Appliquer directement", eqSwitchSaveThenApply: "Enregistrer puis appliquer", AudioBright: "Éclaircissement audio", AudioBrightDesc: "Renforce les hautes fréquences pour un son plus clair et détaillé, améliorant la brillance et l'expressivité globale.", SurroundAmplification: "Amélioration surrond son", SurroundAmplificationDesc: `Améliore l'effet spatial audio, élargit la "zone" sonore, simule les réflexions et la diffusion, créant une sensation d'espace entouré de haut-parleurs.`, DynamicLF: "Dynamique basse", DynamicLFDesc: "Ajustement intelligent des basses : renforce les rythmes puissants, ou les réduit pour un équilibre naturel, procurant une expérience auditive riche et variée.", SmartVolume: "Volume intelligent", SmartVolumeDesc: "Détection automatique des variations de volume, équilibrage intelligent pour éviter les hausses ou baisses soudaines, offrant une expérience d'écoute stable sans réglages manuels fréquents.", VocalClarity: "Clarté vocale", VocalClarityDesc: "Optimisation précise de la bande de fréquence de la voix humaine, réduction du bruit et des interférences pour une voix claire et pure — idéale pour la musique, les séries ou les appels.", MusicMode: "Musique (HD)", VoiceMode: "Voix (FD)", NCut: "Désacouillage", Freqtrap: "Ség. des bandes", Intensity: "Intensité", DYIntensity: "Intensité", QXIntensity: "Intensité", Speech: "Notifications vocales", SpeechDesc: `Retour vocal lors de l'utilisation du haut-parleur (vous pouvez également activer ou désactiver le retour vocal en maintenant simultanément les boutons "+" et "G" du haut-parleur pendant {time} secondes).`, SpeechDescK20Pro: "Annonces vocales pendant l’utilisation du haut-parleur (appuyez sur le bouton du micro du haut-parleur pendant {time} s pour activer ou désactiver les annonces vocales)", micDisabled: "Micro désactivé", micDisabledTitle: "Microphone désactivé détecté, impossible d'utiliser correctement le microphone", step: "Étapes de solution :", step1: "1.Cliquez sur le bouton [Périphériques audio Windows] ci-dessous.", step2: `2.Dans le panneau de contrôle sonore du système (voir l'illustration ci-dessous), sélectionnez "Enregistrement". Trouvez le périphérique correspondant dans la liste, faites un clic droit pour activer le microphone, puis cliquez sur OK.`, step3: "3.Une fois activé, cliquez sur l'icône [Rafraîchir] ci-dessous." }, eq: { title: "Égaliseur", game1: "Mode EQ 1", game2: "Mode EQ 2", game3: "Mode EQ 3", eqSlotDefaultDesc: "Emplacement de préréglage intégré", popover2: "Un égaliseur permet d'ajuster les fréquences audio et le volume. Personnalisez les bandes hautes et basses selon vos préférences, par exemple en accentuant les basses pour les explosions et les hautes pour les tirs dans les jeux, afin d'améliorer l'immersion et la performance.", popover: "Égaliseur ajustable", import: "Importer", 默认: "Par défaut", 音乐清脆风: "Style clair", 音乐清脆风1: "Style clair1", 音乐清脆风2: "Style clair2", "3D影视": "Films 3D", 舞曲: "Dance", 饶舌曲: "Rap", 重金属: "Heavy Metal", 爵士: "Jazz", 抒情摇滚: "Soft Rock", 摇滚: "Rock", 现场: "Live", 高音: "Aigus", 低音: "Graves", bandBass: "Graves", bandLowMid: "Médium-graves", bandMid: "Médiums", bandHighMid: "Médium-aigus", bandHigh: "Aigus", 古典乐: "Classique", 声乐: "Voix", 无畏契约: "valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Personnalisé", more: "Plus", empty: "Aucun effet sélectionné", renamePlaceholder: "Veuillez entrer un nom personnalisé", export: "Exporter", delete: "Supprimer", saveAs: "Enregistrer sous config. pers.", reset: "Restaurer par défaut", newNameTitle: "Personnalisé", newNamePlaceholder: "Veuillez entrer un nom personnalisé", duplicate: "Le nom existe déjà, veuillez entrer un autre nom", ok: "Confirmer", importSuccess: "Importation réussie", importFail: "Échec de l'importation, veuillez réessayer", importFailName: "L'importation a échoué en raison d'un nom duplicata. Veuillez apporter des modifications", exportSuccess: "Exportation réussie", exportFail: "Échec de l'exportation, veuillez réessayer", deleteTitle: "Commande", delPre: 'Êtes-vous sûr de vouloir supprimer "', delAfter: "? Cette action est irréversible. Exportez d’abord si nécessaire", expertListTip: "Les préréglages experts sont liés au mode audio. Pour une qualité optimale, évitez de changer de mode." }, mode: { modeDesc: `Les différents modes peuvent être commutés avec un simple clic,
vous offrant une expérience auditive exclusive et extrême`, gameMode: "Mode jeu", gameMode1: "Mode jeu 1", gameMode2: "Mode jeu 2", musicMode: "Mode musique", movieMode: "Mode film", gameModeDesc: "Met en valeur les détails des tirs et des pas, idéal pour les FPS compétitifs", musicModeDesc: "Réglé professionnellement pour restituer les détails du son, idéal pour les scènes musicales immersives", movieModeDesc: "Offre une expérience sonore digne du cinéma, idéale pour les scènes de film immersives", gameModeDesc2: "Met en valeur les sons d’ambiance du champ de bataille, idéal pour les FPS de guerre" }, light: { switch: "Éclairage", switchOn: "Lumière activée", switchOff: "Lumière désactivée", title: "Effets lumineux", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Flux Étoilé", goFlow: "Waves", continue: "Durée", duan: "Court", chang: "Long", an: "Sombre", guang: "Brillant", direction: "Direction", clockwise: "sens aiguilles", anticlockwise: "sens inv. aiguilles", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "Sync RGB active", syncClosed: "La synchronisation RGB est désactivée et l’effet lumineux sélectionné est appliqué", flowing_f: "Flowing Light - Fast", speed: "rapide", fast: "Fast", slow: "lente", colorjoe: "Palette", reset: "Restaurer par défaut", notView: "Cet effet lumineux ne prend pas en charge l'aperçu", color: "Couleur", lightShow: "Indication de l'éclairage", lightShow1: "Allumer toutes les lumières", lightShow2: "Éteindre les lumières du milieu", lightShow3: "Éteindre les lumières des côtés", smartLight: "Éclairage intelligent", smartLightDesc: "Après activation, sans utilisation ni lecture pendant 30 min, l'écran et l'éclairage passeront automatiquement en faible luminosité", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Vitesse et luminosité", brightness: "luminosité" }, surround: { switch: "Son surround virtuel 7.1", popover: "Simule un son surround 7.1 canaux. Une fois activé, il permet de percevoir les sons provenant de plusieurs directions, vous plongeant ainsi dans les scènes de jeu ou les intrigues de film, en localisant avec précision la direction et la distance des sons, offrant une expérience auditive plus tridimensionnelle et immersive.", popoverGame: "Le son virtuel 7.1 n’est pas adapté aux jeux FPS ; recommandé pour les jeux AAA et les contenus multimédias.", mode: "Sélection de mode", music: "Mode musique/jeu", movie: "Mode film", test: "Test des haut-parleurs", start: "Démarrer le test", stop: "Arrêter le test", size: "Taille de la pièce", small: "petite", mid: "moyenne", big: "grande" }, otherSettings: { alreadyLatest: "Le micrologiciel est déjà à jour, aucune mise à jour nécessaire.", v9TurboHeadset: "Veuillez utiliser le mode 2.4G pour se connecter à la mise à jour.", latest: `Dernière
version`, goUpdate: "Mise à jour", baseV: "Version du micrologiciel de la base :", usbV: "Version USB appareil:", firmwareV: "Version microprog. appareil:", headsetV: "Version microprogramme casque:", dongleV: "Version microprogramme récepteur:", findNew: "Dernière version détectée：", speakerShutdown: "Éteindre l’appareil", speakerShutdownDesc: "Le pilote peut seulement éteindre, pas allumer", shutdown: "Éteindre", speakerShutdownConfirm: "Voulez-vous vraiment éteindre l’appareil ?", speakerShutdownSuccess: "Le haut-parleur a été éteint", speakerShutdownDeviceError: "L'appareil n'est pas connecté, veuillez vérifier l'appareil", speakerShutdownFailed: "Éteindre le haut-parleur a échoué", and: ", ", restoreFactory: "Restaurer les paramètres d'usine", restoreFactoryDesc: "Toutes les configurations seront réinitialisées en paramètres d'usine. Veuillez procéder avec soin.", restore: "Réinitialiser", restoreSuccess: "Réinitialisation d’usine effectuée avec succès", downloading: "Téléchargement du fichier du firmware…", updating: "La mise à niveau du firmware est en cours...", updatingNote: "Veuillez ne pas quitter le programme ou débrancher et brancher l'appareil pendant le processus de mise à niveau!", inDevelopment: "Fonction en développement...", readBinFail: "Échec de la lecture du fichier de firmware", downloadBinFail: "Échec du téléchargement du fichier du firmware", otaFail: "La mise à niveau du firmware a échoué", otaFailResult: "La mise à niveau du firmware a échoué. Vous pouvez essayer de débrancher et de rebrancher l'appareil puis réessayer", otaSuc: "La mise à niveau du firmware a réussi", otaSucDongle: "Mise à jour du firmware réussie. Veuillez attendre que {deviceType} redémarre automatiquement pour que les modifications prennent effet (environ 30 secondes).", otaSucHeadset: "Mise à jour du firmware réussie. Veuillez attendre environ 30 secondes, puis allumez manuellement les écouteurs pour que les modifications prennent effet.", otaSucBoth: "Mise à jour du firmware du casque et du récepteur réussie. Veuillez attendre le redémarrage automatique de l'appareil (environ 30 secondes).", deviceTypeDong: "récepteur", deviceTypeDevice: "appareil", confirmFactoryReset: "Cette opération effacera toutes les configurations. Êtes-vous sûr de vouloir restaurer les paramètres d'usine ?", powerManagement: "Gestion de l’alimentation", autoShutdown: "Arrêt automatique:", autoShutdownDesc: "Lorsque le casque est retiré de la station (hors charge) et sans lecture au-delà du temps défini, il s'éteint automatiquement.", minutes: "Minutes", downloadTips1: "1.Il est recommandé d’enregistrer le paquet du firmware sur le bureau.", downloadTips2Exe: "2.Double-cliquez dessus pour lancer la mise à jour automatique.", downloadTips2Zip: "2.Après l’extraction, double-cliquez sur le paquet du firmware pour lancer la mise à jour automatique.", betterOtaTitle: "Nouveau firmware détecté. Mise à jour recommandée." }, screenSettings: { screenOTAing: "Mise à jour de l’écran, veuillez patienter", screenDisplay: "Affichage écran", screenOn: "Écran allumé", screenOff: "Écran éteint", screenColor: "Couleur de l’écran", presetSettings: "Paramètres de fond", personalizedPreset: "Fond d’écran", customText: "Texte", custom: "Personnalisé", digitalClock: "Horloge Numérique", musicSpectrum: "Spectre Musical", campusDaily: "Vie de Campus", workplaceLife: "Vie Professionnelle", cutePets: "Animaux Mignons", electronicGames: "Jeux Vidéo", cyberTech: "Technologie Cyber", networkMeme: "Mèmes Internet", customImage: "Image personnalisée", customImageOTAWarning: "Veuillez d’abord mettre à jour le firmware avant d’utiliser cette fonction", addImage: "Ajouter image", uploadImage: "Téléverser image", reuploadImage: "Re-téléverser", supportImageFormat: "PNG/JPG/GIF supportés. GIF limité aux 30 premières images", previewImage: "Aperçu", text: "Texte", scenery: "Paysage", character: "Personnage", uploadingToScreen: "Téléchargement vers l’écran", reverseColor: "Inverser les couleurs", scaleScreen: "Agrandir écran", scaleImage: "Agrandir image", blackWhiteRatio: "Ratio noir/blanc", deleteImageConfirm: "Supprimer cette image ? irréversible", deleteImage: "Supprimer", batchDeleteImage: "Suppression multiple", selectAll: "Tout sélectionner", cancelSelectAll: "Tout désélectionner", processImage: "Traitement d’image", exitBatch: "Quitter sélection", deleteSelectedImageConfirm: "Supprimer les images sélectionnées ? irréversible", textContent: "Contenu Texte", textLengthLimit: "Limite de caractères atteinte", save: "Enregistrer", savedSuccess: "Enregistré", historyRecords: "Historique", clearHistory: "Effacer l’Historique en Un Clic", historyTip: "Afficher Uniquement les 20 Derniers Enregistrements", textEffect: "Effet de Texte", staticDisplay: "Affichage Statique", dynamicDisplay: "Affichage Dynamique", alignment: "Alignement", leftAlign: "Aligner à gauche", centerAlign: "Centrer", rightAlign: "Aligner à droite", justifyAlign: "Justifié", scrollEffect: "Effet de Défilement", scrollToRight: "De gauche à droite", scrollToLeft: "De droite à gauche", customColors: "Couleur perso", clearCustomColors: "Effacer les couleurs", syncToLight: "Synchroniser couleur & éclairage", shortPress: "Appui Court", lyrics: "Paroles", lyricsDisplay: "Affichage paroles（BETA）", lyricsDisplayHintLead: "Lors de la lecture d’un audio avec prise en charge des paroles, l’écran affiche les paroles en cours.", lyricsDisplayCantSeeLink: "Vous ne voyez pas les paroles ?", lyricsDisplayCantSeeTooltip: "Seules certaines applications musicales sont actuellement prises en charge. Mettez-les à jour puis actualisez M HUB", lyricsOn: "Activé", lyricsOff: "Désactivé", lyricsAnimation: "Animation paroles", notSupportSyncToLight: "L’effet lumineux actuel est multicolore, la synchronisation des couleurs n’est pas prise en charge", syncToLightSuccess: "Synchronisation réussie", uploadToScreenTip: "Env. {time}s, ne quittez pas", deleteCustomColorConfirm: "Voulez-vous vraiment supprimer la couleur actuelle ?", deleteAllCustomColorsConfirm: "Voulez-vous vraiment supprimer toutes les couleurs personnalisées ?", minimumSelectionToast: "Sélectionnez au moins 2", textVerifyFailed: "L’écran pixel ne prend pas en charge les emojis ni les caractères spéciaux. Utilisez uniquement du texte", lyricsAnimationOption1: "Entrée : De bas en haut. Sortie : De bas en haut", lyricsAnimationOption2: "Entrée : Déployer depuis le centre. Sortie : Se replier vers le centre", lyricsAnimationOption3: "Entrée : De gauche à droite. Sortie : De droite à gauche", lyricsAnimationOption4: "Entrée : De bas en haut. Sortie : De haut en bas", lyricsAnimationOption5: "Entrée : De haut en bas. Sortie : De droite à gauche", lyricsAnimationDemo: "Démo animation paroles", uploadingImgTip: "Image en cours d’envoi, réessayez plus tard" }, update: { alreadyNew: "Dernière version", findNew: "Dernière version détectée", ignore: "Ignorer", update: "Mettre à jour", showHistory: "Voir les versions précédentes", updating: "Mise à jour du pilote en cours…", rollingBack: "Retour à la version historique {version}...", updateContentTitle: "Mise à jour du pilote", updateContent: "Contenu de la mise à jour du pilote:", updateNow: "Mettre à jour maintenant", back: "Retour", historyTitle: "Versions historiques", version: "Numéro de version", date: "Date de mise à jour", backToList: "Revenir au niveau précédent", only30: "Conserver les 30 dernières versions.", operation: "Action", watchContent: "Voir les mises à jour", rollTo: "Revenir à cette version", currentVersion: "Version actuelle", updateTo: "Mettre à jour vers cette version", updateSuccess: "Mise à jour du pilote terminée", revertSuccess: "Revenu à la version historique {version}", updatePre: "Mise à niveau en cours, veuillez patienter...", updateAfter: "L’application va redémarrer automatiquement sous peu. Veuillez patienter", inviteUpdate1: "Nouvelle version disponible, ", inviteUpdate2: "nous vous invitons à effectuer ", inviteUpdate3: "la mise à jour immédiatement", notAdminRunning: "Des privilèges administrateur sont requis pour effectuer la mise à jour. Veuillez quitter l'application, faire un clic droit sur l'icône, puis sélectionner « Exécuter en tant qu'administrateur ». Une fois l'application relancée, essayez de nouveau de faire la mise à jour", updateResultFail: "La mise à jour a échoué, ce qui peut entraîner l'inaccessibilité de certaines fonctionnalités. Veuillez la désinstaller puis aller sur le site officiel de Maicong pour télécharger le dernier paquet d'installation et l'installer", updateFailAfter: "Il y a eu une anomalie pendant la création du paquet compressé. Veuillez la désinstaller puis aller sur le site officiel de Maicong pour télécharger le dernier paquet d'installation et l'installer", updateFailPre: "Il y a eu une anomalie pendant la phase de prétraitement de la mise à niveau. Veuillez réessayer plus tard. Si cela échoue toujours, désinstallez le pilote puis allez sur le site officiel de Maicong pour télécharger le dernier paquet d'installation de pilote et l'installer à nouveau", updateUpFailDefault: "La mise à niveau du pilote a échoué. Veuillez réessayer plus tard", updateBackFailDefault: "Échec de la réversion à la version antérieure. Veuillez réessayer plus tard", notSupportUpdate: "La version actuelle ne prend pas en charge la mise à niveau en ligne. Veuillez aller sur le site officiel de Maicong pour télécharger la dernière version du paquet d'installation et l'installer à nouveau", restartFinishUpdate: "Redémarrer pilote" }, musicDance: { settingPanel: "Panneau cmd. rythme musical", scaleEffect: "Zoom sur le rythme", scaleKeyboard: "Zoom sur le clavier", showEffect: "M. rythme", showKeyboard: "M. clav", reset: "Restaurer par défaut", needWinVcTitle: "La bibliothèque d’exécution Windows MSVC est absente du système, certaines fonctionnalités peuvent donc être limitées", needWinVcDesc: "Téléchargez et installez la bibliothèque officielle de Microsoft, soit vc_redist.x64.exe, puis redémarrez l'application：", needWinVcLink1: "Adresse officielle de téléchargement de Microsoft :", needWinVcLink2: "Adresse de téléchargement de secours :", download: "Cliquez pour télécharger", needWinVcNotice: "Si cette fenêtre apparaît toujours après l’installation, il est possible que votre système ne soit pas encore compatible avec cette fonctionnalité" }, wechatLogin: { privacyPrefix: "En vous connectant, vous acceptez les", privacyPolicy: "«Confidentialité»", privacySuffix: "«Conditions»", privacyAnd: " et la", privacyEnd: "", accountMergeHint: "Après liaison, connexion via WeChat/e-mail, données fusionnées", accountUnbindEmailHint: "Après déliaison, les données restent dans WeChat", privacyPolicyTitle: "Conditions de confidentialité", userAgreement: "Contrat d'utilisateur", privacyWelcome: "Bienvenue dans le service de connexion via WeChat de MCHOSE! Le présent Contrat d’Utilisateur (ci-après le « Contrat ») est conclu entre Shenzhen MCHOSE Technology Co., Ltd. (ci-après « nous » ou « MCHOSE ») et vous (ci-après « vous » ou « l’Utilisateur »), et définit les droits et obligations relatifs au service fourni par MCHOSE via l’authentification WeChat (ci-après le « Service »).", privacyReadNotice: "Veuillez lire attentivement et comprendre cette politique avant d'utiliser le service. En utilisant ce service, vous reconnaissez avoir lu, compris et accepté tous les termes de cette politique de confidentialité.", privacySection1Title: "1. Informations que nous collectons", privacySection1Desc: "Lors de votre utilisation du service, nous pouvons collecter les informations suivantes :", privacyWechatInfo: `1.1 Informations d'autorisation WeChat
Lorsque vous vous connectez via WeChat, nous recueillons des informations de base telles que votre pseudonyme, avatar, OpenID et UnionID via l'interface de la plateforme WeChat, afin d'identifier votre compte et de fournir des services personnalisés.`, privacyCloudData: `1.2 Données d'utilisation cloud
Les fichiers de configuration que vous téléchargez, enregistrez ou utilisez sont stockés sur nos serveurs cloud afin de permettre la synchronisation entre vos différents appareils.`, privacySection2Title: "2. Comment nous utilisons les informations", privacySection2Desc: "Nous collectons vos informations uniquement pour les finalités légales, légitimes et nécessaires suivantes :", privacyServiceFunction: `2.1 Fournir les fonctionnalités du service
Fournir les services principaux tels que la connexion autorisée via WeChat, le stockage cloud et l'accès aux fichiers de configuration.`, privacyServiceSecurity: `2.2 Assurer la sécurité du service
Effectuer la vérification d'identité, détecter les anomalies, résoudre les dysfonctionnements et améliorer la stabilité et la sécurité du système.`, privacySection3Title: "3. Stockage et protection des informations", privacyStorageLocation: `3.1 Lieu et durée de stockage
Toutes les données des utilisateurs sont stockées sur des serveurs situés en Chine continentale. Nous conservons vos informations uniquement pendant la durée nécessaire à la réalisation des finalités susmentionnées, après quoi elles seront supprimées ou anonymisées.`, privacySecurityMeasures: `3.2 Mesures de sécurité des informations
Nous utilisons plusieurs technologies telles que le chiffrement multiple, le contrôle d'accès et l'audit des journaux pour protéger les données contre tout accès non autorisé, divulgation, modification ou destruction.`, privacySection4Title: "4. Vos droits", privacyRightsDesc: "Conformément aux lois et réglementations applicables, vous disposez des droits suivants :", privacyQueryAccess: `4.1 Consultation et accès
Vous avez le droit de vérifier si nous détenons vos informations personnelles et d'y accéder.`, privacyCorrectionDelete: `4.2 Correction et suppression
Si vous constatez que les informations que nous détenons sont inexactes ou invalides, vous pouvez demander leur correction ou suppression.`, privacyCancelWithdraw: `4.3 Suppression de compte et retrait de consentement
Vous pouvez supprimer votre compte ou retirer votre consentement via la plateforme WeChat ou en nous contactant. Dans ce cas, nous cesserons de traiter vos informations, sauf disposition contraire prévue par la loi.`, privacySection5Title: "5. Mise à jour de la politique", privacyPolicyUpdate: "Nous pouvons mettre à jour cette politique de confidentialité en fonction de l'évolution de nos activités ou des changements législatifs. La politique mise à jour sera communiquée via des annonces sur la mini-application WeChat ou par d'autres moyens raisonnables. La poursuite de l'utilisation du service vaut acceptation de la politique mise à jour.", privacySection6Title: "6. Nous contacter", privacyContactDesc: "Si vous avez des questions, suggestions ou plaintes concernant cette politique, vous pouvez nous contacter :", privacyServiceHotline: "6.1 Hotline service client : 400-816-8986", privacyServiceTime: "6.2 Horaires d'ouverture : du lundi au vendredi, de 9h00 à 19h00", privacyConclusion: "Nous vous remercions de votre confiance et de votre utilisation du service de connexion WeChat de MCHOSE. Nous continuerons à œuvrer pour protéger vos informations et votre vie privée.", userAgreementWelcome: "Bienvenue dans le service de connexion via WeChat de MCHOSE ! Le présent Contrat d’Utilisateur (ci-après le « Contrat ») est conclu entre Shenzhen MCHOSE Technology Co., Ltd. (ci-après « nous » ou « MCHOSE ») et vous (ci-après « vous » ou « l’Utilisateur »), et définit les droits et obligations relatifs au service fourni par MCHOSE via l’authentification WeChat (ci-après le « Service »).", userAgreementReadNotice: "Veuillez lire attentivement l'intégralité de ce Contrat avant d'utiliser le Service, notamment les clauses de non-responsabilité et celles limitant vos droits.", userAgreementSection1Title: "1. Conditions d'utilisation du Service", userAgreementSection1Desc: "1.1 Vous déclarez et garantissez expressément :", userAgreementLegalCapacity: "· Avoir la capacité juridique de conclure le présent Contrat et d'utiliser le Service ;", userAgreementMinorNotice: "· Si vous êtes mineur, vous devez utiliser le Service sous la supervision et avec l'accord de votre représentant légal. Si vous avez moins de 14 ans, une autorisation explicite ou une supervision directe du représentant légal est requise.", userAgreementRequirements: "1.2 L'utilisation du Service nécessite un appareil compatible avec un accès réseau, l'installation de l'application WeChat, et une connexion via l'authentification WeChat.", userAgreementSection2Title: "2. Connexion au compte et utilisation", userAgreementLoginProcess: "2.1 Le Service repose sur la plateforme WeChat pour l'authentification de connexion. Lors de votre première utilisation, vous devez accepter et compléter le processus d'authentification WeChat afin de créer ou d'identifier votre compte MCHOSE.", userAgreementInfoAccuracy: "2.2 Vous devez garantir l'exactitude et la véracité des informations fournies pour l'authentification, et les mettre à jour en temps voulu afin d'assurer le bon fonctionnement du Service.", userAgreementAccountSecurity: "2.3 Vous êtes responsable de la sécurité de votre compte WeChat et des informations associées. Toute perte due à une perte ou une fuite du compte est à votre charge.", userAgreementSection3Title: "3. Contenu du Service", userAgreementCloudService: "3.1 Service cloud : téléversement, stockage, synchronisation et gestion de fichiers de configuration sur le cloud ;", userAgreementConfigCall: "3.2 Application de configuration : importation de fichiers de configuration téléversés par l'utilisateur pour une expérience personnalisée ;", userAgreementOfficialSync: "3.3 Synchronisation des fichiers de configuration officiels : mise à jour en temps réel des derniers fichiers de configuration officiels.", userAgreementServiceAdjustment: "MCHOSE se réserve le droit d'ajouter, de supprimer ou d'ajuster le contenu du Service en fonction de l'évolution de ses activités, sans préavis.", userAgreementSection4Title: "4. Règles de conduite de l'utilisateur", userAgreementBehaviorRule1: "4.1 Lors de l'utilisation du Service, vous vous engagez à ne commettre aucun acte illégal, portant atteinte à autrui ou compromettant la sécurité du système ;", userAgreementBehaviorRule2: "4.2 Y compris, sans s'y limiter : diffusion d'informations illégales, atteinte aux droits d'autrui, fraude, interférence avec le système de la plateforme, etc.", userAgreementBehaviorRule3: "4.3 En cas de tels agissements, MCHOSE se réserve le droit de prendre des mesures telles qu'un avertissement, une restriction d'accès, une suspension de compte ou des poursuites judiciaires.", userAgreementSection5Title: "5. Propriété intellectuelle", userAgreementIPOwnership: "5.1 Tout le contenu du Service, y compris la conception des interfaces, le code, les API, les graphiques et la mise en page, appartient à MCHOSE ou à ses partenaires autorisés ;", userAgreementIPRestriction: "5.2 Il est interdit de copier, diffuser, modifier, transférer ou utiliser à des fins commerciales ces éléments sans autorisation préalable.", userAgreementSection6Title: "6. Protection de la vie privée", userAgreementPrivacyNotice1: "6.1 Nous accordons une grande importance à la protection de votre vie privée. Pour plus de détails sur la collecte, l'utilisation, le stockage et la protection de vos données personnelles, veuillez consulter notre Politique de confidentialité.", userAgreementPrivacyNotice2: "6.2 Veuillez lire attentivement cette politique avant d'utiliser le Service afin de comprendre vos droits et nos obligations.", userAgreementSection7Title: "7. Clause de non-responsabilité", userAgreementDisclaimer1: "7.1 Nous faisons de notre mieux pour garantir la stabilité du Service et la sécurité des données, mais nous déclinons toute responsabilité en cas d'interruption, de perte de données ou autres dommages dus à un cas de force majeure ou à un dysfonctionnement du système ;", userAgreementDisclaimer2: "7.2 Toute perte causée par une faute ou négligence de l'utilisateur est à la charge exclusive de celui-ci.", userAgreementSection8Title: "8. Mise à jour et modification du Contrat", userAgreementUpdate1: "8.1 MCHOSE se réserve le droit de mettre à jour ce Contrat en fonction des lois et de l'évolution de son activité, et en informera les utilisateurs via une notification WeChat ou tout autre moyen approprié ;", userAgreementUpdate2: "8.2 Si vous continuez à utiliser le Service, cela vaudra acceptation du Contrat mis à jour.", userAgreementSection9Title: "9. Droit applicable et règlement des litiges", userAgreementLaw1: "9.1 Le présent Contrat est régi par le droit de la République Populaire de Chine ;", userAgreementLaw2: "9.2 En cas de litige, les parties tenteront de le résoudre à l'amiable. À défaut, l'une ou l'autre partie pourra saisir le tribunal compétent du district de Longgang, à Shenzhen.", userAgreementSection10Title: "10. Nous contacter", userAgreementContactDesc: "Pour toute question, suggestion ou réclamation concernant cette politique de confidentialité, vous pouvez nous contacter comme suit :", userAgreementServiceHotline: "10.1 Ligne d'assistance : 400-816-8986", userAgreementServiceTime: "10.2 Horaires de service : du lundi au vendredi, de 9h00 à 19h00", userAgreementConclusion: "Merci d'avoir choisi le service de connexion via WeChat de MCHOSE. Nous continuerons à œuvrer activement pour garantir la sécurité de vos informations et le respect de votre vie privée.", emailPlaceholder: "Saisir l'e-mail", emailFormatError: "Format d'e-mail invalide", emailSendCode: "Obtenir le code", emailResend: "Renvoyer", emailResendCountdown: "Renvoyer ({n}s)", bindEmailGetCode: "Obtenir le code", switchToWechatAria: "Appuyez pour WeChat", switchToEmailAria: "Appuyez pour e-mail", cornerTooltipWechat: "Appuyez pour WeChat", cornerTooltipEmail: "Appuyez pour e-mail", titleEmailLogin: "Connexion par e-mail", titleWechatLogin: "Connexion WeChat", titleBindEmail: "Lier l'e-mail", testEnvLoginTitle: "Connexion (environnement de test)", testEnvSuffix: " (test)", testCodePlaceholder: "Entrez le code d’autorisation (code)", btnLogin: "Se connecter", codeStepBack: "Retour", enterVerificationCode: "Saisir le code", codeEmailCheckTitle: "Vérifiez votre e-mail", codeEmailSentLine: "Code envoyé.", codeEmailInboxLine: "Vérifiez {email}", devOpenDevtools: "Ouvrir les outils de développement", devInspectPage: "Inspecter la page", msgSendCodeFailRetry: "Échec de récupération du code", msgOtpSixDigits: "Entrez le code à 6 chiffres", msgWxConfigInitFail: "Échec d’initialisation WeChat. Vérifiez le réseau.", msgLoginPageLoadFail: "Échec du chargement de la page de connexion.", msgLoginFailRetry: "Échec de la connexion. Réessayez.", msgTestEnterAuthCode: "Entrez le code d’autorisation", msgBindFailGeneric: "Échec de l’association" }, user: { modifyNickname: "Modifier le surnom", modifyAvatar: "Modifier l'avatar", nicknamePlaceholder: "Veuillez saisir un nouveau surnom", nicknameTip: "La longueur du surnom est limitée à 1-10 caractères", nicknameEmpty: "Le surnom ne peut pas être vide", nicknameLengthError: "La longueur du surnom doit être comprise entre 1 et 10 caractères", nicknameUpdateSuccess: "Surnom mis à jour", avatarUpdateSuccess: "Avatar mis à jour avec succès" } }, vI = { common: { prompt: "注意", refresh: "更新", cancel: "キャンセル", close: " 閉じる", restore: "デフォルトに戻します", iKnowIt: "了解しました", notAdminRunning: "この操作を行うには管理者権限が必要です。アプリケーションを終了し、アイコンを右クリックして「管理者として実行」を選択し、再起動してから再試行してください。", clickLogin: "ログイン", cloudEqTip: "ログイン後、クラウド機能が利用可能です（さらに多くの設定共有機能を開発中、ご期待ください）", editNickname: "ニックネームを編集", changeAvatar: "アバターを変更", avatarTip: "JPG、PNG形式に対応。ファイルサイズは2MB以下である必要があります", logout: "ログアウト", autoWechatLogin: "下のオプションを選択すると、自動的にWeChatログインへ移動します", privacyPrefix: "ログインで", userAgreement: "ユーザー規約", loginSuccess: "ログイン成功", emailLoginSuccess: "ログイン成功", bindWechatAction: "WeChatを連携", bindWechatSuccess: "WeChat連携に成功しました", bindWechatFailed: "WeChat連携に失敗しました", wechatAlreadyBoundOtherEmail: "このWeChatは他のメールアドレスに連携済みです", emailAlreadyBoundOtherWechat: "このメールアドレスは他のWeChatに連携済みです", unbindEmail: "メール連携解除", unbindEmailGetCode: "認証コード取得", unbindEmailSuccess: "解除成功", unbindEmailCodeInvalid: "無効なコード", accountBindWechat: "WeChatを連携", accountBindEmail: "メールを連携", accountUnbindEmail: "メール連携解除", bindEmailSuccess: "連携成功", logoutSuccess: "ログアウトしました", changesSubmitted: "変更を送信しました。審査をお待ちください", nicknameEmpty: "ニックネームは空にできません", enterNickname: "ニックネームを入力してください", confirm: "確認", official: "公式プリセット", game: "ゲーム", music: "音楽", cloud: "クラウドコミュニティ", cloudShared: "クラウド", favorited: "お気に入り", myShares: "自分のシェア", search: "検索", latest: "最新", topUsed: "人気順", topLiked: "使用順", topFav: "保存順", author: "作者", import: "インポート", imported: "インポート済み", favoritedStatus: "お気に入り済み", removedFromFavorites: "お気に入りから削除しました", liked: "いいねしました", unliked: "いいねを取り消しました", importedToCustom: "カスタムにインポートしました", importFailed: "インポート失敗。最大20個までです", pleaseLogin: "操作するにはログインが必要です", maxFavorites: "お気に入りは最大20個までです", noUserUploads: "まだユーザーのアップロードがありません", noSearchResults: "該当する内容が見つかりません。別のキーワードを試してください〜", noFavorites: "お気に入りがありません", noSharesYet: "まだ共有していません", cancelSharing: "共有を解除", notice: "注意", confirmCancelShare: "<strong>「{name}」</strong>の共有を解除しますか？", delete: "削除", custom: "カスタム", myPresets: "作成済み", localImport: "ローカル", cloudImports: "クラウドからインポート", confirmDelete: "「<strong>{name}</strong>」を削除しますか？削除後は復元できません。必要に応じてローカルにエクスポートしてください", confirmDeleteReview: "「<strong>{name}</strong>」を削除しますか？このEQは現在審査中で、承認されるとクラウドに引き続き表示される可能性があります。", confirmDeleteSimple: "「<strong>{name}</strong>」を削除しますか？", fromAuthor: "作者：", shareToCloud: "クラウドに共有", shareSuccess: "共有に成功しました", sharingCanceled: "共有をキャンセルしました", maxSharesPerUser: "1人あたり最大10件まで共有可能", selectCategory: "カテゴリを選択", other: "その他", selectGameTag: "ゲームタグを選択してください", enterPresetTitle: "設定タイトルを入力", shareTitlePlaceholder: "クラウドに共有するEQにわかりやすい名前を付けましょう", maxSharesPerUserSimple: "最大10件まで共有可能", shareSuccessful: "共有に成功しました", confirmShareOverwrite: "このEQはすでに共有されています。再共有すると上書きされます。続行しますか？", share: "共有", restoreDefault: "デフォルトに戻す", restoreDefaultSuccess: "デフォルト設定に戻しました。", underReview: "審査中", export: "出力", underReviewTryLater: "審査中です。しばらくしてから再度お試しください", underReviewDeleteWarning: "削除すると審査が中断されます", shareFailTitle: "共有に失敗しました：タイトルが不適切です", shared: "共有済み", exitPreview: "プレビューを終了", nicknameViolation: "不適切", nicknameViolationTip: "不適切なニックネームです。修正してください", rename: "名前変更", copy: "コピー", copied: "コピー済み", noCloudImport: "クラウドにEQがありません", unknown: "不明", noDescription: "説明なし", shareRequestSubmitted: "共有リクエストを送信しました", copySuffix: "copy", view: "表示を見る", sysChanged: "EQは未保存です。<strong>[カスタム保存]</strong>をクリック。", cmdENOENT: "システムに cmd.exe が見つかりません。システムを修復してから再試行してください。", batchOperation: "一括操作", selectAll: "全選択", exitBatch: "一括モードを終了", confirmBatchDeleteAll: '<strong class="delete_name">すべての</strong>EQを削除しますか？', confirmBatchDeleteSelected: "選択した設定を削除しますか？", using: "In Use", clickToUse: "Use Now", expert: "プロ設定", applySuccess: "選択したEQを有効化", noData: "データがありません" }, tray: { open: "M HUB を開", quit: "退出" }, commonHeader: { officialStore: "公式ストア", myDevice: "マイデバイス", back: "戻る", backHome: "ホームに戻る", popoverTheme: "スキン変更", popoverSetting: " 設定", popoverRelatedApp: "ゲーム/アプリを関連付けて自動でオンボードを切り替え", popoverMin: " 最小化", popoverUnmax: " 復元", popoverMax: " 最大化", popoverClose: " 閉じる", offline: "現在のサーバーはオフラインです。しばらくしてからドライバを再起動し、再度試してください", performanceOnDesc: "性能モードを無効にすると、透明背景、ガラスモザイク、枠の丸みの効果が有効になり、外観がより美しくなります。ただし、パソコンの性能には一定の要件があります。", performanceOffDesc: "性能モードを有効にすると、透明背景、ガラスモザイク、枠の丸みの効果が削除され、操作がよりスムーズになります。アプリ使用時に遅延が発生する場合は、このモードの有効化をお勧めします。", feedback: "フィードバック", prizeQuiz: "報酬付き調査" }, themeSetting: { pageName: "テーマ", white: "ホワイト", black: "ブラック", followSys: "システムに従う", bg: "背景", followTheme: "テーマに従う", customizeText: "カスタム背景（ホームページのみ有効）", changeBg: "背景の変更", defaultBg: " デフォルト背景", uploadImg: "画像をアップロードしてください", blurCard: "デバイスカードのぼかし", blurBg: "背景画像のぼかし" }, setting: { version: "現在のバージョン", startup: "起動", startAuto: "PC起動時自動起動", startAutoMini: "起動時にシステムトレイへ最小化", language: "言語", closePanel: "パネルを閉じるとき", exit: "プログラムを終了", minimize: "トレイに最小化、プログラムを終了しない", copyright: "" }, menus: { AudioConfiguration: "オーディオ設定", LightingSettings: "ライティング設定", ScreenSettings: "画面表示", OtherSettings: "その他の設定", GeneralParameters: "標準パラメータ", Equalizer: "イコライザー", SoundMode: "サウンドモード", VirtualSurround: "バーチャル7.1サラウンド", CommonParams: "一般設定", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "あなたの画面設定がデスクトップの表示に影響を与える可能性があることが検出されました。最良の表示効果を得るには、画面のズームとレイアウト比率を変更してください。", gotoSet: "修正する", needAdminNotice: "一部の機能は権限不足により使用できない可能性があります。アプリを終了し、アイコンを右クリックして「管理者として実行」を選び、再起動してください", loadFail: "読み込みに失敗しました", loadFailDesc: "再読み込みするには更新ボタンをクリックするか、ネットワーク接続を確認してドライバーを再起動してください。" }, devicePage: { needOtaNotice: "新しいファームウェア バージョンが検出されました。ドライバを正常に使用するには、アップグレードが必要です。ファームウェアをダウンロードして更新してください。", needOtaNoticeTip: "ヒント：ダウンロード後、保存先に移動してツールキットを開き、手順に従ってアップグレードしてください。", downloadNow: "今すぐダウンロード", restartNotice: `ドライバーをインストールした後、正しく使用するためにはコンピューターを再起動する必要があります。
再起動後にドライバーが有効にならない場合は、カスタマーサポートにお問い合わせください。`, restartNow: "今すぐ再起動", speakerDisabled: "スピーカーが無効化されているため、ドライバーを開けません", step: "解決手順:", step1: "1. 以下の [Windows サウンド デバイス] ボタンをクリックします。", step2: "2. ポップアップ システム サウンド コントロール パネル (以下の図を参照) で、[再生] を選択します。リストで対応するデバイスを見つけ、右クリックしてスピーカーを有効にし、[OK] をクリックします。", step3: "3. 有効になったら、以下の [更新] ボタンをクリックします。", isSleep: `スリープモードに入っている場合、ヘッドセットを再起動するか、接続モードが2.4Gかを確認してください（レシーバーを再接続してください）。
注：オーディオケーブル接続時やBluetoothモード時は、ドライバーを使用できません。`, deviceLostLink: "ドライバー接続が切断されました", headphoneSleepStatus: "ヘッドセットはスリープ状態です", headphoneSleepStatusTips: "ボタンで復帰するか、再起動してください", needLinkWireless: "ドライバーは2.4G接続のみ対応しています", needLinkWirelessHeadphoneTips: "レシーバーが接続されているか確認し、オーディオケーブルやBluetoothモードは使用しないでください", wiredMode: "有線接続", lessThan: "{val} 未満", charging: "充電中", sufficientCharge: "電量十分", wiredVersion: "有線", notAdminRunningHeadset: "オーディオデバイスには管理者権限が必要です。アプリを終了し、アイコンを右クリックして「管理者として実行」を選び、アプリを再起動してください", thxInstallDialogTitle: "オーディオコンポーネントをインストール中", thxInstallDialogTitleUpgrade: "オーディオコンポーネントを更新中", thxInstallDialogDesc1: "所要時間は1〜2分です。しばらくお待ちください。", thxInstallDialogDesc2: "インストール中はドライバーを終了しないでください。完了後、自動でデバイス詳細へ移動します" }, routine: { UserManual: "マニュアル", beepTitle: "通知音", beepTitleDesc: "ヘッドセットの音声ガイダンス音量を調整（メディア音量には影響しません）。", UserManualFull: "マニュアル", Volume: "音量", Microphone: "マイク", MicAI: "AIノイズリダクションを有効化", MicAIDesc: "環境ノイズを除去し、クリアな原音を保持して、よりクリーンで高音質な音声を実現します。", MicNoiseReduction: "定常ノイズ抑制", MicNoiseReductionDesc: "特定の周波数帯域の定常ノイズ成分を減衰させ、エアコンやファンなどの音の信号強度をターゲットにして低減します", MicListen: "マイクモニタリング", MicListenDesc: "自分の声をリアルタイムで確認でき、マイク音量の調整を容易にし、通話をよりクリアで安定させます。", MoYin: "マジサウンドエフ:", MoYin_0: "モンスター", MoYin_1: "アニメ", MoYin_2: "男性ボイス", MoYin_3: "女性ボイス", WindowsAudioDevices: "Windows サウンド デバイス", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "モード{n}に切り替えました", eqItemHoverApply: "適用", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "自動保存済み", eqEditorModifiedAutoSaved: "変更済み、自動保存済み", eqEditorCollapse: "閉じる", eqEditorResetFactory: "工場出荷時のEQに戻す", eqEditorResetFactoryConfirm: "「{mode}」は現在のイコライザー設定を上書きし、工場出荷時の既定状態に戻します。", eqEditorResetFactoryDone: "モード{n}を工場出荷時の既定イコライザーに戻しました。", eqSwitchUnsavedHint: "現在モードのイコライザーを変更しました。直接適用すると、編集中の内容が上書きされます。", eqSwitchApplyDirect: "直接適用", eqSwitchSaveThenApply: "保存してから適用", AudioBright: "オーディオ明るさ", AudioBrightDesc: "音の高周波部分を強化し、音がよりクリアで詳細に、全体的な明るさと表現力を向上させます", SurroundAmplification: "サラウンド強化", SurroundAmplificationDesc: "オーディオ空間効果を強化し、音の「領域」を広げ、反射と拡散をシミュレートして、スピーカーに囲まれた広い空間にいるような感覚を作り出します", DynamicLF: "ダイナミック低音", DynamicLFDesc: "インテリジェントに低音を調整し、強いリズム時には力強さと深さを強化し、鼓点がより力強くなります。低音が少ない場合は減少し、自然なバランスを保ち、ダイナミックで変化に富んだ低音を実現します", SmartVolume: "インテリジェント音量", SmartVolumeDesc: "音量の変化を自動的に感知し、適切なレベルにインテリジェントに均衡させ、音量が急に大きくなったり小さくなったりすることを防ぎ、安定したリスニング体験を提供し、手動で頻繁に音量を調整する必要はありません", VocalClarity: "音声のクリア化", VocalClarityDesc: "音声の周波数帯域を精密に最適化し、ノイズやバックグラウンド音の干渉を低減し、純粋な音声を強調し、歌を聴いたり、ドラマを見たり、通話をしたりする際に、卓越した聴覚体験を提供します", MusicMode: "音楽モード (高ダ)", VoiceMode: "音声モード (低ダ)", NCut: "ノイズ抑", Freqtrap: "周波数帯カット", Intensity: "強度", DYIntensity: "低音強度", QXIntensity: "クリア強", Speech: "音声通知", SpeechDesc: "スピーカー操作中の音声フィードバック（スピーカーの物理的な「+」ボタンと「G」ボタンを同時に {time} 秒間押すことで、音声フィードバックを有効または無効にすることもできます）", SpeechDescK20Pro: "スピーカー操作中の音声ガイド（スピーカーのマイクボタンを{time}秒間押すと、音声ガイドをオン／オフできます）", micDisabled: "マイク無効", micDisabledTitle: "マイクが無効になっていることが検出され、マイクを正しく使用できません", step: "解決手順:", step1: "1. 以下の [Windows サウンド デバイス] ボタンをクリックします。", step2: "2. ポップアップ システム サウンド コントロール パネル (以下の図を参照) で、[録音] を選択します。リストで対応するデバイスを見つけ、右クリックしてマイクを有効にし、[OK] をクリックします。", step3: "3. 有効にしたら、下の [更新] アイコンをクリックします。" }, eq: { title: "イコライザー", game1: "EQモード1", game2: "EQモード2", game3: "EQモード3", eqSlotDefaultDesc: "オンボードプリセットスロット", popover2: "イコライザーはミキサーのように、オーディオの周波数と音量を調整でき、お好みに応じて高音と低音の周波数帯域を調整できます。例えば、ゲーム時に低音を強化して爆発音や足音を強調し、高音を上げて銃声や衝突音をより明確にすることができます。自分の習慣に合わせて専用のサウンドエフェクトを作り出し、没入感や競技的な優位性を高めます", popover: "イコライザーは各周波数帯の音量を調整し、好みに合わせた音質にカスタマイズできます。", import: "インポート", 默认: "デフォルト", 音乐清脆风: "クリアスタイル", 音乐清脆风1: "クリアスタイル1", 音乐清脆风2: "クリアスタイル2", "3D影视": "3D映画", 舞曲: "ダンスミュ", 饶舌曲: "ラップ", 重金属: "ヘビーメタル", 爵士: "ジャズ", 抒情摇滚: "バラードロック", 摇滚: "ロック", 现场: "ライブ", 高音: "ハイ音", 低音: "ロー音", bandBass: "低音", bandLowMid: "低中音", bandMid: "中音", bandHighMid: "中高音", bandHigh: "高音", 古典乐: "クラシック音楽", 声乐: "ボーカル", 无畏契约: "ヴァロラント", 无畏契约1: "ヴァロラント1", 无畏契约2: "ヴァロラント2", 无畏契约3: "ヴァロラント3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "エイペックス", Apex1: "エイペックス1", Apex2: "エイペックス2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "デルタ", 三角洲1: "デルタ1", 三角洲2: "デルタ2", 三角洲3: "デルタ3", add: "カスタマイズ", more: "その他", empty: "エフェクトが選択されていません", renamePlaceholder: "カスタム名を入力してください", export: "エクスポート", delete: "削除", saveAs: "カスタマイズとして保存します", reset: "デフォルトに戻す", newNameTitle: "カスタマイズ", newNamePlaceholder: "カスタム名を入力してください", duplicate: "その名前は既に存在しますので、再度入力してください", ok: "確認", importSuccess: "インポートに成功しました", importFail: "インポートに失敗しました。再試行してください", importFailName: "インポートに失敗しました。名前が重複していますので、修正してください", exportSuccess: "エクスポート成功", exportFail: "エクスポートに失敗しました。再試行してください", deleteTitle: "注意", delPre: '「"', delAfter: "？削除後は復元できません。必要に応じてローカルにエクスポートしてください", expertListTip: "大神プリセットは音響モードに紐づいています。最適な音質のため、音響モードは変更しないでください。" }, mode: { modeDesc: "異なるモードをワンクリックで切り替えることができ、あなたに独占的で究極の聴覚体験をもたらします", gameMode: "ゲームモード", gameMode1: "ゲームモード 1", gameMode2: "ゲームモード 2", musicMode: "音楽モード", movieMode: "映画モード", gameModeDesc: "銃声や足音の細部を強調し、競技系FPSゲームに最適", musicModeDesc: "プロ調整で音の細部を再現、音楽没入シーンに最適", movieModeDesc: "シアター級のサウンド体験を実現し、映画没入シーンに最適", gameModeDesc2: "戦場の環境音を強調し、戦場系FPSゲームに最適" }, light: { switch: "ライト", switchOn: "ライトオン", switchOff: "ライトオフ", title: "ライト効果", static: "Constant on", breath: "Breathing", cyclicDiscolor: "星の流れ", goFlow: "Waves", continue: "持続", duan: "短い", chang: "長い", an: "暗い", guang: "明るい", direction: "方向", clockwise: "時計回り", anticlockwise: "反時計回り", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB 同期有効", syncClosed: "本デバイスの RGB 同期をオフにし、選択したライティングを適用しました", flowing_f: "Flowing Light - Fast", speed: "速度", fast: "速い", slow: "遅い", colorjoe: "パレット", reset: "デフォルトに戻します", notView: "このライト効果はプレビューできません", color: "色彩", lightShow: "照明表示", lightShow1: "すべてのライトを点灯", lightShow2: "真ん中のライトを消灯", lightShow3: "両側のライトを消灯", smartLight: "スマートライト", smartLightDesc: "オンにすると、30分間操作・再生がない場合、画面とアンビエントライトが自動で低輝度になります", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "速度と明るさ", brightness: "明るさ" }, surround: { switch: "バーチャル7.1サラウンド", popover: "7.1チャンネルのサラウンドサウンドをシミュレートし、オンにすると、音が複数の方向から聞こえるようになり、ゲームのシーンや映画のストーリーに没入できます。音の方向と距離を正確に定位し、より立体的で没入感のある音響体験を提供します", popoverGame: "バーチャル7.1サウンドはFPSには不向きで、3Aゲームや映像向けです。", mode: "モード選択", music: "音楽/ゲームモード", movie: "映画モード", test: "スピーカーテスト", start: "テスト開始", stop: "テスト停止", size: "部屋のサイズ", small: "小", mid: "中", big: "大" }, otherSettings: { v9TurboHeadset: "2.4Gモードで接続して更新してください", alreadyLatest: "ファームウェアは最新バージョンですので、更新の必要がありません", latest: "最新です", goUpdate: "アップグレード", baseV: "ベースファームウェアバージョン：", usbV: "デバイス USB バージョン:", firmwareV: "デバイス FW バージョン:", headsetV: "ヘッドセット FW バージョン：", dongleV: "受信機のファーム版：", findNew: "最新版が検出されました：", speakerShutdown: "機器の電源オフ", speakerShutdownDesc: "ドライバーは電源を切ることしかできません、入れることはできません", shutdown: "電源オフ", speakerShutdownConfirm: "機器の電源をオフにしますか？", speakerShutdownSuccess: "スピーカーがオフになりました", speakerShutdownDeviceError: "デバイスが接続されていません。デバイスを確認してください", speakerShutdownFailed: "スピーカーのオフに失敗しました", and: "、", restoreFactory: "工場出荷時の設定に戻します", restoreFactoryDesc: "すべての設定が工場出荷時の状態に戻りますので、慎重に操作してください", restore: "初期化", restoreSuccess: "出荷時設定へのリセットが正常に完了しました", downloading: "ファームウェアファイルをダウンロード中…", updating: "ファームウェアのアップグレード中...", updatingNote: "アップグレード中は、プログラムを終了したり、機器を抜き差ししたりしないでください！", inDevelopment: "機能開発中です。ご期待ください…", readBinFail: "ファームウェアファイルの読み取りに失敗しました", downloadBinFail: "ファームウェアファイルのダウンロードに失敗しました", otaFail: "ファームウェアのアップグレードに失敗しました", otaFailResult: "ファームウェアのアップグレードに失敗しました。デバイスを抜き差ししてから、再度試してください", otaSuc: "ファームウェアのアップグレードに成功しました", otaSucDongle: "ファームウェアのアップグレードが成功しました。{deviceType}が自動的に再起動するまでお待ちください（変更が適用されるまで約30秒）", otaSucHeadset: "ファームウェアのアップグレードが成功しました。約30秒待ってから、ヘッドフォンを手動で電源を入れて変更を適用してください", otaSucBoth: "ヘッドフォンと受信機のファームウェアアップグレードが成功しました。デバイスの自動再起動をお待ちください（約30秒）", deviceTypeDong: "受信機", deviceTypeDevice: "デバイス", confirmFactoryReset: "この操作を行うと、すべての設定がリセットされます。本当に工場出荷時の設定に戻しますか？", powerManagement: "電源管理", autoShutdown: "省電自動電源オフ：", autoShutdownDesc: "ヘッドホンがドックから外れ（非充電時）、再生がなく設定時間を超えると自動的に電源がオフになります。", minutes: "分", downloadTips1: "1.ファームウェアパッケージはデスクトップに保存することを推奨します。", downloadTips2Exe: "2.ダブルクリックすると自動的にアップグレードが始まります。", downloadTips2Zip: "2.解凍後、ファームウェアパッケージをダブルクリックすると自動的にアップグレードが始まります。", betterOtaTitle: "新しいファームウェアを検出しました。最新バージョンへの更新を推奨します。" }, screenSettings: { screenOTAing: "画面をアップデート中、お待ちください", screenDisplay: "画面表示", screenOn: "画面オン", screenOff: "画面オフ", screenColor: "画面色", presetSettings: "壁紙切替設定", personalizedPreset: "画面壁紙", customText: "テキスト", custom: "カスタム", digitalClock: "デジタル時計", musicSpectrum: "ミュージックスペクトラム", campusDaily: "キャンパスライフ", workplaceLife: "職場生活", cutePets: "かわいいペット", electronicGames: "ビデオゲーム", cyberTech: "サイバーテクノロジー", networkMeme: "ネット流行語", customImage: "カスタム画像", customImageOTAWarning: "先にファームウェアを更新してからご利用ください", addImage: "画像を追加", uploadImage: "画像をアップロード", reuploadImage: "再アップロード", supportImageFormat: "PNG/JPG/GIF対応。GIFは最初の30フレームのみ対応", previewImage: "プレビュー", text: "テキスト", scenery: "風景", character: "人物", uploadingToScreen: "画面にアップロード中", reverseColor: "色反転", scaleScreen: "画面拡大", scaleImage: "画像拡大", blackWhiteRatio: "白黒比率", deleteImageConfirm: "このカスタム画像を削除しますか？削除後は復元できません", deleteImage: "削除", batchDeleteImage: "一括削除", selectAll: "すべて選択", cancelSelectAll: "全選択解除", processImage: "画像処理", exitBatch: "一括終了", deleteSelectedImageConfirm: "選択した画像を削除しますか？削除後は復元できません", textContent: "テキスト内容", textLengthLimit: "入力文字数が上限に達しました", save: "保存", savedSuccess: "保存済み", historyRecords: "履歴", clearHistory: "ワンクリックで履歴をクリア", historyTip: "最新20件のみ表示", textEffect: "文字効果", staticDisplay: "静的表示", dynamicDisplay: "動的表示", alignment: "配置方法", leftAlign: "左揃え", centerAlign: "中央揃え", rightAlign: "右揃え", justifyAlign: "両端揃え", scrollEffect: "スクロール効果", scrollToRight: "左から右へ", scrollToLeft: "右から左へ", customColors: "カスタムカラー", clearCustomColors: "クリア", syncToLight: "現在の色をライトに同期", shortPress: "短押し", lyrics: "歌詞", lyricsDisplay: "歌詞表示（BETA）", lyricsDisplayHintLead: "歌詞に対応したオーディオを再生すると、画面に現在の歌詞が表示されます。", lyricsDisplayCantSeeLink: "歌詞が表示されませんか？", lyricsDisplayCantSeeTooltip: "現在は一部の音楽アプリのみ対応しています。最新版へ更新後、M HUB を更新してください", lyricsOn: "オン", lyricsOff: "オフ", lyricsAnimation: "歌詞アニメーション", notSupportSyncToLight: "現在のライト効果は多色で、色の同期は非対応", syncToLightSuccess: "同期成功", uploadToScreenTip: "約{time}秒、終了しないでください", deleteCustomColorConfirm: "現在の色を削除しますか？", deleteAllCustomColorsConfirm: "すべてのカスタムカラーを削除しますか？", minimumSelectionToast: "少なくとも2つ選択", textVerifyFailed: "ピクセル表示は絵文字や特殊記号などの非標準文字に未対応です。テキストのみ入力してください", lyricsAnimationOption1: "入場：下から上へ。退場：下から上へ", lyricsAnimationOption2: "入場：中央から展開。退場：中央へ収縮", lyricsAnimationOption3: "入場：左から右へ。退場：右から左へ", lyricsAnimationOption4: "入場：下から上へ。退場：上から下へ", lyricsAnimationOption5: "入場：上から下へ。退場：右から左へ", lyricsAnimationDemo: "歌詞アニメーション演示", uploadingImgTip: "アップロード中の画像があります。しばらくしてから再試行してください" }, update: { alreadyNew: "最新バージョンです", findNew: "最新バージョンを検出", ignore: "無視", update: "アップグレード", showHistory: "履歴バージョンの確認", updating: "ドライバのアップグレード中…", rollingBack: "履歴バージョン{version}に戻っています…", updateContentTitle: "ドライバのアップグレード", updateContent: "ドライバの更新内容：", updateNow: "直ちにアップ", back: "戻る", historyTitle: "履歴バージョン", version: "バージョン番号", date: "更新日", backToList: "上の階層に戻ります", only30: "最近の30個の履歴バージョンを保持します", operation: "操作", watchContent: "更新内容の確認", rollTo: "このバージョンに戻ります", currentVersion: "現在のバージョン", updateTo: "このバージョンにアップグレードします", updateSuccess: "ドライバのアップグレードが完了しました", revertSuccess: "履歴バージョン{version}に戻りました", updatePre: "アップグレード中です。しばらくお待ちください…", updateAfter: "アプリケーションがまもなく自動的に再起動します。しばらくお待ちください", inviteUpdate1: "新しいバージョンを検出", inviteUpdate2: "しました。今すぐアップグレ", inviteUpdate3: "ードをお勧めします", notAdminRunning: "アップグレードには管理者権限が必要です。アプリを終了し、アプリアイコンを右クリックして「管理者として実行」を選択してください。起動後、再度アップグレードをお試しください", updateResultFail: "アップデートに失敗しました。これにより、一部の機能が使用できなくなる可能性があります。アンインストールしてから、マイコン公式ウェブサイトで最新のインストール パッケージをダウンロードしてインストールしてください", updateFailAfter: "圧縮パッケージの作成段階で異常が発生しました。アンインストールしてから、マイコン公式ウェブサイトで最新のインストール パッケージをダウンロードしてインストールしてください", updateFailPre: "アップグレードの前処理段階で異常が発生しました。しばらくしてから再度試してください。引き続き失敗した場合は、ドライバをアンインストールしてから、マイコン公式ウェブサイトで最新のドライバインストール パッケージをダウンロードして再インストールしてください", updateUpFailDefault: "ドライバのアップグレードに失敗しました。しばらくしてから再度試してください", updateBackFailDefault: "古いバージョンに戻すことに失敗しました。しばらくしてから再度試してください", notSupportUpdate: "現在のバージョンはオンラインアップグレードをサポートしていません。マイコン公式ウェブサイトで最新バージョンのインストール パッケージをダウンロードして再インストールしてください", restartFinishUpdate: "ドライバー再起動" }, musicDance: { settingPanel: "音楽のリズム制御パネル", scaleEffect: "ズーム リズム", scaleKeyboard: "ズーム キーボード", showEffect: "リズム表示", showKeyboard: "キーボード表示", reset: "デフォルトに戻します", needWinVcTitle: "システムに Windows MSVC ランタイムライブラリが不足しているため、一部機能が制限される可能性があります", needWinVcDesc: "マイクロソフト公式のライブラリ「vc_redist.x64.exe」をダウンロードしてインストールしてから、アプリケーションを再起動してください：", needWinVcLink1: "マイクロソフト公式のダウンロードアドレス：", needWinVcLink2: "予備のダウンロードアドレス：", download: "ダウンロードをクリック", needWinVcNotice: "インストール後もこのメッセージが表示される場合は、お使いのシステムが現在この機能に対応していない可能性があります" }, wechatLogin: { privacyPrefix: "ログインで", privacyPolicy: "「プライバシーポリシー」", privacySuffix: "「利用規約」", privacyAnd: "と", privacyEnd: "に同意したことになります", accountMergeHint: "連携後、WeChat/メールで同一アカウントにログイン可能。データは統合されます", accountUnbindEmailHint: "解除後もデータはWeChatに保持され、WeChatでログイン可能", privacyPolicyTitle: "プライバシーポリシー", userAgreement: "ユーザー規約", privacyWelcome: "MCHOSE WeChat認証ログインサービスへようこそ！本【ユーザー契約書】（以下「本契約」といいます。）は、深圳市マイチョウ科技有限公司（Shenzhen MCHOSE Technology Co., Ltd.）（以下「当社」または「MCHOSE」といいます。）とユーザー（以下「お客様」または「ユーザー」といいます。）との間で、MCHOSEがWeChat認証ログイン方式により提供するサービス（以下「本サービス」といいます。）に関する権利義務を定めるものです。", privacyReadNotice: "サービスをご利用になる前に、本ポリシーの全内容を必ずよくお読みいただき、理解してください。本サービスを利用された場合、本プライバシーポリシーの全内容を読み、理解し、同意されたものとみなします。", privacySection1Title: "1. 収集する情報", privacySection1Desc: "サービス利用の過程で、当社は以下の情報を収集することがあります。", privacyWechatInfo: `1.1 WeChat認証情報
お客様がWeChatログインを行う際、WeChatプラットフォームのインターフェースを通じて、お客様のニックネーム、プロフィール画像、openid、unionidなどの基本情報を収集し、アカウント識別およびパーソナライズサービスの提供に利用します。`, privacyCloudData: `1.2 クラウド利用データ
お客様がアップロード、保存、呼び出す設定ファイルは、当社のクラウドサーバーに保存され、デバイス間の同期利用をサポートします。`, privacySection2Title: "2. 情報の利用目的", privacySection2Desc: "当社は収集した情報を、以下の合法的かつ正当な必要な目的のみに使用します。", privacyServiceFunction: `2.1 サービス機能の提供
WeChat認証ログイン、クラウド保存および設定ファイルの呼び出しといった主要サービスを提供します。`, privacyServiceSecurity: `2.2 サービスの安全確保
本人確認、異常検知、障害調査等に使用し、システムの安定性と安全性の向上を図ります。`, privacySection3Title: "3. 情報の保管および保護", privacyStorageLocation: `3.1 保管場所と保有期間
すべてのユーザーデータは中国本土内のサーバーに保管されます。前述の目的を達成するために必要な期間のみ情報を保持し、期間経過後は削除または匿名化処理を行います。`, privacySecurityMeasures: `3.2 情報セキュリティ対策
多重暗号化、アクセス制御、ログ監査などの技術的措置を講じており、不正アクセス、漏えい、改ざん、破壊を防止します。`, privacySection4Title: "4. お客様の権利", privacyRightsDesc: "適用される法律・規制に基づき、お客様には以下の権利があります。", privacyQueryAccess: `4.1 照会およびアクセス
当社が情報を保有しているかどうかの照会および個人情報へのアクセス権があります。`, privacyCorrectionDelete: `4.2 修正および削除
保有情報に誤りや無効な内容がある場合、修正または削除を請求できます。`, privacyCancelWithdraw: `4.3 退会および同意撤回
WeChatプラットフォームまたは当社への連絡を通じて退会または同意撤回が可能であり、その場合は情報の処理を停止します。ただし法令に基づく例外を除きます。`, privacySection5Title: "5. ポリシーの更新", privacyPolicyUpdate: "事業の進展や法令の変更に応じて本プライバシーポリシーを随時更新します。更新内容はWeChatミニプログラムのお知らせやその他合理的な方法で通知します。サービスの継続利用は更新後のポリシーへの同意を意味します。", privacySection6Title: "6. お問い合わせ", privacyContactDesc: "本プライバシーポリシーに関するご質問、ご意見、ご不満がある場合は、下記の連絡先までお問い合わせください。", privacyServiceHotline: "6.1 サービス窓口電話番号：400-816-8986", privacyServiceTime: "6.2 受付時間：月曜～金曜 9:00～19:00", privacyConclusion: "MCHOSEのWeChat認証ログインサービスをご利用いただきありがとうございます。当社はお客様の情報保護とプライバシー権利の確保に努めてまいります。", userAgreementWelcome: "MCHOSE WeChat認証ログインサービスへようこそ！本【ユーザー契約書】（以下「本契約」といいます。）は、深圳市マイチョウ科技有限公司（Shenzhen MCHOSE Technology Co., Ltd.）（以下「当社」または「MCHOSE」といいます。）とユーザー（以下「お客様」または「ユーザー」といいます。）との間で、MCHOSEがWeChat認証ログイン方式により提供するサービス（以下「本サービス」といいます。）に関する権利義務を定めるものです。", userAgreementReadNotice: "ご利用にあたり、本契約の全ての内容をよくお読みいただき、特に免責事項およびお客様の権利制限に関する部分について十分にご理解ください。", userAgreementSection1Title: "1. 本サービスの利用条件", userAgreementSection1Desc: "1.1 お客様は以下の事項を明確に表明し、保証します。", userAgreementLegalCapacity: "· 本契約を締結し、本サービスを利用する法的資格を有していること。", userAgreementMinorNotice: "· 未成年者の場合、保護者の指導のもと、かつ保護者の同意を得た上で本サービスを利用すること。14歳未満の場合は法定代理人の明確な同意または指導のもとで利用してください。", userAgreementRequirements: "1.2 本サービスの利用には、ネットワーク接続が可能な対応機器およびWeChatアプリのインストールが必要であり、WeChat認証ログインを完了する必要があります。", userAgreementSection2Title: "2. アカウントログインおよび利用", userAgreementLoginProcess: "2.1 本サービスはWeChatプラットフォームに依存した認証ログインにより提供されます。初回利用時にWeChat認証手続きを同意・完了していただくことで、MCHOSEサービスアカウントが作成または識別されます。", userAgreementInfoAccuracy: "2.2 お客様は認証情報の真実性・正確性を保証し、サービス正常利用のために情報を速やかに更新してください。", userAgreementAccountSecurity: "2.3 お客様はWeChatアカウントおよび関連情報を適切に管理し、紛失や漏洩による損害は自己責任となります。", userAgreementSection3Title: "3. 本サービスの内容", userAgreementCloudService: "3.1 クラウドサービス：設定ファイルのクラウドへのアップロード、保存、同期および管理。", userAgreementConfigCall: "3.2 設定適用：ユーザーがアップロードした設定ファイルをインポートし、パーソナライズされた体験を実現。", userAgreementOfficialSync: "3.3 公式設定ファイルの同期：最新の公式設定ファイルをリアルタイムで同期。", userAgreementServiceAdjustment: "MCHOSEは事業の発展に伴い、サービス内容の追加・削除・調整を行う権利を有し、事前通知なしに実施する場合があります。", userAgreementSection4Title: "4. ユーザー行動規範", userAgreementBehaviorRule1: "4.1 本サービスの利用にあたり、違法行為や権利侵害、システムの安全を損なう行為を行ってはなりません。", userAgreementBehaviorRule2: "4.2 具体的には、違法情報の拡散、他者の権利侵害、詐欺行為、プラットフォームシステムの妨害などが含まれます。", userAgreementBehaviorRule3: "4.3 上記の行為があった場合、MCHOSEは警告、利用制限、アカウント停止、法的措置などを講じる権利を有します。", userAgreementSection5Title: "5. 知的財産権", userAgreementIPOwnership: "5.1 本サービスの全てのコンテンツ、インターフェースデザイン、コード、API、グラフィック、レイアウト等はMCHOSEまたはその権利者に帰属します。", userAgreementIPRestriction: "5.2 無断での複製、配布、改変、譲渡または商用利用は禁止されています。", userAgreementSection6Title: "6. プライバシー保護", userAgreementPrivacyNotice1: "6.1 当社はお客様のプライバシー保護を重視しています。個人情報の収集、利用、保存および保護方法については【プライバシーポリシー】をご参照ください。", userAgreementPrivacyNotice2: "6.2 本サービス利用前に必ずポリシーを読み、お客様の権利および当社の義務を理解してください。", userAgreementSection7Title: "7. 免責事項", userAgreementDisclaimer1: "7.1 当社はサービスの安定稼働およびデータ安全確保に努めますが、不可抗力やシステム障害等によるサービス停止やデータ損失等については責任を負いかねます。", userAgreementDisclaimer2: "7.2 ユーザー側の事情による損害はユーザー自身の責任となります。", userAgreementSection8Title: "8. 契約の更新および変更", userAgreementUpdate1: "8.1 MCHOSEは法令や事業状況の変更に応じて本契約を更新し、WeChat上の告知またはその他合理的な方法で通知します。", userAgreementUpdate2: "8.2 お客様が引き続き本サービスを利用する場合、更新後の契約内容を承諾したものとみなします。", userAgreementSection9Title: "9. 準拠法および紛争解決", userAgreementLaw1: "9.1 本契約は中華人民共和国の法律に準拠します。", userAgreementLaw2: "9.2 紛争が生じた場合、双方は協議により解決を図り、協議不調の場合は深圳市龍崗区の管轄裁判所に提訴できます。", userAgreementSection10Title: "10. お問い合わせ", userAgreementContactDesc: "本プライバシーポリシーに関するご質問、ご意見または苦情は、以下の連絡先までお願いいたします。", userAgreementServiceHotline: "10.1 サービス電話番号：400-816-8986", userAgreementServiceTime: "10.2 受付時間：月曜～金曜 9:00～19:00", userAgreementConclusion: "MCHOSE WeChat認証ログインサービスをご利用いただき、誠にありがとうございます。お客様の情報の安全とプライバシー権の保護に努めてまいります。", emailPlaceholder: "メールアドレスを入力", emailFormatError: "メール形式が正しくありません", emailSendCode: "認証コード取得", emailResend: "再送", emailResendCountdown: "再送（{n}秒）", bindEmailGetCode: "認証コード取得", switchToWechatAria: "タップでWeChatログインに切替", switchToEmailAria: "タップでメールログインに切替", cornerTooltipWechat: "タップでWeChatログインに切替", cornerTooltipEmail: "タップでメールログインに切替", titleEmailLogin: "メールログイン", titleWechatLogin: "WeChatログイン", titleBindEmail: "メール連携", testEnvLoginTitle: "テスト環境でログイン", testEnvSuffix: "（テスト）", testCodePlaceholder: "認証コード（code）を入力", btnLogin: "ログイン", codeStepBack: "戻る", enterVerificationCode: "コード入力", codeEmailCheckTitle: "メールをご確認ください", codeEmailSentLine: "認証コードを送信しました。", codeEmailInboxLine: "{email} の受信箱をご確認ください。", devOpenDevtools: "開発者ツールを開く", devInspectPage: "ページを検証", msgSendCodeFailRetry: "コード取得に失敗しました", msgOtpSixDigits: "6桁のコードを入力してください", msgWxConfigInitFail: "WeChatの初期化に失敗しました。ネットワークを確認してください。", msgLoginPageLoadFail: "ログインページの読み込みに失敗しました。", msgLoginFailRetry: "ログインに失敗しました。もう一度お試しください。", msgTestEnterAuthCode: "認証コードを入力してください", msgBindFailGeneric: "紐づけに失敗しました" }, user: { modifyNickname: "ニックネームを変更", modifyAvatar: "アバターを変更", nicknamePlaceholder: "新しいニックネームを入力してください", nicknameTip: "ニックネームの長さは1-10文字に制限されています", nicknameEmpty: "ニックネームは空にできません", nicknameLengthError: "ニックネームの長さは1-10文字の間である必要があります", nicknameUpdateSuccess: "ニックネームを変更しました", avatarUpdateSuccess: "アバターを更新しました" } }, wI = { common: { prompt: "알림", refresh: "새로고침", cancel: "취소", close: "닫기", restore: "기본값 복원", iKnowIt: "확인", notAdminRunning: "이 작업을 수행하려면 관리자 권한이 필요합니다. 애플리케이션을 종료한 후 아이콘을 마우스 오른쪽 버튼으로 클릭하고 “관리자 권한으로 실행”을 선택한 다음 다시 시작하여 시도해 주세요.", clickLogin: "로그인", cloudEqTip: "로그인 후 클라우드 기능을 사용할 수 있습니다（추가 설정 공유 기능 개발 중, 기대해 주세요）", editNickname: "닉네임 수정", changeAvatar: "프로필 사진 변경", avatarTip: "JPG, PNG 형식을 지원하며, 파일 크기는 2MB를 초과할 수 없습니다", logout: "로그아웃", autoWechatLogin: "아래 항목을 체크하면 WeChat 로그인으로 자동 이동합니다", privacyPrefix: "로그인하면", userAgreement: "이용 약관", loginSuccess: "로그인 성공", emailLoginSuccess: "로그인 성공", bindWechatAction: "WeChat 연동", bindWechatSuccess: "WeChat 연동 성공", bindWechatFailed: "WeChat 연동 실패", wechatAlreadyBoundOtherEmail: "해당 위챗은 다른 이메일에 이미 연결되었습니다", emailAlreadyBoundOtherWechat: "해당 이메일은 다른 위챗에 이미 연결되었습니다", unbindEmail: "이메일 바인딩 해제", unbindEmailGetCode: "인증코드 받기", unbindEmailSuccess: "해제 성공", unbindEmailCodeInvalid: "유효하지 않은 코드", accountBindWechat: "위챗 바인딩", accountBindEmail: "이메일 바인딩", accountUnbindEmail: "이메일 바인딩 해제", bindEmailSuccess: "바인딩 성공", logoutSuccess: "로그아웃 완료", changesSubmitted: "수정이 제출되었습니다. 검토를 기다려 주세요", nicknameEmpty: "닉네임은 비워둘 수 없습니다", enterNickname: "닉네임을 입력해 주세요", confirm: "확인", official: "공식 프리셋", game: "게임", music: "음악", cloud: "클라우드 커뮤니티", cloudShared: "클라우드 공유", favorited: "즐겨찾기됨", myShares: "내 공유", search: "검색", latest: "최신순", topUsed: "TOP 사용", topLiked: "TOP 좋아요", topFav: "TOP 즐겨찾기", author: "작성자", import: "가져오기", imported: "가져옴", favoritedStatus: "즐겨찾기에 추가되었습니다", removedFromFavorites: "즐겨찾기에 추가됨", liked: "좋아요를 눌렀습니다", unliked: "좋아요를 취소했습니다", importedToCustom: "사용자 정의에 가져오기 완료", importFailed: "가져오기 실패, 최대 20개까지 가능", pleaseLogin: "작업을 하시려면 먼저 로그인해 주세요", maxFavorites: "최대 20개까지 즐겨찾기 가능", noUserUploads: "아직 업로드한 사용자가 없습니다", noSearchResults: "관련 내용을 찾을 수 없습니다. 다른 키워드로 검색해 보세요~", noFavorites: "즐겨찾기가 없습니다", noSharesYet: "아직 공유한 항목이 없습니다", cancelSharing: "공유 취소", notice: "알림", confirmCancelShare: '<strong>"{name}"</strong> 공유를 취소할까요?', delete: "삭제", custom: "사용자 정의", myPresets: "내가 만든 항목", localImport: "로컬 가져오기", cloudImports: "클라우드에서 가져온 항목", confirmDelete: '"xxx"을(를) 삭제하시겠습니까? 삭제 후 복구할 수 없습니다. 필요한 경우 먼저 내보내기를 권장합니다', confirmDeleteReview: '<strong>"{name}"</strong>을(를) 삭제하시겠습니까? 해당 EQ는 현재 검토 중이며, 검토 통과 시 클라우드에 계속 표시될 수 있습니다.', confirmDeleteSimple: '<strong>"{name}"</strong>을(를) 삭제하시겠습니까?', fromAuthor: "작성자:", shareToCloud: "클라우드에 공유", shareSuccess: "공유 성공", sharingCanceled: "공유 취소됨", maxSharesPerUser: "사용자당 최대 10개 공유 가능", selectCategory: "카테고리 선택", other: "기타", selectGameTag: "게임 태그를 선택해 주세요", enterPresetTitle: "설정 제목 입력", shareTitlePlaceholder: "클라우드에 공유할 EQ의 멋진 제목을 입력해 보세요", maxSharesPerUserSimple: "사용자당 최대 10개 공유 가능", shareSuccessful: "공유 성공", confirmShareOverwrite: "이 EQ는 이전에 공유된 항목입니다. 다시 공유하면 기존 EQ가 덮어쓰기 됩니다. 계속하시결습니까", share: "공유", restoreDefault: "기본값으로 복원", restoreDefaultSuccess: "기본값으로 복원됨", underReview: "검토 중", export: "내보내기", underReviewTryLater: "검토 중입니다. 나중에 다시 시도해 주세요", underReviewDeleteWarning: "검토 중인 항목은 삭제 시 검토가 중단됩니다", shareFailTitle: "공유 실패: 제목에 문제가 있습니다", shared: "공유됨", exitPreview: "미리보기 종료", nicknameViolation: "부적절함", nicknameViolationTip: "부적절한 닉네임입니다. 수정해주세요", rename: "이름 변경", copy: "복사", copied: "복사됨", noCloudImport: "클라우드에 EQ 없음", unknown: "알 수 없음", noDescription: "설명 없음", shareRequestSubmitted: "공유 요청이 제출되었습니다", copySuffix: "copy", view: "보기", sysChanged: "EQ가 저장되지 않았습니다. <strong>[사용자 지정 저장]</strong>을 클릭하세요.", cmdENOENT: "시스템에서 cmd.exe 파일이 누락되었습니다. 시스템을 복구한 후 다시 시도하세요.", batchOperation: "일괄 작업", selectAll: "전체 선택", exitBatch: "일괄 모드 종료", confirmBatchDeleteAll: '<strong class="delete_name">모든</strong>EQ를 삭제하시겠습니까?', confirmBatchDeleteSelected: "선택한 구성을 삭제하시겠습니까?", using: "In Use", clickToUse: "Use Now", expert: "고수 설정", applySuccess: "선택한 EQ 활성화됨", noData: "데이터가 없습니다" }, tray: { open: "M HUB 열기", quit: "종료" }, commonHeader: { officialStore: "공식 스토어", myDevice: "내 장치", back: "돌아가다", backHome: "홈으로 돌아가기", popoverTheme: "테마 변경", popoverSetting: "설정", popoverRelatedApp: "게임/앱을 연결하여 자동으로 온보드 전환", popoverMin: "최소화", popoverUnmax: "복원", popoverMax: "최대화", popoverClose: "닫기", offline: "현재 서버가 온라인 상태가 아닙니다. 나중에 드라이버를 재부팅하고 다시 시도해주세요", performanceOnDesc: "성능 모드를 끄면 투명 배경, 유리 블러, 테두리 둥근 모서리 효과가 활성화되어 외관이 더 예뻐집니다. 다만 컴퓨터 성능에 일정 요구 사항이 있습니다.", performanceOffDesc: "성능 모드를 켜면 투명 배경, 유리 블러, 테두리 둥근 모서리 효과가 제거되어 조작이 더 원활해집니다. 애플리케이션을 사용할 때 끊김이 발생하면 켜는 것이 좋습니다.", feedback: "피드백", prizeQuiz: "유료 설문" }, themeSetting: { pageName: "테마", white: "화이트", black: "블랙", followSys: "시스템 따라가기", bg: "배경", followTheme: "테마 따라가기", customizeText: "사용자 지정 배경 (홈 화면에서만 적용)", changeBg: "배경 변경", defaultBg: "기본 배경 ", uploadImg: "이미지 업로드", blurCard: "장치 카드 흐림도", blurBg: "이미지 배경 흐림도" }, setting: { version: "현재 버전", startup: "시작 설정", startAuto: "부팅 시 자동 시작", startAutoMini: "시작 시 시스템 트레이로 최소화", language: "언어", closePanel: "패널 닫을 때", exit: "프로그램 종료", minimize: "트레이로 최소화 (프로그램 종료 안 함)", copyright: "" }, menus: { AudioConfiguration: "오디오 설정", LightingSettings: "조명 설정", ScreenSettings: "화면 표시", OtherSettings: "기타 설정", GeneralParameters: "일반 설정", Equalizer: "이퀄라이저", SoundMode: "사운드 모드", VirtualSurround: "가상 7.1 서라운드", CommonParams: "일반 설정", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "화면 설정이 데스크톱의 표시에 영향을 줄 수 있다는 것이 감지되었습니다. 최상의 표시 효과를 위해 화면 확대/축소 및 배치 비율을 수정하세요.", gotoSet: "편집", needAdminNotice: "일부 기능은 권한 부족으로 인해 사용할 수 없습니다. 애플리케이션을 종료한 후 아이콘을 마우스 오른쪽 버튼으로 클릭하고 ‘관리자 권한으로 실행’을 선택하여 다시 시작해 주세요", loadFail: "로딩 실패", loadFailDesc: "다시 로드하려면 새로고침 버튼을 클릭하거나 네트워크 연결을 확인하고 드라이버를 재시작하세요." }, devicePage: { needOtaNotice: "새 펌웨어 버전이 감지되었습니다. 드라이버를 정상적으로 사용하려면 업그레이드해야 합니다. 펌웨어를 다운로드하고 업데이트하세요.", needOtaNoticeTip: "안내: 다운로드 후 저장 경로로 이동하여 도구 키트를 열고 안내에 따라 업그레이드를 진행하세요.", downloadNow: "즉시 다운로드", restartNotice: "드라이버 설치 후, 컴퓨터를 재시작해야 정상적으로 사용할 수 있습니다.재시작 후에도 드라이버가 정상적으로 작동하지 않는 경우, 고객 지원팀에 문의해 주세요.", restartNow: "지금 재시작", speakerDisabled: "스피커가 비활성화되어 드라이버가 정상적으로 실행되지 않습니다", step: "해결 방법:", step1: "1. 아래 [Windows 사운드 장치] 를 눌러줍니다.", step2: "2. 시스템의 사운드 설정창이 나오면 (예시 화면 참고), 재생을 선택하여, 목록에서 해당 장치를 찾은 후 기기의 오른쪽 버튼 -> 사용 -> 확인 버튼을 누릅니다.", step3: "3. 활성화 후, 아래 [새로고침] 버튼을 누릅니다.", isSleep: `이미 휴면 상태에 진입한 경우, 이어폰을 다시 시작해주세요. 
또는 연결 모드가 2.4G인지 확인해주세요. (리시버를 다시 꽂아보시기 바랍니다.) 참고: 오디오 케이블을 연결하거나 블루투스 모드에서는 드라이버를 사용할 수 없습니다.`, deviceLostLink: "드라이버 연결이 끊어졌습니다", headphoneSleepStatus: "헤드셋이 절전 상태입니다", headphoneSleepStatusTips: "버튼으로 깨우거나 헤드셋을 다시 시작하세요", needLinkWireless: "드라이버는 2.4G 연결만 지원합니다", needLinkWirelessHeadphoneTips: "수신기가 연결되어 있는지 확인하고 오디오 케이블 또는 블루투스 모드는 사용하지 마세요", wiredMode: "유선 연결", lessThan: "{val} 미만", charging: "충전 중", sufficientCharge: "배터리 충분", wiredVersion: "유선", notAdminRunningHeadset: "오디오 장치에는 관리자 권한이 필요합니다. 애플리케이션을 종료한 후 아이콘을 마우스 오른쪽 버튼으로 클릭하고 ‘관리자 권한으로 실행’을 선택하여 다시 시작해 주세요", thxInstallDialogTitle: "오디오 구성 요소 설치 중", thxInstallDialogTitleUpgrade: "오디오 구성 요소 업데이트 중", thxInstallDialogDesc1: "예상 소요 시간은 1~2분입니다. 잠시 기다려 주세요", thxInstallDialogDesc2: "설치 중에는 드라이버를 종료하지 마세요. 완료 후 자동으로 장치 상세로 이동합니다" }, routine: { UserManual: "매뉴얼", beepTitle: "알림음", beepTitleDesc: "헤드셋 음성 안내 볼륨 조절(미디어 볼륨에는 영향 없음)", UserManualFull: "사용 방법 매뉴얼", Volume: "볼륨", Microphone: "마이크", MicAI: "AI 노이즈 감소 켜기", MicAIDesc: "주변 소음을 제거하고 원음을 유지하여 더 깨끗하고 선명한 음질을 제공합니다.", MicNoiseReduction: "지속 상태 잡음 억제", MicNoiseReductionDesc: "에어컨이나 선풍기 소음 같은 특정 주파수 대역의 지속적인 소음을 줄여주는 기능입니다.", MicListen: "마이크 모니터링", MicListenDesc: "자신의 목소리를 실시간으로 들으며 마이크 볼륨을 쉽게 조절하여 통화를 더 선명하고 안정적으로 만듭니다.", MoYin: "매직 사운드 효과：", MoYin_0: "몬스터", MoYin_1: "카툰", MoYin_2: "남성 음성", MoYin_3: "여성 음성", WindowsAudioDevices: "Windows 사운드 장치", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "모드 {n}(으)로 전환했습니다", eqItemHoverApply: "적용", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "자동 저장됨", eqEditorModifiedAutoSaved: "수정됨, 자동 저장됨", eqEditorCollapse: "접기", eqEditorResetFactory: "공장 기본 EQ로 복원", eqEditorResetFactoryConfirm: "[{mode}]이(가) 현재 이코라이저 설정을 덮어쓰고 공장 기본 상태로 복원합니다.", eqEditorResetFactoryDone: "모드 {n}이(가) 공장 기본 이코라이저로 복원되었습니다.", eqSwitchUnsavedHint: "현재 모드의 이코라이저를 수정했습니다. 바로 적용하면 편집 중인 내용이 덮어쓰여집니다.", eqSwitchApplyDirect: "바로 적용", eqSwitchSaveThenApply: "저장 후 적용", AudioBright: " 오디오 밝기 향상", AudioBrightDesc: "고주파 영역을 강화하여 사운드를 더욱 선명하고 풍부하게 만들어, 전반적인 표현력을 향상합니다.", SurroundAmplification: "서라운드 확장", SurroundAmplificationDesc: "소리의 범위를 넓혀주고, 반사 및 확산 효과를 시뮬레이션하여 더 넓은 공간에서 스피커에 둘러싸인 듯한 느낌을 제공, 음향의 공간감을 더욱 강화해주는 기능입니다.", DynamicLF: "다이나믹 저음", DynamicLFDesc: "저주파를 자동감지하여 제어합니다.강한 리듬이 있을 경우, 강도와 깊이를 증대시켜 비트를 더욱 강렬하게 만듭니다.저주파가 적을 경우, 자연스러운 균형을 유지하기 위해 약화시킵니다. 이를 통해 역동적이고 다양한 저음 청취 경험을 제공합니다.", SmartVolume: "스마트 볼륨", SmartVolumeDesc: "오디오 볼륨 변화를 자동으로 감지하여 적절한 수준으로 균형을 맞춥니다.갑작스러운 볼륨 상승 또는 감소를 방지하여 안정적인 청취 경험을 제공합니다.빈번한 수동 조정을 줄여 편리한 사용성을 제공합니다.", VocalClarity: "보컬 선명도", VocalClarityDesc: "보컬 주파수 대역을 정밀하게 최적화하여 노이즈 및 배경 간섭을 줄입니다.순수한 보컬을 강조하여 음악, 드라마, 통화에서 모든 단어를 또렷하게 들을 수 있도록 합니다.최상의 청취 경험을 제공합니다.", MusicMode: "음악 모드 (고동적)", VoiceMode: "음성 모드 (저동적)", NCut: "노이즈 억제", Freqtrap: "밴드 분할", Intensity: "강도", DYIntensity: "강도", QXIntensity: "강도", Speech: "음성 안내 기능", SpeechDesc: "스피커 조작 시 음성 안내가 나옵니다. (스피커 버튼의 +와 G 버튼을 동시에 {time}초간 눌러 음성 안내를 온오프 할 수 있습니다.)", SpeechDescK20Pro: "스피커 조작 시 음성 안내 (스피커의 마이크 버튼을 {time}초간 눌러 음성 안내를 켜거나 끌 수 있습니다)", micDisabled: "마이크 비활성화 감지됨", micDisabledTitle: "마이크 비활성화 중，마이크가 비활성화되어 기능을 정상적으로 사용할 수 없습니다", step: "해결 방법:", step1: "1. 아래 [Windows 사운드 장치] 버튼을 클릭합니다.", step2: "2. 시스템의 사운드 설정창이 나오면 (예시 화면 참고), 녹음을 선택하여, 목록에서 해당 장치를 찾은 후 기기의 오른쪽 버튼 -> 사용 -> 확인 버튼을 누릅니다.", step3: "3. 활성화 후, 아래 [새로고침] 버튼을 누릅니다." }, eq: { title: "이퀄라이저", game1: "EQ 모드 1", game2: "EQ 모드 2", game3: "EQ 모드 3", eqSlotDefaultDesc: "온보드 프리셋 슬롯", popover2: "이퀄라이저는 믹싱 콘솔처럼 작동하여 오디오 주파수 볼륨을 조정할 수 있도록 합니다.고음 및 저음을 사용자 취향에 맞게 조절할 수 있습니다.예를 들어, 게임에서 저음을 증폭하면 폭발음과 발소리를 강조할 수 있으며,고음을 높이면 총격음과 충돌음을 더욱 선명하게 만들어 몰입감 있고 경쟁력 있는 사운드 환경을 제공합니다.", popover: "이퀄라이저는 주파수 대역별 음량을 조절해 원하는 사운드로 커스터마이즈할 수 있습니다.", import: "가져오기", 默认: "기본", 音乐清脆风: "청량한 스타일", 音乐清脆风1: "청량한 스타일1", 音乐清脆风2: "청량한 스타일2", "3D影视": "3D 영화", 舞曲: "댄스", 饶舌曲: "랩", 重金属: "메탈", 爵士: "재즈", 抒情摇滚: "발라드 록", 摇滚: "록", 现场: "라이브", 高音: "고음", 低音: "베이스", bandBass: "저음", bandLowMid: "저중음", bandMid: "중음", bandHighMid: "고중음", bandHigh: "고음", 古典乐: "클래식", 声乐: "보컬", 无畏契约: "발로란트", 无畏契约1: "발로란트1", 无畏契约2: "발로란트2", 无畏契约3: "발로란트3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "에이펙스(Apex)", Apex1: "에이펙스(Apex)1", Apex2: "에이펙스(Apex)2", 绝地求生: "배틀그라운드 (PUBG)", 绝地求生1: "배틀그라운드 (PUBG)1", 绝地求生2: "배틀그라운드 (PUBG)2", 绝地求生3: "배틀그라운드 (PUBG)3", CF: "크로스파이어 (CF)", CF1: "크로스파이어 (CF)1", CF2: "크로스파이어 (CF)2", 三角洲: "델타 (Delta)", 三角洲1: "델타 (Delta)1", 三角洲2: "델타 (Delta)2", 三角洲3: "델타 (Delta)3", add: "사용자 지정", more: "더보기", empty: "선택된 효과가 없습니다", renamePlaceholder: "사용자 지정 이름을 입력해 주세요", export: "내보내기", delete: "삭제", saveAs: "사용자 지정으로 저장", reset: "기본값으로 복원", newNameTitle: "사용자 지정", newNamePlaceholder: "사용자 지정 이름을 입력해 주세요", duplicate: "이미 존재하는 이름입니다. 새로운 이름을 입력해 주세요", ok: "확인", importSuccess: "가져오기 성공", importFail: "가져오기 실패, 다시 시도해 주세요", importFailName: "가져오기에 실패했습니다. 이름이 중복되므로 수정해주세요", exportSuccess: "내보내기 성공", exportFail: "내보내기에 실패했습니다. 다시 시도해 주세요.", deleteTitle: "알림", delPre: "“", delAfter: "? 삭제 후 복구할 수 없습니다. 필요한 경우 먼저 내보내기를 권장합니다", expertListTip: "고수 프리셋은 사운드 모드에 연동되어 있습니다. 최상의 음질을 위해 사운드 모드를 변경하지 마세요." }, mode: { modeDesc: "다양한 모드를 단일 클릭으로 전환하여 귀하에게 독특하고 궁극적인 청각 경험을 제공합니다", gameMode: "게임 모드", gameMode1: "게임 모드 1", gameMode2: "게임 모드 2", musicMode: "음악 모드", movieMode: "영화 모드", gameModeDesc: "총소리와 발소리 디테일을 강조하여 경쟁형 FPS 게임에 적합", musicModeDesc: "전문 튜닝으로 사운드 디테일을 복원, 음악 몰입형 장면에 적합", movieModeDesc: "시네마급 사운드 경험 제공, 영화 몰입형 장면에 적합", gameModeDesc2: "전장의 환경음을 강조하여 전장형 FPS 게임에 적합" }, light: { switch: "조명", switchOn: "조명 켜기", switchOff: "조명 끄기", title: "조명 효과", static: "Constant on", breath: "Breathing", cyclicDiscolor: "별의 흐름", goFlow: "Waves", continue: "지속", duan: "짧음", chang: "길음", an: "어두움", guang: "밝음", direction: "방향 설정", clockwise: "시계 방향", anticlockwise: "반시계 방향", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB 동기화 적용중", syncClosed: "현재 장치의 RGB 동기화를 끄고 선택한 조명 효과를 적용했습니다", flowing_f: "Flowing Light - Fast", speed: "속도", fast: "빠름", slow: "느림", colorjoe: "색상 팔레트", reset: "기본값 복원", notView: "해당 조명 효과는 미리보기를 지원하지 않습니다", color: "색깔", lightShow: "조명 표시", lightShow1: "모든 조명 켜기", lightShow2: "중간 조명 끄기", lightShow3: "양쪽 조명 끄기", smartLight: "스마트 조명", smartLightDesc: "켜면 30분 동안 조작 및 재생이 없을 경우 화면과 무드등이 자동으로 저휘도 모드로 전환됩니다", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "속도 및 밝기", brightness: "밝기" }, surround: { switch: "가상 7.1 서라운드", popover: "시뮬레이션된 7.1채널 서라운드 사운드. 활성화되면 다양한 방향에서 소리가 오는 것을 느낄 수 있어 게임 또는 영화의 상황에 몰입하게 하며, 소리의 방향과 거리를 정확하게 파악할 수 있어 보다 다차원적이고 몰입감 있는 청각 경험을 제공합니다.", popoverGame: "가상 7.1 사운드는 FPS 게임에는 부적합하며, 3A 게임 및 영상에 적합합니다.", mode: "모드 선택", music: "음악/게임 모드", movie: "영화 모드", test: "스피커 테스트", start: "테스트 시작", stop: "테스트 중지", size: "실내 크기", small: "소", mid: "중", big: "대" }, otherSettings: { alreadyLatest: "펌웨어가 최신 상태입니다. 업데이트가 필요하지 않습니다", v9TurboHeadset: "2.4G 모드로 연결하여 업데이트하세요", latest: "최신 상태", baseV: "베이스 펌웨어 버전:", goUpdate: `업그레이드로
이동`, usbV: "기기 USB 버전:", firmwareV: "기기 펌웨어 버전：", headsetV: "헤드셋 펌웨어 버전:", dongleV: "리시버 펌웨어 버전:", findNew: "최신 버전 감지됨:", speakerShutdown: "기기 끄기", speakerShutdownDesc: "드라이버는 종료만 가능하며, 켤 수 없습니다", shutdown: "종료", speakerShutdownConfirm: "기기를 끄시겠습니까?", speakerShutdownSuccess: "스피커가 끄였습니다", speakerShutdownDeviceError: "기기가 연결되지 않았습니다. 기기를 확인해 주세요", speakerShutdownFailed: "스피커 끄기 실패", and: ", ", restoreFactory: "공장 초기화", restoreFactoryDesc: "모든 설정이 공장 초기화 값으로 복원됩니다. 신중하게 진행하시기 바랍니다", restore: "공장 초기화", restoreSuccess: "공장 초기화가 성공적으로 완료되었습니다", downloading: "펌웨어 파일 다운로드 중…", updating: "펌웨어 업그레이드 중...", updatingNote: "업그레이드하는 동안 프로그램을 종료하거나 기기를 연결하거나 분리하지 마세요!", inDevelopment: "기능 개발 중입니다. 기대해 주세요… ", readBinFail: "펌웨어 파일을 읽지 못했습니다", downloadBinFail: "펌웨어 파일 다운로드에 실패했습니다", otaFail: "펌웨어 업그레이드에 실패했습니다", otaFailResult: "펌웨어 업그레이드에 실패했습니다. 디바이스를 분리했다가 다시 연결한 후 다시 시도해보세요", otaSuc: "펌웨어 업그레이드가 성공했습니다", otaSucDongle: "펌웨어 업그레이드가 성공적으로 완료되었습니다. {deviceType}가 자동으로 재시작될 때까지 기다려 주세요 (변경 사항이 적용되기까지 약 30초).", otaSucHeadset: "펌웨어 업그레이드가 성공적으로 완료되었습니다. 약 30초 후에 헤드폰을 수동으로 켜서 변경 사항을 적용하세요.", otaSucBoth: "헤드폰과 리시버 펌웨어 업그레이드가 성공적으로 완료되었습니다. 기기가 자동으로 재시작할 때까지 기다려 주세요(약 30초).", deviceTypeDong: "리시버", deviceTypeDevice: "기기", confirmFactoryReset: "이 작업은 모든 설정을 초기화합니다. 공장 초기화를 진행하시겠습니까?", powerManagement: "전원 관리", autoShutdown: "절전 자동 전원 끄기:", autoShutdownDesc: "헤드셋이 도크에서 분리된 상태(비충전)에서 재생 없이 설정한 시간을 초과하면 자동으로 전원이 꺼집니다.", minutes: "분", downloadTips1: "1.펌웨어 패키지는 데스크톱에 저장하는 것을 권장합니다.", downloadTips2Exe: "2.펌웨어 패키지를 더블 클릭하면 자동으로 업그레이드됩니다.", downloadTips2Zip: "2.압축 해제 후 펌웨어 패키지를 더블 클릭하면 자동으로 업그레이드됩니다.", betterOtaTitle: "새 펌웨어가 감지되었습니다. 최신 버전으로 업데이트를 권장합니다." }, screenSettings: { screenOTAing: "화면 업데이트 중, 잠시만 기다려주세요", screenDisplay: "화면 표시", screenOn: "화면 켜짐", screenOff: "화면 꺼짐", screenColor: "화면 색상", presetSettings: "배경 전환 설정", personalizedPreset: "화면 배경", customText: "텍스트", custom: "사용자 정의", digitalClock: "디지털 시계", musicSpectrum: "음악 스펙트럼", campusDaily: "캠퍼스 생활", workplaceLife: "직장 생활", cutePets: "귀여운 반려동물", electronicGames: "비디오 게임", cyberTech: "사이버 기술", networkMeme: "인터넷 밈", customImage: "사용자 이미지", customImageOTAWarning: "먼저 펌웨어를 업데이트한 후 사용하세요", addImage: "이미지 추가", uploadImage: "이미지 업로드", reuploadImage: "다시 업로드", supportImageFormat: "PNG/JPG/GIF 지원. GIF는 앞 30프레임만 지원", previewImage: "효과 미리보기", text: "텍스트", scenery: "풍경", character: "人物", uploadingToScreen: "화면에 업로드 중", reverseColor: "색상 반전", scaleScreen: "화면 확대", scaleImage: "이미지 확대", blackWhiteRatio: "흑백 비율", deleteImageConfirm: "이 사용자 이미지를 삭제하시겠습니까? 삭제 후 복구 불가", deleteImage: "삭제", batchDeleteImage: "일괄 삭제", selectAll: "전체 선택", cancelSelectAll: "전체 선택 해제", processImage: "이미지 처리", exitBatch: "일괄 종료", deleteSelectedImageConfirm: "선택한 이미지를 삭제하시겠습니까? 삭제 후 복구 불가", textContent: "텍스트 내용", textLengthLimit: "입력 가능한 문자 수에 도달했습니다", save: "저장", savedSuccess: "저장됨", historyRecords: "기록", clearHistory: "원클릭 기록 삭제", historyTip: "최근 20개만 표시", textEffect: "텍스트 효과", staticDisplay: "정적 표시", dynamicDisplay: "동적 표시", alignment: "정렬", leftAlign: "왼쪽 정렬", centerAlign: "가운데 정렬", rightAlign: "오른쪽 정렬", justifyAlign: "양쪽 정렬", scrollEffect: "스크롤 효과", scrollToRight: "왼쪽에서 오른쪽", scrollToLeft: "오른쪽에서 왼쪽", customColors: "사용자 정의 색상", clearCustomColors: "사용자 정의 색상 삭제", syncToLight: "현재 색상을 조명에 동기화", shortPress: "짧게 누르기", lyrics: "가사", lyricsDisplay: "가사 표시（BETA）", lyricsDisplayHintLead: "가사를 지원하는 오디오를 재생하면 화면에 현재 가사가 표시됩니다.", lyricsDisplayCantSeeLink: "가사가 보이지 않나요?", lyricsDisplayCantSeeTooltip: "현재 일부 음악 앱만 지원합니다. 최신 버전으로 업데이트 후 M HUB를 새로고침하세요", lyricsOn: "켜기", lyricsOff: "끄기", lyricsAnimation: "가사 애니메이션", notSupportSyncToLight: "현재 조명 효과는 다색, 색상 동기화 불가", syncToLightSuccess: "동기화 성공", uploadToScreenTip: "약 {time}초 소요, 종료하지 마세요", deleteCustomColorConfirm: "현재 색상을 삭제하시겠습니까?", deleteAllCustomColorsConfirm: "모든 사용자 지정 색상을 삭제하시겠습니까?", minimumSelectionToast: "최소 2개 선택하세요", textVerifyFailed: "픽셀 화면은 이모지 및 특수문자를 지원하지 않습니다. 일반 텍스트만 입력하세요", lyricsAnimationOption1: "입장: 아래에서 위로. 퇴장: 아래에서 위로", lyricsAnimationOption2: "입장: 가운데에서 펼쳐짐. 퇴장: 가운데로 모임", lyricsAnimationOption3: "입장: 왼쪽에서 오른쪽으로. 퇴장: 오른쪽에서 왼쪽으로", lyricsAnimationOption4: "입장: 아래에서 위로. 퇴장: 위에서 아래로", lyricsAnimationOption5: "입장: 위에서 아래로. 퇴장: 오른쪽에서 왼쪽으로", lyricsAnimationDemo: "가사 애니메이션 데모", uploadingImgTip: "업로드 중인 이미지가 있습니다. 잠시 후 다시 시도하세요" }, update: { alreadyNew: "최신 펌웨어 사용 중", findNew: "최신 버전 감지됨", ignore: "무시", update: "업그레이드", showHistory: "이전 펌웨어 보기", updating: "드라이버 업그레이드 진행 중...", rollingBack: "이전 버전 {version}로 돌아가는 중...", updateContentTitle: "드라이버 업그레이드", updateContent: "드라이버 업데이트 세부 정보：", updateNow: "업그레이드", back: "돌아가다", historyTitle: "과거 버전", version: "드라이버 버전", date: "업데이트 날짜", backToList: "이전 단계로 돌아가기", only30: "최근 30개의 펌웨어 업데이트 기록 유지", operation: "작업", watchContent: "업데이트 내용 보기", rollTo: "이 버전으로 되돌리기", currentVersion: "현재 버전", updateTo: "이 버전으로 업그레이드", updateSuccess: "드라이버 업그레이드 완료", revertSuccess: "이전 버전 {version}로 돌아가기 완료", updatePre: "업그레이드 준비 중, 잠시만 기다려 주세요...", updateAfter: "애플리케이션이 곧 자동으로 다시 시작됩니다. 잠시만 기다려 주세요", inviteUpdate1: "새 펌웨어버전이 존재합니다. ", inviteUpdate2: "지금 즉시 업그레이드를 권장합니다.", inviteUpdate3: "", notAdminRunning: "업그레이드에는 관리자 권한이 필요합니다. 애플리케이션을 종료한 후 아이콘을 마우스 오른쪽 버튼으로 클릭하고 ‘관리자 권한으로 실행’을 선택하세요. 실행 후 다시 업그레이드를 시도해 주세요", updateResultFail: "업데이트에 실패했습니다. 일부 기능이 작동하지 않을 수 있습니다. 제거한 후 마이콩 공식 웹사이트에서 최신 설치 팩키지를 다운로드하여 설치하세요", updateFailAfter: "압축 팩키지 생성 단계에서 이상이 발생했습니다. 제거한 후 마이콩 공식 웹사이트에서 최신 설치 팩키지를 다운로드하여 설치하세요", updateFailPre: "업그레이드 전 처리 단계에서 이상이 발생했습니다. 나중에 다시 시도해주세요. 여전히 실패하면 드라이버를 제거한 후 마이콩 공식 웹사이트에서 최신 드라이버 설치 팩키지를 다운로드하여 재설치하세요", updateUpFailDefault: "드라이버 업그레이드에 실패했습니다. 나중에 다시 시도해주세요", updateBackFailDefault: "이전 버전으로 롤백에 실패했습니다. 나중에 다시 시도해주세요", notSupportUpdate: "현재 버전은 온라인 업그레이드를 지원하지 않습니다. 마이콩 공식 웹사이트에서 최신 버전의 설치 팩키지를 다운로드하여 재설치하세요", restartFinishUpdate: "드라이버 재시작" }, musicDance: { settingPanel: "음악 리듬 제어 패널", scaleEffect: "줌 리듬", scaleKeyboard: "줌 키보드", showEffect: "리듬 보여주기", showKeyboard: "키보드 보여주기", reset: "기본값 복원", needWinVcTitle: "시스템에 Windows MSVC 런타임 라이브러리가 없어 일부 기능 사용이 제한될 수 있습니다", needWinVcDesc: "마이크로소프트 공식 라이브러리인 vc_redist.x64.exe를 다운로드하여 설치한 후 애플리케이션을 재부팅해 주세요：", needWinVcLink1: "마이크로소프트 공식 다운로드 주소:", needWinVcLink2: "예비 다운로드 주소:", download: "다운로드 클릭", needWinVcNotice: "설치 후에도 이 팝업이 계속 표시되면 현재 시스템이 해당 기능을 지원하지 않을 수 있습니다" }, wechatLogin: { privacyPrefix: "로그인하면", privacyPolicy: "「개인정보 처리방침」", privacySuffix: "「이용 약관」", privacyAnd: "및", privacyEnd: "에 동의한 것으로 간주됩니다", accountMergeHint: "바인딩 후 위챗/이메일로 동일 계정 로그인 가능, 데이터 통합", accountUnbindEmailHint: "해제 후 데이터는 위챗 계정에 유지, 위챗으로 계속 사용 가능", privacyPolicyTitle: "개인정보 처리방침", userAgreement: "이용 약관", privacyWelcome: "MCHOSE 위챗(WeChat) 인증 로그인 서비스를 이용해 주셔서 감사합니다! 본 이용자 계약(이하 “본 계약”)은 심천시 마이초우 과기 유한회사(Shenzhen MCHOSE Technology Co., Ltd.)(이하 “당사” 또는 “MCHOSE”)와 사용자(이하 “귀하”) 간에, MCHOSE가 위챗 인증 로그인 방식을 통해 제공하는 서비스(이하 “본 서비스”)에 관한 권리 및 의무를 규정하는 것입니다.", privacyReadNotice: "서비스를 이용하시기 전에 본 방침의 모든 내용을 꼭 주의 깊게 읽고 이해해 주시기 바랍니다. 서비스를 이용함으로써 귀하는 본 방침의 모든 내용에 대해 읽고 이해하였으며 동의한 것으로 간주됩니다.", privacySection1Title: "1. 당사가 수집하는 정보", privacySection1Desc: "서비스 이용 과정에서 당사는 다음과 같은 정보를 수집할 수 있습니다:", privacyWechatInfo: `1.1 WeChat 인증 정보
귀하가 WeChat을 통해 로그인할 때, 당사는 WeChat 플랫폼을 통해 귀하의 닉네임, 프로필 사진, openid, unionid 등의 기본 정보를 수집하며, 이는 계정 식별 및 개인 맞춤형 서비스 제공을 위해 사용됩니다.`, privacyCloudData: `1.2 클라우드 이용 데이터
귀하가 업로드, 저장, 호출하는 설정 파일은 당사의 클라우드 서버에 저장되어 기기 간 동기화 사용을 지원합니다.`, privacySection2Title: "2. 수집한 정보의 이용 목적", privacySection2Desc: "당사는 수집한 정보를 다음과 같은 합법적이고 정당하며 필요한 목적에 한해 사용합니다:", privacyServiceFunction: `2.1 서비스 기능 제공
WeChat 인증 로그인, 클라우드 저장 및 설정 파일 호출 등 핵심 기능을 제공하기 위해 사용합니다.`, privacyServiceSecurity: `2.2 서비스 보안 보장
신원 확인, 이상 감지, 오류 분석 등을 통해 시스템의 안정성과 보안성을 향상시킵니다.`, privacySection3Title: "3. 정보의 저장 및 보호", privacyStorageLocation: `3.1 저장 위치 및 보유 기간
모든 사용자 데이터는 중국 본토 내 서버에 저장됩니다. 수집 목적 달성을 위한 기간 동안만 정보를 보유하며, 기간이 경과한 경우 삭제하거나 익명화 처리합니다.`, privacySecurityMeasures: `3.2 정보 보안 조치
데이터 보안을 위해 다중 암호화, 접근 통제, 로그 감사 등 다양한 기술적 조치를 적용하여 무단 접근, 유출, 변경, 파기 등을 방지합니다.`, privacySection4Title: "4. 귀하의 권리", privacyRightsDesc: "적용 가능한 법률 및 규정에 따라, 귀하는 다음과 같은 권리를 가집니다:", privacyQueryAccess: `4.1 조회 및 열람
당사가 귀하의 정보를 보관 중인지 여부를 확인할 수 있으며, 귀하의 개인정보에 접근할 수 있는 권리가 있습니다.`, privacyCorrectionDelete: `4.2 수정 및 삭제
보유된 정보가 부정확하거나 무효인 경우, 수정 또는 삭제를 요청할 수 있습니다.`, privacyCancelWithdraw: `4.3 탈퇴 및 동의 철회
WeChat 플랫폼 또는 당사에 연락하여 계정을 탈퇴하거나 동의를 철회할 수 있으며, 이 경우 당사는 더 이상 귀하의 정보를 처리하지 않습니다. 단, 관련 법령에 따라 보관이 필요한 경우는 예외로 합니다.`, privacySection5Title: "5. 방침의 변경", privacyPolicyUpdate: "당사는 사업 운영 또는 관련 법령의 변경에 따라 본 개인정보처리방침을 수시로 업데이트할 수 있습니다. 변경 사항은 WeChat 미니프로그램 공지 또는 기타 적절한 방법으로 안내드리며, 귀하가 서비스를 계속 사용하는 경우 변경된 방침에 동의한 것으로 간주됩니다.", privacySection6Title: "6. 문의하기", privacyContactDesc: "본 방침에 대한 문의, 의견, 불만이 있으신 경우 아래 연락처로 문의해 주시기 바랍니다:", privacyServiceHotline: "6.1 고객센터 전화: 400-816-8986", privacyServiceTime: "6.2 운영시간: 월요일~금요일, 오전 9:00 ~ 오후 7:00", privacyConclusion: "MCHOSE의 WeChat 인증 로그인 서비스를 이용해 주셔서 감사합니다. 당사는 귀하의 정보보호와 프라이버시 권리를 지키기 위해 지속적으로 노력하겠습니다.", userAgreementWelcome: "MCHOSE 위챗(WeChat) 인증 로그인 서비스를 이용해 주셔서 감사합니다! 본 이용자 계약(이하 “본 계약”)은 심천시 마이초우 과기 유한회사(Shenzhen MCHOSE Technology Co., Ltd.)(이하 “당사” 또는 “MCHOSE”)와 사용자(이하 “귀하”) 간에, MCHOSE가 위챗 인증 로그인 방식을 통해 제공하는 서비스(이하 “본 서비스”)에 관한 권리 및 의무를 규정하는 것입니다.", userAgreementReadNotice: "본 서비스를 이용하시기 전에, 특히 면책 조항 및 귀하의 권리를 제한하는 조항을 주의 깊게 읽고 충분히 이해하시기 바랍니다.", userAgreementSection1Title: "1. 서비스 이용 요건", userAgreementSection1Desc: "1.1 귀하는 다음 사항을 명확히 선언하고 보증합니다:", userAgreementLegalCapacity: "· 본 계약을 체결하고 본 서비스를 이용할 법적 자격이 있습니다.", userAgreementMinorNotice: "· 미성년자인 경우, 보호자의 지도 및 동의를 받은 후에만 본 서비스를 이용할 수 있으며, 만 14세 미만일 경우에는 법정 보호자의 명확한 동의 또는 지도하에 사용해야 합니다.", userAgreementRequirements: "1.2 본 서비스를 이용하려면 네트워크에 연결 가능한 호환 기기와 위챗 애플리케이션이 필요하며, 위챗을 통해 로그인 인증을 완료해야 합니다.", userAgreementSection2Title: "2. 계정 로그인 및 사용", userAgreementLoginProcess: "2.1 본 서비스는 위챗 플랫폼의 인증 로그인을 기반으로 제공되며, 처음 사용할 때 위챗 인증 절차에 동의하고 완료해야 MCHOSE 서비스 계정이 생성 또는 식별됩니다.", userAgreementInfoAccuracy: "2.2 귀하는 인증 정보의 진실성과 정확성을 보장해야 하며, 정상적인 서비스 이용을 위해 정보를 즉시 갱신해야 합니다.", userAgreementAccountSecurity: "2.3 귀하는 위챗 계정 및 관련 정보를 안전하게 보관해야 하며, 계정 분실이나 정보 유출로 인한 손실은 귀하의 책임입니다.", userAgreementSection3Title: "3. 서비스 내용", userAgreementCloudService: "3.1 클라우드 서비스: 구성 파일을 클라우드에 업로드하여 저장, 동기화 및 관리;", userAgreementConfigCall: "3.2 구성 적용: 사용자가 업로드한 구성 파일을 불러와 개인화된 사용 경험 제공;", userAgreementOfficialSync: "3.3 공식 구성 파일 동기화: 최신 공식 구성 파일을 실시간으로 동기화.", userAgreementServiceAdjustment: "MCHOSE는 비즈니스 상황에 따라 서비스 내용을 추가, 삭제 또는 조정할 수 있으며, 별도의 통지 없이 진행할 수 있습니다.", userAgreementSection4Title: "4. 사용자 행동 규범", userAgreementBehaviorRule1: "4.1 귀하는 본 서비스를 사용하는 동안 불법 행위, 권리 침해 또는 시스템 보안을 해치는 행위를 해서는 안 됩니다.", userAgreementBehaviorRule2: "4.2 이에 포함되나 이에 국한되지 않음: 불법 정보 유포, 타인의 권리 침해, 사기 행위, 시스템 방해 등.", userAgreementBehaviorRule3: "4.3 위와 같은 행위에 대해 MCHOSE는 경고, 서비스 이용 제한, 계정 정지, 법적 책임 추궁 등의 조치를 취할 수 있습니다.", userAgreementSection5Title: "5. 지적 재산권", userAgreementIPOwnership: "5.1 본 서비스의 모든 콘텐츠, UI 디자인, 코드, 인터페이스, 그래픽, 레이아웃 등은 MCHOSE 또는 그 라이선스 제공자에게 귀속됩니다.", userAgreementIPRestriction: "5.2 사전 허가 없이 복제, 배포, 수정, 양도 또는 상업적 이용을 해서는 안 됩니다.", userAgreementSection6Title: "6. 개인정보 보호", userAgreementPrivacyNotice1: "6.1 당사는 귀하의 개인정보 보호를 매우 중요하게 생각합니다. 당사가 귀하의 개인정보를 수집, 이용, 저장, 보호하는 방법은 [개인정보 보호정책]을 참고하시기 바랍니다.", userAgreementPrivacyNotice2: "6.2 본 서비스를 사용하기 전에 해당 정책을 주의 깊게 읽어 귀하의 권리와 당사의 의무를 이해하시기 바랍니다.", userAgreementSection7Title: "7. 면책 조항", userAgreementDisclaimer1: "7.1 당사는 서비스의 안정성과 데이터 보안을 최대한 보장하기 위해 노력하지만, 불가항력 또는 시스템 장애 등으로 인한 서비스 중단, 데이터 손실 등에 대해서는 책임을 지지 않습니다.", userAgreementDisclaimer2: "7.2 사용자 본인의 사유로 인한 손해는 사용자 본인이 책임져야 합니다.", userAgreementSection8Title: "8. 계약 갱신 및 변경", userAgreementUpdate1: "8.1 MCHOSE는 관련 법령 및 비즈니스 상황에 따라 본 계약을 갱신할 수 있으며, 위챗 공지 또는 기타 합리적인 방법으로 통지합니다.", userAgreementUpdate2: "8.2 귀하가 계속해서 본 서비스를 사용하는 경우, 갱신된 계약 내용을 수락한 것으로 간주됩니다.", userAgreementSection9Title: "9. 준거법 및 분쟁 해결", userAgreementLaw1: "9.1 본 계약은 중화인민공화국의 법률을 따릅니다.", userAgreementLaw2: "9.2 분쟁이 발생할 경우, 쌍방은 우선 협의를 통해 해결하며, 협의가 되지 않는 경우 심천시 룽강구 관할 법원에 소송을 제기할 수 있습니다.", userAgreementSection10Title: "10. 연락처", userAgreementContactDesc: "본 개인정보 보호정책에 대해 궁금한 사항, 제안 또는 불만이 있으실 경우 아래 연락처로 문의해 주시기 바랍니다:", userAgreementServiceHotline: "10.1 고객센터 전화: 400-816-8986", userAgreementServiceTime: "10.2 상담 시간: 월요일 ~ 금요일, 오전 9:00 ~ 오후 7:00", userAgreementConclusion: "MCHOSE 위챗 인증 로그인 서비스를 이용해 주셔서 감사합니다. 당사는 귀하의 정보 보안과 프라이버시 권익을 지키기 위해 지속적으로 노력하겠습니다.", emailPlaceholder: "이메일 입력", emailFormatError: "이메일 형식 오류", emailSendCode: "인증코드 받기", emailResend: "재전송", emailResendCountdown: "재전송（{n}초）", bindEmailGetCode: "인증코드 받기", switchToWechatAria: "탭하여 WeChat 로그인으로 전환", switchToEmailAria: "탭하여 이메일 로그인으로 전환", cornerTooltipWechat: "탭하여 WeChat 로그인으로 전환", cornerTooltipEmail: "탭하여 이메일 로그인으로 전환", titleEmailLogin: "이메일 로그인", titleWechatLogin: "WeChat 로그인", titleBindEmail: "이메일 바인딩", testEnvLoginTitle: "테스트 환경 로그인", testEnvSuffix: " (테스트)", testCodePlaceholder: "인증 코드(code) 입력", btnLogin: "로그인", codeStepBack: "뒤로", enterVerificationCode: "코드 입력", codeEmailCheckTitle: "메일을 확인하세요", codeEmailSentLine: "인증코드를 보냈습니다.", codeEmailInboxLine: "{email} 받은편지함을 확인하세요.", devOpenDevtools: "개발자 도구 열기", devInspectPage: "페이지 검사", msgSendCodeFailRetry: "코드 수신 실패", msgOtpSixDigits: "6자리 코드를 입력하세요", msgWxConfigInitFail: "WeChat 초기화 실패. 네트워크를 확인하세요.", msgLoginPageLoadFail: "로그인 페이지를 불러오지 못했습니다.", msgLoginFailRetry: "로그인 실패. 다시 시도하세요.", msgTestEnterAuthCode: "인증 코드를 입력하세요", msgBindFailGeneric: "연결 실패" }, user: { modifyNickname: "닉네임 수정", modifyAvatar: "프로필 사진 변경", nicknamePlaceholder: "새로운 닉네임을 입력해 주세요", nicknameTip: "닉네임 길이는 1-10자로 제한됩니다", nicknameEmpty: "닉네임은 비워둘 수 없습니다", nicknameLengthError: "닉네임 길이는 1-10자 사이여야 합니다", nicknameUpdateSuccess: "닉네임이 변경되었습니다", avatarUpdateSuccess: "아바타가 수정되었습니다" } }, SI = { common: { prompt: "Komunikat", refresh: "Odśwież", cancel: "Anuluj", close: "Zamknij", restore: "Przywróć domyślnie", iKnowIt: "Rozumiem", notAdminRunning: "Ta operacja wymaga uprawnień administratora. Zamknij aplikację, kliknij ikonę prawym przyciskiem myszy i wybierz „Uruchom jako administrator”, a następnie uruchom ponownie i spróbuj ponownie.", clickLogin: "Zaloguj się", cloudEqTip: "Po zalogowaniu dostępne będą funkcje w chmurze (więcej opcji udostępniania konfiguracji w trakcie opracowywania, prosimy o cierpliwość).", editNickname: "Edytuj nazwę", changeAvatar: "Zmień avatar", avatarTip: "Obsługiwane formaty: JPG i PNG, maks. rozmiar pliku: 2 MB", logout: "Wyloguj się", autoWechatLogin: "Zaznacz opcję poniżej, aby automatycznie przejść do logowania przez WeChat", privacyPrefix: "Logowanie oznacza akceptację", userAgreement: "Regulamin użytkownika", loginSuccess: "Zalogowano pomyślnie", emailLoginSuccess: "Zalogowano pomyślnie", bindWechatAction: "Powiąż WeChat", bindWechatSuccess: "Połączono WeChat", bindWechatFailed: "Nie udało się połączyć WeChat", wechatAlreadyBoundOtherEmail: "WeChat jest już powiązany z innym e-mailem", emailAlreadyBoundOtherWechat: "E-mail jest już powiązany z innym WeChat", unbindEmail: "Odłącz e-mail", unbindEmailGetCode: "Pobierz kod", unbindEmailSuccess: "Odłączono", unbindEmailCodeInvalid: "Nieprawidłowy kod", accountBindWechat: "Powiąż WeChat", accountBindEmail: "Powiąż e-mail", accountUnbindEmail: "Odłącz e-mail", bindEmailSuccess: "Powiązano", logoutSuccess: "Wylogowano pomyślnie", changesSubmitted: "Zmiany zostały przesłane, oczekuj na zatwierdzenie", nicknameEmpty: "Nazwa nie może być pusta", enterNickname: "Wprowadź nazwę", confirm: "OK", official: "Presety oficjalne", game: "Gry", music: "Muzyka", cloud: "Społeczność chmury", cloudShared: "Udostępnione", favorited: "Ulubione", myShares: "Moje", search: "Szukaj", latest: "Nowe", topUsed: "Popularne", topLiked: "Lubiane", topFav: "Ulubione", author: "Autor", import: "Importuj", imported: "Zaimportowano", favoritedStatus: "Dodano do ulubionych", removedFromFavorites: "Usunięto z ulubionych", liked: "Polubiono", unliked: "Cofnięto polubienie", importedToCustom: 'Zaimportowano do „Własne"', importFailed: "Import nieudany, maks. 20 pozycji", pleaseLogin: "Zaloguj się, aby kontynuować", maxFavorites: "Maks. 20 ulubionych", noUserUploads: "Brak przesłanych materiałów od użytkowników", noSearchResults: "Nie znaleziono wyników, spróbuj innego słowa~", noFavorites: "Brak ulubionych", noSharesYet: "Jeszcze nic nie udostępniłeś", cancelSharing: "Usuń dostęp", notice: "Komunikat", confirmCancelShare: 'Anulować udostępnianie „<strong>{name}</strong>"?', delete: "Del", custom: "Własne", myPresets: "Utworzone przeze mnie", localImport: "Import lokalny", cloudImports: "Import z chmury", confirmDelete: 'Czy na pewno chcesz usunąć „xxx"? Tego nie można cofnąć. W razie potrzeby zalecamy eksport', confirmDeleteReview: 'Czy na pewno chcesz usunąć „<strong>{name}"</strong>? Ten EQ jest w trakcie weryfikacji i może nadal być widoczny w chmurze po zatwierdzeniu.', confirmDeleteSimple: 'Czy na pewno chcesz usunąć „<strong>{name}"</strong>?', fromAuthor: "Od autora:", shareToCloud: "Udostępnij w chmurze", shareSuccess: "Udostępniono pomyślnie", sharingCanceled: "Udostępnianie anulowane", maxSharesPerUser: "Maks. 10 udostępnień na osobę", selectCategory: "Wybierz kategorię", other: "Inne", selectGameTag: "Wybierz tag gry", enterPresetTitle: "Wpisz tytuł ustawienia", shareTitlePlaceholder: "Nadaj tytuł swojemu korektorowi udostępnionemu w chmurze", maxSharesPerUserSimple: "Maks. 10 udostępnień na osobę", shareSuccessful: "Udostępniono pomyślnie", confirmShareOverwrite: "Ten EQ już był udostępniony. Udostępnienie ponownie zastąpi poprzedni. Kontynuować?", share: "Udostęp", restoreDefault: "Przywróć domyślne", restoreDefaultSuccess: "Przywrócono do ustawień domyślnych", underReview: "W trakcie sprawdzania", export: "Exp", underReviewTryLater: "W trakcie sprawdzania, spróbuj ponownie później", underReviewDeleteWarning: "Usunięcie przerwie weryfikację", shareFailTitle: "Nieudane udostępnienie: nieprawidłowy tytuł", shared: "Udost.", exitPreview: "Zakończ podgląd", nicknameViolation: "Nieprawidłowy", nicknameViolationTip: "Nieprawidłowy pseudonim. Proszę go zmienić", rename: "Zmień nazwę.", copy: "Kop", copied: "Skopiowano", noCloudImport: "Brak EQ w chmurze", unknown: "Nieznany", noDescription: "Brak opisu", shareRequestSubmitted: "Prośba o udostępnienie wysłana", copySuffix: "copy", view: "Zobacz", sysChanged: "EQ niezapisany. Kliknij <strong>[Zapisz jako własny]</strong>.", cmdENOENT: "Brakuje pliku cmd.exe w systemie. Proszę naprawić system i spróbować ponownie.", batchOperation: "Operacje zbiorcze", selectAll: "Wybierz wszystkie", exitBatch: "Zakończ tryb zbiorczy", confirmBatchDeleteAll: 'Czy usunąć <strong class="delete_name">wszystkie</strong> konfiguracje?', confirmBatchDeleteSelected: "Czy usunąć wybrane konfiguracje?", using: "In Use", clickToUse: "Use Now", expert: "Ustawienia Eksperta", applySuccess: "Wybrany EQ aktywowany", noData: "Brak danych" }, tray: { open: "Otwórz M HUB", quit: "Wyjść" }, commonHeader: { officialStore: "Oficjalny sklep", myDevice: "Moje urządzenie", back: "Powrót", backHome: "Powrót do strony głównej", popoverTheme: "Zmień skórkę", popoverSetting: "Ustawienia panelu", popoverRelatedApp: "Powiąż grę/aplikację i automatycznie przełącz profil", popoverMin: "Minimalizuj", popoverUnmax: "Przywróć", popoverMax: "Maksymalizuj", popoverClose: "Zamknij", offline: "Obecny serwer jest offline. Proszę ponownie uruchomić sterownik później i spróbować ponownie", performanceOnDesc: "Po wyłączeniu trybu wydajnościowego zostaną włączone efekty przezroczystego tła, szkła matowego oraz zaokrąglonych rogów obramowania. Zwiększy to estetykę, jednakże będzie to wymagać pewnego poziomu wydajności komputera.", performanceOffDesc: "Po włączeniu trybu wydajnościowego zostaną usunięte efekty przezroczystego tła, szkła matowego oraz zaokrąglonych rogów obramowania. Dzięki temu działanie będzie płynniejsze. Jeśli podczas korzystania z aplikacji występują zatrzymania, zaleca się włączenie tego trybu.", feedback: "Opinie", prizeQuiz: "Ankieta z nagrodą" }, themeSetting: { pageName: "Motyw", white: "Biały", black: "Czarny", followSys: "Zgodnie z systemem", bg: "Tło", followTheme: "Zgodnie z motywem", customizeText: "Niestandardowe tło (dotyczy tylko strony głównej)", changeBg: "Zmień tło", defaultBg: "Domyślne tło ", uploadImg: "Prześlij obraz", blurCard: "Rozmycie karty urządzenia", blurBg: "Rozmycie tła obrazu" }, setting: { version: "Obecna wersja", startup: "Uruchamianie", startAuto: "Uruchamiaj automatycznie", startAutoMini: "Minimalizuj do zasobnika przy uruchomieniu", language: "Język", closePanel: "Po zamknięciu panelu", exit: "Zamknij program", minimize: "Zminimalizuj do zasobnika, nie zamykaj programu", copyright: "" }, menus: { AudioConfiguration: "Konfiguracja audio", LightingSettings: "Ustawienia oświetlenia", ScreenSettings: "Wyświetlacz", OtherSettings: "Inne ustawienia", GeneralParameters: "Parametry standardowe", Equalizer: "Equalizer", SoundMode: "Tryb dźwięku", VirtualSurround: "Wirtualny dźwięk 7.1", CommonParams: "Typowe parametry", SpeakerSettings: "播放设置", MicSettings: "麦克风设置", THXSurround: "THX空间音效" }, speakerSettings: { volumeBalance: "Volume balance", volumeBalanceTip: "Balance channels and dynamics for a more even listening experience.", trebleEnhancement: "Treble enhancement", trebleEnhancementTip: "Boost high-frequency detail; too high may sound harsh.", vocalEnhancement: "Vocal enhancement", vocalEnhancementTip: "Improve voice clarity and reduce ambient noise.", alertMode: "Alert mode", alertModeTip: "Adjust pickup pattern to focus on sounds from a preferred direction.", bassEnhancement: "Bass enhancement", bassEnhancementTip: "Boost low frequencies; use cutoff to avoid muddiness.", intensity: "Intensity", clarityStrength: "Clarity", noiseSuppression: "Noise suppression", bassStrength: "Bass strength", freqCutoff: "Frequency cutoff", musicModeDynamic: "Music mode (high dynamic)", voiceModeDynamic: "Voice mode (low dynamic)", omnidirectionalMode: "Omnidirectional", rearMode: "Rear", unitDb: "(dB)", unitHz: "(Hz)" }, index: { screenNotice: "Wykryto, że ustawienia ekranu mogą wpłynąć na wyświetlanie na pulpicie. Zmień zoom i układ dla najlepszego wyniku.", gotoSet: "Edytuj", needAdminNotice: "Niektóre funkcje mogą być niedostępne z powodu braku uprawnień. Zamknij aplikację, kliknij ikonę prawym przyciskiem myszy i wybierz „Uruchom jako administrator”, aby ją ponownie uruchomić", loadFail: "Ładowanie nie powiodło się", loadFailDesc: "Kliknij przycisk odświeżania, aby ponownie załadować, lub sprawdź połączenie sieciowe i uruchom ponownie sterownik." }, devicePage: { needOtaNotice: "Został wykryty nowy wersja oprogramowania wbudowanego. Aby móc korzystać z sterownika normalnie, należy go zaktualizować. Pobierz i zaktualizuj oprogramowanie wbudowane.", needOtaNoticeTip: "Wskazówka: Po pobraniu przejdź do folderu docelowego, otwórz zestaw narzędzi i postępuj zgodnie z instrukcją, aby przeprowadzić aktualizację.", downloadNow: "Pobierz teraz", restartNotice: "Po zainstalowaniu sterownika musisz ponownie uruchomić komputer, aby działał poprawnie.Jeśli sterownik nie działa po ponownym uruchomieniu, skontaktuj się z pomocą techniczną.", restartNow: "Uruchom ponownie teraz", speakerDisabled: "Wykryto Wyłączony Głośnik, Nie Można Otworzyć Sterownika", step: "Kroki Rozwiązania:", step1: "1. Kliknij przycisk [Urządzenia Dźwiękowe Windows] poniżej.", step2: '2. W wyskakującym Panelu Sterowania Dźwiękiem Systemowym (patrz diagram poniżej), wybierz "Odtwarzanie". Znajdź odpowiednie urządzenie na liście, kliknij prawym przyciskiem myszy i włącz głośnik, a następnie kliknij "OK".', step3: "3. Po włączeniu kliknij przycisk [Odśwież] poniżej.", isSleep: `Jeśli słuchawki są w trybie uśpienia, uruchom je ponownie. Sprawdź, czy tryb połączenia to 2.4G (możesz ponownie podłączyć odbiornik).
Uwaga: Sterownik nie działa, gdy podłączony jest kabel audio lub gdy urządzenie działa w trybie Bluetooth.`, deviceLostLink: "Utracono połączenie sterownika", headphoneSleepStatus: "Słuchawki są w trybie uśpienia", headphoneSleepStatusTips: "Naciśnij przycisk lub uruchom ponownie", needLinkWireless: "Sterownik obsługuje tylko 2.4G", needLinkWirelessHeadphoneTips: "Sprawdź, czy odbiornik jest podłączony i nie używaj kabla audio ani Bluetooth", wiredMode: "Połączenie kablowe", lessThan: "Poniżej {val}", charging: "Ładowanie", sufficientCharge: "Pobór wystarczający", wiredVersion: "kablowy", notAdminRunningHeadset: "Urządzenia audio wymagają uprawnień administratora. Zamknij aplikację, kliknij ikonę prawym przyciskiem myszy i wybierz „Uruchom jako administrator”, aby ponownie uruchomić aplikację", thxInstallDialogTitle: "Instalacja komponentów audio", thxInstallDialogTitleUpgrade: "Aktualizacja komponentów audio", thxInstallDialogDesc1: "Potrwa 1–2 minuty, proszę czekać", thxInstallDialogDesc2: "Nie zamykaj sterownika podczas instalacji. Po zakończeniu otworzy się strona urządzenia" }, routine: { UserManual: "Ręcznik", beepTitle: "Dźwięk powiadomień", beepTitleDesc: "Regulacja głośności komunikatów (bez wpływu na multimedia)", UserManualFull: "Ręcznik użytkownika", Volume: "Głośność", Microphone: "Mikrofon", MicAI: "Włącz redukcję szumów AI", MicAIDesc: "Filtruje hałas i poprawia jakość", MicNoiseReduction: "Tłumienie Hałasu Statycznego", MicNoiseReductionDesc: "Redukuje stałe składniki hałasu w określonych pasmach częstotliwości, koncentrując się na obniżeniu natężenia dźwięków takich jak klimatyzatory czy wentylatory.", MicListen: "Monitoring mikrofonu", MicListenDesc: "Słuchanie własnego głosu w czasie rzeczywistym", MoYin: "Magiczne dźwięki:", MoYin_0: "Potwór", MoYin_1: "Kreskówka", MoYin_2: "Głos męski", MoYin_3: "Głos żeński", WindowsAudioDevices: "Urządzenia Dźwiękowe Windows", soundModeTitle: "Sound mode", soundModeTipLine: "编辑声音模式均衡器，一键切换应对不同场景", soundModeBadge: "Mode {n}", soundModeActive: "Active", soundModeInactive: "Off", soundModeSwitched: "Switched to mode {n}", eqItemHoverApply: "Apply", soundModeRename: "Rename", soundModeEditEq: "Edit equalizer", eqEditorAutoSaved: "Auto-saved", eqEditorModifiedAutoSaved: "Zmieniono, zapisano automatycznie", eqEditorCollapse: "Collapse", eqEditorResetFactory: "Przywróć fabryczne EQ", eqEditorResetFactoryConfirm: "[{mode}] nadpisze bieżące ustawienia korektora i przywróci ustawienia fabryczne.", eqEditorResetFactoryDone: "Tryb {n} przywrócono do fabrycznego korektora domyślnego.", eqSwitchUnsavedHint: "Zmodyfikowano korektor bieżącego trybu. Bezpośrednie zastosowanie innego EQ nadpisze edycję.", eqSwitchApplyDirect: "Zastosuj od razu", eqSwitchSaveThenApply: "Zapisz, potem zastosuj", AudioBright: "Wzmocnij dźwięk", AudioBrightDesc: " Wzmocnienie wysokich częstotliwości audio, aby dźwięk był wyraźniejszy i bogatszy w szczegóły, skutecznie poprawiając ogólną jasność i ekspresyjność dźwięku.", SurroundAmplification: "Rozszerzenie surround", SurroundAmplificationDesc: 'Zwiększa efekt przestrzenny dźwięku, poszerzając "obszar" dźwięku, symulując odbicia i dyfuzję, tworząc wrażenie przebywania w większej przestrzeni otoczonej głośnikami.', DynamicLF: "Dynamiczny bas", DynamicLFDesc: "Inteligentne dostosowanie niskich częstotliwości, wzmacniające siłę i głębię podczas mocnych rytmów, sprawiając, że uderzenia są bardziej intensywne. Zmniejszenie niskich częstotliwości w celu ich osłabienia pozwala osiągnąć naturalną równowagę dźwięku, zapewniając dynamiczne i zróżnicowane wrażenia słuchowe w zakresie niskich częstotliwości.", SmartVolume: "Inteligentna głośność", SmartVolumeDesc: "Automatycznie wykrywa zmiany głośności dźwięku, inteligentnie dostosowując ją do odpowiedniego poziomu, unikając nagłych wzrostów i spadków, zapewniając stabilne wrażenia słuchowe bez konieczności częstych ręcznych regulacji głośności.", VocalClarity: "Czystość wokalu", VocalClarityDesc: "Precyzyjnie optymalizuje pasmo częstotliwości ludzkiego głosu, redukując szumy i zakłócenia tła, podkreślając czysty ludzki głos, pozwalając na wyraźne wychwycenie artykulacji i cieszenie się doskonałym doświadczeniem słuchowym podczas słuchania muzyki, oglądania seriali czy rozmów telefonicznych.", MusicMode: "Muzyczny (wysoki)", VoiceMode: "Głosowy (niski)", NCut: "Tłumienie hałasu", Freqtrap: "Podział pasm", Intensity: "Intensywność", DYIntensity: "Intensywność", QXIntensity: "Intensywność", Speech: "Powiadomienia Głosowe", SpeechDesc: 'Informacje zwrotne głosowe podczas działania głośnika (możesz także włączyć lub wyłączyć informacje zwrotne, przytrzymując jednocześnie przez {time} sekundy fizyczne przyciski "+" i "G" na głośniku).', SpeechDescK20Pro: "Komunikaty głosowe podczas obsługi głośnika (przytrzymaj przycisk mikrofonu na głośniku przez {time} s, aby włączyć lub wyłączyć komunikaty)", micDisabled: "Mikrofon wyłączony", micDisabledTitle: "Wykryto Wyłączony Mikrofon, Nie Można Poprawnie Używać Mikrofonu", step: "Kroki Rozwiązania:", step1: "1.Kliknij przycisk [Urządzenia Dźwiękowe Windows] poniżej.", step2: '2.W wyskakującym Panelu Sterowania Dźwiękiem Systemowym (patrz diagram poniżej), wybierz "Nagrywanie". Znajdź odpowiednie urządzenie na liście, kliknij prawym przyciskiem myszy i włącz mikrofon, a następnie kliknij "OK".', step3: "3.Po włączeniu kliknij ikonę [Odśwież] poniżej." }, eq: { title: "Equalizer", game1: "Tryb EQ 1", game2: "Tryb EQ 2", game3: "Tryb EQ 3", eqSlotDefaultDesc: "Slot presetu na urządzeniu", popover2: "Equalizer, podobny do konsoli mikserskiej, pozwala dostosować częstotliwości audio i głośność, umożliwiając modyfikowanie pasm wysokich i niskich częstotliwości zgodnie z własnymi preferencjami. Na przykład, podczas gry można zwiększyć niskie częstotliwości, aby wzmocnić eksplozje i kroki, oraz podnieść wysokie częstotliwości, aby wyraźniej słyszeć strzały i kolizje, tworząc niestandardowy efekt dźwiękowy dopasowany do własnych nawyków, co zwiększa zaangażowanie i przewagę konkurencyjną.", popover: "Equalizer dostosowuje częstotliwości", import: "Importowanie", 默认: "Domyślny", 音乐清脆风: "Czysty styl", 音乐清脆风1: "Czysty styl1", 音乐清脆风2: "Czysty styl2", "3D影视": "Filmy 3D", 舞曲: "Taniec", 饶舌曲: "Rap", 重金属: "Heavy metal", 爵士: "Jazz", 抒情摇滚: "Soft rock", 摇滚: "Rock", 现场: "Na żywo", 高音: "Wysoki ton", 低音: "Niski ton", bandBass: "Niski", bandLowMid: "Średnio-niski", bandMid: "Średni", bandHighMid: "Średnio-wysoki", bandHigh: "Wysoki", 古典乐: "Klasyka", 声乐: "Wokale", 无畏契约: "valorant", 无畏契约1: "valorant1", 无畏契约2: "valorant2", 无畏契约3: "valorant3", CS: "CS", CS1: "CS1", CS2: "CS2", CS3: "CS3", Apex: "Apex", Apex1: "Apex1", Apex2: "Apex2", 绝地求生: "PUBG", 绝地求生1: "PUBG1", 绝地求生2: "PUBG2", 绝地求生3: "PUBG3", CF: "CF", CF1: "CF1", CF2: "CF2", 三角洲: "Delta", 三角洲1: "Delta1", 三角洲2: "Delta2", 三角洲3: "Delta3", add: "Custom", more: "Więcej", empty: "Brak wybranych efektów", renamePlaceholder: "Wprowadź niestandardową nazwę", export: "Eksportowanie", delete: "Usuń", saveAs: "Zapisz jako niestandardowy", reset: "Przywróć domyślne", newNameTitle: "Dostosuj", newNamePlaceholder: "Wprowadź niestandardową nazwę", duplicate: "Nazwa już istnieje, wprowadź ponownie", ok: "Potwierdź", importSuccess: "Import zakończony sukcesem", importFail: "Błąd importu, spróbuj ponownie", importFailName: "Import nie powiódł się z powodu powtarzającego się nazwy. Prosimy o wprowadzenie zmian", exportSuccess: "Eksport zakończony pomyślnie", exportFail: "Eksport nie powiódł się, spróbuj ponownie", deleteTitle: "Komunikat", delPre: "Czy na pewno chcesz usunąć „", delAfter: "? Tego nie można cofnąć. W razie potrzeby zalecamy eksport", expertListTip: "Presety ekspertów są powiązane z trybem dźwięku. Dla najlepszego brzmienia nie zaleca się zmiany trybu." }, mode: { modeDesc: `Różne tryby można przełączać jednym kliknięciem,
co zapewni ci wyjątkowe i ostateczne doświadczenie słuchowe`, gameMode: "tryb gry", gameMode1: "tryb gry 1", gameMode2: "tryb gry 2", musicMode: "tryb muzyczny", movieMode: "tryb filmowy", gameModeDesc: "Podkreśla szczegóły strzałów i kroków, idealne do konkurencyjnych gier FPS", musicModeDesc: "Profesjonalne strojenie odtwarza szczegóły dźwięku, idealne do immersyjnych scen muzycznych", movieModeDesc: "Zapewnia kinowej jakości dźwięk, idealne do immersyjnych scen filmowych", gameModeDesc2: "Podkreśla dźwięki pola bitwy, idealne do wojennych gier FPS" }, light: { switch: "Oświetlenie", switchOn: "Światło włączone", switchOff: "Światło wyłączone", title: "Efekty świetlne", static: "Constant on", breath: "Breathing", cyclicDiscolor: "Gwiezdny strumień", goFlow: "Waves", continue: "Trwanie", duan: "Krótki", chang: "Długi", an: "Ciemny", guang: "Jasny", direction: "Kierunek", clockwise: "w kier. wsk. zeg.", anticlockwise: "w pr. kier. do wsk. zeg.", loop: "Color cycling", music: "Music rhythm", flowing_s: "Flowing Light - Slow", sync_in_effect: "RGB aktywna", syncClosed: "Wyłączono synchronizację RGB na tym urządzeniu i zastosowano wybrany efekt świetlny", flowing_f: "Flowing Light - Fast", speed: "Prędkość", fast: "Szybka", slow: "Wolna", colorjoe: "Paleta", reset: "Przywróć domyślne", notView: "This lighting effect does not support a preview", color: "Kolor", lightShow: "Wyświetlanie światła", lightShow1: "Włączyć wszystkie światła", lightShow2: "Wyłączyć światła w środku", lightShow3: "Wyłączyć światła na obu stronach", smartLight: "Inteligentne oświetlenie", smartLightDesc: "Po włączeniu, po 30 min bez działania i odtwarzania ekran oraz podświetlenie przejdą w tryb niskiej jasności", k20Mode1: `Constant
on`, k20Mode2: "Tide", k20Mode3: "Breathing", k20Mode4: `Music
rhythm`, k20Mode5: `Gorgeous
colors`, k20Mode6: "Circulate", k20Mode7: "Glow", speedAndBrightness: "Prędkość i jasność", brightness: "Jasność" }, surround: { switch: "Wirtualny dźwięk 7.1", popover: "Symuluje dźwięk przestrzenny 7.1. Po aktywacji pozwala poczuć dźwięk dochodzący z wielu kierunków, zanurza Cię w scenach gier lub fabułach filmowych, dokładnie lokalizując kierunek i odległość dźwięków, zapewniając bardziej trójwymiarowe, immersyjne wrażenia słuchowe.", popoverGame: "Wirtualny dźwięk 7.1 nie nadaje się do gier FPS; polecany do gier AAA i multimediów.", mode: "Wybór trybu", music: "Tryb muzyczny/gry", movie: "Tryb filmowy", test: "Test głośników", start: "Rozpocznij test", stop: "Zakończ test", size: "Rozmiar pokoju", small: "Mały", mid: "Średni", big: "Duży" }, otherSettings: { alreadyLatest: "Oprogramowanie jest już aktualne, nie wymaga aktualizacji", v9TurboHeadset: "Proszę użyć trybu 2.4G do podłączenia do aktualizacji.", latest: "Najnowszy", goUpdate: `Przejdź
aktualiz.`, baseV: "Wersja oprogramowania podstawy:", usbV: "Wersja USB urządzenia:", firmwareV: "Wersja firmware urządzenia:", headsetV: "Wersja oprog. sprz. słuchawek:", dongleV: "Wersja oprog. ukł. odb.:", findNew: "Wykryto najnowszą wersję:", speakerShutdown: "Wyłącz Urządzenie", speakerShutdownDesc: "Sterownik może tylko wyłączyć, nie włączyć", shutdown: "Wyłącz", speakerShutdownConfirm: "Czy na pewno chcesz wyłączyć urządzenie?", speakerShutdownSuccess: "Głośnik wyłączony", speakerShutdownDeviceError: "Urządzenie nie jest podłączone, prosimy sprawdzić urządzenie", speakerShutdownFailed: "Wyłączenie głośnika nie powiodło się", and: ", ", restoreFactory: "Przywróć ustawienia fabryczne", restoreFactoryDesc: "Wszystkie ustawienia zostaną przywrócone do wartości fabrycznych, proszę działać ostrożnie", restore: `Przywróć
fabrycznie`, restoreSuccess: "Przywracanie ustawień fabrycznych zakończone pomyślnie", downloading: "Trwa pobieranie pliku firmware…", updating: "Trwa aktualizacja oprogramowania stałego...", updatingNote: "Prosimy, nie wyłączaj programu ani nie wtykaj i nie wyjmuj urządzenia podczas procesu aktualizacji!", inDevelopment: "Funkcja jest w trakcie tworzenia...", readBinFail: "Nie udało się odczytać pliku oprogramowania", downloadBinFail: "Nie udało się pobrać pliku firmware", otaFail: "Aktualizacja oprogramowania nie powiodła się", otaFailResult: "Aktualizacja oprogramowania nie powiodła się. Spróbuj odłączyć i ponownie połączyć urządzenie, a następnie spróbuj ponownie", otaSuc: "Aktualizacja oprogramowania na urządzeniu powiodła się", otaSucDongle: "Aktualizacja oprogramowania układowego zakończona pomyślnie. Proszę poczekać, aż {deviceType} automatycznie się zrestartuje, aby zmiany mogły zostać zastosowane (około 30 sekund).", otaSucHeadset: "Aktualizacja oprogramowania układowego zakończona pomyślnie. Proszę poczekać około 30 sekund, a następnie ręcznie włączyć słuchawki, aby zmiany mogły zostać zastosowane.", otaSucBoth: "Aktualizacja oprogramowania układowego słuchawek i odbiornika zakończona pomyślnie. Poczekaj na automatyczne ponowne uruchomienie urządzenia (ok. 30 sekund).", deviceTypeDong: "odbiornik", deviceTypeDevice: "urządzenia", confirmFactoryReset: "Ta operacja wyczyści wszystkie ustawienia. Czy na pewno chcesz przywrócić ustawienia fabryczne?", powerManagement: "Zarządzanie energią", autoShutdown: "Auto wyłączanie:", autoShutdownDesc: "Po wyjęciu słuchawek ze stacji (bez ładowania), jeśli nie ma odtwarzania przez ustawiony czas, słuchawki wyłączą się automatycznie.", minutes: "Minuty", downloadTips1: "1.Zaleca się zapisanie pakietu firmware na pulpicie.", downloadTips2Exe: "2.Kliknij dwukrotnie, aby rozpocząć automatyczną aktualizację.", downloadTips2Zip: "2.Po rozpakowaniu kliknij dwukrotnie pakiet firmware, aby rozpocząć automatyczną aktualizację.", betterOtaTitle: "Wykryto nowy firmware. Zalecana aktualizacja." }, screenSettings: { screenOTAing: "Aktualizacja ekranu, proszę czekać", screenDisplay: "Wyświetlacz", screenOn: "Ekran włączony", screenOff: "Ekran wyłączony", screenColor: "Kolor ekranu", presetSettings: "Ustawienia zmiany tapety", personalizedPreset: "Tapeta ekranu", customText: "Tekst", custom: "Własne", digitalClock: "Zegar Cyfrowy", musicSpectrum: "Spektrum Muzyczne", campusDaily: "Życie na Kampusie", workplaceLife: "Życie Zawodowe", cutePets: "Urocze Zwierzaki", electronicGames: "Gry Wideo", cyberTech: "Technologia Cyber", networkMeme: "Internetowe Memy", customImage: "Obraz własny", customImageOTAWarning: "Najpierw zaktualizuj firmware, a następnie użyj tej funkcji", addImage: "Dodaj obraz", uploadImage: "Prześlij obraz", reuploadImage: "Prześlij ponownie", supportImageFormat: "PNG/JPG/GIF. GIF tylko 30 klatek", previewImage: "Podgląd efektu", text: "Tekst", scenery: "Krajobraz", character: "Postać", uploadingToScreen: "Przesyłanie na ekran", reverseColor: "Odwrócenie kolorów", scaleScreen: "Skalowanie ekranu", scaleImage: "Skalowanie obrazu", blackWhiteRatio: "Proporcja B/W", deleteImageConfirm: "Usunąć ten obraz? Nie można cofnąć", deleteImage: "Usuń", batchDeleteImage: "Usuwanie zbiorcze", selectAll: "Zaznacz wszystko", cancelSelectAll: "Odznacz wszystko", processImage: "Obróbka obrazu", exitBatch: "Zakończ tryb", deleteSelectedImageConfirm: "Usunąć wybrane obrazy? Nie można cofnąć", textContent: "Treść Tekstowa", textLengthLimit: "Osiągnięto limit znaków", save: "Zapisz", savedSuccess: "Zapisano", historyRecords: "Historia", clearHistory: "Wyczyść Historię Jednym Kliknięciem", historyTip: "Wyświetlaj Tylko Ostatnie 20 Wpisów", textEffect: "Efekt tekstu", staticDisplay: "Wyświetlanie statyczne", dynamicDisplay: "Wyświetlanie dynamiczne", alignment: "Wyrównanie", leftAlign: "Wyrównaj do lewej", centerAlign: "Wyśrodkuj", rightAlign: "Wyrównaj do prawej", justifyAlign: "Wyjustuj", scrollEffect: "Efekt przewijania", scrollToRight: "Od lewej do prawej", scrollToLeft: "Od prawej do lewej", customColors: "Własny kolor", clearCustomColors: "Resetuj kolory", syncToLight: "Synchronizuj kolor oświetlenia", shortPress: "Krótki Naciśnięcie", lyrics: "Tekst piosenki", lyricsDisplay: "Wyświetlanie tekstu piosenki（BETA）", lyricsDisplayHintLead: "Podczas odtwarzania audio z tekstem na ekranie wyświetlany jest bieżący tekst piosenki.", lyricsDisplayCantSeeLink: "Nie widać tekstu?", lyricsDisplayCantSeeTooltip: "Obecnie obsługiwane są tylko wybrane aplikacje muzyczne. Zaktualizuj je i odśwież M HUB", lyricsOn: "Wł.", lyricsOff: "Wył.", lyricsAnimation: "Animacja tekstu piosenki", notSupportSyncToLight: "Bieżący efekt oświetlenia jest wielokolorowy, synchronizacja koloru niedostępna", syncToLightSuccess: "Synchronizacja zakończona sukcesem", uploadToScreenTip: "Około {time}s, nie wychodź", deleteCustomColorConfirm: "Czy na pewno usunąć bieżący kolor?", deleteAllCustomColorsConfirm: "Czy na pewno usunąć wszystkie niestandardowe kolory?", minimumSelectionToast: "Wybierz co najmniej 2", textVerifyFailed: "Ekran pikselowy nie obsługuje emoji ani znaków specjalnych. Używaj tylko tekstu", lyricsAnimationOption1: "Wejście: z dołu do góry. Wyjście: z dołu do góry", lyricsAnimationOption2: "Wejście: rozwinięcie ze środka. Wyjście: zwężenie do środka", lyricsAnimationOption3: "Wejście: z lewej do prawej. Wyjście: z prawej do lewej", lyricsAnimationOption4: "Wejście: z dołu do góry. Wyjście: z góry na dół", lyricsAnimationOption5: "Wejście: z góry na dół. Wyjście: z prawej do lewej", lyricsAnimationDemo: "Demo animacji tekstu", uploadingImgTip: "Trwa przesyłanie obrazu, spróbuj później" }, update: { alreadyNew: "Najnowsza wersja", findNew: "Wykryto najnowszą wersję", ignore: "Ignoruj", update: "Zaktualizuj", showHistory: "Zobacz historyczne wersje", updating: "Aktualizacja sterownika w toku…", rollingBack: "Powrót do wersji historycznej {version}...", updateContentTitle: "Aktualizacja sterownika", updateContent: "Treść aktualizacji sterownika:", updateNow: "Zaktualizuj teraz", back: "Powrót", historyTitle: "Historyczne wersje", version: "Numer wersji", date: "Data aktualizacji", backToList: "Wróć do poprzedniego poziomu", only30: "Przechowaj ostatnie 30 wersji historycznych", operation: "Operacje", watchContent: "Sprawdź treści aktualizacji", rollTo: "Powróć do tej wersji", currentVersion: "Obecna wersja", updateTo: "Zaktualizuj do tej wersji", updateSuccess: "Aktualizacja sterownika zakończona", revertSuccess: "Powrócono do wersji historycznej {version}", updatePre: "Trwa aktualizacja, proszę czekać...", updateAfter: "Aplikacja wkrótce uruchomi się ponownie automatycznie. Proszę czekać", inviteUpdate1: "Odkryto nową wersję,", inviteUpdate2: "zapraszamy do", inviteUpdate3: "natychmiastowej aktualizacji.", notAdminRunning: "Do przeprowadzenia aktualizacji wymagane są uprawnienia administratora. Zamknij aplikację, kliknij ikonę prawym przyciskiem myszy i wybierz „Uruchom jako administrator”. Po uruchomieniu spróbuj ponownie zaktualizować", updateResultFail: "Aktualizacja się nie powiodła, co może spowodować niedostępność niektórych funkcji. Uninstalluj program, a następnie przejdź na oficjalną stronę Maicong, aby pobrać najnowszy pakiet instalacyjny i go zainstalować", updateFailAfter: "W momencie tworzenia pakietu spakowanego wystąpiła anomalia. Uninstalluj program, a następnie przejdź na oficjalną stronę Maicong, aby pobrać najnowszy pakiet instalacyjny i go zainstalować", updateFailPre: "W fazie wstępnego przygotowania do aktualizacji wystąpiła anomalia. Spróbuj ponownie później. Jeśli nadal się nie powiedzie, odinstaluj sterownik, a następnie przejdź na oficjalną stronę Maicong, aby pobrać najnowszy pakiet instalacyjny sterownika i go ponownie zainstalować", updateUpFailDefault: "Aktualizacja sterownika się nie powiodła. Spróbuj ponownie później", updateBackFailDefault: "Nie udało się cofnąć do wcześniejszej wersji. Spróbuj ponownie później", notSupportUpdate: "Bieżąca wersja nie obsługuje aktualizacji online. Przejdź na oficjalną stronę Maicong, aby pobrać najnowszą wersję pakietu instalacyjnego i go ponownie zainstalować", restartFinishUpdate: "Restart sterownika" }, musicDance: { settingPanel: "Panel ster. rytmem muz.", scaleEffect: "Powiększanie/zmniejszanie rytmu", scaleKeyboard: "Powiększanie/zmniejszanie klawiatury", showEffect: "Pokaż rytm", showKeyboard: "Pokaż klawiaturę", reset: "Przywróć domyślne", needWinVcTitle: "W systemie brakuje biblioteki wykonawczej Windows MSVC, dlatego niektóre funkcje mogą być ograniczone", needWinVcDesc: "Pobierz i zainstaluj oficjalną bibliotekę firmy Microsoft vc_redist.x64.exe, a następnie ponownie uruchom aplikację：", needWinVcLink1: "Oficjalny adres pobierania firmy Microsoft:", needWinVcLink2: "Zasadowy adres pobierania:", download: "Kliknij, aby pobrać", needWinVcNotice: "Jeśli ten komunikat nadal pojawia się po instalacji, możliwe, że Twój system nie obsługuje jeszcze tej funkcji" }, wechatLogin: { privacyPrefix: "Logowanie oznacza akceptację", privacyPolicy: "„Polityki prywatności”", privacySuffix: "„Regulaminu”", privacyAnd: "i", privacyEnd: "", accountMergeHint: "Po powiązaniu logowanie WeChat/e-mail, dane scalone", accountUnbindEmailHint: "Po odłączeniu dane pozostają w WeChat", privacyPolicyTitle: "Polityka prywatności", userAgreement: "Regulamin użytkownika", privacyWelcome: "Witamy w usłudze logowania przez WeChat autoryzowanej przez MCHOSE! Niniejsza Umowa użytkownika („Umowa”) jest zawierana pomiędzy Shenzhen MCHOSE Technology Co., Ltd. (dalej „my” lub „MCHOSE”) a Tobą (dalej „Ty” lub „Użytkownik”) i reguluje prawa oraz obowiązki związane z usługą logowania przez WeChat, świadczoną przez MCHOSE (dalej „Usługa”).", privacyReadNotice: "Prosimy o dokładne przeczytanie i zrozumienie niniejszej polityki przed skorzystaniem z usługi. Korzystając z niej, wyrażasz zgodę na wszystkie postanowienia tej Polityki prywatności.", privacySection1Title: "1. Informacje, które zbieramy", privacySection1Desc: "Podczas korzystania z usługi możemy zbierać następujące dane:", privacyWechatInfo: `1.1 Informacje autoryzacyjne WeChat
Logując się za pośrednictwem WeChat, zbieramy podstawowe dane takie jak Twój pseudonim, awatar, OpenID oraz UnionID za pośrednictwem interfejsu platformy WeChat, aby identyfikować Twoje konto i świadczyć spersonalizowane usługi.`, privacyCloudData: `1.2 Dane dotyczące korzystania z chmury
Pliki konfiguracyjne, które przesyłasz, zapisujesz lub wywołujesz, są przechowywane na naszych serwerach w chmurze, co umożliwia synchronizację między urządzeniami.`, privacySection2Title: "2. Jak wykorzystujemy informacje", privacySection2Desc: "Zbieramy Twoje dane wyłącznie w następujących prawnie uzasadnionych i niezbędnych celach:", privacyServiceFunction: `2.1 Realizacja funkcji usługi
Świadczenie kluczowych usług, takich jak autoryzowane logowanie WeChat, przechowywanie w chmurze i dostęp do plików konfiguracyjnych.`, privacyServiceSecurity: `2.2 Zapewnienie bezpieczeństwa usługi
Weryfikacja tożsamości, wykrywanie nieprawidłowości, rozwiązywanie problemów oraz podnoszenie stabilności i bezpieczeństwa systemu.`, privacySection3Title: "3. Przechowywanie i ochrona informacji", privacyStorageLocation: `3.1 Lokalizacja i okres przechowywania
Wszystkie dane użytkowników są przechowywane na serwerach znajdujących się na terytorium Chin kontynentalnych. Przechowujemy Twoje dane tylko przez czas niezbędny do realizacji powyższych celów, po czym dane zostaną usunięte lub zanonimizowane.`, privacySecurityMeasures: `3.2 Środki ochrony informacji
Stosujemy różnorodne techniczne środki zabezpieczające, takie jak wielowarstwowe szyfrowanie, kontrola dostępu oraz audyt logów, aby chronić dane przed nieautoryzowanym dostępem, ujawnieniem, modyfikacją lub zniszczeniem.`, privacySection4Title: "4. Twoje prawa", privacyRightsDesc: "Zgodnie z obowiązującymi przepisami masz następujące prawa:", privacyQueryAccess: `4.1 Dostęp i wgląd
Masz prawo dowiedzieć się, czy przechowujemy Twoje dane osobowe, oraz mieć do nich dostęp.`, privacyCorrectionDelete: `4.2 Korekta i usunięcie
Jeśli uznasz, że posiadane przez nas dane są nieścisłe lub nieaktualne, możesz zażądać ich poprawienia lub usunięcia.`, privacyCancelWithdraw: `4.3 Anulowanie konta i cofnięcie zgody
Możesz anulować swoje konto lub cofnąć zgodę poprzez platformę WeChat lub kontaktując się z nami. Po tym nie będziemy przetwarzać Twoich danych, chyba że przepisy prawa stanowią inaczej.`, privacySection5Title: "5. Aktualizacje polityki", privacyPolicyUpdate: "Możemy aktualizować niniejszą Politykę prywatności zgodnie z rozwojem działalności lub zmianami prawnymi. Zaktualizowana polityka zostanie przekazana za pośrednictwem ogłoszeń w miniaplikacji WeChat lub innych odpowiednich kanałów. Kontynuacja korzystania z usługi oznacza akceptację zaktualizowanej polityki.", privacySection6Title: "6. Kontakt z nami", privacyContactDesc: "Jeśli masz pytania, sugestie lub skargi dotyczące niniejszej polityki, skontaktuj się z nami:", privacyServiceHotline: "6.1 Linia obsługi klienta: 400-816-8986", privacyServiceTime: "6.2 Godziny pracy: od poniedziałku do piątku, 9:00–19:00", privacyConclusion: "Dziękujemy za zaufanie i korzystanie z usługi logowania WeChat firmy MCHOSE. Będziemy nadal dokładać starań, aby chronić Twoje dane i prywatność.", userAgreementWelcome: "Witamy w usłudze logowania przez WeChat autoryzowanej przez MCHOSE! Niniejsza Umowa użytkownika („Umowa”) jest zawierana pomiędzy Shenzhen MCHOSE Technology Co., Ltd. (dalej „my” lub „MCHOSE”) a Tobą (dalej „Ty” lub „Użytkownik”) i reguluje prawa oraz obowiązki związane z usługą logowania przez WeChat, świadczoną przez MCHOSE (dalej „Usługa”).", userAgreementReadNotice: "Prosimy o uważne przeczytanie i zrozumienie całej treści Umowy przed korzystaniem z Usługi, ze szczególnym uwzględnieniem postanowień dotyczących wyłączenia odpowiedzialności oraz ograniczenia Twoich praw.", userAgreementSection1Title: "1. Wymagania dotyczące korzystania z Usługi", userAgreementSection1Desc: "1.1 Oświadczasz i zapewniasz, że:", userAgreementLegalCapacity: "· Posiadasz zdolność prawną do zawarcia niniejszej Umowy oraz korzystania z Usługi;", userAgreementMinorNotice: "· Jeśli jesteś osobą niepełnoletnią, musisz korzystać z Usługi pod nadzorem i za zgodą opiekuna prawnego. Jeśli masz mniej niż czternaście (14) lat, musisz uzyskać wyraźną zgodę lub nadzór opiekuna prawnego przed rozpoczęciem korzystania z Usługi.", userAgreementRequirements: "1.2 Do korzystania z Usługi potrzebujesz kompatybilnego urządzenia z dostępem do internetu, zainstalowanej aplikacji WeChat oraz zalogowania się poprzez autoryzację WeChat.", userAgreementSection2Title: "2. Logowanie i korzystanie z konta", userAgreementLoginProcess: "2.1 Usługa opiera się na platformie WeChat, która umożliwia logowanie za pomocą autoryzacji. Musisz wyrazić zgodę i ukończyć proces autoryzacji WeChat przy pierwszym użyciu, aby utworzyć lub zidentyfikować swoje konto MCHOSE.", userAgreementInfoAccuracy: "2.2 Musisz zapewnić prawdziwość i dokładność danych autoryzacyjnych oraz niezwłocznie je aktualizować, aby zapewnić prawidłowe korzystanie z Usługi.", userAgreementAccountSecurity: "2.3 Jesteś odpowiedzialny za bezpieczne przechowywanie swojego konta WeChat oraz powiązanych danych. Za wszelkie szkody powstałe w wyniku utraty lub wycieku konta odpowiadasz samodzielnie.", userAgreementSection3Title: "3. Zakres Usługi", userAgreementCloudService: "3.1 Usługa w chmurze: przesyłanie, przechowywanie, synchronizacja i zarządzanie plikami konfiguracyjnymi w chmurze;", userAgreementConfigCall: "3.2 Aktywacja konfiguracji: importowanie przesłanych przez użytkownika plików konfiguracyjnych w celu personalizacji doświadczenia;", userAgreementOfficialSync: "3.3 Synchronizacja oficjalnych plików konfiguracyjnych: synchronizacja w czasie rzeczywistym najnowszych oficjalnych plików konfiguracyjnych.", userAgreementServiceAdjustment: "MCHOSE zastrzega sobie prawo do dodawania, usuwania lub modyfikowania zawartości Usługi bez wcześniejszego powiadomienia, w zależności od rozwoju działalności.", userAgreementSection4Title: "4. Zasady zachowania użytkownika", userAgreementBehaviorRule1: "4.1 Podczas korzystania z Usługi nie wolno podejmować działań niezgodnych z prawem, naruszających prawa innych osób lub zagrażających bezpieczeństwu systemu;", userAgreementBehaviorRule2: "4.2 Obejmuje to między innymi: rozpowszechnianie nielegalnych informacji, naruszanie praw innych osób, oszustwa, zakłócanie działania platformy itp.;", userAgreementBehaviorRule3: "4.3 W przypadku takich działań MCHOSE ma prawo zastosować ostrzeżenia, ograniczenia w korzystaniu, blokadę konta lub dochodzenie odpowiedzialności prawnej.", userAgreementSection5Title: "5. Własność intelektualna", userAgreementIPOwnership: "5.1 Wszystkie materiały Usługi, w tym design interfejsu, kod, API, grafikę i układ, należą do MCHOSE lub jej licencjodawców;", userAgreementIPRestriction: "5.2 Bez zezwolenia zabronione jest kopiowanie, rozpowszechnianie, modyfikowanie, przenoszenie lub wykorzystywanie komercyjne tych materiałów.", userAgreementSection6Title: "6. Ochrona prywatności", userAgreementPrivacyNotice1: "6.1 Przykładamy dużą wagę do ochrony Twojej prywatności. Szczegóły dotyczące zbierania, wykorzystywania, przechowywania i ochrony Twoich danych osobowych zawiera nasza Polityka Prywatności.", userAgreementPrivacyNotice2: "6.2 Prosimy o uważne zapoznanie się z nią przed korzystaniem z Usługi, aby poznać swoje prawa i nasze obowiązki.", userAgreementSection7Title: "7. Zrzeczenie się odpowiedzialności", userAgreementDisclaimer1: "7.1 Dołożymy wszelkich starań, aby zapewnić stabilność działania Usługi oraz bezpieczeństwo danych, jednak nie ponosimy odpowiedzialności za przerwy w działaniu, utratę danych lub inne problemy spowodowane siłą wyższą lub awariami systemu;", userAgreementDisclaimer2: "7.2 Użytkownik ponosi odpowiedzialność za szkody powstałe z jego własnej winy.", userAgreementSection8Title: "8. Aktualizacje i zmiany Umowy", userAgreementUpdate1: "8.1 MCHOSE zastrzega sobie prawo do aktualizacji niniejszej Umowy zgodnie z przepisami prawa i zmianami w działalności, powiadamiając o tym użytkowników poprzez ogłoszenia w WeChat lub inne odpowiednie sposoby;", userAgreementUpdate2: "8.2 Kontynuowanie korzystania z Usługi oznacza akceptację zaktualizowanej Umowy.", userAgreementSection9Title: "9. Prawo właściwe i rozstrzyganie sporów", userAgreementLaw1: "9.1 Niniejsza Umowa podlega prawu Chińskiej Republiki Ludowej;", userAgreementLaw2: "9.2 W przypadku sporu strony powinny podjąć próbę rozwiązania go na drodze negocjacji; jeśli nie dojdzie do porozumienia, każda ze stron ma prawo złożyć pozew w sądzie właściwym dla dzielnicy Longgang w Shenzhen.", userAgreementSection10Title: "10. Kontakt", userAgreementContactDesc: "W przypadku pytań, sugestii lub skarg dotyczących Polityki Prywatności, prosimy o kontakt pod następującymi danymi:", userAgreementServiceHotline: "10.1 Linia obsługi klienta: 400-816-8986", userAgreementServiceTime: "10.2 Godziny pracy: od poniedziałku do piątku, 9:00–19:00", userAgreementConclusion: "Dziękujemy za zaufanie i korzystanie z usługi logowania przez WeChat autoryzowanego przez MCHOSE. Będziemy nadal dążyć do ochrony bezpieczeństwa Twoich danych i praw do prywatności.", emailPlaceholder: "Wpisz e-mail", emailFormatError: "Nieprawidłowy e-mail", emailSendCode: "Pobierz kod", emailResend: "Wyślij ponownie", emailResendCountdown: "Wyślij ponownie ({n}s)", bindEmailGetCode: "Pobierz kod", switchToWechatAria: "Kliknij, aby zalogować przez WeChat", switchToEmailAria: "Kliknij, aby zalogować e-mailem", cornerTooltipWechat: "Kliknij, aby zalogować przez WeChat", cornerTooltipEmail: "Kliknij, aby zalogować e-mailem", titleEmailLogin: "Logowanie e-mail", titleWechatLogin: "Logowanie WeChat", titleBindEmail: "Powiązanie e-mail", testEnvLoginTitle: "Logowanie (środowisko testowe)", testEnvSuffix: " (test)", testCodePlaceholder: "Wprowadź kod autoryzacyjny (code)", btnLogin: "Zaloguj się", codeStepBack: "Wstecz", enterVerificationCode: "Wpisz kod", codeEmailCheckTitle: "Sprawdź pocztę", codeEmailSentLine: "Kod wysłany.", codeEmailInboxLine: "Sprawdź {email}", devOpenDevtools: "Otwórz narzędzia deweloperskie", devInspectPage: "Zbadaj stronę", msgSendCodeFailRetry: "Błąd pobierania kodu", msgOtpSixDigits: "Wprowadź 6-cyfrowy kod", msgWxConfigInitFail: "Inicjacja WeChat nie powiodła się. Sprawdź sieć.", msgLoginPageLoadFail: "Nie udało się załadować strony logowania.", msgLoginFailRetry: "Logowanie nie powiodło się. Spróbuj ponownie.", msgTestEnterAuthCode: "Wprowadź kod autoryzacyjny", msgBindFailGeneric: "Powiązanie nie powiodło się" }, user: { modifyNickname: "Zmień pseudonim", modifyAvatar: "Zmień avatar", nicknamePlaceholder: "Wprowadź nowy pseudonim", nicknameTip: "Długość pseudonimu jest ograniczona do 1-10 znaków", nicknameEmpty: "Pseudonim nie może być pusty", nicknameLengthError: "Długość pseudonimu musi wynosić od 1 do 10 znaków", nicknameUpdateSuccess: "Pseudonim zaktualizowany", avatarUpdateSuccess: "Awatar został pomyślnie zaktualizowany" } }, wS = [{ key: "zh_CN", desc: "简体中文", id: 1, config: fI }, { key: "en_US", desc: "English", id: 2, config: pI }, { key: "ru_RU", desc: "Русский язык", id: 3, config: mI }, { key: "de_DE", desc: "Deutsch", id: 4, config: hI }, { key: "es_ES", desc: "español", id: 5, config: gI }, { key: "fr_FR", desc: "français", id: 6, config: yI }, { key: "ja_JP", desc: "日本語", id: 7, config: vI }, { key: "ko_KR", desc: "한국어", id: 8, config: wI }, { key: "pl_PL", desc: "polski", id: 9, config: SI }], Yd = { name: "debugMode", defaultValue: { switch: false, manuallyInstallDriver: false } };
  async function bI() {
    return await window.electronAPI.getConfig(Yd.name) ?? Yd.defaultValue;
  }
  async function _I(e) {
    return await window.electronAPI.setConfig(Yd.name, e);
  }
  let wy = "en_US";
  const SS = {};
  wS.forEach((e) => {
    SS[e.key] = e.config;
  });
  const AI = nI({ locale: wy, fallbackLocale: wy, messages: SS });
  wS.map((e) => ({ key: e.key, desc: e.desc, id: e.id }));
  const CI = /* @__PURE__ */ wf("debugModeStore", () => {
    const e = Ln(false), t = la({ showUI: true, switch: false, manuallyInstallDriver: false, env: "production" });
    function n(s) {
      Object.assign(t, s), _I(s);
    }
    async function o() {
      const s = await bI();
      s && Object.assign(t, s);
    }
    function a(s) {
      e.value = s;
    }
    return o(), { isShowAudioSDKStatePanel: e, debugModeConfig: t, setDebugMode: n, setIsShowAudioSDKStatePanel: a };
  }), bS = /* @__PURE__ */ wf("envConfig", () => {
    const e = CI(), { debugModeConfig: t } = Sf(e), n = "production", o = la({}), a = We(() => t.value.switch === true ? t.value.env : n), s = We(() => o[a.value] || o.production), c = We(() => new URL(s.value.urlIndex).origin);
    async function u() {
      const v = await window.electronAPI.getEnvConfigs();
      Object.assign(o, v);
    }
    vi(a, async (v) => {
      await window.electronAPI.setCurEnv(v);
    });
    function f(v) {
      return v ? v.startsWith("http") ? v : c.value + v : "";
    }
    const m = Ln(null);
    function h(v) {
      m.value = v;
    }
    return { curEnv: a, curEnvConfig: s, envConfigs: o, curIndexOrigin: c, initEnvConfig: u, getOriginUrl: f, refreshIframeUrl: m, setRefreshIframeUrl: h };
  });
  function TI() {
    try {
      const e = _S();
      if (e && e.user.token) return e.user.token;
    } catch {
    }
  }
  class EI {
    constructor(t = {}) {
      this.instance = Ot.create({ timeout: t.timeout || 1e4, ...t }), this.instance.interceptors.request.use((n) => {
        const o = TI();
        return o && (n.headers.token = o), n.baseURL || (n.baseURL = this._getBaseUrl()), n;
      }, (n) => Promise.reject(n)), this.instance.interceptors.response.use((n) => {
        var a;
        if (n.data && ((a = n.data) == null ? void 0 : a.code) === 208) {
          localStorage.removeItem("token");
          try {
            _S().setUser({ token: "", nickname: "", headimgurl: "" }), window.electronAPI.setUserConfig({ token: "", nickname: "", headimgurl: "" }), ["/user"].includes(n.config.url) || fO.error(AI.global.t("common.pleaseLogin"));
          } catch {
          }
        }
        return !["/user"].includes(n.config.url) && n.data.code !== 200 && console.error(n.data.data || n.data.message), n.data;
      }, (n) => (console.error(n), Promise.reject(n)));
    }
    _getBaseUrl() {
      const t = bS(), { curEnvConfig: n } = Sf(t);
      return n.value.apiConfig.baseUrl;
    }
    get(t, n = {}) {
      return this.instance.get(t, n);
    }
    post(t, n = {}, o = {}) {
      return this.instance.post(t, n, o);
    }
    put(t, n = {}, o = {}) {
      return this.instance.put(t, n, o);
    }
    delete(t, n = {}) {
      return this.instance.delete(t, n);
    }
  }
  const kI = new EI(), zI = () => kI.get("/user"), DI = 60, _S = /* @__PURE__ */ wf("main", { persist: { key: "web-main-store", storage: localStorage, paths: ["user", "eqCloudConfig", "selectId", "selectIdMap", "eqShareCloudConfig", "eqSelectMainTabName", "expertSelectedIdMap", "v9TuborMusicConfig", "emailLoginResendSentAt", "screenSettingsHistoryList"] }, state: () => ({ isAdminRunning: null, user: { token: null, nickname: null, headimgurl: null }, headerConfig: { type: "index", backText: "Return", height: 60, showSetting: true, withBorder: false }, pcHeaderStyle: {}, headerMaskStyle: { display: "none" }, backgroundLoading: false, bgImgConfig: { isIndex: false, bgImgMode: "auto", bgImgModeL2: "customize_default_1", dataUrl: "", bgImgBlur: 0, bgCardBlur: 40 }, v9TuborMusicConfig: { enable: true, mode: 0, speed: 3, brightness: 3, direction: 0, lightSyncStatus: false, baseColor: [254, 3, 3] }, webRouterInfo: { name: "ConnectDevice" }, showUpdate: false, isDownloading: true, downloadProgress: 0, progressVal: 0, detailIsSleep: false, lang: "zh_CN", eqSelectMainTabName: "", expertSelectedIdMap: {}, themeValue: "light", isShowInstructions: false, keyboardMusicDanceConfig: [], musicDanceBoxStyle: null, isShowMusicDanceBox: false, v9TuborPedestalOtaIng: false, firmwareVerInfo: { finishFlag: false, dongle: null, headset: null, base: null }, OTAConfig: null, eqCloudConfig: {}, eqShareCloudConfig: {}, selectIdMap: {}, selectId: "", isV9TuborChargingStand: false, v9tSyncMusicDance: { key: "" }, webShowCloudCommunity: false, emailLoginResendSentAt: {}, screenSettingsHistoryList: [] }), getters: {}, actions: { syncWebShowCloudCommunity(e) {
    this.webShowCloudCommunity = e;
  }, setIsAdminRunning(e) {
    this.isAdminRunning = e;
  }, setV9tSyncMusicDance(e) {
    this.v9tSyncMusicDance = e;
  }, setSelectIdMap(e) {
    Object.assign(this.selectIdMap, e);
  }, setSelectId(e) {
    this.selectId = e;
  }, getSelectId(e) {
    return this.selectIdMap[e] || "";
  }, setV9TuborPedestalOtaIng(e) {
    this.v9TuborPedestalOtaIng = e;
  }, setHeaderConfig(e) {
    Object.assign(this.headerConfig, e);
  }, setBackgroundLoading(e) {
    this.backgroundLoading = e;
  }, setExpertSelectedIdMap(e) {
    Object.assign(this.expertSelectedIdMap, e);
  }, setEqSelectMainTabName(e) {
    this.eqSelectMainTabName = e;
  }, setV9TuborMusicConfig(e) {
    Object.assign(this.v9TuborMusicConfig, e);
  }, setValueByKey(e, t, n = false) {
    n ? Object.assign(this[e], t) : this[e] = t;
  }, setDetailIsSleep(e) {
    this.detailIsSleep = e;
  }, getCurrentDeviceEqConfig(e) {
    return !this.eqCloudConfig || !e ? [] : Array.isArray(this.eqCloudConfig[e]) ? [...this.eqCloudConfig[e]] : [];
  }, updateEqCloudConfig(e, t, n) {
    const o = this.getCurrentDeviceEqConfig(n), a = o.findIndex((s) => s.id ? s.id === t.id : s.name === e);
    if (a !== -1) {
      const s = o[a];
      o[a] = { ...s, ...t }, this.setEqConfig(n, o, false);
    }
  }, clearAllMarks(e) {
    if (!e) return;
    const t = this.getCurrentDeviceEqConfig(e);
    t.forEach((n) => {
      delete n.isNew, delete n.isEdited, delete n.isDeleted;
    }), this.setEqConfig(e, t, false);
  }, setEqConfig(e, t, n = false) {
    n ? (this.eqShareCloudConfig || (this.eqShareCloudConfig = {}), this.eqShareCloudConfig[e] = t) : (this.eqCloudConfig || (this.eqCloudConfig = {}), this.eqCloudConfig[e] = t);
  }, async updateUserInfo() {
    if (!this.user.token) return;
    const e = await zI();
    return e && e.code === 200 && (this.user = { ...this.user, ...e.data }, window.electronAPI.setUserConfig({ ...this.user })), e;
  }, setBgImgConfig(e) {
    Object.assign(this.bgImgConfig, e);
  }, setWebRouterInfo(e) {
    Object.assign(this.webRouterInfo, e);
  }, setLang(e) {
    this.lang = e;
  }, setThemeValue(e) {
    this.themeValue = e;
  }, setkeyboardMusicDanceConfig(e) {
    this.keyboardMusicDanceConfig = e;
  }, setIsShowMusicDanceBox(e) {
    this.isShowMusicDanceBox = e;
  }, setMusicDanceBoxStyle(e) {
    this.musicDanceBoxStyle = e;
  }, setPCHeaderStyle(e) {
    this.pcHeaderStyle = e;
  }, setHeaderMaskStyle(e) {
    this.headerMaskStyle = e;
  }, setUser(e) {
    this.user = e;
  }, setFirmwareVerInfo(e) {
    Object.assign(this.firmwareVerInfo, e);
  }, reSetFirmwareVerInfo() {
    Object.assign(this.firmwareVerInfo, { finishFlag: false, dongle: null, headset: null });
  }, getConfigEnvValue() {
    const e = bS(), { curEnv: t } = Sf(e);
    return ["production", "test85_out", "pre"].includes(t.value) ? "prod" : "test";
  }, async getOTAConfig() {
    const { setData: e } = Cy(), t = this.getConfigEnvValue(), n = `https://cdn.mchose.com.cn/OTA/PC/${t}/otaFile/otaConfigApp_${t}.json`;
    try {
      const o = await Ot.get(n, { timeout: 8e3, headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } });
      return o && o.status === 200 ? (this.OTAConfig = o.data, e("pcOTAConfig", o.data), o.data) : (console.error("下载otaConfig失败 res:", o), false);
    } catch (o) {
      return console.error("下载otaConfig失败 error:", o), false;
    }
  }, resetUpdateStatus() {
    this.showUpdate = false, this.isDownloading = true, this.downloadProgress = 0, this.progressVal = 0;
  }, setIsV9TuborChargingStand(e) {
    this.isV9TuborChargingStand = e;
  }, setEmailLoginResendSentAt(e, t) {
    const n = String(e ?? "").trim();
    !n || typeof t != "number" || (this.emailLoginResendSentAt[n] = t);
  }, pruneEmailLoginResendSentAt(e = Date.now()) {
    const t = DI * 1e3, n = this.emailLoginResendSentAt;
    for (const o of Object.keys(n)) n[o] + t <= e && delete n[o];
  }, removeEmailLoginResendSentAt(e) {
    const t = String(e ?? "").trim();
    if (!t) return;
    const n = this.emailLoginResendSentAt;
    t in n && delete n[t];
  } } });
  var Vl = { exports: {} };
  /**
  * @license
  * Lodash <https://lodash.com/>
  * Copyright OpenJS Foundation and other contributors <https://openjsf.org/>
  * Released under MIT license <https://lodash.com/license>
  * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
  * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
  */
  Vl.exports;
  (function(e, t) {
    (function() {
      var n, o = "4.18.1", a = 200, s = "Unsupported core-js use. Try https://npms.io/search?q=ponyfill.", c = "Expected a function", u = "Invalid `variable` option passed into `_.template`", f = "Invalid `imports` option passed into `_.template`", m = "__lodash_hash_undefined__", h = 500, v = "__lodash_placeholder__", C = 1, D = 2, W = 4, E = 1, L = 2, b = 1, P = 2, B = 4, k = 8, j = 16, $ = 32, q = 64, ue = 128, ee = 256, se = 512, le = 30, re = "...", Ee = 800, fe = 16, ce = 1, G = 2, oe = 3, ie = 1 / 0, pe = 9007199254740991, we = 17976931348623157e292, Te = NaN, ke = 4294967295, tt = ke - 1, Me = ke >>> 1, it = [["ary", ue], ["bind", b], ["bindKey", P], ["curry", k], ["curryRight", j], ["flip", se], ["partial", $], ["partialRight", q], ["rearg", ee]], Re = "[object Arguments]", ft = "[object Array]", Ie = "[object AsyncFunction]", pt = "[object Boolean]", be = "[object Date]", Ae = "[object DOMException]", _ = "[object Error]", z = "[object Function]", U = "[object GeneratorFunction]", Y = "[object Map]", J = "[object Number]", X = "[object Null]", w = "[object Object]", S = "[object Promise]", x = "[object Proxy]", N = "[object RegExp]", de = "[object Set]", Z = "[object String]", O = "[object Symbol]", H = "[object Undefined]", ge = "[object WeakMap]", ze = "[object WeakSet]", Fe = "[object ArrayBuffer]", Ke = "[object DataView]", Qe = "[object Float32Array]", Et = "[object Float64Array]", vt = "[object Int8Array]", In = "[object Int16Array]", Fi = "[object Int32Array]", Nt = "[object Uint8Array]", qt = "[object Uint8ClampedArray]", Ni = "[object Uint16Array]", si = "[object Uint32Array]", vo = /\b__p \+= '';/g, $n = /\b(__p \+=) '' \+/g, pr = /(__e\(.*?\)|\b__t\)) \+\n'';/g, wo = /&(?:amp|lt|gt|quot|#39);/g, So = /[&<>"']/g, gc = RegExp(wo.source), ua = RegExp(So.source), da = /<%-([\s\S]+?)%>/g, yc = /<%([\s\S]+?)%>/g, mr = /<%=([\s\S]+?)%>/g, vc = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/, wc = /^\w*$/, kt = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g, _i = /[\\^$.*+?()[\]{}|]/g, Sc = RegExp(_i.source), bo = /^\s+/, fa = /\s/, Cs = /\{(?:\n\/\* \[wrapped with .+\] \*\/)?\n?/, Ts = /\{\n\/\* \[wrapped with (.+)\] \*/, bc = /,? & /, Rn = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g, Ai = /[()=,{}\[\]\/\s]/, Es = /\\(\\)?/g, ks = /\$\{([^\\}]*(?:\\.[^\\}]*)*)\}/g, _o = /\w*$/, Ao = /^[-+]0x[0-9a-f]+$/i, hr = /^0b[01]+$/i, Co = /^\[object .+?Constructor\]$/, li = /^0o[0-7]+$/i, zs = /^(?:0|[1-9]\d*)$/, Ds = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g, To = /($^)/, Ms = /['\n\r\u2028\u2029\\]/g, Fr = "\\ud800-\\udfff", Eo = "\\u0300-\\u036f", gr = "\\ufe20-\\ufe2f", _e = "\\u20d0-\\u20ff", A = Eo + gr + _e, Q = "\\u2700-\\u27bf", me = "a-z\\xdf-\\xf6\\xf8-\\xff", nt = "\\xac\\xb1\\xd7\\xf7", Ue = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf", ut = "\\u2000-\\u206f", Pt = " \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000", cn = "A-Z\\xc0-\\xd6\\xd8-\\xde", An = "\\ufe0e\\ufe0f", ko = nt + Ue + ut + Pt, Dt = "['’]", Ls = "[" + Fr + "]", pa = "[" + ko + "]", xs = "[" + A + "]", Uf = "\\d+", TS = "[" + Q + "]", jf = "[" + me + "]", Hf = "[^" + Fr + ko + Uf + Q + me + cn + "]", _c = "\\ud83c[\\udffb-\\udfff]", ES = "(?:" + xs + "|" + _c + ")", Vf = "[^" + Fr + "]", Ac = "(?:\\ud83c[\\udde6-\\uddff]){2}", Cc = "[\\ud800-\\udbff][\\udc00-\\udfff]", zo = "[" + cn + "]", qf = "\\u200d", $f = "(?:" + jf + "|" + Hf + ")", kS = "(?:" + zo + "|" + Hf + ")", Gf = "(?:" + Dt + "(?:d|ll|m|re|s|t|ve))?", Kf = "(?:" + Dt + "(?:D|LL|M|RE|S|T|VE))?", Yf = ES + "?", Zf = "[" + An + "]?", zS = "(?:" + qf + "(?:" + [Vf, Ac, Cc].join("|") + ")" + Zf + Yf + ")*", DS = "\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])", MS = "\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])", Qf = Zf + Yf + zS, LS = "(?:" + [TS, Ac, Cc].join("|") + ")" + Qf, xS = "(?:" + [Vf + xs + "?", xs, Ac, Cc, Ls].join("|") + ")", OS = RegExp(Dt, "g"), PS = RegExp(xs, "g"), Tc = RegExp(_c + "(?=" + _c + ")|" + xS + Qf, "g"), IS = RegExp([zo + "?" + jf + "+" + Gf + "(?=" + [pa, zo, "$"].join("|") + ")", kS + "+" + Kf + "(?=" + [pa, zo + $f, "$"].join("|") + ")", zo + "?" + $f + "+" + Gf, zo + "+" + Kf, MS, DS, Uf, LS].join("|"), "g"), RS = RegExp("[" + qf + Fr + A + An + "]"), FS = /[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/, NS = ["Array", "Buffer", "DataView", "Date", "Error", "Float32Array", "Float64Array", "Function", "Int8Array", "Int16Array", "Int32Array", "Map", "Math", "Object", "Promise", "RegExp", "Set", "String", "Symbol", "TypeError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "WeakMap", "_", "clearTimeout", "isFinite", "parseInt", "setTimeout"], WS = -1, _t = {};
      _t[Qe] = _t[Et] = _t[vt] = _t[In] = _t[Fi] = _t[Nt] = _t[qt] = _t[Ni] = _t[si] = true, _t[Re] = _t[ft] = _t[Fe] = _t[pt] = _t[Ke] = _t[be] = _t[_] = _t[z] = _t[Y] = _t[J] = _t[w] = _t[N] = _t[de] = _t[Z] = _t[ge] = false;
      var wt = {};
      wt[Re] = wt[ft] = wt[Fe] = wt[Ke] = wt[pt] = wt[be] = wt[Qe] = wt[Et] = wt[vt] = wt[In] = wt[Fi] = wt[Y] = wt[J] = wt[w] = wt[N] = wt[de] = wt[Z] = wt[O] = wt[Nt] = wt[qt] = wt[Ni] = wt[si] = true, wt[_] = wt[z] = wt[ge] = false;
      var BS = { À: "A", Á: "A", Â: "A", Ã: "A", Ä: "A", Å: "A", à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", Ç: "C", ç: "c", Ð: "D", ð: "d", È: "E", É: "E", Ê: "E", Ë: "E", è: "e", é: "e", ê: "e", ë: "e", Ì: "I", Í: "I", Î: "I", Ï: "I", ì: "i", í: "i", î: "i", ï: "i", Ñ: "N", ñ: "n", Ò: "O", Ó: "O", Ô: "O", Õ: "O", Ö: "O", Ø: "O", ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", Ù: "U", Ú: "U", Û: "U", Ü: "U", ù: "u", ú: "u", û: "u", ü: "u", Ý: "Y", ý: "y", ÿ: "y", Æ: "Ae", æ: "ae", Þ: "Th", þ: "th", ß: "ss", Ā: "A", Ă: "A", Ą: "A", ā: "a", ă: "a", ą: "a", Ć: "C", Ĉ: "C", Ċ: "C", Č: "C", ć: "c", ĉ: "c", ċ: "c", č: "c", Ď: "D", Đ: "D", ď: "d", đ: "d", Ē: "E", Ĕ: "E", Ė: "E", Ę: "E", Ě: "E", ē: "e", ĕ: "e", ė: "e", ę: "e", ě: "e", Ĝ: "G", Ğ: "G", Ġ: "G", Ģ: "G", ĝ: "g", ğ: "g", ġ: "g", ģ: "g", Ĥ: "H", Ħ: "H", ĥ: "h", ħ: "h", Ĩ: "I", Ī: "I", Ĭ: "I", Į: "I", İ: "I", ĩ: "i", ī: "i", ĭ: "i", į: "i", ı: "i", Ĵ: "J", ĵ: "j", Ķ: "K", ķ: "k", ĸ: "k", Ĺ: "L", Ļ: "L", Ľ: "L", Ŀ: "L", Ł: "L", ĺ: "l", ļ: "l", ľ: "l", ŀ: "l", ł: "l", Ń: "N", Ņ: "N", Ň: "N", Ŋ: "N", ń: "n", ņ: "n", ň: "n", ŋ: "n", Ō: "O", Ŏ: "O", Ő: "O", ō: "o", ŏ: "o", ő: "o", Ŕ: "R", Ŗ: "R", Ř: "R", ŕ: "r", ŗ: "r", ř: "r", Ś: "S", Ŝ: "S", Ş: "S", Š: "S", ś: "s", ŝ: "s", ş: "s", š: "s", Ţ: "T", Ť: "T", Ŧ: "T", ţ: "t", ť: "t", ŧ: "t", Ũ: "U", Ū: "U", Ŭ: "U", Ů: "U", Ű: "U", Ų: "U", ũ: "u", ū: "u", ŭ: "u", ů: "u", ű: "u", ų: "u", Ŵ: "W", ŵ: "w", Ŷ: "Y", ŷ: "y", Ÿ: "Y", Ź: "Z", Ż: "Z", Ž: "Z", ź: "z", ż: "z", ž: "z", Ĳ: "IJ", ĳ: "ij", Œ: "Oe", œ: "oe", ŉ: "'n", ſ: "s" }, US = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }, jS = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }, HS = { "\\": "\\", "'": "'", "\n": "n", "\r": "r", "\u2028": "u2028", "\u2029": "u2029" }, VS = parseFloat, qS = parseInt, Jf = typeof Qo == "object" && Qo && Qo.Object === Object && Qo, $S = typeof self == "object" && self && self.Object === Object && self, Yt = Jf || $S || Function("return this")(), Ec = t && !t.nodeType && t, Nr = Ec && true && e && !e.nodeType && e, Xf = Nr && Nr.exports === Ec, kc = Xf && Jf.process, Gn = (function() {
        try {
          var I = Nr && Nr.require && Nr.require("util").types;
          return I || kc && kc.binding && kc.binding("util");
        } catch {
        }
      })(), ep = Gn && Gn.isArrayBuffer, tp = Gn && Gn.isDate, np = Gn && Gn.isMap, ip = Gn && Gn.isRegExp, rp = Gn && Gn.isSet, op = Gn && Gn.isTypedArray;
      function Fn(I, K, V) {
        switch (V.length) {
          case 0:
            return I.call(K);
          case 1:
            return I.call(K, V[0]);
          case 2:
            return I.call(K, V[0], V[1]);
          case 3:
            return I.call(K, V[0], V[1], V[2]);
        }
        return I.apply(K, V);
      }
      function GS(I, K, V, ve) {
        for (var Ne = -1, at = I == null ? 0 : I.length; ++Ne < at; ) {
          var Bt = I[Ne];
          K(ve, Bt, V(Bt), I);
        }
        return ve;
      }
      function Nn(I, K) {
        for (var V = -1, ve = I == null ? 0 : I.length; ++V < ve && K(I[V], V, I) !== false; ) ;
        return I;
      }
      function KS(I, K) {
        for (var V = I == null ? 0 : I.length; V-- && K(I[V], V, I) !== false; ) ;
        return I;
      }
      function ap(I, K) {
        for (var V = -1, ve = I == null ? 0 : I.length; ++V < ve; ) if (!K(I[V], V, I)) return false;
        return true;
      }
      function yr(I, K) {
        for (var V = -1, ve = I == null ? 0 : I.length, Ne = 0, at = []; ++V < ve; ) {
          var Bt = I[V];
          K(Bt, V, I) && (at[Ne++] = Bt);
        }
        return at;
      }
      function Os(I, K) {
        var V = I == null ? 0 : I.length;
        return !!V && Do(I, K, 0) > -1;
      }
      function zc(I, K, V) {
        for (var ve = -1, Ne = I == null ? 0 : I.length; ++ve < Ne; ) if (V(K, I[ve])) return true;
        return false;
      }
      function Tt(I, K) {
        for (var V = -1, ve = I == null ? 0 : I.length, Ne = Array(ve); ++V < ve; ) Ne[V] = K(I[V], V, I);
        return Ne;
      }
      function vr(I, K) {
        for (var V = -1, ve = K.length, Ne = I.length; ++V < ve; ) I[Ne + V] = K[V];
        return I;
      }
      function Dc(I, K, V, ve) {
        var Ne = -1, at = I == null ? 0 : I.length;
        for (ve && at && (V = I[++Ne]); ++Ne < at; ) V = K(V, I[Ne], Ne, I);
        return V;
      }
      function YS(I, K, V, ve) {
        var Ne = I == null ? 0 : I.length;
        for (ve && Ne && (V = I[--Ne]); Ne--; ) V = K(V, I[Ne], Ne, I);
        return V;
      }
      function Mc(I, K) {
        for (var V = -1, ve = I == null ? 0 : I.length; ++V < ve; ) if (K(I[V], V, I)) return true;
        return false;
      }
      var ZS = Lc("length");
      function QS(I) {
        return I.split("");
      }
      function JS(I) {
        return I.match(Rn) || [];
      }
      function sp(I, K, V) {
        var ve;
        return V(I, function(Ne, at, Bt) {
          if (K(Ne, at, Bt)) return ve = at, false;
        }), ve;
      }
      function Ps(I, K, V, ve) {
        for (var Ne = I.length, at = V + (ve ? 1 : -1); ve ? at-- : ++at < Ne; ) if (K(I[at], at, I)) return at;
        return -1;
      }
      function Do(I, K, V) {
        return K === K ? ub(I, K, V) : Ps(I, lp, V);
      }
      function XS(I, K, V, ve) {
        for (var Ne = V - 1, at = I.length; ++Ne < at; ) if (ve(I[Ne], K)) return Ne;
        return -1;
      }
      function lp(I) {
        return I !== I;
      }
      function cp(I, K) {
        var V = I == null ? 0 : I.length;
        return V ? Oc(I, K) / V : Te;
      }
      function Lc(I) {
        return function(K) {
          return K == null ? n : K[I];
        };
      }
      function xc(I) {
        return function(K) {
          return I == null ? n : I[K];
        };
      }
      function up(I, K, V, ve, Ne) {
        return Ne(I, function(at, Bt, gt) {
          V = ve ? (ve = false, at) : K(V, at, Bt, gt);
        }), V;
      }
      function eb(I, K) {
        var V = I.length;
        for (I.sort(K); V--; ) I[V] = I[V].value;
        return I;
      }
      function Oc(I, K) {
        for (var V, ve = -1, Ne = I.length; ++ve < Ne; ) {
          var at = K(I[ve]);
          at !== n && (V = V === n ? at : V + at);
        }
        return V;
      }
      function Pc(I, K) {
        for (var V = -1, ve = Array(I); ++V < I; ) ve[V] = K(V);
        return ve;
      }
      function tb(I, K) {
        return Tt(K, function(V) {
          return [V, I[V]];
        });
      }
      function dp(I) {
        return I && I.slice(0, hp(I) + 1).replace(bo, "");
      }
      function Wn(I) {
        return function(K) {
          return I(K);
        };
      }
      function Ic(I, K) {
        return Tt(K, function(V) {
          return I[V];
        });
      }
      function ma(I, K) {
        return I.has(K);
      }
      function fp(I, K) {
        for (var V = -1, ve = I.length; ++V < ve && Do(K, I[V], 0) > -1; ) ;
        return V;
      }
      function pp(I, K) {
        for (var V = I.length; V-- && Do(K, I[V], 0) > -1; ) ;
        return V;
      }
      function nb(I, K) {
        for (var V = I.length, ve = 0; V--; ) I[V] === K && ++ve;
        return ve;
      }
      var ib = xc(BS), rb = xc(US);
      function ob(I) {
        return "\\" + HS[I];
      }
      function ab(I, K) {
        return I == null ? n : I[K];
      }
      function Mo(I) {
        return RS.test(I);
      }
      function sb(I) {
        return FS.test(I);
      }
      function lb(I) {
        for (var K, V = []; !(K = I.next()).done; ) V.push(K.value);
        return V;
      }
      function Rc(I) {
        var K = -1, V = Array(I.size);
        return I.forEach(function(ve, Ne) {
          V[++K] = [Ne, ve];
        }), V;
      }
      function mp(I, K) {
        return function(V) {
          return I(K(V));
        };
      }
      function wr(I, K) {
        for (var V = -1, ve = I.length, Ne = 0, at = []; ++V < ve; ) {
          var Bt = I[V];
          (Bt === K || Bt === v) && (I[V] = v, at[Ne++] = V);
        }
        return at;
      }
      function Is(I) {
        var K = -1, V = Array(I.size);
        return I.forEach(function(ve) {
          V[++K] = ve;
        }), V;
      }
      function cb(I) {
        var K = -1, V = Array(I.size);
        return I.forEach(function(ve) {
          V[++K] = [ve, ve];
        }), V;
      }
      function ub(I, K, V) {
        for (var ve = V - 1, Ne = I.length; ++ve < Ne; ) if (I[ve] === K) return ve;
        return -1;
      }
      function db(I, K, V) {
        for (var ve = V + 1; ve--; ) if (I[ve] === K) return ve;
        return ve;
      }
      function Lo(I) {
        return Mo(I) ? pb(I) : ZS(I);
      }
      function ci(I) {
        return Mo(I) ? mb(I) : QS(I);
      }
      function hp(I) {
        for (var K = I.length; K-- && fa.test(I.charAt(K)); ) ;
        return K;
      }
      var fb = xc(jS);
      function pb(I) {
        for (var K = Tc.lastIndex = 0; Tc.test(I); ) ++K;
        return K;
      }
      function mb(I) {
        return I.match(Tc) || [];
      }
      function hb(I) {
        return I.match(IS) || [];
      }
      var gb = function I(K) {
        K = K == null ? Yt : xo.defaults(Yt.Object(), K, xo.pick(Yt, NS));
        var V = K.Array, ve = K.Date, Ne = K.Error, at = K.Function, Bt = K.Math, gt = K.Object, Fc = K.RegExp, yb = K.String, Kn = K.TypeError, Rs = V.prototype, vb = at.prototype, Oo = gt.prototype, Fs = K["__core-js_shared__"], Ns = vb.toString, lt = Oo.hasOwnProperty, wb = 0, gp = (function() {
          var i = /[^.]+$/.exec(Fs && Fs.keys && Fs.keys.IE_PROTO || "");
          return i ? "Symbol(src)_1." + i : "";
        })(), Ws = Oo.toString, Sb = Ns.call(gt), bb = Yt._, _b = Fc("^" + Ns.call(lt).replace(_i, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$"), Bs = Xf ? K.Buffer : n, Sr = K.Symbol, Us = K.Uint8Array, yp = Bs ? Bs.allocUnsafe : n, js = mp(gt.getPrototypeOf, gt), vp = gt.create, wp = Oo.propertyIsEnumerable, Hs = Rs.splice, Sp = Sr ? Sr.isConcatSpreadable : n, ha = Sr ? Sr.iterator : n, Wr = Sr ? Sr.toStringTag : n, Vs = (function() {
          try {
            var i = Vr(gt, "defineProperty");
            return i({}, "", {}), i;
          } catch {
          }
        })(), Ab = K.clearTimeout !== Yt.clearTimeout && K.clearTimeout, Cb = ve && ve.now !== Yt.Date.now && ve.now, Tb = K.setTimeout !== Yt.setTimeout && K.setTimeout, qs = Bt.ceil, $s = Bt.floor, Nc = gt.getOwnPropertySymbols, Eb = Bs ? Bs.isBuffer : n, bp = K.isFinite, kb = Rs.join, zb = mp(gt.keys, gt), Ut = Bt.max, en = Bt.min, Db = ve.now, Mb = K.parseInt, _p = Bt.random, Lb = Rs.reverse, Wc = Vr(K, "DataView"), ga = Vr(K, "Map"), Bc = Vr(K, "Promise"), Po = Vr(K, "Set"), ya = Vr(K, "WeakMap"), va = Vr(gt, "create"), Gs = ya && new ya(), Io = {}, xb = qr(Wc), Ob = qr(ga), Pb = qr(Bc), Ib = qr(Po), Rb = qr(ya), Ks = Sr ? Sr.prototype : n, wa = Ks ? Ks.valueOf : n, Ap = Ks ? Ks.toString : n;
        function g(i) {
          if (Mt(i) && !Be(i) && !(i instanceof Ye)) {
            if (i instanceof Yn) return i;
            if (lt.call(i, "__wrapped__")) return Cm(i);
          }
          return new Yn(i);
        }
        var Ro = /* @__PURE__ */ (function() {
          function i() {
          }
          return function(r) {
            if (!zt(r)) return {};
            if (vp) return vp(r);
            i.prototype = r;
            var l = new i();
            return i.prototype = n, l;
          };
        })();
        function Ys() {
        }
        function Yn(i, r) {
          this.__wrapped__ = i, this.__actions__ = [], this.__chain__ = !!r, this.__index__ = 0, this.__values__ = n;
        }
        g.templateSettings = { escape: da, evaluate: yc, interpolate: mr, variable: "", imports: { _: g } }, g.prototype = Ys.prototype, g.prototype.constructor = g, Yn.prototype = Ro(Ys.prototype), Yn.prototype.constructor = Yn;
        function Ye(i) {
          this.__wrapped__ = i, this.__actions__ = [], this.__dir__ = 1, this.__filtered__ = false, this.__iteratees__ = [], this.__takeCount__ = ke, this.__views__ = [];
        }
        function Fb() {
          var i = new Ye(this.__wrapped__);
          return i.__actions__ = Cn(this.__actions__), i.__dir__ = this.__dir__, i.__filtered__ = this.__filtered__, i.__iteratees__ = Cn(this.__iteratees__), i.__takeCount__ = this.__takeCount__, i.__views__ = Cn(this.__views__), i;
        }
        function Nb() {
          if (this.__filtered__) {
            var i = new Ye(this);
            i.__dir__ = -1, i.__filtered__ = true;
          } else i = this.clone(), i.__dir__ *= -1;
          return i;
        }
        function Wb() {
          var i = this.__wrapped__.value(), r = this.__dir__, l = Be(i), d = r < 0, p = l ? i.length : 0, y = Q0(0, p, this.__views__), T = y.start, M = y.end, R = M - T, te = d ? M : T - 1, ne = this.__iteratees__, ae = ne.length, he = 0, Ce = en(R, this.__takeCount__);
          if (!l || !d && p == R && Ce == R) return Gp(i, this.__actions__);
          var Oe = [];
          e: for (; R-- && he < Ce; ) {
            te += r;
            for (var Ve = -1, De = i[te]; ++Ve < ae; ) {
              var Ge = ne[Ve], Ze = Ge.iteratee, jn = Ge.type, fn = Ze(De);
              if (jn == G) De = fn;
              else if (!fn) {
                if (jn == ce) continue e;
                break e;
              }
            }
            Oe[he++] = De;
          }
          return Oe;
        }
        Ye.prototype = Ro(Ys.prototype), Ye.prototype.constructor = Ye;
        function Br(i) {
          var r = -1, l = i == null ? 0 : i.length;
          for (this.clear(); ++r < l; ) {
            var d = i[r];
            this.set(d[0], d[1]);
          }
        }
        function Bb() {
          this.__data__ = va ? va(null) : {}, this.size = 0;
        }
        function Ub(i) {
          var r = this.has(i) && delete this.__data__[i];
          return this.size -= r ? 1 : 0, r;
        }
        function jb(i) {
          var r = this.__data__;
          if (va) {
            var l = r[i];
            return l === m ? n : l;
          }
          return lt.call(r, i) ? r[i] : n;
        }
        function Hb(i) {
          var r = this.__data__;
          return va ? r[i] !== n : lt.call(r, i);
        }
        function Vb(i, r) {
          var l = this.__data__;
          return this.size += this.has(i) ? 0 : 1, l[i] = va && r === n ? m : r, this;
        }
        Br.prototype.clear = Bb, Br.prototype.delete = Ub, Br.prototype.get = jb, Br.prototype.has = Hb, Br.prototype.set = Vb;
        function Wi(i) {
          var r = -1, l = i == null ? 0 : i.length;
          for (this.clear(); ++r < l; ) {
            var d = i[r];
            this.set(d[0], d[1]);
          }
        }
        function qb() {
          this.__data__ = [], this.size = 0;
        }
        function $b(i) {
          var r = this.__data__, l = Zs(r, i);
          if (l < 0) return false;
          var d = r.length - 1;
          return l == d ? r.pop() : Hs.call(r, l, 1), --this.size, true;
        }
        function Gb(i) {
          var r = this.__data__, l = Zs(r, i);
          return l < 0 ? n : r[l][1];
        }
        function Kb(i) {
          return Zs(this.__data__, i) > -1;
        }
        function Yb(i, r) {
          var l = this.__data__, d = Zs(l, i);
          return d < 0 ? (++this.size, l.push([i, r])) : l[d][1] = r, this;
        }
        Wi.prototype.clear = qb, Wi.prototype.delete = $b, Wi.prototype.get = Gb, Wi.prototype.has = Kb, Wi.prototype.set = Yb;
        function Bi(i) {
          var r = -1, l = i == null ? 0 : i.length;
          for (this.clear(); ++r < l; ) {
            var d = i[r];
            this.set(d[0], d[1]);
          }
        }
        function Zb() {
          this.size = 0, this.__data__ = { hash: new Br(), map: new (ga || Wi)(), string: new Br() };
        }
        function Qb(i) {
          var r = ll(this, i).delete(i);
          return this.size -= r ? 1 : 0, r;
        }
        function Jb(i) {
          return ll(this, i).get(i);
        }
        function Xb(i) {
          return ll(this, i).has(i);
        }
        function e0(i, r) {
          var l = ll(this, i), d = l.size;
          return l.set(i, r), this.size += l.size == d ? 0 : 1, this;
        }
        Bi.prototype.clear = Zb, Bi.prototype.delete = Qb, Bi.prototype.get = Jb, Bi.prototype.has = Xb, Bi.prototype.set = e0;
        function Ur(i) {
          var r = -1, l = i == null ? 0 : i.length;
          for (this.__data__ = new Bi(); ++r < l; ) this.add(i[r]);
        }
        function t0(i) {
          return this.__data__.set(i, m), this;
        }
        function n0(i) {
          return this.__data__.has(i);
        }
        Ur.prototype.add = Ur.prototype.push = t0, Ur.prototype.has = n0;
        function ui(i) {
          var r = this.__data__ = new Wi(i);
          this.size = r.size;
        }
        function i0() {
          this.__data__ = new Wi(), this.size = 0;
        }
        function r0(i) {
          var r = this.__data__, l = r.delete(i);
          return this.size = r.size, l;
        }
        function o0(i) {
          return this.__data__.get(i);
        }
        function a0(i) {
          return this.__data__.has(i);
        }
        function s0(i, r) {
          var l = this.__data__;
          if (l instanceof Wi) {
            var d = l.__data__;
            if (!ga || d.length < a - 1) return d.push([i, r]), this.size = ++l.size, this;
            l = this.__data__ = new Bi(d);
          }
          return l.set(i, r), this.size = l.size, this;
        }
        ui.prototype.clear = i0, ui.prototype.delete = r0, ui.prototype.get = o0, ui.prototype.has = a0, ui.prototype.set = s0;
        function Cp(i, r) {
          var l = Be(i), d = !l && $r(i), p = !l && !d && Tr(i), y = !l && !d && !p && Bo(i), T = l || d || p || y, M = T ? Pc(i.length, yb) : [], R = M.length;
          for (var te in i) (r || lt.call(i, te)) && !(T && (te == "length" || p && (te == "offset" || te == "parent") || y && (te == "buffer" || te == "byteLength" || te == "byteOffset") || Hi(te, R))) && M.push(te);
          return M;
        }
        function Tp(i) {
          var r = i.length;
          return r ? i[Qc(0, r - 1)] : n;
        }
        function l0(i, r) {
          return cl(Cn(i), jr(r, 0, i.length));
        }
        function c0(i) {
          return cl(Cn(i));
        }
        function Uc(i, r, l) {
          (l !== n && !fi(i[r], l) || l === n && !(r in i)) && Ci(i, r, l);
        }
        function Sa(i, r, l) {
          var d = i[r];
          (!(lt.call(i, r) && fi(d, l)) || l === n && !(r in i)) && Ci(i, r, l);
        }
        function Zs(i, r) {
          for (var l = i.length; l--; ) if (fi(i[l][0], r)) return l;
          return -1;
        }
        function u0(i, r, l, d) {
          return br(i, function(p, y, T) {
            r(d, p, l(p), T);
          }), d;
        }
        function Ep(i, r) {
          return i && Ei(r, $t(r), i);
        }
        function d0(i, r) {
          return i && Ei(r, En(r), i);
        }
        function Ci(i, r, l) {
          r == "__proto__" && Vs ? Vs(i, r, { configurable: true, enumerable: true, value: l, writable: true }) : i[r] = l;
        }
        function jc(i, r) {
          for (var l = -1, d = r.length, p = V(d), y = i == null; ++l < d; ) p[l] = y ? n : Au(i, r[l]);
          return p;
        }
        function jr(i, r, l) {
          return i === i && (l !== n && (i = i <= l ? i : l), r !== n && (i = i >= r ? i : r)), i;
        }
        function Zn(i, r, l, d, p, y) {
          var T, M = r & C, R = r & D, te = r & W;
          if (l && (T = p ? l(i, d, p, y) : l(i)), T !== n) return T;
          if (!zt(i)) return i;
          var ne = Be(i);
          if (ne) {
            if (T = X0(i), !M) return Cn(i, T);
          } else {
            var ae = tn(i), he = ae == z || ae == U;
            if (Tr(i)) return Zp(i, M);
            if (ae == w || ae == Re || he && !p) {
              if (T = R || he ? {} : hm(i), !M) return R ? j0(i, d0(T, i)) : U0(i, Ep(T, i));
            } else {
              if (!wt[ae]) return p ? i : {};
              T = e_(i, ae, M);
            }
          }
          y || (y = new ui());
          var Ce = y.get(i);
          if (Ce) return Ce;
          y.set(i, T), Vm(i) ? i.forEach(function(De) {
            T.add(Zn(De, r, l, De, i, y));
          }) : jm(i) && i.forEach(function(De, Ge) {
            T.set(Ge, Zn(De, r, l, Ge, i, y));
          });
          var Oe = te ? R ? lu : su : R ? En : $t, Ve = ne ? n : Oe(i);
          return Nn(Ve || i, function(De, Ge) {
            Ve && (Ge = De, De = i[Ge]), Sa(T, Ge, Zn(De, r, l, Ge, i, y));
          }), T;
        }
        function f0(i) {
          var r = $t(i);
          return function(l) {
            return kp(l, i, r);
          };
        }
        function kp(i, r, l) {
          var d = l.length;
          if (i == null) return !d;
          for (i = gt(i); d--; ) {
            var p = l[d], y = r[p], T = i[p];
            if (T === n && !(p in i) || !y(T)) return false;
          }
          return true;
        }
        function zp(i, r, l) {
          if (typeof i != "function") throw new Kn(c);
          return ka(function() {
            i.apply(n, l);
          }, r);
        }
        function ba(i, r, l, d) {
          var p = -1, y = Os, T = true, M = i.length, R = [], te = r.length;
          if (!M) return R;
          l && (r = Tt(r, Wn(l))), d ? (y = zc, T = false) : r.length >= a && (y = ma, T = false, r = new Ur(r));
          e: for (; ++p < M; ) {
            var ne = i[p], ae = l == null ? ne : l(ne);
            if (ne = d || ne !== 0 ? ne : 0, T && ae === ae) {
              for (var he = te; he--; ) if (r[he] === ae) continue e;
              R.push(ne);
            } else y(r, ae, d) || R.push(ne);
          }
          return R;
        }
        var br = tm(Ti), Dp = tm(Vc, true);
        function p0(i, r) {
          var l = true;
          return br(i, function(d, p, y) {
            return l = !!r(d, p, y), l;
          }), l;
        }
        function Qs(i, r, l) {
          for (var d = -1, p = i.length; ++d < p; ) {
            var y = i[d], T = r(y);
            if (T != null && (M === n ? T === T && !Un(T) : l(T, M))) var M = T, R = y;
          }
          return R;
        }
        function m0(i, r, l, d) {
          var p = i.length;
          for (l = je(l), l < 0 && (l = -l > p ? 0 : p + l), d = d === n || d > p ? p : je(d), d < 0 && (d += p), d = l > d ? 0 : $m(d); l < d; ) i[l++] = r;
          return i;
        }
        function Mp(i, r) {
          var l = [];
          return br(i, function(d, p, y) {
            r(d, p, y) && l.push(d);
          }), l;
        }
        function Zt(i, r, l, d, p) {
          var y = -1, T = i.length;
          for (l || (l = n_), p || (p = []); ++y < T; ) {
            var M = i[y];
            r > 0 && l(M) ? r > 1 ? Zt(M, r - 1, l, d, p) : vr(p, M) : d || (p[p.length] = M);
          }
          return p;
        }
        var Hc = nm(), Lp = nm(true);
        function Ti(i, r) {
          return i && Hc(i, r, $t);
        }
        function Vc(i, r) {
          return i && Lp(i, r, $t);
        }
        function Js(i, r) {
          return yr(r, function(l) {
            return Vi(i[l]);
          });
        }
        function Hr(i, r) {
          r = Ar(r, i);
          for (var l = 0, d = r.length; i != null && l < d; ) i = i[di(r[l++])];
          return l && l == d ? i : n;
        }
        function xp(i, r, l) {
          var d = r(i);
          return Be(i) ? d : vr(d, l(i));
        }
        function un(i) {
          return i == null ? i === n ? H : X : Wr && Wr in gt(i) ? Z0(i) : c_(i);
        }
        function qc(i, r) {
          return i > r;
        }
        function h0(i, r) {
          return i != null && lt.call(i, r);
        }
        function g0(i, r) {
          return i != null && r in gt(i);
        }
        function y0(i, r, l) {
          return i >= en(r, l) && i < Ut(r, l);
        }
        function $c(i, r, l) {
          for (var d = l ? zc : Os, p = i[0].length, y = i.length, T = y, M = V(y), R = 1 / 0, te = []; T--; ) {
            var ne = i[T];
            T && r && (ne = Tt(ne, Wn(r))), R = en(ne.length, R), M[T] = !l && (r || p >= 120 && ne.length >= 120) ? new Ur(T && ne) : n;
          }
          ne = i[0];
          var ae = -1, he = M[0];
          e: for (; ++ae < p && te.length < R; ) {
            var Ce = ne[ae], Oe = r ? r(Ce) : Ce;
            if (Ce = l || Ce !== 0 ? Ce : 0, !(he ? ma(he, Oe) : d(te, Oe, l))) {
              for (T = y; --T; ) {
                var Ve = M[T];
                if (!(Ve ? ma(Ve, Oe) : d(i[T], Oe, l))) continue e;
              }
              he && he.push(Oe), te.push(Ce);
            }
          }
          return te;
        }
        function v0(i, r, l, d) {
          return Ti(i, function(p, y, T) {
            r(d, l(p), y, T);
          }), d;
        }
        function _a(i, r, l) {
          r = Ar(r, i), i = wm(i, r);
          var d = i == null ? i : i[di(Jn(r))];
          return d == null ? n : Fn(d, i, l);
        }
        function Op(i) {
          return Mt(i) && un(i) == Re;
        }
        function w0(i) {
          return Mt(i) && un(i) == Fe;
        }
        function S0(i) {
          return Mt(i) && un(i) == be;
        }
        function Aa(i, r, l, d, p) {
          return i === r ? true : i == null || r == null || !Mt(i) && !Mt(r) ? i !== i && r !== r : b0(i, r, l, d, Aa, p);
        }
        function b0(i, r, l, d, p, y) {
          var T = Be(i), M = Be(r), R = T ? ft : tn(i), te = M ? ft : tn(r);
          R = R == Re ? w : R, te = te == Re ? w : te;
          var ne = R == w, ae = te == w, he = R == te;
          if (he && Tr(i)) {
            if (!Tr(r)) return false;
            T = true, ne = false;
          }
          if (he && !ne) return y || (y = new ui()), T || Bo(i) ? fm(i, r, l, d, p, y) : K0(i, r, R, l, d, p, y);
          if (!(l & E)) {
            var Ce = ne && lt.call(i, "__wrapped__"), Oe = ae && lt.call(r, "__wrapped__");
            if (Ce || Oe) {
              var Ve = Ce ? i.value() : i, De = Oe ? r.value() : r;
              return y || (y = new ui()), p(Ve, De, l, d, y);
            }
          }
          return he ? (y || (y = new ui()), Y0(i, r, l, d, p, y)) : false;
        }
        function _0(i) {
          return Mt(i) && tn(i) == Y;
        }
        function Gc(i, r, l, d) {
          var p = l.length, y = p, T = !d;
          if (i == null) return !y;
          for (i = gt(i); p--; ) {
            var M = l[p];
            if (T && M[2] ? M[1] !== i[M[0]] : !(M[0] in i)) return false;
          }
          for (; ++p < y; ) {
            M = l[p];
            var R = M[0], te = i[R], ne = M[1];
            if (T && M[2]) {
              if (te === n && !(R in i)) return false;
            } else {
              var ae = new ui();
              if (d) var he = d(te, ne, R, i, r, ae);
              if (!(he === n ? Aa(ne, te, E | L, d, ae) : he)) return false;
            }
          }
          return true;
        }
        function Pp(i) {
          if (!zt(i) || r_(i)) return false;
          var r = Vi(i) ? _b : Co;
          return r.test(qr(i));
        }
        function A0(i) {
          return Mt(i) && un(i) == N;
        }
        function C0(i) {
          return Mt(i) && tn(i) == de;
        }
        function T0(i) {
          return Mt(i) && hl(i.length) && !!_t[un(i)];
        }
        function Ip(i) {
          return typeof i == "function" ? i : i == null ? kn : typeof i == "object" ? Be(i) ? Np(i[0], i[1]) : Fp(i) : rh(i);
        }
        function Kc(i) {
          if (!Ea(i)) return zb(i);
          var r = [];
          for (var l in gt(i)) lt.call(i, l) && l != "constructor" && r.push(l);
          return r;
        }
        function E0(i) {
          if (!zt(i)) return l_(i);
          var r = Ea(i), l = [];
          for (var d in i) d == "constructor" && (r || !lt.call(i, d)) || l.push(d);
          return l;
        }
        function Yc(i, r) {
          return i < r;
        }
        function Rp(i, r) {
          var l = -1, d = Tn(i) ? V(i.length) : [];
          return br(i, function(p, y, T) {
            d[++l] = r(p, y, T);
          }), d;
        }
        function Fp(i) {
          var r = uu(i);
          return r.length == 1 && r[0][2] ? ym(r[0][0], r[0][1]) : function(l) {
            return l === i || Gc(l, i, r);
          };
        }
        function Np(i, r) {
          return fu(i) && gm(r) ? ym(di(i), r) : function(l) {
            var d = Au(l, i);
            return d === n && d === r ? Cu(l, i) : Aa(r, d, E | L);
          };
        }
        function Xs(i, r, l, d, p) {
          i !== r && Hc(r, function(y, T) {
            if (p || (p = new ui()), zt(y)) k0(i, r, T, l, Xs, d, p);
            else {
              var M = d ? d(mu(i, T), y, T + "", i, r, p) : n;
              M === n && (M = y), Uc(i, T, M);
            }
          }, En);
        }
        function k0(i, r, l, d, p, y, T) {
          var M = mu(i, l), R = mu(r, l), te = T.get(R);
          if (te) {
            Uc(i, l, te);
            return;
          }
          var ne = y ? y(M, R, l + "", i, r, T) : n, ae = ne === n;
          if (ae) {
            var he = Be(R), Ce = !he && Tr(R), Oe = !he && !Ce && Bo(R);
            ne = R, he || Ce || Oe ? Be(M) ? ne = M : It(M) ? ne = Cn(M) : Ce ? (ae = false, ne = Zp(R, true)) : Oe ? (ae = false, ne = Qp(R, true)) : ne = [] : za(R) || $r(R) ? (ne = M, $r(M) ? ne = Gm(M) : (!zt(M) || Vi(M)) && (ne = hm(R))) : ae = false;
          }
          ae && (T.set(R, ne), p(ne, R, d, y, T), T.delete(R)), Uc(i, l, ne);
        }
        function Wp(i, r) {
          var l = i.length;
          if (l) return r += r < 0 ? l : 0, Hi(r, l) ? i[r] : n;
        }
        function Bp(i, r, l) {
          r.length ? r = Tt(r, function(y) {
            return Be(y) ? function(T) {
              return Hr(T, y.length === 1 ? y[0] : y);
            } : y;
          }) : r = [kn];
          var d = -1;
          r = Tt(r, Wn(Le()));
          var p = Rp(i, function(y, T, M) {
            var R = Tt(r, function(te) {
              return te(y);
            });
            return { criteria: R, index: ++d, value: y };
          });
          return eb(p, function(y, T) {
            return B0(y, T, l);
          });
        }
        function z0(i, r) {
          return Up(i, r, function(l, d) {
            return Cu(i, d);
          });
        }
        function Up(i, r, l) {
          for (var d = -1, p = r.length, y = {}; ++d < p; ) {
            var T = r[d], M = Hr(i, T);
            l(M, T) && Ca(y, Ar(T, i), M);
          }
          return y;
        }
        function D0(i) {
          return function(r) {
            return Hr(r, i);
          };
        }
        function Zc(i, r, l, d) {
          var p = d ? XS : Do, y = -1, T = r.length, M = i;
          for (i === r && (r = Cn(r)), l && (M = Tt(i, Wn(l))); ++y < T; ) for (var R = 0, te = r[y], ne = l ? l(te) : te; (R = p(M, ne, R, d)) > -1; ) M !== i && Hs.call(M, R, 1), Hs.call(i, R, 1);
          return i;
        }
        function jp(i, r) {
          for (var l = i ? r.length : 0, d = l - 1; l--; ) {
            var p = r[l];
            if (l == d || p !== y) {
              var y = p;
              Hi(p) ? Hs.call(i, p, 1) : eu(i, p);
            }
          }
          return i;
        }
        function Qc(i, r) {
          return i + $s(_p() * (r - i + 1));
        }
        function M0(i, r, l, d) {
          for (var p = -1, y = Ut(qs((r - i) / (l || 1)), 0), T = V(y); y--; ) T[d ? y : ++p] = i, i += l;
          return T;
        }
        function Jc(i, r) {
          var l = "";
          if (!i || r < 1 || r > pe) return l;
          do
            r % 2 && (l += i), r = $s(r / 2), r && (i += i);
          while (r);
          return l;
        }
        function qe(i, r) {
          return hu(vm(i, r, kn), i + "");
        }
        function L0(i) {
          return Tp(Uo(i));
        }
        function x0(i, r) {
          var l = Uo(i);
          return cl(l, jr(r, 0, l.length));
        }
        function Ca(i, r, l, d) {
          if (!zt(i)) return i;
          r = Ar(r, i);
          for (var p = -1, y = r.length, T = y - 1, M = i; M != null && ++p < y; ) {
            var R = di(r[p]), te = l;
            if (R === "__proto__" || R === "constructor" || R === "prototype") return i;
            if (p != T) {
              var ne = M[R];
              te = d ? d(ne, R, M) : n, te === n && (te = zt(ne) ? ne : Hi(r[p + 1]) ? [] : {});
            }
            Sa(M, R, te), M = M[R];
          }
          return i;
        }
        var Hp = Gs ? function(i, r) {
          return Gs.set(i, r), i;
        } : kn, O0 = Vs ? function(i, r) {
          return Vs(i, "toString", { configurable: true, enumerable: false, value: Eu(r), writable: true });
        } : kn;
        function P0(i) {
          return cl(Uo(i));
        }
        function Qn(i, r, l) {
          var d = -1, p = i.length;
          r < 0 && (r = -r > p ? 0 : p + r), l = l > p ? p : l, l < 0 && (l += p), p = r > l ? 0 : l - r >>> 0, r >>>= 0;
          for (var y = V(p); ++d < p; ) y[d] = i[d + r];
          return y;
        }
        function I0(i, r) {
          var l;
          return br(i, function(d, p, y) {
            return l = r(d, p, y), !l;
          }), !!l;
        }
        function el(i, r, l) {
          var d = 0, p = i == null ? d : i.length;
          if (typeof r == "number" && r === r && p <= Me) {
            for (; d < p; ) {
              var y = d + p >>> 1, T = i[y];
              T !== null && !Un(T) && (l ? T <= r : T < r) ? d = y + 1 : p = y;
            }
            return p;
          }
          return Xc(i, r, kn, l);
        }
        function Xc(i, r, l, d) {
          var p = 0, y = i == null ? 0 : i.length;
          if (y === 0) return 0;
          r = l(r);
          for (var T = r !== r, M = r === null, R = Un(r), te = r === n; p < y; ) {
            var ne = $s((p + y) / 2), ae = l(i[ne]), he = ae !== n, Ce = ae === null, Oe = ae === ae, Ve = Un(ae);
            if (T) var De = d || Oe;
            else te ? De = Oe && (d || he) : M ? De = Oe && he && (d || !Ce) : R ? De = Oe && he && !Ce && (d || !Ve) : Ce || Ve ? De = false : De = d ? ae <= r : ae < r;
            De ? p = ne + 1 : y = ne;
          }
          return en(y, tt);
        }
        function Vp(i, r) {
          for (var l = -1, d = i.length, p = 0, y = []; ++l < d; ) {
            var T = i[l], M = r ? r(T) : T;
            if (!l || !fi(M, R)) {
              var R = M;
              y[p++] = T === 0 ? 0 : T;
            }
          }
          return y;
        }
        function qp(i) {
          return typeof i == "number" ? i : Un(i) ? Te : +i;
        }
        function Bn(i) {
          if (typeof i == "string") return i;
          if (Be(i)) return Tt(i, Bn) + "";
          if (Un(i)) return Ap ? Ap.call(i) : "";
          var r = i + "";
          return r == "0" && 1 / i == -ie ? "-0" : r;
        }
        function _r(i, r, l) {
          var d = -1, p = Os, y = i.length, T = true, M = [], R = M;
          if (l) T = false, p = zc;
          else if (y >= a) {
            var te = r ? null : $0(i);
            if (te) return Is(te);
            T = false, p = ma, R = new Ur();
          } else R = r ? [] : M;
          e: for (; ++d < y; ) {
            var ne = i[d], ae = r ? r(ne) : ne;
            if (ne = l || ne !== 0 ? ne : 0, T && ae === ae) {
              for (var he = R.length; he--; ) if (R[he] === ae) continue e;
              r && R.push(ae), M.push(ne);
            } else p(R, ae, l) || (R !== M && R.push(ae), M.push(ne));
          }
          return M;
        }
        function eu(i, r) {
          r = Ar(r, i);
          var l = -1, d = r.length;
          if (!d) return true;
          for (; ++l < d; ) {
            var p = di(r[l]);
            if (p === "__proto__" && !lt.call(i, "__proto__") || (p === "constructor" || p === "prototype") && l < d - 1) return false;
          }
          var y = wm(i, r);
          return y == null || delete y[di(Jn(r))];
        }
        function $p(i, r, l, d) {
          return Ca(i, r, l(Hr(i, r)), d);
        }
        function tl(i, r, l, d) {
          for (var p = i.length, y = d ? p : -1; (d ? y-- : ++y < p) && r(i[y], y, i); ) ;
          return l ? Qn(i, d ? 0 : y, d ? y + 1 : p) : Qn(i, d ? y + 1 : 0, d ? p : y);
        }
        function Gp(i, r) {
          var l = i;
          return l instanceof Ye && (l = l.value()), Dc(r, function(d, p) {
            return p.func.apply(p.thisArg, vr([d], p.args));
          }, l);
        }
        function tu(i, r, l) {
          var d = i.length;
          if (d < 2) return d ? _r(i[0]) : [];
          for (var p = -1, y = V(d); ++p < d; ) for (var T = i[p], M = -1; ++M < d; ) M != p && (y[p] = ba(y[p] || T, i[M], r, l));
          return _r(Zt(y, 1), r, l);
        }
        function Kp(i, r, l) {
          for (var d = -1, p = i.length, y = r.length, T = {}; ++d < p; ) {
            var M = d < y ? r[d] : n;
            l(T, i[d], M);
          }
          return T;
        }
        function nu(i) {
          return It(i) ? i : [];
        }
        function iu(i) {
          return typeof i == "function" ? i : kn;
        }
        function Ar(i, r) {
          return Be(i) ? i : fu(i, r) ? [i] : Am(ct(i));
        }
        var R0 = qe;
        function Cr(i, r, l) {
          var d = i.length;
          return l = l === n ? d : l, !r && l >= d ? i : Qn(i, r, l);
        }
        var Yp = Ab || function(i) {
          return Yt.clearTimeout(i);
        };
        function Zp(i, r) {
          if (r) return i.slice();
          var l = i.length, d = yp ? yp(l) : new i.constructor(l);
          return i.copy(d), d;
        }
        function ru(i) {
          var r = new i.constructor(i.byteLength);
          return new Us(r).set(new Us(i)), r;
        }
        function F0(i, r) {
          var l = r ? ru(i.buffer) : i.buffer;
          return new i.constructor(l, i.byteOffset, i.byteLength);
        }
        function N0(i) {
          var r = new i.constructor(i.source, _o.exec(i));
          return r.lastIndex = i.lastIndex, r;
        }
        function W0(i) {
          return wa ? gt(wa.call(i)) : {};
        }
        function Qp(i, r) {
          var l = r ? ru(i.buffer) : i.buffer;
          return new i.constructor(l, i.byteOffset, i.length);
        }
        function Jp(i, r) {
          if (i !== r) {
            var l = i !== n, d = i === null, p = i === i, y = Un(i), T = r !== n, M = r === null, R = r === r, te = Un(r);
            if (!M && !te && !y && i > r || y && T && R && !M && !te || d && T && R || !l && R || !p) return 1;
            if (!d && !y && !te && i < r || te && l && p && !d && !y || M && l && p || !T && p || !R) return -1;
          }
          return 0;
        }
        function B0(i, r, l) {
          for (var d = -1, p = i.criteria, y = r.criteria, T = p.length, M = l.length; ++d < T; ) {
            var R = Jp(p[d], y[d]);
            if (R) {
              if (d >= M) return R;
              var te = l[d];
              return R * (te == "desc" ? -1 : 1);
            }
          }
          return i.index - r.index;
        }
        function Xp(i, r, l, d) {
          for (var p = -1, y = i.length, T = l.length, M = -1, R = r.length, te = Ut(y - T, 0), ne = V(R + te), ae = !d; ++M < R; ) ne[M] = r[M];
          for (; ++p < T; ) (ae || p < y) && (ne[l[p]] = i[p]);
          for (; te--; ) ne[M++] = i[p++];
          return ne;
        }
        function em(i, r, l, d) {
          for (var p = -1, y = i.length, T = -1, M = l.length, R = -1, te = r.length, ne = Ut(y - M, 0), ae = V(ne + te), he = !d; ++p < ne; ) ae[p] = i[p];
          for (var Ce = p; ++R < te; ) ae[Ce + R] = r[R];
          for (; ++T < M; ) (he || p < y) && (ae[Ce + l[T]] = i[p++]);
          return ae;
        }
        function Cn(i, r) {
          var l = -1, d = i.length;
          for (r || (r = V(d)); ++l < d; ) r[l] = i[l];
          return r;
        }
        function Ei(i, r, l, d) {
          var p = !l;
          l || (l = {});
          for (var y = -1, T = r.length; ++y < T; ) {
            var M = r[y], R = d ? d(l[M], i[M], M, l, i) : n;
            R === n && (R = i[M]), p ? Ci(l, M, R) : Sa(l, M, R);
          }
          return l;
        }
        function U0(i, r) {
          return Ei(i, du(i), r);
        }
        function j0(i, r) {
          return Ei(i, pm(i), r);
        }
        function nl(i, r) {
          return function(l, d) {
            var p = Be(l) ? GS : u0, y = r ? r() : {};
            return p(l, i, Le(d, 2), y);
          };
        }
        function Fo(i) {
          return qe(function(r, l) {
            var d = -1, p = l.length, y = p > 1 ? l[p - 1] : n, T = p > 2 ? l[2] : n;
            for (y = i.length > 3 && typeof y == "function" ? (p--, y) : n, T && dn(l[0], l[1], T) && (y = p < 3 ? n : y, p = 1), r = gt(r); ++d < p; ) {
              var M = l[d];
              M && i(r, M, d, y);
            }
            return r;
          });
        }
        function tm(i, r) {
          return function(l, d) {
            if (l == null) return l;
            if (!Tn(l)) return i(l, d);
            for (var p = l.length, y = r ? p : -1, T = gt(l); (r ? y-- : ++y < p) && d(T[y], y, T) !== false; ) ;
            return l;
          };
        }
        function nm(i) {
          return function(r, l, d) {
            for (var p = -1, y = gt(r), T = d(r), M = T.length; M--; ) {
              var R = T[i ? M : ++p];
              if (l(y[R], R, y) === false) break;
            }
            return r;
          };
        }
        function H0(i, r, l) {
          var d = r & b, p = Ta(i);
          function y() {
            var T = this && this !== Yt && this instanceof y ? p : i;
            return T.apply(d ? l : this, arguments);
          }
          return y;
        }
        function im(i) {
          return function(r) {
            r = ct(r);
            var l = Mo(r) ? ci(r) : n, d = l ? l[0] : r.charAt(0), p = l ? Cr(l, 1).join("") : r.slice(1);
            return d[i]() + p;
          };
        }
        function No(i) {
          return function(r) {
            return Dc(nh(th(r).replace(OS, "")), i, "");
          };
        }
        function Ta(i) {
          return function() {
            var r = arguments;
            switch (r.length) {
              case 0:
                return new i();
              case 1:
                return new i(r[0]);
              case 2:
                return new i(r[0], r[1]);
              case 3:
                return new i(r[0], r[1], r[2]);
              case 4:
                return new i(r[0], r[1], r[2], r[3]);
              case 5:
                return new i(r[0], r[1], r[2], r[3], r[4]);
              case 6:
                return new i(r[0], r[1], r[2], r[3], r[4], r[5]);
              case 7:
                return new i(r[0], r[1], r[2], r[3], r[4], r[5], r[6]);
            }
            var l = Ro(i.prototype), d = i.apply(l, r);
            return zt(d) ? d : l;
          };
        }
        function V0(i, r, l) {
          var d = Ta(i);
          function p() {
            for (var y = arguments.length, T = V(y), M = y, R = Wo(p); M--; ) T[M] = arguments[M];
            var te = y < 3 && T[0] !== R && T[y - 1] !== R ? [] : wr(T, R);
            if (y -= te.length, y < l) return lm(i, r, il, p.placeholder, n, T, te, n, n, l - y);
            var ne = this && this !== Yt && this instanceof p ? d : i;
            return Fn(ne, this, T);
          }
          return p;
        }
        function rm(i) {
          return function(r, l, d) {
            var p = gt(r);
            if (!Tn(r)) {
              var y = Le(l, 3);
              r = $t(r), l = function(M) {
                return y(p[M], M, p);
              };
            }
            var T = i(r, l, d);
            return T > -1 ? p[y ? r[T] : T] : n;
          };
        }
        function om(i) {
          return ji(function(r) {
            var l = r.length, d = l, p = Yn.prototype.thru;
            for (i && r.reverse(); d--; ) {
              var y = r[d];
              if (typeof y != "function") throw new Kn(c);
              if (p && !T && sl(y) == "wrapper") var T = new Yn([], true);
            }
            for (d = T ? d : l; ++d < l; ) {
              y = r[d];
              var M = sl(y), R = M == "wrapper" ? cu(y) : n;
              R && pu(R[0]) && R[1] == (ue | k | $ | ee) && !R[4].length && R[9] == 1 ? T = T[sl(R[0])].apply(T, R[3]) : T = y.length == 1 && pu(y) ? T[M]() : T.thru(y);
            }
            return function() {
              var te = arguments, ne = te[0];
              if (T && te.length == 1 && Be(ne)) return T.plant(ne).value();
              for (var ae = 0, he = l ? r[ae].apply(this, te) : ne; ++ae < l; ) he = r[ae].call(this, he);
              return he;
            };
          });
        }
        function il(i, r, l, d, p, y, T, M, R, te) {
          var ne = r & ue, ae = r & b, he = r & P, Ce = r & (k | j), Oe = r & se, Ve = he ? n : Ta(i);
          function De() {
            for (var Ge = arguments.length, Ze = V(Ge), jn = Ge; jn--; ) Ze[jn] = arguments[jn];
            if (Ce) var fn = Wo(De), Hn = nb(Ze, fn);
            if (d && (Ze = Xp(Ze, d, p, Ce)), y && (Ze = em(Ze, y, T, Ce)), Ge -= Hn, Ce && Ge < te) {
              var Rt = wr(Ze, fn);
              return lm(i, r, il, De.placeholder, l, Ze, Rt, M, R, te - Ge);
            }
            var pi = ae ? l : this, $i = he ? pi[i] : i;
            return Ge = Ze.length, M ? Ze = u_(Ze, M) : Oe && Ge > 1 && Ze.reverse(), ne && R < Ge && (Ze.length = R), this && this !== Yt && this instanceof De && ($i = Ve || Ta($i)), $i.apply(pi, Ze);
          }
          return De;
        }
        function am(i, r) {
          return function(l, d) {
            return v0(l, i, r(d), {});
          };
        }
        function rl(i, r) {
          return function(l, d) {
            var p;
            if (l === n && d === n) return r;
            if (l !== n && (p = l), d !== n) {
              if (p === n) return d;
              typeof l == "string" || typeof d == "string" ? (l = Bn(l), d = Bn(d)) : (l = qp(l), d = qp(d)), p = i(l, d);
            }
            return p;
          };
        }
        function ou(i) {
          return ji(function(r) {
            return r = Tt(r, Wn(Le())), qe(function(l) {
              var d = this;
              return i(r, function(p) {
                return Fn(p, d, l);
              });
            });
          });
        }
        function ol(i, r) {
          r = r === n ? " " : Bn(r);
          var l = r.length;
          if (l < 2) return l ? Jc(r, i) : r;
          var d = Jc(r, qs(i / Lo(r)));
          return Mo(r) ? Cr(ci(d), 0, i).join("") : d.slice(0, i);
        }
        function q0(i, r, l, d) {
          var p = r & b, y = Ta(i);
          function T() {
            for (var M = -1, R = arguments.length, te = -1, ne = d.length, ae = V(ne + R), he = this && this !== Yt && this instanceof T ? y : i; ++te < ne; ) ae[te] = d[te];
            for (; R--; ) ae[te++] = arguments[++M];
            return Fn(he, p ? l : this, ae);
          }
          return T;
        }
        function sm(i) {
          return function(r, l, d) {
            return d && typeof d != "number" && dn(r, l, d) && (l = d = n), r = qi(r), l === n ? (l = r, r = 0) : l = qi(l), d = d === n ? r < l ? 1 : -1 : qi(d), M0(r, l, d, i);
          };
        }
        function al(i) {
          return function(r, l) {
            return typeof r == "string" && typeof l == "string" || (r = Xn(r), l = Xn(l)), i(r, l);
          };
        }
        function lm(i, r, l, d, p, y, T, M, R, te) {
          var ne = r & k, ae = ne ? T : n, he = ne ? n : T, Ce = ne ? y : n, Oe = ne ? n : y;
          r |= ne ? $ : q, r &= ~(ne ? q : $), r & B || (r &= -4);
          var Ve = [i, r, p, Ce, ae, Oe, he, M, R, te], De = l.apply(n, Ve);
          return pu(i) && Sm(De, Ve), De.placeholder = d, bm(De, i, r);
        }
        function au(i) {
          var r = Bt[i];
          return function(l, d) {
            if (l = Xn(l), d = d == null ? 0 : en(je(d), 292), d && bp(l)) {
              var p = (ct(l) + "e").split("e"), y = r(p[0] + "e" + (+p[1] + d));
              return p = (ct(y) + "e").split("e"), +(p[0] + "e" + (+p[1] - d));
            }
            return r(l);
          };
        }
        var $0 = Po && 1 / Is(new Po([, -0]))[1] == ie ? function(i) {
          return new Po(i);
        } : Du;
        function cm(i) {
          return function(r) {
            var l = tn(r);
            return l == Y ? Rc(r) : l == de ? cb(r) : tb(r, i(r));
          };
        }
        function Ui(i, r, l, d, p, y, T, M) {
          var R = r & P;
          if (!R && typeof i != "function") throw new Kn(c);
          var te = d ? d.length : 0;
          if (te || (r &= -97, d = p = n), T = T === n ? T : Ut(je(T), 0), M = M === n ? M : je(M), te -= p ? p.length : 0, r & q) {
            var ne = d, ae = p;
            d = p = n;
          }
          var he = R ? n : cu(i), Ce = [i, r, l, d, p, ne, ae, y, T, M];
          if (he && s_(Ce, he), i = Ce[0], r = Ce[1], l = Ce[2], d = Ce[3], p = Ce[4], M = Ce[9] = Ce[9] === n ? R ? 0 : i.length : Ut(Ce[9] - te, 0), !M && r & (k | j) && (r &= -25), !r || r == b) var Oe = H0(i, r, l);
          else r == k || r == j ? Oe = V0(i, r, M) : (r == $ || r == (b | $)) && !p.length ? Oe = q0(i, r, l, d) : Oe = il.apply(n, Ce);
          var Ve = he ? Hp : Sm;
          return bm(Ve(Oe, Ce), i, r);
        }
        function um(i, r, l, d) {
          return i === n || fi(i, Oo[l]) && !lt.call(d, l) ? r : i;
        }
        function dm(i, r, l, d, p, y) {
          return zt(i) && zt(r) && (y.set(r, i), Xs(i, r, n, dm, y), y.delete(r)), i;
        }
        function G0(i) {
          return za(i) ? n : i;
        }
        function fm(i, r, l, d, p, y) {
          var T = l & E, M = i.length, R = r.length;
          if (M != R && !(T && R > M)) return false;
          var te = y.get(i), ne = y.get(r);
          if (te && ne) return te == r && ne == i;
          var ae = -1, he = true, Ce = l & L ? new Ur() : n;
          for (y.set(i, r), y.set(r, i); ++ae < M; ) {
            var Oe = i[ae], Ve = r[ae];
            if (d) var De = T ? d(Ve, Oe, ae, r, i, y) : d(Oe, Ve, ae, i, r, y);
            if (De !== n) {
              if (De) continue;
              he = false;
              break;
            }
            if (Ce) {
              if (!Mc(r, function(Ge, Ze) {
                if (!ma(Ce, Ze) && (Oe === Ge || p(Oe, Ge, l, d, y))) return Ce.push(Ze);
              })) {
                he = false;
                break;
              }
            } else if (!(Oe === Ve || p(Oe, Ve, l, d, y))) {
              he = false;
              break;
            }
          }
          return y.delete(i), y.delete(r), he;
        }
        function K0(i, r, l, d, p, y, T) {
          switch (l) {
            case Ke:
              if (i.byteLength != r.byteLength || i.byteOffset != r.byteOffset) return false;
              i = i.buffer, r = r.buffer;
            case Fe:
              return !(i.byteLength != r.byteLength || !y(new Us(i), new Us(r)));
            case pt:
            case be:
            case J:
              return fi(+i, +r);
            case _:
              return i.name == r.name && i.message == r.message;
            case N:
            case Z:
              return i == r + "";
            case Y:
              var M = Rc;
            case de:
              var R = d & E;
              if (M || (M = Is), i.size != r.size && !R) return false;
              var te = T.get(i);
              if (te) return te == r;
              d |= L, T.set(i, r);
              var ne = fm(M(i), M(r), d, p, y, T);
              return T.delete(i), ne;
            case O:
              if (wa) return wa.call(i) == wa.call(r);
          }
          return false;
        }
        function Y0(i, r, l, d, p, y) {
          var T = l & E, M = su(i), R = M.length, te = su(r), ne = te.length;
          if (R != ne && !T) return false;
          for (var ae = R; ae--; ) {
            var he = M[ae];
            if (!(T ? he in r : lt.call(r, he))) return false;
          }
          var Ce = y.get(i), Oe = y.get(r);
          if (Ce && Oe) return Ce == r && Oe == i;
          var Ve = true;
          y.set(i, r), y.set(r, i);
          for (var De = T; ++ae < R; ) {
            he = M[ae];
            var Ge = i[he], Ze = r[he];
            if (d) var jn = T ? d(Ze, Ge, he, r, i, y) : d(Ge, Ze, he, i, r, y);
            if (!(jn === n ? Ge === Ze || p(Ge, Ze, l, d, y) : jn)) {
              Ve = false;
              break;
            }
            De || (De = he == "constructor");
          }
          if (Ve && !De) {
            var fn = i.constructor, Hn = r.constructor;
            fn != Hn && "constructor" in i && "constructor" in r && !(typeof fn == "function" && fn instanceof fn && typeof Hn == "function" && Hn instanceof Hn) && (Ve = false);
          }
          return y.delete(i), y.delete(r), Ve;
        }
        function ji(i) {
          return hu(vm(i, n, km), i + "");
        }
        function su(i) {
          return xp(i, $t, du);
        }
        function lu(i) {
          return xp(i, En, pm);
        }
        var cu = Gs ? function(i) {
          return Gs.get(i);
        } : Du;
        function sl(i) {
          for (var r = i.name + "", l = Io[r], d = lt.call(Io, r) ? l.length : 0; d--; ) {
            var p = l[d], y = p.func;
            if (y == null || y == i) return p.name;
          }
          return r;
        }
        function Wo(i) {
          var r = lt.call(g, "placeholder") ? g : i;
          return r.placeholder;
        }
        function Le() {
          var i = g.iteratee || ku;
          return i = i === ku ? Ip : i, arguments.length ? i(arguments[0], arguments[1]) : i;
        }
        function ll(i, r) {
          var l = i.__data__;
          return i_(r) ? l[typeof r == "string" ? "string" : "hash"] : l.map;
        }
        function uu(i) {
          for (var r = $t(i), l = r.length; l--; ) {
            var d = r[l], p = i[d];
            r[l] = [d, p, gm(p)];
          }
          return r;
        }
        function Vr(i, r) {
          var l = ab(i, r);
          return Pp(l) ? l : n;
        }
        function Z0(i) {
          var r = lt.call(i, Wr), l = i[Wr];
          try {
            i[Wr] = n;
            var d = true;
          } catch {
          }
          var p = Ws.call(i);
          return d && (r ? i[Wr] = l : delete i[Wr]), p;
        }
        var du = Nc ? function(i) {
          return i == null ? [] : (i = gt(i), yr(Nc(i), function(r) {
            return wp.call(i, r);
          }));
        } : Mu, pm = Nc ? function(i) {
          for (var r = []; i; ) vr(r, du(i)), i = js(i);
          return r;
        } : Mu, tn = un;
        (Wc && tn(new Wc(new ArrayBuffer(1))) != Ke || ga && tn(new ga()) != Y || Bc && tn(Bc.resolve()) != S || Po && tn(new Po()) != de || ya && tn(new ya()) != ge) && (tn = function(i) {
          var r = un(i), l = r == w ? i.constructor : n, d = l ? qr(l) : "";
          if (d) switch (d) {
            case xb:
              return Ke;
            case Ob:
              return Y;
            case Pb:
              return S;
            case Ib:
              return de;
            case Rb:
              return ge;
          }
          return r;
        });
        function Q0(i, r, l) {
          for (var d = -1, p = l.length; ++d < p; ) {
            var y = l[d], T = y.size;
            switch (y.type) {
              case "drop":
                i += T;
                break;
              case "dropRight":
                r -= T;
                break;
              case "take":
                r = en(r, i + T);
                break;
              case "takeRight":
                i = Ut(i, r - T);
                break;
            }
          }
          return { start: i, end: r };
        }
        function J0(i) {
          var r = i.match(Ts);
          return r ? r[1].split(bc) : [];
        }
        function mm(i, r, l) {
          r = Ar(r, i);
          for (var d = -1, p = r.length, y = false; ++d < p; ) {
            var T = di(r[d]);
            if (!(y = i != null && l(i, T))) break;
            i = i[T];
          }
          return y || ++d != p ? y : (p = i == null ? 0 : i.length, !!p && hl(p) && Hi(T, p) && (Be(i) || $r(i)));
        }
        function X0(i) {
          var r = i.length, l = new i.constructor(r);
          return r && typeof i[0] == "string" && lt.call(i, "index") && (l.index = i.index, l.input = i.input), l;
        }
        function hm(i) {
          return typeof i.constructor == "function" && !Ea(i) ? Ro(js(i)) : {};
        }
        function e_(i, r, l) {
          var d = i.constructor;
          switch (r) {
            case Fe:
              return ru(i);
            case pt:
            case be:
              return new d(+i);
            case Ke:
              return F0(i, l);
            case Qe:
            case Et:
            case vt:
            case In:
            case Fi:
            case Nt:
            case qt:
            case Ni:
            case si:
              return Qp(i, l);
            case Y:
              return new d();
            case J:
            case Z:
              return new d(i);
            case N:
              return N0(i);
            case de:
              return new d();
            case O:
              return W0(i);
          }
        }
        function t_(i, r) {
          var l = r.length;
          if (!l) return i;
          var d = l - 1;
          return r[d] = (l > 1 ? "& " : "") + r[d], r = r.join(l > 2 ? ", " : " "), i.replace(Cs, `{
/* [wrapped with ` + r + `] */
`);
        }
        function n_(i) {
          return Be(i) || $r(i) || !!(Sp && i && i[Sp]);
        }
        function Hi(i, r) {
          var l = typeof i;
          return r = r ?? pe, !!r && (l == "number" || l != "symbol" && zs.test(i)) && i > -1 && i % 1 == 0 && i < r;
        }
        function dn(i, r, l) {
          if (!zt(l)) return false;
          var d = typeof r;
          return (d == "number" ? Tn(l) && Hi(r, l.length) : d == "string" && r in l) ? fi(l[r], i) : false;
        }
        function fu(i, r) {
          if (Be(i)) return false;
          var l = typeof i;
          return l == "number" || l == "symbol" || l == "boolean" || i == null || Un(i) ? true : wc.test(i) || !vc.test(i) || r != null && i in gt(r);
        }
        function i_(i) {
          var r = typeof i;
          return r == "string" || r == "number" || r == "symbol" || r == "boolean" ? i !== "__proto__" : i === null;
        }
        function pu(i) {
          var r = sl(i), l = g[r];
          if (typeof l != "function" || !(r in Ye.prototype)) return false;
          if (i === l) return true;
          var d = cu(l);
          return !!d && i === d[0];
        }
        function r_(i) {
          return !!gp && gp in i;
        }
        var o_ = Fs ? Vi : Lu;
        function Ea(i) {
          var r = i && i.constructor, l = typeof r == "function" && r.prototype || Oo;
          return i === l;
        }
        function gm(i) {
          return i === i && !zt(i);
        }
        function ym(i, r) {
          return function(l) {
            return l == null ? false : l[i] === r && (r !== n || i in gt(l));
          };
        }
        function a_(i) {
          var r = pl(i, function(d) {
            return l.size === h && l.clear(), d;
          }), l = r.cache;
          return r;
        }
        function s_(i, r) {
          var l = i[1], d = r[1], p = l | d, y = p < (b | P | ue), T = d == ue && l == k || d == ue && l == ee && i[7].length <= r[8] || d == (ue | ee) && r[7].length <= r[8] && l == k;
          if (!(y || T)) return i;
          d & b && (i[2] = r[2], p |= l & b ? 0 : B);
          var M = r[3];
          if (M) {
            var R = i[3];
            i[3] = R ? Xp(R, M, r[4]) : M, i[4] = R ? wr(i[3], v) : r[4];
          }
          return M = r[5], M && (R = i[5], i[5] = R ? em(R, M, r[6]) : M, i[6] = R ? wr(i[5], v) : r[6]), M = r[7], M && (i[7] = M), d & ue && (i[8] = i[8] == null ? r[8] : en(i[8], r[8])), i[9] == null && (i[9] = r[9]), i[0] = r[0], i[1] = p, i;
        }
        function l_(i) {
          var r = [];
          if (i != null) for (var l in gt(i)) r.push(l);
          return r;
        }
        function c_(i) {
          return Ws.call(i);
        }
        function vm(i, r, l) {
          return r = Ut(r === n ? i.length - 1 : r, 0), function() {
            for (var d = arguments, p = -1, y = Ut(d.length - r, 0), T = V(y); ++p < y; ) T[p] = d[r + p];
            p = -1;
            for (var M = V(r + 1); ++p < r; ) M[p] = d[p];
            return M[r] = l(T), Fn(i, this, M);
          };
        }
        function wm(i, r) {
          return r.length < 2 ? i : Hr(i, Qn(r, 0, -1));
        }
        function u_(i, r) {
          for (var l = i.length, d = en(r.length, l), p = Cn(i); d--; ) {
            var y = r[d];
            i[d] = Hi(y, l) ? p[y] : n;
          }
          return i;
        }
        function mu(i, r) {
          if (!(r === "constructor" && typeof i[r] == "function") && r != "__proto__") return i[r];
        }
        var Sm = _m(Hp), ka = Tb || function(i, r) {
          return Yt.setTimeout(i, r);
        }, hu = _m(O0);
        function bm(i, r, l) {
          var d = r + "";
          return hu(i, t_(d, d_(J0(d), l)));
        }
        function _m(i) {
          var r = 0, l = 0;
          return function() {
            var d = Db(), p = fe - (d - l);
            if (l = d, p > 0) {
              if (++r >= Ee) return arguments[0];
            } else r = 0;
            return i.apply(n, arguments);
          };
        }
        function cl(i, r) {
          var l = -1, d = i.length, p = d - 1;
          for (r = r === n ? d : r; ++l < r; ) {
            var y = Qc(l, p), T = i[y];
            i[y] = i[l], i[l] = T;
          }
          return i.length = r, i;
        }
        var Am = a_(function(i) {
          var r = [];
          return i.charCodeAt(0) === 46 && r.push(""), i.replace(kt, function(l, d, p, y) {
            r.push(p ? y.replace(Es, "$1") : d || l);
          }), r;
        });
        function di(i) {
          if (typeof i == "string" || Un(i)) return i;
          var r = i + "";
          return r == "0" && 1 / i == -ie ? "-0" : r;
        }
        function qr(i) {
          if (i != null) {
            try {
              return Ns.call(i);
            } catch {
            }
            try {
              return i + "";
            } catch {
            }
          }
          return "";
        }
        function d_(i, r) {
          return Nn(it, function(l) {
            var d = "_." + l[0];
            r & l[1] && !Os(i, d) && i.push(d);
          }), i.sort();
        }
        function Cm(i) {
          if (i instanceof Ye) return i.clone();
          var r = new Yn(i.__wrapped__, i.__chain__);
          return r.__actions__ = Cn(i.__actions__), r.__index__ = i.__index__, r.__values__ = i.__values__, r;
        }
        function f_(i, r, l) {
          (l ? dn(i, r, l) : r === n) ? r = 1 : r = Ut(je(r), 0);
          var d = i == null ? 0 : i.length;
          if (!d || r < 1) return [];
          for (var p = 0, y = 0, T = V(qs(d / r)); p < d; ) T[y++] = Qn(i, p, p += r);
          return T;
        }
        function p_(i) {
          for (var r = -1, l = i == null ? 0 : i.length, d = 0, p = []; ++r < l; ) {
            var y = i[r];
            y && (p[d++] = y);
          }
          return p;
        }
        function m_() {
          var i = arguments.length;
          if (!i) return [];
          for (var r = V(i - 1), l = arguments[0], d = i; d--; ) r[d - 1] = arguments[d];
          return vr(Be(l) ? Cn(l) : [l], Zt(r, 1));
        }
        var h_ = qe(function(i, r) {
          return It(i) ? ba(i, Zt(r, 1, It, true)) : [];
        }), g_ = qe(function(i, r) {
          var l = Jn(r);
          return It(l) && (l = n), It(i) ? ba(i, Zt(r, 1, It, true), Le(l, 2)) : [];
        }), y_ = qe(function(i, r) {
          var l = Jn(r);
          return It(l) && (l = n), It(i) ? ba(i, Zt(r, 1, It, true), n, l) : [];
        });
        function v_(i, r, l) {
          var d = i == null ? 0 : i.length;
          return d ? (r = l || r === n ? 1 : je(r), Qn(i, r < 0 ? 0 : r, d)) : [];
        }
        function w_(i, r, l) {
          var d = i == null ? 0 : i.length;
          return d ? (r = l || r === n ? 1 : je(r), r = d - r, Qn(i, 0, r < 0 ? 0 : r)) : [];
        }
        function S_(i, r) {
          return i && i.length ? tl(i, Le(r, 3), true, true) : [];
        }
        function b_(i, r) {
          return i && i.length ? tl(i, Le(r, 3), true) : [];
        }
        function __(i, r, l, d) {
          var p = i == null ? 0 : i.length;
          return p ? (l && typeof l != "number" && dn(i, r, l) && (l = 0, d = p), m0(i, r, l, d)) : [];
        }
        function Tm(i, r, l) {
          var d = i == null ? 0 : i.length;
          if (!d) return -1;
          var p = l == null ? 0 : je(l);
          return p < 0 && (p = Ut(d + p, 0)), Ps(i, Le(r, 3), p);
        }
        function Em(i, r, l) {
          var d = i == null ? 0 : i.length;
          if (!d) return -1;
          var p = d - 1;
          return l !== n && (p = je(l), p = l < 0 ? Ut(d + p, 0) : en(p, d - 1)), Ps(i, Le(r, 3), p, true);
        }
        function km(i) {
          var r = i == null ? 0 : i.length;
          return r ? Zt(i, 1) : [];
        }
        function A_(i) {
          var r = i == null ? 0 : i.length;
          return r ? Zt(i, ie) : [];
        }
        function C_(i, r) {
          var l = i == null ? 0 : i.length;
          return l ? (r = r === n ? 1 : je(r), Zt(i, r)) : [];
        }
        function T_(i) {
          for (var r = -1, l = i == null ? 0 : i.length, d = {}; ++r < l; ) {
            var p = i[r];
            Ci(d, p[0], p[1]);
          }
          return d;
        }
        function zm(i) {
          return i && i.length ? i[0] : n;
        }
        function E_(i, r, l) {
          var d = i == null ? 0 : i.length;
          if (!d) return -1;
          var p = l == null ? 0 : je(l);
          return p < 0 && (p = Ut(d + p, 0)), Do(i, r, p);
        }
        function k_(i) {
          var r = i == null ? 0 : i.length;
          return r ? Qn(i, 0, -1) : [];
        }
        var z_ = qe(function(i) {
          var r = Tt(i, nu);
          return r.length && r[0] === i[0] ? $c(r) : [];
        }), D_ = qe(function(i) {
          var r = Jn(i), l = Tt(i, nu);
          return r === Jn(l) ? r = n : l.pop(), l.length && l[0] === i[0] ? $c(l, Le(r, 2)) : [];
        }), M_ = qe(function(i) {
          var r = Jn(i), l = Tt(i, nu);
          return r = typeof r == "function" ? r : n, r && l.pop(), l.length && l[0] === i[0] ? $c(l, n, r) : [];
        });
        function L_(i, r) {
          return i == null ? "" : kb.call(i, r);
        }
        function Jn(i) {
          var r = i == null ? 0 : i.length;
          return r ? i[r - 1] : n;
        }
        function x_(i, r, l) {
          var d = i == null ? 0 : i.length;
          if (!d) return -1;
          var p = d;
          return l !== n && (p = je(l), p = p < 0 ? Ut(d + p, 0) : en(p, d - 1)), r === r ? db(i, r, p) : Ps(i, lp, p, true);
        }
        function O_(i, r) {
          return i && i.length ? Wp(i, je(r)) : n;
        }
        var P_ = qe(Dm);
        function Dm(i, r) {
          return i && i.length && r && r.length ? Zc(i, r) : i;
        }
        function I_(i, r, l) {
          return i && i.length && r && r.length ? Zc(i, r, Le(l, 2)) : i;
        }
        function R_(i, r, l) {
          return i && i.length && r && r.length ? Zc(i, r, n, l) : i;
        }
        var F_ = ji(function(i, r) {
          var l = i == null ? 0 : i.length, d = jc(i, r);
          return jp(i, Tt(r, function(p) {
            return Hi(p, l) ? +p : p;
          }).sort(Jp)), d;
        });
        function N_(i, r) {
          var l = [];
          if (!(i && i.length)) return l;
          var d = -1, p = [], y = i.length;
          for (r = Le(r, 3); ++d < y; ) {
            var T = i[d];
            r(T, d, i) && (l.push(T), p.push(d));
          }
          return jp(i, p), l;
        }
        function gu(i) {
          return i == null ? i : Lb.call(i);
        }
        function W_(i, r, l) {
          var d = i == null ? 0 : i.length;
          return d ? (l && typeof l != "number" && dn(i, r, l) ? (r = 0, l = d) : (r = r == null ? 0 : je(r), l = l === n ? d : je(l)), Qn(i, r, l)) : [];
        }
        function B_(i, r) {
          return el(i, r);
        }
        function U_(i, r, l) {
          return Xc(i, r, Le(l, 2));
        }
        function j_(i, r) {
          var l = i == null ? 0 : i.length;
          if (l) {
            var d = el(i, r);
            if (d < l && fi(i[d], r)) return d;
          }
          return -1;
        }
        function H_(i, r) {
          return el(i, r, true);
        }
        function V_(i, r, l) {
          return Xc(i, r, Le(l, 2), true);
        }
        function q_(i, r) {
          var l = i == null ? 0 : i.length;
          if (l) {
            var d = el(i, r, true) - 1;
            if (fi(i[d], r)) return d;
          }
          return -1;
        }
        function $_(i) {
          return i && i.length ? Vp(i) : [];
        }
        function G_(i, r) {
          return i && i.length ? Vp(i, Le(r, 2)) : [];
        }
        function K_(i) {
          var r = i == null ? 0 : i.length;
          return r ? Qn(i, 1, r) : [];
        }
        function Y_(i, r, l) {
          return i && i.length ? (r = l || r === n ? 1 : je(r), Qn(i, 0, r < 0 ? 0 : r)) : [];
        }
        function Z_(i, r, l) {
          var d = i == null ? 0 : i.length;
          return d ? (r = l || r === n ? 1 : je(r), r = d - r, Qn(i, r < 0 ? 0 : r, d)) : [];
        }
        function Q_(i, r) {
          return i && i.length ? tl(i, Le(r, 3), false, true) : [];
        }
        function J_(i, r) {
          return i && i.length ? tl(i, Le(r, 3)) : [];
        }
        var X_ = qe(function(i) {
          return _r(Zt(i, 1, It, true));
        }), e1 = qe(function(i) {
          var r = Jn(i);
          return It(r) && (r = n), _r(Zt(i, 1, It, true), Le(r, 2));
        }), t1 = qe(function(i) {
          var r = Jn(i);
          return r = typeof r == "function" ? r : n, _r(Zt(i, 1, It, true), n, r);
        });
        function n1(i) {
          return i && i.length ? _r(i) : [];
        }
        function i1(i, r) {
          return i && i.length ? _r(i, Le(r, 2)) : [];
        }
        function r1(i, r) {
          return r = typeof r == "function" ? r : n, i && i.length ? _r(i, n, r) : [];
        }
        function yu(i) {
          if (!(i && i.length)) return [];
          var r = 0;
          return i = yr(i, function(l) {
            if (It(l)) return r = Ut(l.length, r), true;
          }), Pc(r, function(l) {
            return Tt(i, Lc(l));
          });
        }
        function Mm(i, r) {
          if (!(i && i.length)) return [];
          var l = yu(i);
          return r == null ? l : Tt(l, function(d) {
            return Fn(r, n, d);
          });
        }
        var o1 = qe(function(i, r) {
          return It(i) ? ba(i, r) : [];
        }), a1 = qe(function(i) {
          return tu(yr(i, It));
        }), s1 = qe(function(i) {
          var r = Jn(i);
          return It(r) && (r = n), tu(yr(i, It), Le(r, 2));
        }), l1 = qe(function(i) {
          var r = Jn(i);
          return r = typeof r == "function" ? r : n, tu(yr(i, It), n, r);
        }), c1 = qe(yu);
        function u1(i, r) {
          return Kp(i || [], r || [], Sa);
        }
        function d1(i, r) {
          return Kp(i || [], r || [], Ca);
        }
        var f1 = qe(function(i) {
          var r = i.length, l = r > 1 ? i[r - 1] : n;
          return l = typeof l == "function" ? (i.pop(), l) : n, Mm(i, l);
        });
        function Lm(i) {
          var r = g(i);
          return r.__chain__ = true, r;
        }
        function p1(i, r) {
          return r(i), i;
        }
        function ul(i, r) {
          return r(i);
        }
        var m1 = ji(function(i) {
          var r = i.length, l = r ? i[0] : 0, d = this.__wrapped__, p = function(y) {
            return jc(y, i);
          };
          return r > 1 || this.__actions__.length || !(d instanceof Ye) || !Hi(l) ? this.thru(p) : (d = d.slice(l, +l + (r ? 1 : 0)), d.__actions__.push({ func: ul, args: [p], thisArg: n }), new Yn(d, this.__chain__).thru(function(y) {
            return r && !y.length && y.push(n), y;
          }));
        });
        function h1() {
          return Lm(this);
        }
        function g1() {
          return new Yn(this.value(), this.__chain__);
        }
        function y1() {
          this.__values__ === n && (this.__values__ = qm(this.value()));
          var i = this.__index__ >= this.__values__.length, r = i ? n : this.__values__[this.__index__++];
          return { done: i, value: r };
        }
        function v1() {
          return this;
        }
        function w1(i) {
          for (var r, l = this; l instanceof Ys; ) {
            var d = Cm(l);
            d.__index__ = 0, d.__values__ = n, r ? p.__wrapped__ = d : r = d;
            var p = d;
            l = l.__wrapped__;
          }
          return p.__wrapped__ = i, r;
        }
        function S1() {
          var i = this.__wrapped__;
          if (i instanceof Ye) {
            var r = i;
            return this.__actions__.length && (r = new Ye(this)), r = r.reverse(), r.__actions__.push({ func: ul, args: [gu], thisArg: n }), new Yn(r, this.__chain__);
          }
          return this.thru(gu);
        }
        function b1() {
          return Gp(this.__wrapped__, this.__actions__);
        }
        var _1 = nl(function(i, r, l) {
          lt.call(i, l) ? ++i[l] : Ci(i, l, 1);
        });
        function A1(i, r, l) {
          var d = Be(i) ? ap : p0;
          return l && dn(i, r, l) && (r = n), d(i, Le(r, 3));
        }
        function C1(i, r) {
          var l = Be(i) ? yr : Mp;
          return l(i, Le(r, 3));
        }
        var T1 = rm(Tm), E1 = rm(Em);
        function k1(i, r) {
          return Zt(dl(i, r), 1);
        }
        function z1(i, r) {
          return Zt(dl(i, r), ie);
        }
        function D1(i, r, l) {
          return l = l === n ? 1 : je(l), Zt(dl(i, r), l);
        }
        function xm(i, r) {
          var l = Be(i) ? Nn : br;
          return l(i, Le(r, 3));
        }
        function Om(i, r) {
          var l = Be(i) ? KS : Dp;
          return l(i, Le(r, 3));
        }
        var M1 = nl(function(i, r, l) {
          lt.call(i, l) ? i[l].push(r) : Ci(i, l, [r]);
        });
        function L1(i, r, l, d) {
          i = Tn(i) ? i : Uo(i), l = l && !d ? je(l) : 0;
          var p = i.length;
          return l < 0 && (l = Ut(p + l, 0)), gl(i) ? l <= p && i.indexOf(r, l) > -1 : !!p && Do(i, r, l) > -1;
        }
        var x1 = qe(function(i, r, l) {
          var d = -1, p = typeof r == "function", y = Tn(i) ? V(i.length) : [];
          return br(i, function(T) {
            y[++d] = p ? Fn(r, T, l) : _a(T, r, l);
          }), y;
        }), O1 = nl(function(i, r, l) {
          Ci(i, l, r);
        });
        function dl(i, r) {
          var l = Be(i) ? Tt : Rp;
          return l(i, Le(r, 3));
        }
        function P1(i, r, l, d) {
          return i == null ? [] : (Be(r) || (r = r == null ? [] : [r]), l = d ? n : l, Be(l) || (l = l == null ? [] : [l]), Bp(i, r, l));
        }
        var I1 = nl(function(i, r, l) {
          i[l ? 0 : 1].push(r);
        }, function() {
          return [[], []];
        });
        function R1(i, r, l) {
          var d = Be(i) ? Dc : up, p = arguments.length < 3;
          return d(i, Le(r, 4), l, p, br);
        }
        function F1(i, r, l) {
          var d = Be(i) ? YS : up, p = arguments.length < 3;
          return d(i, Le(r, 4), l, p, Dp);
        }
        function N1(i, r) {
          var l = Be(i) ? yr : Mp;
          return l(i, ml(Le(r, 3)));
        }
        function W1(i) {
          var r = Be(i) ? Tp : L0;
          return r(i);
        }
        function B1(i, r, l) {
          (l ? dn(i, r, l) : r === n) ? r = 1 : r = je(r);
          var d = Be(i) ? l0 : x0;
          return d(i, r);
        }
        function U1(i) {
          var r = Be(i) ? c0 : P0;
          return r(i);
        }
        function j1(i) {
          if (i == null) return 0;
          if (Tn(i)) return gl(i) ? Lo(i) : i.length;
          var r = tn(i);
          return r == Y || r == de ? i.size : Kc(i).length;
        }
        function H1(i, r, l) {
          var d = Be(i) ? Mc : I0;
          return l && dn(i, r, l) && (r = n), d(i, Le(r, 3));
        }
        var V1 = qe(function(i, r) {
          if (i == null) return [];
          var l = r.length;
          return l > 1 && dn(i, r[0], r[1]) ? r = [] : l > 2 && dn(r[0], r[1], r[2]) && (r = [r[0]]), Bp(i, Zt(r, 1), []);
        }), fl = Cb || function() {
          return Yt.Date.now();
        };
        function q1(i, r) {
          if (typeof r != "function") throw new Kn(c);
          return i = je(i), function() {
            if (--i < 1) return r.apply(this, arguments);
          };
        }
        function Pm(i, r, l) {
          return r = l ? n : r, r = i && r == null ? i.length : r, Ui(i, ue, n, n, n, n, r);
        }
        function Im(i, r) {
          var l;
          if (typeof r != "function") throw new Kn(c);
          return i = je(i), function() {
            return --i > 0 && (l = r.apply(this, arguments)), i <= 1 && (r = n), l;
          };
        }
        var vu = qe(function(i, r, l) {
          var d = b;
          if (l.length) {
            var p = wr(l, Wo(vu));
            d |= $;
          }
          return Ui(i, d, r, l, p);
        }), Rm = qe(function(i, r, l) {
          var d = b | P;
          if (l.length) {
            var p = wr(l, Wo(Rm));
            d |= $;
          }
          return Ui(r, d, i, l, p);
        });
        function Fm(i, r, l) {
          r = l ? n : r;
          var d = Ui(i, k, n, n, n, n, n, r);
          return d.placeholder = Fm.placeholder, d;
        }
        function Nm(i, r, l) {
          r = l ? n : r;
          var d = Ui(i, j, n, n, n, n, n, r);
          return d.placeholder = Nm.placeholder, d;
        }
        function Wm(i, r, l) {
          var d, p, y, T, M, R, te = 0, ne = false, ae = false, he = true;
          if (typeof i != "function") throw new Kn(c);
          r = Xn(r) || 0, zt(l) && (ne = !!l.leading, ae = "maxWait" in l, y = ae ? Ut(Xn(l.maxWait) || 0, r) : y, he = "trailing" in l ? !!l.trailing : he);
          function Ce(Rt) {
            var pi = d, $i = p;
            return d = p = n, te = Rt, T = i.apply($i, pi), T;
          }
          function Oe(Rt) {
            return te = Rt, M = ka(Ge, r), ne ? Ce(Rt) : T;
          }
          function Ve(Rt) {
            var pi = Rt - R, $i = Rt - te, oh = r - pi;
            return ae ? en(oh, y - $i) : oh;
          }
          function De(Rt) {
            var pi = Rt - R, $i = Rt - te;
            return R === n || pi >= r || pi < 0 || ae && $i >= y;
          }
          function Ge() {
            var Rt = fl();
            if (De(Rt)) return Ze(Rt);
            M = ka(Ge, Ve(Rt));
          }
          function Ze(Rt) {
            return M = n, he && d ? Ce(Rt) : (d = p = n, T);
          }
          function jn() {
            M !== n && Yp(M), te = 0, d = R = p = M = n;
          }
          function fn() {
            return M === n ? T : Ze(fl());
          }
          function Hn() {
            var Rt = fl(), pi = De(Rt);
            if (d = arguments, p = this, R = Rt, pi) {
              if (M === n) return Oe(R);
              if (ae) return Yp(M), M = ka(Ge, r), Ce(R);
            }
            return M === n && (M = ka(Ge, r)), T;
          }
          return Hn.cancel = jn, Hn.flush = fn, Hn;
        }
        var $1 = qe(function(i, r) {
          return zp(i, 1, r);
        }), G1 = qe(function(i, r, l) {
          return zp(i, Xn(r) || 0, l);
        });
        function K1(i) {
          return Ui(i, se);
        }
        function pl(i, r) {
          if (typeof i != "function" || r != null && typeof r != "function") throw new Kn(c);
          var l = function() {
            var d = arguments, p = r ? r.apply(this, d) : d[0], y = l.cache;
            if (y.has(p)) return y.get(p);
            var T = i.apply(this, d);
            return l.cache = y.set(p, T) || y, T;
          };
          return l.cache = new (pl.Cache || Bi)(), l;
        }
        pl.Cache = Bi;
        function ml(i) {
          if (typeof i != "function") throw new Kn(c);
          return function() {
            var r = arguments;
            switch (r.length) {
              case 0:
                return !i.call(this);
              case 1:
                return !i.call(this, r[0]);
              case 2:
                return !i.call(this, r[0], r[1]);
              case 3:
                return !i.call(this, r[0], r[1], r[2]);
            }
            return !i.apply(this, r);
          };
        }
        function Y1(i) {
          return Im(2, i);
        }
        var Z1 = R0(function(i, r) {
          r = r.length == 1 && Be(r[0]) ? Tt(r[0], Wn(Le())) : Tt(Zt(r, 1), Wn(Le()));
          var l = r.length;
          return qe(function(d) {
            for (var p = -1, y = en(d.length, l); ++p < y; ) d[p] = r[p].call(this, d[p]);
            return Fn(i, this, d);
          });
        }), wu = qe(function(i, r) {
          var l = wr(r, Wo(wu));
          return Ui(i, $, n, r, l);
        }), Bm = qe(function(i, r) {
          var l = wr(r, Wo(Bm));
          return Ui(i, q, n, r, l);
        }), Q1 = ji(function(i, r) {
          return Ui(i, ee, n, n, n, r);
        });
        function J1(i, r) {
          if (typeof i != "function") throw new Kn(c);
          return r = r === n ? r : je(r), qe(i, r);
        }
        function X1(i, r) {
          if (typeof i != "function") throw new Kn(c);
          return r = r == null ? 0 : Ut(je(r), 0), qe(function(l) {
            var d = l[r], p = Cr(l, 0, r);
            return d && vr(p, d), Fn(i, this, p);
          });
        }
        function eA(i, r, l) {
          var d = true, p = true;
          if (typeof i != "function") throw new Kn(c);
          return zt(l) && (d = "leading" in l ? !!l.leading : d, p = "trailing" in l ? !!l.trailing : p), Wm(i, r, { leading: d, maxWait: r, trailing: p });
        }
        function tA(i) {
          return Pm(i, 1);
        }
        function nA(i, r) {
          return wu(iu(r), i);
        }
        function iA() {
          if (!arguments.length) return [];
          var i = arguments[0];
          return Be(i) ? i : [i];
        }
        function rA(i) {
          return Zn(i, W);
        }
        function oA(i, r) {
          return r = typeof r == "function" ? r : n, Zn(i, W, r);
        }
        function aA(i) {
          return Zn(i, C | W);
        }
        function sA(i, r) {
          return r = typeof r == "function" ? r : n, Zn(i, C | W, r);
        }
        function lA(i, r) {
          return r == null || kp(i, r, $t(r));
        }
        function fi(i, r) {
          return i === r || i !== i && r !== r;
        }
        var cA = al(qc), uA = al(function(i, r) {
          return i >= r;
        }), $r = Op(/* @__PURE__ */ (function() {
          return arguments;
        })()) ? Op : function(i) {
          return Mt(i) && lt.call(i, "callee") && !wp.call(i, "callee");
        }, Be = V.isArray, dA = ep ? Wn(ep) : w0;
        function Tn(i) {
          return i != null && hl(i.length) && !Vi(i);
        }
        function It(i) {
          return Mt(i) && Tn(i);
        }
        function fA(i) {
          return i === true || i === false || Mt(i) && un(i) == pt;
        }
        var Tr = Eb || Lu, pA = tp ? Wn(tp) : S0;
        function mA(i) {
          return Mt(i) && i.nodeType === 1 && !za(i);
        }
        function hA(i) {
          if (i == null) return true;
          if (Tn(i) && (Be(i) || typeof i == "string" || typeof i.splice == "function" || Tr(i) || Bo(i) || $r(i))) return !i.length;
          var r = tn(i);
          if (r == Y || r == de) return !i.size;
          if (Ea(i)) return !Kc(i).length;
          for (var l in i) if (lt.call(i, l)) return false;
          return true;
        }
        function gA(i, r) {
          return Aa(i, r);
        }
        function yA(i, r, l) {
          l = typeof l == "function" ? l : n;
          var d = l ? l(i, r) : n;
          return d === n ? Aa(i, r, n, l) : !!d;
        }
        function Su(i) {
          if (!Mt(i)) return false;
          var r = un(i);
          return r == _ || r == Ae || typeof i.message == "string" && typeof i.name == "string" && !za(i);
        }
        function vA(i) {
          return typeof i == "number" && bp(i);
        }
        function Vi(i) {
          if (!zt(i)) return false;
          var r = un(i);
          return r == z || r == U || r == Ie || r == x;
        }
        function Um(i) {
          return typeof i == "number" && i == je(i);
        }
        function hl(i) {
          return typeof i == "number" && i > -1 && i % 1 == 0 && i <= pe;
        }
        function zt(i) {
          var r = typeof i;
          return i != null && (r == "object" || r == "function");
        }
        function Mt(i) {
          return i != null && typeof i == "object";
        }
        var jm = np ? Wn(np) : _0;
        function wA(i, r) {
          return i === r || Gc(i, r, uu(r));
        }
        function SA(i, r, l) {
          return l = typeof l == "function" ? l : n, Gc(i, r, uu(r), l);
        }
        function bA(i) {
          return Hm(i) && i != +i;
        }
        function _A(i) {
          if (o_(i)) throw new Ne(s);
          return Pp(i);
        }
        function AA(i) {
          return i === null;
        }
        function CA(i) {
          return i == null;
        }
        function Hm(i) {
          return typeof i == "number" || Mt(i) && un(i) == J;
        }
        function za(i) {
          if (!Mt(i) || un(i) != w) return false;
          var r = js(i);
          if (r === null) return true;
          var l = lt.call(r, "constructor") && r.constructor;
          return typeof l == "function" && l instanceof l && Ns.call(l) == Sb;
        }
        var bu = ip ? Wn(ip) : A0;
        function TA(i) {
          return Um(i) && i >= -pe && i <= pe;
        }
        var Vm = rp ? Wn(rp) : C0;
        function gl(i) {
          return typeof i == "string" || !Be(i) && Mt(i) && un(i) == Z;
        }
        function Un(i) {
          return typeof i == "symbol" || Mt(i) && un(i) == O;
        }
        var Bo = op ? Wn(op) : T0;
        function EA(i) {
          return i === n;
        }
        function kA(i) {
          return Mt(i) && tn(i) == ge;
        }
        function zA(i) {
          return Mt(i) && un(i) == ze;
        }
        var DA = al(Yc), MA = al(function(i, r) {
          return i <= r;
        });
        function qm(i) {
          if (!i) return [];
          if (Tn(i)) return gl(i) ? ci(i) : Cn(i);
          if (ha && i[ha]) return lb(i[ha]());
          var r = tn(i), l = r == Y ? Rc : r == de ? Is : Uo;
          return l(i);
        }
        function qi(i) {
          if (!i) return i === 0 ? i : 0;
          if (i = Xn(i), i === ie || i === -ie) {
            var r = i < 0 ? -1 : 1;
            return r * we;
          }
          return i === i ? i : 0;
        }
        function je(i) {
          var r = qi(i), l = r % 1;
          return r === r ? l ? r - l : r : 0;
        }
        function $m(i) {
          return i ? jr(je(i), 0, ke) : 0;
        }
        function Xn(i) {
          if (typeof i == "number") return i;
          if (Un(i)) return Te;
          if (zt(i)) {
            var r = typeof i.valueOf == "function" ? i.valueOf() : i;
            i = zt(r) ? r + "" : r;
          }
          if (typeof i != "string") return i === 0 ? i : +i;
          i = dp(i);
          var l = hr.test(i);
          return l || li.test(i) ? qS(i.slice(2), l ? 2 : 8) : Ao.test(i) ? Te : +i;
        }
        function Gm(i) {
          return Ei(i, En(i));
        }
        function LA(i) {
          return i ? jr(je(i), -pe, pe) : i === 0 ? i : 0;
        }
        function ct(i) {
          return i == null ? "" : Bn(i);
        }
        var xA = Fo(function(i, r) {
          if (Ea(r) || Tn(r)) {
            Ei(r, $t(r), i);
            return;
          }
          for (var l in r) lt.call(r, l) && Sa(i, l, r[l]);
        }), Km = Fo(function(i, r) {
          Ei(r, En(r), i);
        }), Ym = Fo(function(i, r, l, d) {
          Ei(r, En(r), i, d);
        }), _u = Fo(function(i, r, l, d) {
          Ei(r, $t(r), i, d);
        }), OA = ji(jc);
        function PA(i, r) {
          var l = Ro(i);
          return r == null ? l : Ep(l, r);
        }
        var IA = qe(function(i, r) {
          i = gt(i);
          var l = -1, d = r.length, p = d > 2 ? r[2] : n;
          for (p && dn(r[0], r[1], p) && (d = 1); ++l < d; ) for (var y = r[l], T = En(y), M = -1, R = T.length; ++M < R; ) {
            var te = T[M], ne = i[te];
            (ne === n || fi(ne, Oo[te]) && !lt.call(i, te)) && (i[te] = y[te]);
          }
          return i;
        }), RA = qe(function(i) {
          return i.push(n, dm), Fn(Zm, n, i);
        });
        function FA(i, r) {
          return sp(i, Le(r, 3), Ti);
        }
        function NA(i, r) {
          return sp(i, Le(r, 3), Vc);
        }
        function WA(i, r) {
          return i == null ? i : Hc(i, Le(r, 3), En);
        }
        function BA(i, r) {
          return i == null ? i : Lp(i, Le(r, 3), En);
        }
        function UA(i, r) {
          return i && Ti(i, Le(r, 3));
        }
        function jA(i, r) {
          return i && Vc(i, Le(r, 3));
        }
        function HA(i) {
          return i == null ? [] : Js(i, $t(i));
        }
        function VA(i) {
          return i == null ? [] : Js(i, En(i));
        }
        function Au(i, r, l) {
          var d = i == null ? n : Hr(i, r);
          return d === n ? l : d;
        }
        function qA(i, r) {
          return i != null && mm(i, r, h0);
        }
        function Cu(i, r) {
          return i != null && mm(i, r, g0);
        }
        var $A = am(function(i, r, l) {
          r != null && typeof r.toString != "function" && (r = Ws.call(r)), i[r] = l;
        }, Eu(kn)), GA = am(function(i, r, l) {
          r != null && typeof r.toString != "function" && (r = Ws.call(r)), lt.call(i, r) ? i[r].push(l) : i[r] = [l];
        }, Le), KA = qe(_a);
        function $t(i) {
          return Tn(i) ? Cp(i) : Kc(i);
        }
        function En(i) {
          return Tn(i) ? Cp(i, true) : E0(i);
        }
        function YA(i, r) {
          var l = {};
          return r = Le(r, 3), Ti(i, function(d, p, y) {
            Ci(l, r(d, p, y), d);
          }), l;
        }
        function ZA(i, r) {
          var l = {};
          return r = Le(r, 3), Ti(i, function(d, p, y) {
            Ci(l, p, r(d, p, y));
          }), l;
        }
        var QA = Fo(function(i, r, l) {
          Xs(i, r, l);
        }), Zm = Fo(function(i, r, l, d) {
          Xs(i, r, l, d);
        }), JA = ji(function(i, r) {
          var l = {};
          if (i == null) return l;
          var d = false;
          r = Tt(r, function(y) {
            return y = Ar(y, i), d || (d = y.length > 1), y;
          }), Ei(i, lu(i), l), d && (l = Zn(l, C | D | W, G0));
          for (var p = r.length; p--; ) eu(l, r[p]);
          return l;
        });
        function XA(i, r) {
          return Qm(i, ml(Le(r)));
        }
        var eC = ji(function(i, r) {
          return i == null ? {} : z0(i, r);
        });
        function Qm(i, r) {
          if (i == null) return {};
          var l = Tt(lu(i), function(d) {
            return [d];
          });
          return r = Le(r), Up(i, l, function(d, p) {
            return r(d, p[0]);
          });
        }
        function tC(i, r, l) {
          r = Ar(r, i);
          var d = -1, p = r.length;
          for (p || (p = 1, i = n); ++d < p; ) {
            var y = i == null ? n : i[di(r[d])];
            y === n && (d = p, y = l), i = Vi(y) ? y.call(i) : y;
          }
          return i;
        }
        function nC(i, r, l) {
          return i == null ? i : Ca(i, r, l);
        }
        function iC(i, r, l, d) {
          return d = typeof d == "function" ? d : n, i == null ? i : Ca(i, r, l, d);
        }
        var Jm = cm($t), Xm = cm(En);
        function rC(i, r, l) {
          var d = Be(i), p = d || Tr(i) || Bo(i);
          if (r = Le(r, 4), l == null) {
            var y = i && i.constructor;
            p ? l = d ? new y() : [] : zt(i) ? l = Vi(y) ? Ro(js(i)) : {} : l = {};
          }
          return (p ? Nn : Ti)(i, function(T, M, R) {
            return r(l, T, M, R);
          }), l;
        }
        function oC(i, r) {
          return i == null ? true : eu(i, r);
        }
        function aC(i, r, l) {
          return i == null ? i : $p(i, r, iu(l));
        }
        function sC(i, r, l, d) {
          return d = typeof d == "function" ? d : n, i == null ? i : $p(i, r, iu(l), d);
        }
        function Uo(i) {
          return i == null ? [] : Ic(i, $t(i));
        }
        function lC(i) {
          return i == null ? [] : Ic(i, En(i));
        }
        function cC(i, r, l) {
          return l === n && (l = r, r = n), l !== n && (l = Xn(l), l = l === l ? l : 0), r !== n && (r = Xn(r), r = r === r ? r : 0), jr(Xn(i), r, l);
        }
        function uC(i, r, l) {
          return r = qi(r), l === n ? (l = r, r = 0) : l = qi(l), i = Xn(i), y0(i, r, l);
        }
        function dC(i, r, l) {
          if (l && typeof l != "boolean" && dn(i, r, l) && (r = l = n), l === n && (typeof r == "boolean" ? (l = r, r = n) : typeof i == "boolean" && (l = i, i = n)), i === n && r === n ? (i = 0, r = 1) : (i = qi(i), r === n ? (r = i, i = 0) : r = qi(r)), i > r) {
            var d = i;
            i = r, r = d;
          }
          if (l || i % 1 || r % 1) {
            var p = _p();
            return en(i + p * (r - i + VS("1e-" + ((p + "").length - 1))), r);
          }
          return Qc(i, r);
        }
        var fC = No(function(i, r, l) {
          return r = r.toLowerCase(), i + (l ? eh(r) : r);
        });
        function eh(i) {
          return Tu(ct(i).toLowerCase());
        }
        function th(i) {
          return i = ct(i), i && i.replace(Ds, ib).replace(PS, "");
        }
        function pC(i, r, l) {
          i = ct(i), r = Bn(r);
          var d = i.length;
          l = l === n ? d : jr(je(l), 0, d);
          var p = l;
          return l -= r.length, l >= 0 && i.slice(l, p) == r;
        }
        function mC(i) {
          return i = ct(i), i && ua.test(i) ? i.replace(So, rb) : i;
        }
        function hC(i) {
          return i = ct(i), i && Sc.test(i) ? i.replace(_i, "\\$&") : i;
        }
        var gC = No(function(i, r, l) {
          return i + (l ? "-" : "") + r.toLowerCase();
        }), yC = No(function(i, r, l) {
          return i + (l ? " " : "") + r.toLowerCase();
        }), vC = im("toLowerCase");
        function wC(i, r, l) {
          i = ct(i), r = je(r);
          var d = r ? Lo(i) : 0;
          if (!r || d >= r) return i;
          var p = (r - d) / 2;
          return ol($s(p), l) + i + ol(qs(p), l);
        }
        function SC(i, r, l) {
          i = ct(i), r = je(r);
          var d = r ? Lo(i) : 0;
          return r && d < r ? i + ol(r - d, l) : i;
        }
        function bC(i, r, l) {
          i = ct(i), r = je(r);
          var d = r ? Lo(i) : 0;
          return r && d < r ? ol(r - d, l) + i : i;
        }
        function _C(i, r, l) {
          return l || r == null ? r = 0 : r && (r = +r), Mb(ct(i).replace(bo, ""), r || 0);
        }
        function AC(i, r, l) {
          return (l ? dn(i, r, l) : r === n) ? r = 1 : r = je(r), Jc(ct(i), r);
        }
        function CC() {
          var i = arguments, r = ct(i[0]);
          return i.length < 3 ? r : r.replace(i[1], i[2]);
        }
        var TC = No(function(i, r, l) {
          return i + (l ? "_" : "") + r.toLowerCase();
        });
        function EC(i, r, l) {
          return l && typeof l != "number" && dn(i, r, l) && (r = l = n), l = l === n ? ke : l >>> 0, l ? (i = ct(i), i && (typeof r == "string" || r != null && !bu(r)) && (r = Bn(r), !r && Mo(i)) ? Cr(ci(i), 0, l) : i.split(r, l)) : [];
        }
        var kC = No(function(i, r, l) {
          return i + (l ? " " : "") + Tu(r);
        });
        function zC(i, r, l) {
          return i = ct(i), l = l == null ? 0 : jr(je(l), 0, i.length), r = Bn(r), i.slice(l, l + r.length) == r;
        }
        function DC(i, r, l) {
          var d = g.templateSettings;
          l && dn(i, r, l) && (r = n), i = ct(i), r = _u({}, r, d, um);
          var p = _u({}, r.imports, d.imports, um), y = $t(p), T = Ic(p, y);
          Nn(y, function(De) {
            if (Ai.test(De)) throw new Ne(f);
          });
          var M, R, te = 0, ne = r.interpolate || To, ae = "__p += '", he = Fc((r.escape || To).source + "|" + ne.source + "|" + (ne === mr ? ks : To).source + "|" + (r.evaluate || To).source + "|$", "g"), Ce = "//# sourceURL=" + (lt.call(r, "sourceURL") ? (r.sourceURL + "").replace(/\s/g, " ") : "lodash.templateSources[" + ++WS + "]") + `
`;
          i.replace(he, function(De, Ge, Ze, jn, fn, Hn) {
            return Ze || (Ze = jn), ae += i.slice(te, Hn).replace(Ms, ob), Ge && (M = true, ae += `' +
__e(` + Ge + `) +
'`), fn && (R = true, ae += `';
` + fn + `;
__p += '`), Ze && (ae += `' +
((__t = (` + Ze + `)) == null ? '' : __t) +
'`), te = Hn + De.length, De;
          }), ae += `';
`;
          var Oe = lt.call(r, "variable") && r.variable;
          if (!Oe) ae = `with (obj) {
` + ae + `
}
`;
          else if (Ai.test(Oe)) throw new Ne(u);
          ae = (R ? ae.replace(vo, "") : ae).replace($n, "$1").replace(pr, "$1;"), ae = "function(" + (Oe || "obj") + `) {
` + (Oe ? "" : `obj || (obj = {});
`) + "var __t, __p = ''" + (M ? ", __e = _.escape" : "") + (R ? `, __j = Array.prototype.join;
function print() { __p += __j.call(arguments, '') }
` : `;
`) + ae + `return __p
}`;
          var Ve = ih(function() {
            return at(y, Ce + "return " + ae).apply(n, T);
          });
          if (Ve.source = ae, Su(Ve)) throw Ve;
          return Ve;
        }
        function MC(i) {
          return ct(i).toLowerCase();
        }
        function LC(i) {
          return ct(i).toUpperCase();
        }
        function xC(i, r, l) {
          if (i = ct(i), i && (l || r === n)) return dp(i);
          if (!i || !(r = Bn(r))) return i;
          var d = ci(i), p = ci(r), y = fp(d, p), T = pp(d, p) + 1;
          return Cr(d, y, T).join("");
        }
        function OC(i, r, l) {
          if (i = ct(i), i && (l || r === n)) return i.slice(0, hp(i) + 1);
          if (!i || !(r = Bn(r))) return i;
          var d = ci(i), p = pp(d, ci(r)) + 1;
          return Cr(d, 0, p).join("");
        }
        function PC(i, r, l) {
          if (i = ct(i), i && (l || r === n)) return i.replace(bo, "");
          if (!i || !(r = Bn(r))) return i;
          var d = ci(i), p = fp(d, ci(r));
          return Cr(d, p).join("");
        }
        function IC(i, r) {
          var l = le, d = re;
          if (zt(r)) {
            var p = "separator" in r ? r.separator : p;
            l = "length" in r ? je(r.length) : l, d = "omission" in r ? Bn(r.omission) : d;
          }
          i = ct(i);
          var y = i.length;
          if (Mo(i)) {
            var T = ci(i);
            y = T.length;
          }
          if (l >= y) return i;
          var M = l - Lo(d);
          if (M < 1) return d;
          var R = T ? Cr(T, 0, M).join("") : i.slice(0, M);
          if (p === n) return R + d;
          if (T && (M += R.length - M), bu(p)) {
            if (i.slice(M).search(p)) {
              var te, ne = R;
              for (p.global || (p = Fc(p.source, ct(_o.exec(p)) + "g")), p.lastIndex = 0; te = p.exec(ne); ) var ae = te.index;
              R = R.slice(0, ae === n ? M : ae);
            }
          } else if (i.indexOf(Bn(p), M) != M) {
            var he = R.lastIndexOf(p);
            he > -1 && (R = R.slice(0, he));
          }
          return R + d;
        }
        function RC(i) {
          return i = ct(i), i && gc.test(i) ? i.replace(wo, fb) : i;
        }
        var FC = No(function(i, r, l) {
          return i + (l ? " " : "") + r.toUpperCase();
        }), Tu = im("toUpperCase");
        function nh(i, r, l) {
          return i = ct(i), r = l ? n : r, r === n ? sb(i) ? hb(i) : JS(i) : i.match(r) || [];
        }
        var ih = qe(function(i, r) {
          try {
            return Fn(i, n, r);
          } catch (l) {
            return Su(l) ? l : new Ne(l);
          }
        }), NC = ji(function(i, r) {
          return Nn(r, function(l) {
            l = di(l), Ci(i, l, vu(i[l], i));
          }), i;
        });
        function WC(i) {
          var r = i == null ? 0 : i.length, l = Le();
          return i = r ? Tt(i, function(d) {
            if (typeof d[1] != "function") throw new Kn(c);
            return [l(d[0]), d[1]];
          }) : [], qe(function(d) {
            for (var p = -1; ++p < r; ) {
              var y = i[p];
              if (Fn(y[0], this, d)) return Fn(y[1], this, d);
            }
          });
        }
        function BC(i) {
          return f0(Zn(i, C));
        }
        function Eu(i) {
          return function() {
            return i;
          };
        }
        function UC(i, r) {
          return i == null || i !== i ? r : i;
        }
        var jC = om(), HC = om(true);
        function kn(i) {
          return i;
        }
        function ku(i) {
          return Ip(typeof i == "function" ? i : Zn(i, C));
        }
        function VC(i) {
          return Fp(Zn(i, C));
        }
        function qC(i, r) {
          return Np(i, Zn(r, C));
        }
        var $C = qe(function(i, r) {
          return function(l) {
            return _a(l, i, r);
          };
        }), GC = qe(function(i, r) {
          return function(l) {
            return _a(i, l, r);
          };
        });
        function zu(i, r, l) {
          var d = $t(r), p = Js(r, d);
          l == null && !(zt(r) && (p.length || !d.length)) && (l = r, r = i, i = this, p = Js(r, $t(r)));
          var y = !(zt(l) && "chain" in l) || !!l.chain, T = Vi(i);
          return Nn(p, function(M) {
            var R = r[M];
            i[M] = R, T && (i.prototype[M] = function() {
              var te = this.__chain__;
              if (y || te) {
                var ne = i(this.__wrapped__), ae = ne.__actions__ = Cn(this.__actions__);
                return ae.push({ func: R, args: arguments, thisArg: i }), ne.__chain__ = te, ne;
              }
              return R.apply(i, vr([this.value()], arguments));
            });
          }), i;
        }
        function KC() {
          return Yt._ === this && (Yt._ = bb), this;
        }
        function Du() {
        }
        function YC(i) {
          return i = je(i), qe(function(r) {
            return Wp(r, i);
          });
        }
        var ZC = ou(Tt), QC = ou(ap), JC = ou(Mc);
        function rh(i) {
          return fu(i) ? Lc(di(i)) : D0(i);
        }
        function XC(i) {
          return function(r) {
            return i == null ? n : Hr(i, r);
          };
        }
        var eT = sm(), tT = sm(true);
        function Mu() {
          return [];
        }
        function Lu() {
          return false;
        }
        function nT() {
          return {};
        }
        function iT() {
          return "";
        }
        function rT() {
          return true;
        }
        function oT(i, r) {
          if (i = je(i), i < 1 || i > pe) return [];
          var l = ke, d = en(i, ke);
          r = Le(r), i -= ke;
          for (var p = Pc(d, r); ++l < i; ) r(l);
          return p;
        }
        function aT(i) {
          return Be(i) ? Tt(i, di) : Un(i) ? [i] : Cn(Am(ct(i)));
        }
        function sT(i) {
          var r = ++wb;
          return ct(i) + r;
        }
        var lT = rl(function(i, r) {
          return i + r;
        }, 0), cT = au("ceil"), uT = rl(function(i, r) {
          return i / r;
        }, 1), dT = au("floor");
        function fT(i) {
          return i && i.length ? Qs(i, kn, qc) : n;
        }
        function pT(i, r) {
          return i && i.length ? Qs(i, Le(r, 2), qc) : n;
        }
        function mT(i) {
          return cp(i, kn);
        }
        function hT(i, r) {
          return cp(i, Le(r, 2));
        }
        function gT(i) {
          return i && i.length ? Qs(i, kn, Yc) : n;
        }
        function yT(i, r) {
          return i && i.length ? Qs(i, Le(r, 2), Yc) : n;
        }
        var vT = rl(function(i, r) {
          return i * r;
        }, 1), wT = au("round"), ST = rl(function(i, r) {
          return i - r;
        }, 0);
        function bT(i) {
          return i && i.length ? Oc(i, kn) : 0;
        }
        function _T(i, r) {
          return i && i.length ? Oc(i, Le(r, 2)) : 0;
        }
        return g.after = q1, g.ary = Pm, g.assign = xA, g.assignIn = Km, g.assignInWith = Ym, g.assignWith = _u, g.at = OA, g.before = Im, g.bind = vu, g.bindAll = NC, g.bindKey = Rm, g.castArray = iA, g.chain = Lm, g.chunk = f_, g.compact = p_, g.concat = m_, g.cond = WC, g.conforms = BC, g.constant = Eu, g.countBy = _1, g.create = PA, g.curry = Fm, g.curryRight = Nm, g.debounce = Wm, g.defaults = IA, g.defaultsDeep = RA, g.defer = $1, g.delay = G1, g.difference = h_, g.differenceBy = g_, g.differenceWith = y_, g.drop = v_, g.dropRight = w_, g.dropRightWhile = S_, g.dropWhile = b_, g.fill = __, g.filter = C1, g.flatMap = k1, g.flatMapDeep = z1, g.flatMapDepth = D1, g.flatten = km, g.flattenDeep = A_, g.flattenDepth = C_, g.flip = K1, g.flow = jC, g.flowRight = HC, g.fromPairs = T_, g.functions = HA, g.functionsIn = VA, g.groupBy = M1, g.initial = k_, g.intersection = z_, g.intersectionBy = D_, g.intersectionWith = M_, g.invert = $A, g.invertBy = GA, g.invokeMap = x1, g.iteratee = ku, g.keyBy = O1, g.keys = $t, g.keysIn = En, g.map = dl, g.mapKeys = YA, g.mapValues = ZA, g.matches = VC, g.matchesProperty = qC, g.memoize = pl, g.merge = QA, g.mergeWith = Zm, g.method = $C, g.methodOf = GC, g.mixin = zu, g.negate = ml, g.nthArg = YC, g.omit = JA, g.omitBy = XA, g.once = Y1, g.orderBy = P1, g.over = ZC, g.overArgs = Z1, g.overEvery = QC, g.overSome = JC, g.partial = wu, g.partialRight = Bm, g.partition = I1, g.pick = eC, g.pickBy = Qm, g.property = rh, g.propertyOf = XC, g.pull = P_, g.pullAll = Dm, g.pullAllBy = I_, g.pullAllWith = R_, g.pullAt = F_, g.range = eT, g.rangeRight = tT, g.rearg = Q1, g.reject = N1, g.remove = N_, g.rest = J1, g.reverse = gu, g.sampleSize = B1, g.set = nC, g.setWith = iC, g.shuffle = U1, g.slice = W_, g.sortBy = V1, g.sortedUniq = $_, g.sortedUniqBy = G_, g.split = EC, g.spread = X1, g.tail = K_, g.take = Y_, g.takeRight = Z_, g.takeRightWhile = Q_, g.takeWhile = J_, g.tap = p1, g.throttle = eA, g.thru = ul, g.toArray = qm, g.toPairs = Jm, g.toPairsIn = Xm, g.toPath = aT, g.toPlainObject = Gm, g.transform = rC, g.unary = tA, g.union = X_, g.unionBy = e1, g.unionWith = t1, g.uniq = n1, g.uniqBy = i1, g.uniqWith = r1, g.unset = oC, g.unzip = yu, g.unzipWith = Mm, g.update = aC, g.updateWith = sC, g.values = Uo, g.valuesIn = lC, g.without = o1, g.words = nh, g.wrap = nA, g.xor = a1, g.xorBy = s1, g.xorWith = l1, g.zip = c1, g.zipObject = u1, g.zipObjectDeep = d1, g.zipWith = f1, g.entries = Jm, g.entriesIn = Xm, g.extend = Km, g.extendWith = Ym, zu(g, g), g.add = lT, g.attempt = ih, g.camelCase = fC, g.capitalize = eh, g.ceil = cT, g.clamp = cC, g.clone = rA, g.cloneDeep = aA, g.cloneDeepWith = sA, g.cloneWith = oA, g.conformsTo = lA, g.deburr = th, g.defaultTo = UC, g.divide = uT, g.endsWith = pC, g.eq = fi, g.escape = mC, g.escapeRegExp = hC, g.every = A1, g.find = T1, g.findIndex = Tm, g.findKey = FA, g.findLast = E1, g.findLastIndex = Em, g.findLastKey = NA, g.floor = dT, g.forEach = xm, g.forEachRight = Om, g.forIn = WA, g.forInRight = BA, g.forOwn = UA, g.forOwnRight = jA, g.get = Au, g.gt = cA, g.gte = uA, g.has = qA, g.hasIn = Cu, g.head = zm, g.identity = kn, g.includes = L1, g.indexOf = E_, g.inRange = uC, g.invoke = KA, g.isArguments = $r, g.isArray = Be, g.isArrayBuffer = dA, g.isArrayLike = Tn, g.isArrayLikeObject = It, g.isBoolean = fA, g.isBuffer = Tr, g.isDate = pA, g.isElement = mA, g.isEmpty = hA, g.isEqual = gA, g.isEqualWith = yA, g.isError = Su, g.isFinite = vA, g.isFunction = Vi, g.isInteger = Um, g.isLength = hl, g.isMap = jm, g.isMatch = wA, g.isMatchWith = SA, g.isNaN = bA, g.isNative = _A, g.isNil = CA, g.isNull = AA, g.isNumber = Hm, g.isObject = zt, g.isObjectLike = Mt, g.isPlainObject = za, g.isRegExp = bu, g.isSafeInteger = TA, g.isSet = Vm, g.isString = gl, g.isSymbol = Un, g.isTypedArray = Bo, g.isUndefined = EA, g.isWeakMap = kA, g.isWeakSet = zA, g.join = L_, g.kebabCase = gC, g.last = Jn, g.lastIndexOf = x_, g.lowerCase = yC, g.lowerFirst = vC, g.lt = DA, g.lte = MA, g.max = fT, g.maxBy = pT, g.mean = mT, g.meanBy = hT, g.min = gT, g.minBy = yT, g.stubArray = Mu, g.stubFalse = Lu, g.stubObject = nT, g.stubString = iT, g.stubTrue = rT, g.multiply = vT, g.nth = O_, g.noConflict = KC, g.noop = Du, g.now = fl, g.pad = wC, g.padEnd = SC, g.padStart = bC, g.parseInt = _C, g.random = dC, g.reduce = R1, g.reduceRight = F1, g.repeat = AC, g.replace = CC, g.result = tC, g.round = wT, g.runInContext = I, g.sample = W1, g.size = j1, g.snakeCase = TC, g.some = H1, g.sortedIndex = B_, g.sortedIndexBy = U_, g.sortedIndexOf = j_, g.sortedLastIndex = H_, g.sortedLastIndexBy = V_, g.sortedLastIndexOf = q_, g.startCase = kC, g.startsWith = zC, g.subtract = ST, g.sum = bT, g.sumBy = _T, g.template = DC, g.times = oT, g.toFinite = qi, g.toInteger = je, g.toLength = $m, g.toLower = MC, g.toNumber = Xn, g.toSafeInteger = LA, g.toString = ct, g.toUpper = LC, g.trim = xC, g.trimEnd = OC, g.trimStart = PC, g.truncate = IC, g.unescape = RC, g.uniqueId = sT, g.upperCase = FC, g.upperFirst = Tu, g.each = xm, g.eachRight = Om, g.first = zm, zu(g, (function() {
          var i = {};
          return Ti(g, function(r, l) {
            lt.call(g.prototype, l) || (i[l] = r);
          }), i;
        })(), { chain: false }), g.VERSION = o, Nn(["bind", "bindKey", "curry", "curryRight", "partial", "partialRight"], function(i) {
          g[i].placeholder = g;
        }), Nn(["drop", "take"], function(i, r) {
          Ye.prototype[i] = function(l) {
            l = l === n ? 1 : Ut(je(l), 0);
            var d = this.__filtered__ && !r ? new Ye(this) : this.clone();
            return d.__filtered__ ? d.__takeCount__ = en(l, d.__takeCount__) : d.__views__.push({ size: en(l, ke), type: i + (d.__dir__ < 0 ? "Right" : "") }), d;
          }, Ye.prototype[i + "Right"] = function(l) {
            return this.reverse()[i](l).reverse();
          };
        }), Nn(["filter", "map", "takeWhile"], function(i, r) {
          var l = r + 1, d = l == ce || l == oe;
          Ye.prototype[i] = function(p) {
            var y = this.clone();
            return y.__iteratees__.push({ iteratee: Le(p, 3), type: l }), y.__filtered__ = y.__filtered__ || d, y;
          };
        }), Nn(["head", "last"], function(i, r) {
          var l = "take" + (r ? "Right" : "");
          Ye.prototype[i] = function() {
            return this[l](1).value()[0];
          };
        }), Nn(["initial", "tail"], function(i, r) {
          var l = "drop" + (r ? "" : "Right");
          Ye.prototype[i] = function() {
            return this.__filtered__ ? new Ye(this) : this[l](1);
          };
        }), Ye.prototype.compact = function() {
          return this.filter(kn);
        }, Ye.prototype.find = function(i) {
          return this.filter(i).head();
        }, Ye.prototype.findLast = function(i) {
          return this.reverse().find(i);
        }, Ye.prototype.invokeMap = qe(function(i, r) {
          return typeof i == "function" ? new Ye(this) : this.map(function(l) {
            return _a(l, i, r);
          });
        }), Ye.prototype.reject = function(i) {
          return this.filter(ml(Le(i)));
        }, Ye.prototype.slice = function(i, r) {
          i = je(i);
          var l = this;
          return l.__filtered__ && (i > 0 || r < 0) ? new Ye(l) : (i < 0 ? l = l.takeRight(-i) : i && (l = l.drop(i)), r !== n && (r = je(r), l = r < 0 ? l.dropRight(-r) : l.take(r - i)), l);
        }, Ye.prototype.takeRightWhile = function(i) {
          return this.reverse().takeWhile(i).reverse();
        }, Ye.prototype.toArray = function() {
          return this.take(ke);
        }, Ti(Ye.prototype, function(i, r) {
          var l = /^(?:filter|find|map|reject)|While$/.test(r), d = /^(?:head|last)$/.test(r), p = g[d ? "take" + (r == "last" ? "Right" : "") : r], y = d || /^find/.test(r);
          p && (g.prototype[r] = function() {
            var T = this.__wrapped__, M = d ? [1] : arguments, R = T instanceof Ye, te = M[0], ne = R || Be(T), ae = function(Ge) {
              var Ze = p.apply(g, vr([Ge], M));
              return d && he ? Ze[0] : Ze;
            };
            ne && l && typeof te == "function" && te.length != 1 && (R = ne = false);
            var he = this.__chain__, Ce = !!this.__actions__.length, Oe = y && !he, Ve = R && !Ce;
            if (!y && ne) {
              T = Ve ? T : new Ye(this);
              var De = i.apply(T, M);
              return De.__actions__.push({ func: ul, args: [ae], thisArg: n }), new Yn(De, he);
            }
            return Oe && Ve ? i.apply(this, M) : (De = this.thru(ae), Oe ? d ? De.value()[0] : De.value() : De);
          });
        }), Nn(["pop", "push", "shift", "sort", "splice", "unshift"], function(i) {
          var r = Rs[i], l = /^(?:push|sort|unshift)$/.test(i) ? "tap" : "thru", d = /^(?:pop|shift)$/.test(i);
          g.prototype[i] = function() {
            var p = arguments;
            if (d && !this.__chain__) {
              var y = this.value();
              return r.apply(Be(y) ? y : [], p);
            }
            return this[l](function(T) {
              return r.apply(Be(T) ? T : [], p);
            });
          };
        }), Ti(Ye.prototype, function(i, r) {
          var l = g[r];
          if (l) {
            var d = l.name + "";
            lt.call(Io, d) || (Io[d] = []), Io[d].push({ name: r, func: l });
          }
        }), Io[il(n, P).name] = [{ name: "wrapper", func: n }], Ye.prototype.clone = Fb, Ye.prototype.reverse = Nb, Ye.prototype.value = Wb, g.prototype.at = m1, g.prototype.chain = h1, g.prototype.commit = g1, g.prototype.next = y1, g.prototype.plant = w1, g.prototype.reverse = S1, g.prototype.toJSON = g.prototype.valueOf = g.prototype.value = b1, g.prototype.first = g.prototype.head, ha && (g.prototype[ha] = v1), g;
      }, xo = gb();
      Nr ? ((Nr.exports = xo)._ = xo, Ec._ = xo) : Yt._ = xo;
    }).call(Qo);
  })(Vl, Vl.exports);
  Vl.exports;
  function AS(e, t = "hash", n = location.href) {
    const o = new URL(n);
    let a = o.hash.split("?")[1];
    t === "search" && (a = o.search.slice(1));
    const c = new URLSearchParams(a).get(e);
    return c !== null ? c : null;
  }
  const { getData: CS, setData: MI } = Cy(), Ba = AS("windowId", "search"), Sy = AS("hideDelay", "search"), Ml = document.getElementById("custom-app"), LI = { ALLOWED_TAGS: ["div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "br", "hr", "strong", "em", "b", "i", "u", "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "blockquote", "pre", "code", "style"], ALLOWED_ATTR: ["style", "class", "id", "href", "src", "alt", "title", "target", "data-*", "width", "height", "colspan", "rowspan"], FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur"], ALLOW_DATA_ATTR: true, KEEP_CONTENT: true };
  function xI(e) {
    if (!Ml) return;
    if (typeof e != "string") {
      console.error("HTML 内容必须是字符串");
      return;
    }
    const t = eE.sanitize(e, LI);
    Ml.innerHTML = "";
    const n = document.createElement("div");
    for (n.innerHTML = t; n.firstChild; ) Ml.appendChild(n.firstChild);
  }
  async function OI(e) {
    const t = await CS("tipsWindowHtmlMap");
    t && t.value && t.value[e] && (delete t.value[e], await MI("tipsWindowHtmlMap", t.value));
  }
  async function Zd(e) {
    await OI(e), await window.electronAPI.windowManager({ method: "closeWindow", params: [e] });
  }
  function PI() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      t instanceof Element && t.getAttribute("data-close-self-window") === "true" && (e.preventDefault(), e.stopPropagation(), Zd(Ba));
    });
  }
  async function II() {
    PI(), CS("tipsWindowHtmlMap").then((e) => {
      console.log("newVal", e), e.success && e.value && e.value[Ba] && xI(e.value[Ba]);
    }), setTimeout(async () => {
      const e = document.documentElement, t = document.body, n = Ml;
      if (!e || !t) {
        await Zd(Ba);
        return;
      }
      const o = 1e3, a = Date.now(), s = 1, c = 0, u = 16, f = async () => {
        const m = Date.now() - a, h = Math.min(m / o, 1), v = 1 - Math.pow(1 - h, 3), C = s + (c - s) * v;
        e.style.opacity = C, e.style.transition = "none", t.style.opacity = C, t.style.transition = "none", n && (n.style.opacity = C, n.style.transition = "none"), h < 1 ? setTimeout(f, u) : await Zd(Ba);
      };
      f();
    }, Sy ? parseInt(Sy) : 4500);
  }
  II();
});
export default RI();
