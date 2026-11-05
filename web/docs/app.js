/* HireAIJob API docs — comportamiento sin dependencias.
   - Botones de copia en los bloques de código.
   - "Probar este endpoint" rellena el formulario.
   - Probador real contra el mismo origen, con errores explícitos.
   - Índice con sección activa.
*/
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /* ------------------------------------------------------------ copiar */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (!ok) { throw new Error("copia no disponible"); }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        legacyCopy(text);
      });
    }
    return new Promise(function (resolve, reject) {
      try { legacyCopy(text); resolve(); } catch (e) { reject(e); }
    });
  }

  function selectNode(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* sin selección programática */ }
  }

  function enhanceCodeBlocks() {
    $$("pre").forEach(function (pre) {
      if (pre.id === "try-output") { return; }
      if (pre.parentNode && pre.parentNode.classList.contains("pre-wrap")) { return; }

      var wrap = document.createElement("div");
      wrap.className = "pre-wrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.textContent = "Copiar";
      btn.setAttribute("aria-label", "Copiar este bloque de código");
      wrap.appendChild(btn);

      btn.addEventListener("click", function () {
        copyText(pre.textContent).then(function () {
          btn.textContent = "Copiado";
          btn.classList.add("is-done");
          window.setTimeout(function () {
            btn.textContent = "Copiar";
            btn.classList.remove("is-done");
          }, 1800);
        }).catch(function () {
          selectNode(pre);
          btn.textContent = "Selecciona y copia";
          window.setTimeout(function () { btn.textContent = "Copiar"; }, 2600);
        });
      });
    });
  }

  /* ------------------------------------------------------------ probador */
  var form = $("#try-form");
  var keyInput = $("#try-key");
  var methodInput = $("#try-method");
  var pathInput = $("#try-path");
  var bodyInput = $("#try-body");
  var sendBtn = $("#try-send");
  var clearBtn = $("#try-clear");
  var statusEl = $("#try-status");
  var metaEl = $("#try-meta");
  var outputEl = $("#try-output");

  var DEFAULT_TEXT = "Aún no has enviado ninguna petición.";

  function setStatus(kind, label) {
    statusEl.className = "status-badge status-" + kind;
    statusEl.textContent = label;
  }

  function show(kind, text) {
    outputEl.classList.remove("is-error", "is-ok");
    if (kind === "err") { outputEl.classList.add("is-error"); }
    if (kind === "ok") { outputEl.classList.add("is-ok"); }
    outputEl.textContent = text;
  }

  function hintFor(status) {
    if (status === 401) { return "· revisa la clave: falta o no es válida"; }
    if (status === 403) { return "· la clave no tiene permiso sobre este recurso"; }
    if (status === 404) { return "· el id no existe"; }
    if (status === 409) { return "· transición no permitida en el estado actual"; }
    if (status === 422) { return "· cuerpo inválido: revisa tipos y longitudes"; }
    if (status >= 500) { return "· error del servidor: revisa los logs de la API"; }
    return "";
  }

  function absolutize(raw) {
    var value = raw.trim();
    if (!value) { throw new Error("Escribe una ruta, por ejemplo /jobs o /health."); }
    if (/^https?:\/\//i.test(value)) {
      var u = new URL(value);
      if (u.origin !== window.location.origin) {
        throw new Error(
          "Solo se permiten rutas del mismo origen (" + window.location.origin +
          ").\nUsa una ruta relativa como /health para evitar CORS."
        );
      }
      return u.pathname + u.search;
    }
    if (value.charAt(0) !== "/") { value = "/" + value; }
    return value;
  }

  function pretty(text, contentType) {
    if (!text) { return "(respuesta vacía)"; }
    var isJson = contentType.indexOf("json") !== -1;
    if (!isJson) {
      try { JSON.parse(text); isJson = true; } catch (e) { isJson = false; }
    }
    if (isJson) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* texto plano */ }
    }
    if (text.length > 6000) {
      return text.slice(0, 6000) + "\n\n… (recortado: " + text.length + " caracteres en total)";
    }
    return text;
  }

  function send() {
    if (!form || !outputEl) { return; }

    var method = methodInput.value;
    var path;
    try {
      path = absolutize(pathInput.value);
    } catch (err) {
      setStatus("err", "ruta inválida");
      metaEl.textContent = "";
      show("err", err.message);
      pathInput.focus();
      return;
    }

    var hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    var rawBody = bodyInput.value.trim();
    var body;

    if (hasBody && rawBody) {
      try {
        JSON.parse(rawBody);
      } catch (err) {
        setStatus("err", "JSON inválido");
        metaEl.textContent = "";
        show("err",
          "El cuerpo no es JSON válido:\n" + err.message +
          "\n\nCorrige el cuerpo antes de enviar. No se ha hecho ninguna petición.");
        bodyInput.focus();
        return;
      }
      body = rawBody;
    }

    var headers = { "Accept": "application/json, text/html;q=0.9, */*;q=0.8" };
    var key = keyInput.value.trim();
    if (key) {
      headers["Authorization"] = /^Bearer\s/i.test(key) ? key : "Bearer " + key;
    }
    if (body !== undefined) { headers["Content-Type"] = "application/json"; }

    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 90000);
    var started = (window.performance && performance.now) ? performance.now() : Date.now();

    sendBtn.disabled = true;
    setStatus("run", "enviando…");
    metaEl.textContent = method + " " + path;
    show("ok", "Esperando respuesta…");

    fetch(path, {
      method: method,
      headers: headers,
      body: body,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (res) {
      var elapsed = Math.round(((window.performance && performance.now)
        ? performance.now() : Date.now()) - started);
      var ctype = res.headers.get("content-type") || "sin content-type";

      return res.text().then(function (text) {
        var kind = res.ok ? "ok" : "warn";
        if (res.status >= 500) { kind = "err"; }
        setStatus(kind, res.status + " " + (res.statusText || ""));
        var hint = hintFor(res.status);
        metaEl.textContent = elapsed + " ms · " + ctype + (hint ? " " + hint : "");
        if (res.ok) {
          show("ok", pretty(text, ctype));
        } else {
          show(res.status >= 500 ? "err" : "warn", pretty(text, ctype));
        }
      });
    }).catch(function (err) {
      if (err && err.name === "AbortError") {
        setStatus("err", "tiempo agotado");
        metaEl.textContent = "90 s";
        show("err", "La petición superó los 90 s y se canceló.\n" +
          "La API puede estar arrancando o el validador de antivirus puede tardar.");
        return;
      }
      setStatus("err", "error de red");
      metaEl.textContent = window.location.origin;
      show("err",
        "No se pudo conectar con " + window.location.origin + path + ".\n\n" +
        "Causas habituales:\n" +
        "· La página está abierta como file:// o desde un estático sin proxy hacia la API.\n" +
        "· La API no está levantada en este origen (por defecto 127.0.0.1:3211).\n" +
        "· El servidor no tiene la ruta /jobs o /agents montada en el mismo origen.\n" +
        "· Mezcla de http/https o certificado no válido.\n\n" +
        "Detalle técnico: " + (err && err.message ? err.message : "fetch failed"));
    }).then(function () {
      window.clearTimeout(timer);
      sendBtn.disabled = false;
    });
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      send();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      setStatus("idle", "sin enviar");
      metaEl.textContent = "";
      outputEl.classList.remove("is-error", "is-ok");
      outputEl.textContent = DEFAULT_TEXT;
    });
  }

  if (bodyInput) {
    bodyInput.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        send();
      }
    });
  }

  /* Rellenar el probador desde una tarjeta de endpoint */
  $$(".try-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var card = btn.closest(".ep");
      if (!card || !methodInput || !pathInput) { return; }
      var bodyPre = $('pre[data-role="body"]', card);

      methodInput.value = card.getAttribute("data-method") || "GET";
      pathInput.value = card.getAttribute("data-path") || "/health";
      bodyInput.value = bodyPre ? bodyPre.textContent.replace(/\s+$/, "") : "";

      setStatus("idle", "sin enviar");
      metaEl.textContent = "";
      outputEl.classList.remove("is-error", "is-ok");
      outputEl.textContent = DEFAULT_TEXT;

      var target = document.getElementById("probar");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      window.setTimeout(function () {
        if (keyInput) { keyInput.focus({ preventScroll: true }); }
      }, 320);
    });
  });

  /* Índice activo */
  function markActive() {
    var links = $$(".toc-desktop a[href^='#']");
    if (!links.length || !("IntersectionObserver" in window)) { return; }

    var byId = {};
    links.forEach(function (a) {
      byId[a.getAttribute("href").slice(1)] = a;
    });

    var targets = Object.keys(byId)
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) { return; }
        links.forEach(function (a) { a.classList.remove("is-active"); });
        var active = byId[entry.target.id];
        if (active) { active.classList.add("is-active"); }
      });
    }, { rootMargin: "-15% 0px -70% 0px", threshold: 0 });

    targets.forEach(function (t) { obs.observe(t); });
  }

  function init() {
    enhanceCodeBlocks();
    markActive();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
