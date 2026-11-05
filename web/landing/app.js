/* HireAIJob — landing
   Sin dependencias. Datos reales desde la API del mismo origen:
     GET /jobs     encargos publicados
     GET /health   estado del escrow contable
     GET /chain    estado on-chain
   Si la API no responde, la página lo dice; no inventa cifras. */
'use strict';

(function () {
  document.documentElement.classList.add('js');

  // El movimiento va siempre activo, por petición de Leon (2026-11-05):
  // se ignora la preferencia del sistema de reducir animaciones.
  var reduce = false;
  var $ = function (id) { return document.getElementById(id); };
  var fmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  var ESTADOS = {
    created: 'sin fondear', funded: 'fondos retenidos', accepted: 'en curso',
    delivered: 'entregado', validating: 'validando', released: 'pagado',
    refunded: 'devuelto', disputed: 'en disputa', cancelled: 'cancelado',
  };

  /* ------------------------------------------------ 1. revelado al scroll */
  var reveals = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (reveals.length) {
    if (reduce || !('IntersectionObserver' in window)) {
      reveals.forEach(function (el) { el.classList.add('reveal', 'is-in'); });
    } else {
      reveals.forEach(function (el) { el.classList.add('reveal'); });
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          e.target.classList.add('is-in');
          obs.unobserve(e.target);
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
      reveals.forEach(function (el) {
        if (el.getBoundingClientRect().top < window.innerHeight * 0.95) {
          el.classList.add('is-in');
        } else {
          obs.observe(el);
        }
      });
      window.setTimeout(function () {
        reveals.forEach(function (el) { el.classList.add('is-in'); });
      }, 900);
    }
  }

  /* ------------------------------------------------ 2. tarjeta de escrow */
  var PASOS = [
    { estado: 'retenido', fill: 18, checks: 0, sha: 'pendiente', label: 'retenido' },
    { estado: 'validando', fill: 64, checks: 4, sha: 'ff31…a7be', label: 'validando' },
    { estado: 'liberado', fill: 100, checks: 7, sha: 'ff31…a7be', label: 'liberado' },
  ];
  var checks = Array.prototype.slice.call(document.querySelectorAll('#escrow-checks li'));
  var fill = $('escrow-fill');
  var pill = $('escrow-state');
  var sha = $('escrow-sha');
  var steps = Array.prototype.slice.call(document.querySelectorAll('.rail__steps em'));

  function pintarEscrow(i) {
    var p = PASOS[i % PASOS.length];
    if (fill) fill.style.width = p.fill + '%';
    if (pill) pill.textContent = p.estado;
    if (sha) sha.textContent = p.sha;
    steps.forEach(function (em, n) { em.classList.toggle('on', n <= i % PASOS.length); });
    checks.forEach(function (li, n) {
      var hecho = n < p.checks;
      li.classList.toggle('is-pass', hecho);
      var b = li.querySelector('b');
      if (!b) return;
      if (hecho) {
        b.textContent = n === 4 ? '0,50' : '1,00';
      } else {
        b.textContent = '—';
      }
    });
  }
  if (fill) {
    pintarEscrow(1);
    if (!reduce) {
      var i = 1;
      window.setInterval(function () { i += 1; pintarEscrow(i); }, 4200);
    }
  }

  /* ------------------------------------------------ 2b. cinta del mercado */
  var VALIDADORES = ['size', 'integrity', 'prompt_injection', 'malware', 'antivirus', 'syntax', 'requirements'];

  function itemCinta(o) {
    var el = document.createElement('span');
    el.className = 'tick' + (o.tipo === 'check' ? ' tick--check' : '');
    if (o.importe) {
      var b = document.createElement('b');
      b.textContent = o.importe;
      el.appendChild(b);
    }
    var txt = document.createElement('span');
    txt.textContent = o.texto;
    el.appendChild(txt);
    if (o.estado) {
      var em = document.createElement('i');
      em.textContent = o.estado;
      el.appendChild(em);
    }
    return el;
  }

  function datosCinta(lista) {
    var datos = [];
    (lista || []).slice(0, 6).forEach(function (t) {
      datos.push({
        tipo: 'job',
        importe: fmt.format(t.amount_usdc) + ' USDC',
        texto: t.title,
        estado: ESTADOS[t.state] || t.state,
      });
    });
    VALIDADORES.forEach(function (v) {
      datos.push({ tipo: 'check', texto: v, estado: '✓' });
    });
    return datos;
  }

  function montarCinta(lista) {
    var fila = $('ticker');
    if (!fila) return;
    fila.style.animation = 'none';
    fila.innerHTML = '';
    var datos = datosCinta(lista);
    var grupo = document.createElement('div');
    grupo.className = 'ticker__group';
    fila.appendChild(grupo);
    var vueltas = 0;
    do {
      datos.forEach(function (d) { grupo.appendChild(itemCinta(d)); });
      vueltas += 1;
    } while (grupo.scrollWidth < window.innerWidth * 1.2 && vueltas < 10);
    fila.appendChild(grupo.cloneNode(true));
    void fila.offsetWidth;
    fila.style.animation = '';
    fila.style.animationDuration = Math.max(18, grupo.scrollWidth / 62).toFixed(1) + 's';
  }

  var ultimoMercado = [];
  montarCinta(ultimoMercado);
  var temporizadorCinta = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(temporizadorCinta);
    temporizadorCinta = window.setTimeout(function () { montarCinta(ultimoMercado); }, 250);
  });

  /* ------------------------------------------------------- 3. el mercado */
  function tarjeta(t) {
    var art = document.createElement('article');
    art.className = 'job';

    var top = document.createElement('div');
    top.className = 'job__top';
    var est = document.createElement('span');
    est.className = 'job__state';
    est.dataset.s = t.state;
    est.textContent = ESTADOS[t.state] || t.state;
    var imp = document.createElement('p');
    imp.className = 'job__amount';
    imp.textContent = fmt.format(t.amount_usdc) + ' ';
    var usdc = document.createElement('small');
    usdc.textContent = 'USDC';
    imp.appendChild(usdc);
    top.appendChild(est);
    top.appendChild(imp);

    var h3 = document.createElement('h3');
    h3.textContent = t.title;

    var meta = document.createElement('p');
    meta.className = 'job__meta';
    var esp = (t.especialidades || []).slice(0, 2).join(' · ');
    meta.textContent = esp || 'sin especialidad';

    var link = document.createElement('a');
    link.className = 'job__link';
    link.href = '/panel/#/job/' + encodeURIComponent(t.id);
    link.textContent = 'Ver el encargo y sus validaciones →';

    art.appendChild(top);
    art.appendChild(h3);
    art.appendChild(meta);
    art.appendChild(link);
    return art;
  }

  function cargarMercado() {
    var caja = $('jobs');
    var cuenta = $('jobs-count');
    if (!caja) return;
    fetch('/jobs', { headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var lista = (d && d.trabajos) || [];
        ultimoMercado = lista;
        montarCinta(lista);
        caja.innerHTML = '';
        if (!lista.length) {
          var p = document.createElement('p');
          p.className = 'jobs__empty';
          p.textContent = 'Todavía no hay encargos publicados. El primero puedes ser tú.';
          caja.appendChild(p);
        } else {
          lista.slice(0, 6).forEach(function (t, i) {
            var el = tarjeta(t);
            el.style.animationDelay = (0.08 * i + 0.05) + 's';
            caja.appendChild(el);
          });
        }
        if (cuenta) {
          cuenta.textContent = lista.length
            ? lista.length + ' encargos · leído ahora de /jobs'
            : '0 encargos · leído ahora de /jobs';
        }
      })
      .catch(function (e) {
        caja.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'jobs__empty';
        p.textContent = 'No he podido leer el mercado (' + e.message + '). El panel sigue disponible.';
        caja.appendChild(p);
        if (cuenta) cuenta.textContent = 'sin datos';
      });
  }
  cargarMercado();

  /* ------------------------------------------------------ 4. estado real */
  fetch('/chain', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var el = $('foot-chain');
      if (!el) return;
      el.textContent = d && d.onchain
        ? 'contrato ' + String(d.escrow).slice(0, 10) + '… · ' + fmt.format(d.en_escrow_usdc || 0) + ' USDC retenidos'
        : 'modo simulación (sin fondos reales)';
    })
    .catch(function () {});

  /* ------------------------------------------------- 5. copiar el cURL */
  var copy = $('copy-btn');
  if (copy) {
    copy.addEventListener('click', function () {
      var pre = $('curl');
      if (!pre) return;
      var texto = pre.innerText;
      var hecho = function () {
        copy.textContent = 'Copiado';
        window.setTimeout(function () { copy.textContent = 'Copiar'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(hecho).catch(function () {
          copy.textContent = 'Copia a mano';
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = texto;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); hecho(); } catch (e) { copy.textContent = 'Copia a mano'; }
        document.body.removeChild(ta);
      }
    });
  }

  /* ======================================================== 6. movimiento */
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* 6.1 luz que sigue al puntero */
  var luz = $('cursor');
  if (luz && finePointer && !reduce) {
    var lx = -600, ly = -600, tx = -600, ty = -600, vivo = false;
    window.addEventListener('pointermove', function (e) {
      tx = e.clientX; ty = e.clientY;
      if (!vivo) { vivo = true; luz.classList.add('is-on'); }
    }, { passive: true });
    document.addEventListener('pointerleave', function () {
      vivo = false; luz.classList.remove('is-on');
    });
    (function seguir() {
      lx += (tx - lx) * 0.11;
      ly += (ty - ly) * 0.11;
      luz.style.transform = 'translate3d(' + lx.toFixed(1) + 'px,' + ly.toFixed(1) + 'px,0)';
      window.requestAnimationFrame(seguir);
    })();
  }

  /* 6.2 barra de progreso + paralaje de la placa */
  var barra = $('progress-bar');
  var pendiente = false;

  function medirScroll() {
    pendiente = false;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    if (barra) {
      barra.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0) + ')';
    }
  }

  window.addEventListener('scroll', function () {
    if (pendiente) return;
    pendiente = true;
    window.requestAnimationFrame(medirScroll);
  }, { passive: true });
  window.addEventListener('resize', medirScroll);
  medirScroll();

  /* 6.3 retardo escalonado del revelado */
  var porPadre = new Map();
  reveals.forEach(function (el) {
    var padre = el.parentNode;
    var n = porPadre.get(padre) || 0;
    porPadre.set(padre, n + 1);
    if (n < 6) el.style.setProperty('--d', (n * 0.075).toFixed(3) + 's');
  });

  /* 6.4 línea de los pasos */
  var pasos = document.querySelector('[data-steps]');
  if (pasos) {
    if (reduce || !('IntersectionObserver' in window)) {
      pasos.classList.add('is-in');
    } else {
      var obsPasos = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (e) {
          if (!e.isIntersecting) return;
          pasos.classList.add('is-in');
          obsPasos.disconnect();
        });
      }, { threshold: 0.18 });
      obsPasos.observe(pasos);
    }
  }

  /* 6.5 contadores de las cifras */
  var cifras = Array.prototype.slice.call(document.querySelectorAll('[data-count]'));
  function contar(el) {
    var fin = parseInt(el.getAttribute('data-count'), 10) || 0;
    var sufijo = el.getAttribute('data-suffix') || '';
    if (reduce) { el.textContent = fin + sufijo; return; }
    var t0 = null, dur = 1100;
    function paso(t) {
      if (!t0) t0 = t;
      var k = Math.min(1, (t - t0) / dur);
      var v = Math.round(fin * (1 - Math.pow(1 - k, 3)));
      el.textContent = v + sufijo;
      if (k < 1) window.requestAnimationFrame(paso);
    }
    el.textContent = '0' + sufijo;
    window.requestAnimationFrame(paso);
  }
  if (cifras.length) {
    if (!('IntersectionObserver' in window)) {
      cifras.forEach(contar);
    } else {
      var obsCifras = new IntersectionObserver(function (entradas) {
        entradas.forEach(function (e) {
          if (!e.isIntersecting) return;
          contar(e.target);
          obsCifras.unobserve(e.target);
        });
      }, { threshold: 0.7 });
      cifras.forEach(function (el) { obsCifras.observe(el); });
    }
  }

  /* 6.6 inclinación 3D de la tarjeta de escrow */
  var tarjetaEscrow = $('escrow');
  if (tarjetaEscrow && finePointer && !reduce) {
    tarjetaEscrow.addEventListener('pointermove', function (e) {
      var r = tarjetaEscrow.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      tarjetaEscrow.style.transform =
        'perspective(1100px) rotateY(' + (px * 7).toFixed(2) + 'deg) rotateX(' +
        (-py * 7).toFixed(2) + 'deg) translateY(-2px)';
      tarjetaEscrow.style.setProperty('--mx', ((px + 0.5) * 100).toFixed(1) + '%');
      tarjetaEscrow.style.setProperty('--my', ((py + 0.5) * 100).toFixed(1) + '%');
    });
    tarjetaEscrow.addEventListener('pointerleave', function () {
      tarjetaEscrow.style.transform = '';
    });
  }

  /* 6.7 foco que sigue al ratón en tarjetas */
  if (finePointer && !reduce) {
    var conFoco = Array.prototype.slice.call(document.querySelectorAll('[data-spot]'));
    conFoco.forEach(function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
      });
    });

    /* 6.8 botones magnéticos */
    Array.prototype.slice.call(document.querySelectorAll('.btn')).forEach(function (b) {
      b.addEventListener('pointermove', function (e) {
        var r = b.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) / r.width;
        var dy = (e.clientY - (r.top + r.height / 2)) / r.height;
        b.style.transform = 'translate(' + (dx * 4).toFixed(1) + 'px,' + (dy * 3).toFixed(1) + 'px)';
        b.style.transition = 'transform 0.12s linear';
      });
      b.addEventListener('pointerleave', function () {
        b.style.transform = '';
        b.style.transition = '';
      });
    });
  }

  /* 6.9 red de nodos del hero */
  var lienzo = $('net');
  if (lienzo && !reduce) {
    var ctx = lienzo.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var ancho = 0, alto = 0, nodos = [], rafRed = 0, visible = true;
    var puntero = { x: -999, y: -999 };

    function medirLienzo() {
      var r = lienzo.getBoundingClientRect();
      ancho = Math.max(1, r.width);
      alto = Math.max(1, r.height);
      lienzo.width = Math.round(ancho * dpr);
      lienzo.height = Math.round(alto * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var n = Math.round((ancho * alto) / 20000);
      n = Math.max(12, Math.min(34, n));
      nodos = [];
      for (var i = 0; i < n; i++) {
        nodos.push({
          x: Math.random() * ancho,
          y: Math.random() * alto,
          vx: (Math.random() - 0.5) * 0.28,
          vy: (Math.random() - 0.5) * 0.28,
          r: 0.7 + Math.random() * 1.5,
        });
      }
    }

    function dibujarRed() {
      ctx.clearRect(0, 0, ancho, alto);
      var d;
      for (var i = 0; i < nodos.length; i++) {
        var a = nodos[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > ancho) a.vx *= -1;
        if (a.y < 0 || a.y > alto) a.vy *= -1;
        a.x = Math.max(0, Math.min(ancho, a.x));
        a.y = Math.max(0, Math.min(alto, a.y));
        for (var j = i + 1; j < nodos.length; j++) {
          var b = nodos[j];
          var dx = a.x - b.x, dy = a.y - b.y;
          d = Math.sqrt(dx * dx + dy * dy);
          if (d < 118) {
            ctx.strokeStyle = 'rgba(94,234,212,' + ((1 - d / 118) * 0.22).toFixed(3) + ')';
            ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        var dxp = a.x - puntero.x, dyp = a.y - puntero.y;
        var dp = Math.sqrt(dxp * dxp + dyp * dyp);
        if (dp < 150) {
          ctx.strokeStyle = 'rgba(168,182,255,' + ((1 - dp / 150) * 0.34).toFixed(3) + ')';
          ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(puntero.x, puntero.y); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(94,234,212,' + (dp < 150 ? 0.9 : 0.55) + ')';
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
      }
      rafRed = window.requestAnimationFrame(dibujarRed);
    }

    function arrancarRed() {
      if (rafRed) return;
      rafRed = window.requestAnimationFrame(dibujarRed);
    }
    function pararRed() {
      if (!rafRed) return;
      window.cancelAnimationFrame(rafRed);
      rafRed = 0;
    }

    medirLienzo();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entradas) {
        visible = entradas[0].isIntersecting;
        if (visible) arrancarRed(); else pararRed();
      }, { threshold: 0.01 }).observe(lienzo);
    } else {
      arrancarRed();
    }
    window.addEventListener('resize', function () {
      pararRed(); medirLienzo(); if (visible) arrancarRed();
    });
    var visual = document.querySelector('.hero__visual');
    if (visual && finePointer) {
      visual.addEventListener('pointermove', function (e) {
        var r = lienzo.getBoundingClientRect();
        puntero.x = e.clientX - r.left;
        puntero.y = e.clientY - r.top;
      });
      visual.addEventListener('pointerleave', function () {
        puntero.x = -999; puntero.y = -999;
      });
    }
  }

  /* ------------------------------------------------------- 6. detalles */
  var y = $('year');
  if (y) y.textContent = String(new Date().getFullYear());
})();
