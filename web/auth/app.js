/* ============================================================
   HireAIJob — acceso
   Login · registro · panel de seguridad. Sin dependencias.
   Habla con el mismo origen: /auth/*
   ============================================================ */
'use strict';

(function () {
  // ---------------------------------------------------------------
  // Entorno
  // ---------------------------------------------------------------
  const hasServer = location.protocol === 'http:' || location.protocol === 'https:';
  const supportsWebAuthn = !!(
    window.PublicKeyCredential &&
    navigator.credentials &&
    typeof navigator.credentials.create === 'function'
  );
  const secureContext = window.isSecureContext !== false;

  const ROUTES = {
    login: { view: 'view-login', title: 'Entrar', focus: 'login-title' },
    registro: { view: 'view-register', title: 'Crear cuenta', focus: 'register-title' },
    seguridad: { view: 'view-security', title: 'Seguridad', focus: 'security-title' },
  };

  let pendingEmail = null; // correo del registro, para pedir opciones de passkey
  let loadingSecurity = false;

  // ---------------------------------------------------------------
  // Atajos DOM
  // ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const ROLE_LABELS = { buyer: 'Comprador', agent: 'Agente' };

  // ---------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------
  class ApiError extends Error {
    constructor(message, opts) {
      super(message);
      this.name = 'ApiError';
      this.network = !!(opts && opts.network);
      this.status = (opts && opts.status) || 0;
    }
  }

  async function api(method, path, payload) {
    if (!hasServer) {
      throw new ApiError(
        'Esta página está abierta como archivo local: no hay servidor al que enviar los datos. ' +
          'Ábrela desde la web (en /auth/) para poder entrar.',
        { network: true }
      );
    }

    const options = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };
    if (payload !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }

    let response;
    try {
      response = await fetch(path, options);
    } catch (err) {
      throw new ApiError(
        'No se pudo contactar con el servidor. Comprueba tu conexión: no sabemos si la acción llegó a guardarse.',
        { network: true }
      );
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();

    return {
      ok: response.ok,
      status: response.status,
      data,
      text,
      isJson: contentType.indexOf('json') !== -1 && data !== null,
      retryAfter: response.headers.get('Retry-After'),
    };
  }

  async function safeApi(method, path, payload) {
    try {
      return { res: await api(method, path, payload), error: null };
    } catch (err) {
      return { res: null, error: err };
    }
  }

  // ---------------------------------------------------------------
  // Mensajes de error: el texto del servidor manda
  // ---------------------------------------------------------------
  function serverMessage(res) {
    const data = res && res.data;
    if (data && typeof data === 'object') {
      const keys = ['motivo', 'detail', 'error', 'message', 'mensaje', 'descripcion'];
      for (let i = 0; i < keys.length; i += 1) {
        const value = data[keys[i]];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (Array.isArray(value)) {
          const parts = value
            .map((item) => {
              if (typeof item === 'string') return item;
              if (item && typeof item === 'object') return item.msg || item.message || '';
              return '';
            })
            .filter(Boolean);
          if (parts.length) return parts.join('\n');
        }
      }
    }
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (res && typeof res.text === 'string') {
      const raw = res.text.trim();
      if (raw && raw.charAt(0) !== '<' && raw.length <= 400) return raw;
    }
    return '';
  }

  function describeApiError(res) {
    const status = res ? res.status : 0;
    const raw = serverMessage(res);
    const info = {
      title: 'Error ' + status,
      message: raw,
      hint: '',
    };

    if (status === 400 || status === 422) {
      info.title = 'Datos rechazados';
      info.hint = 'Revisa los campos y vuelve a enviarlo tal como lo pide el mensaje de arriba.';
    } else if (status === 401) {
      info.title = 'Credenciales incorrectas';
      info.hint = 'El servidor no distingue si falla el correo o la contraseña. Revisa ambos.';
    } else if (status === 403) {
      info.title = 'Acceso denegado';
    } else if (status === 404) {
      info.title = 'No encontrado';
      info.hint = 'La ruta que hemos llamado no existe en este servidor.';
    } else if (status === 409) {
      info.title = 'Conflicto';
      info.hint = 'Si estabas registrándote, puede que ese correo ya tenga cuenta: prueba a entrar.';
    } else if (status === 423) {
      info.title = 'Cuenta bloqueada';
      info.hint = raw
        ? 'Ese es el motivo tal cual lo devuelve el servidor. Guárdalo: es lo que te pedirán en soporte.'
        : 'El servidor no ha indicado el motivo del bloqueo.';
    } else if (status === 429) {
      info.title = 'Demasiados intentos';
      const seconds = res && res.retryAfter ? parseInt(res.retryAfter, 10) : NaN;
      if (!Number.isNaN(seconds) && seconds > 0) {
        info.hint = 'El servidor pide esperar ' + seconds + ' s antes de reintentar.';
      } else {
        info.hint = 'El servidor no ha dicho cuánto falta. Espera unos minutos y vuelve a intentarlo.';
      }
    } else if (status >= 500) {
      info.title = 'El servidor ha fallado';
      info.hint = 'No es culpa de lo que has escrito. Inténtalo más tarde.';
    } else {
      info.hint = 'Respuesta HTTP ' + status + '.';
    }

    if (!info.message) {
      info.message = res && res.isJson
        ? 'El servidor no ha devuelto ningún texto de error.'
        : 'El servidor respondió con una página de error, no con datos.';
    }

    return info;
  }

  // ---------------------------------------------------------------
  // Avisos en pantalla
  // ---------------------------------------------------------------
  function clearSlot(node) {
    if (node) node.textContent = '';
  }

  function renderAlert(node, kind, opts) {
    if (!node) return;
    node.textContent = '';
    const o = opts || {};
    if (!o.title && !o.message) return;

    const box = document.createElement('div');
    box.className = 'alert alert--' + kind;
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    if (o.title) {
      const title = document.createElement('p');
      title.className = 'alert__title';
      title.textContent = o.title;
      box.appendChild(title);
    }
    if (o.message) {
      const message = document.createElement('p');
      message.className = 'alert__msg';
      message.textContent = o.message;
      box.appendChild(message);
    }
    if (o.hint) {
      const hint = document.createElement('p');
      hint.className = 'alert__hint';
      hint.textContent = o.hint;
      box.appendChild(hint);
    }
    if (o.action && o.action.href) {
      const link = document.createElement('a');
      link.className = 'alert__link';
      link.href = o.action.href;
      link.textContent = o.action.label || 'Continuar';
      box.appendChild(link);
    }

    node.appendChild(box);
  }

  function showApiError(node, res) {
    const info = describeApiError(res);
    renderAlert(node, res && res.status === 423 ? 'warn' : 'error', info);
  }

  function setFieldError(input, errorNode, message) {
    if (!input || !errorNode) return;
    if (message) {
      errorNode.textContent = message;
      errorNode.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      errorNode.textContent = '';
      errorNode.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = button.textContent.trim();
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = label || button.dataset.label;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.label) {
        button.textContent = button.dataset.label;
        delete button.dataset.label;
      }
    }
  }

  function setCardBusy(cardId, busy) {
    const card = $(cardId);
    if (card) card.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // ---------------------------------------------------------------
  // Validación local (solo formato; las reglas duras son del servidor)
  // ---------------------------------------------------------------
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function isEmail(value) {
    return EMAIL_RE.test(String(value || '').trim());
  }

  // ---------------------------------------------------------------
  // Fuerza de contraseña (entropía estimada de verdad)
  // ---------------------------------------------------------------
  const COMMON_PASSWORDS = new Set([
    '123456', '123456789', '12345678', '1234567', '12345', '1234',
    'qwerty', 'qwerty123', 'qwertyuiop', 'asdfgh', 'zxcvbn', '1q2w3e',
    'password', 'password1', 'passw0rd', 'p@ssw0rd', 'contraseña',
    '111111', '000000', '123123', '123321', '654321', '121212',
    'abc123', '123456a', 'aa123456', 'admin', 'admin123', 'root',
    'welcome', 'welcome1', 'monkey', 'letmein', 'dragon', 'football',
    'baseball', 'sunshine', 'master', 'shadow', 'superman', 'michael',
    'trustno1', 'iloveyou', 'princess', 'hola123', 'españa', 'barcelona',
    'madrid', 'futbol', 'usuario', 'prueba123', 'bandit', 'login',
  ]);

  function isCommonPassword(value) {
    const lower = value.toLowerCase();
    const alnum = lower.replace(/[^a-z0-9]/g, '');
    const bare = alnum.replace(/[0-9]+$/, '');
    return (
      COMMON_PASSWORDS.has(lower) ||
      COMMON_PASSWORDS.has(alnum) ||
      (bare.length >= 4 && COMMON_PASSWORDS.has(bare))
    );
  }

  function hasSequence(value) {
    const s = value.toLowerCase();
    if (/(qwert|asdf|zxcv|qazwsx|wsxedc|12345|09876|abcdef|aaaa|1111)/.test(s)) return true;
    for (let i = 0; i + 2 < s.length; i += 1) {
      const a = s.charCodeAt(i);
      const b = s.charCodeAt(i + 1);
      const c = s.charCodeAt(i + 2);
      if (a === b && b === c) return true;
      if ((b === a + 1 && c === b + 1) || (b === a - 1 && c === b - 1)) return true;
    }
    return false;
  }

  function analyzePassword(value) {
    const pw = String(value || '');
    const chars = Array.from(pw);
    const length = chars.length;
    if (!length) {
      return { score: 0, bits: 0, label: 'Sin contraseña', met: {} };
    }

    const lower = /[a-z]/.test(pw);
    const upper = /[A-Z]/.test(pw);
    const digit = /\d/.test(pw);
    const symbol = /[^A-Za-z0-9]/.test(pw);

    let pool = 0;
    if (lower) pool += 26;
    if (upper) pool += 26;
    if (digit) pool += 10;
    if (symbol) pool += 33;
    if (!pool) pool = 1;

    const unique = new Set(chars).size;
    const ratio = unique / length;
    let bits = length * Math.log2(pool);

    // Las frases largas repiten letras a propósito: solo penalizamos la
    // repetición cuando la contraseña es corta.
    if (length < 16) {
      if (ratio < 0.5) bits *= 0.55;
      else if (ratio < 0.7) bits *= 0.85;
    }
    if (hasSequence(pw)) bits *= 0.8;

    const common = isCommonPassword(pw);
    if (common) bits = Math.min(bits, 16);
    bits = Math.max(0, Math.round(bits));

    let score;
    if (common || bits < 26) score = 1;
    else if (bits < 42) score = 2;
    else if (bits < 60) score = 3;
    else score = 4;

    if (length < 8) score = Math.min(score, 1);
    else if (length < 12) score = Math.min(score, 3);

    return {
      score,
      bits,
      label: ['Sin contraseña', 'Muy débil', 'Débil', 'Buena', 'Fuerte'][score],
      met: {
        len: length >= 12,
        case: lower && upper,
        digit,
        symbol,
        nocommon: !common,
      },
    };
  }

  function updateStrength(value) {
    const wrapper = $('pw-strength');
    if (!wrapper) return;
    const result = analyzePassword(value);

    wrapper.dataset.score = String(result.score);
    $('pw-strength-text').textContent = result.label;
    $('pw-bits').textContent = result.bits > 0 ? '≈ ' + result.bits + ' bits' : '';

    const meter = $('pw-meter');
    meter.setAttribute('aria-valuenow', String(result.score));
    meter.setAttribute(
      'aria-valuetext',
      result.bits > 0
        ? result.label + ', unos ' + result.bits + ' bits de entropía estimada'
        : 'Sin contraseña'
    );

    const reqs = $('pw-reqs');
    if (reqs) {
      reqs.querySelectorAll('li[data-req]').forEach((item) => {
        const key = item.dataset.req;
        const met = !!result.met[key];
        item.dataset.met = met ? 'true' : 'false';
        const mark = item.querySelector('.reqs__mark');
        if (mark) mark.textContent = met ? '✓' : '○';
      });
    }
  }

  // ---------------------------------------------------------------
  // Router por hash
  // ---------------------------------------------------------------
  function routeFromHash() {
    const raw = (location.hash || '')
      .replace(/^#\/?/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (!raw) return 'login';
    if (['login', 'entrar', 'acceso'].indexOf(raw) !== -1) return 'login';
    if (['registro', 'register', 'crear', 'crear-cuenta', 'signup'].indexOf(raw) !== -1) return 'registro';
    if (['seguridad', 'security', 'panel', 'cuenta', 'dispositivos'].indexOf(raw) !== -1) return 'seguridad';
    return 'login';
  }

  function showView(name, moveFocus) {
    const route = ROUTES[name] || ROUTES.login;

    Object.keys(ROUTES).forEach((key) => {
      const node = $(ROUTES[key].view);
      if (node) node.hidden = key !== name;
    });

    document.querySelectorAll('[data-nav]').forEach((link) => {
      if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    document.title = route.title + ' · HireAIJob';

    if (moveFocus !== false) {
      window.scrollTo(0, 0);
      const heading = $(route.focus);
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  function onRoute(isInitial) {
    const name = routeFromHash();
    showView(name, !isInitial);
    if (name === 'seguridad') loadSecurity();
  }

  // ---------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------
  function validateLogin() {
    const email = $('login-email');
    const password = $('login-password');
    let firstBad = null;

    if (!isEmail(email.value)) {
      setFieldError(
        email,
        $('login-email-error'),
        email.value.trim() ? 'Ese correo no tiene un formato válido (algo@dominio.com).' : 'Escribe tu correo.'
      );
      firstBad = firstBad || email;
    } else {
      setFieldError(email, $('login-email-error'), '');
    }

    if (!password.value) {
      setFieldError(password, $('login-password-error'), 'Escribe tu contraseña.');
      firstBad = firstBad || password;
    } else {
      setFieldError(password, $('login-password-error'), '');
    }

    if (firstBad) {
      firstBad.focus();
      return false;
    }
    return true;
  }

  async function onSubmitLogin(event) {
    event.preventDefault();
    const alertSlot = $('login-alert');
    const button = $('login-submit');
    clearSlot(alertSlot);

    if (!validateLogin()) return;

    setBusy(button, true, 'Entrando…');

    try {
      const res = await api('POST', '/auth/login', {
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      });

      if (!res.ok) {
        showApiError(alertSlot, res);
        if (res.status === 429 || res.status === 423) {
          $('login-email').focus();
        } else {
          $('login-password').select();
        }
        return;
      }

      if (!res.isJson || !res.data || res.data.ok === false) {
        renderAlert(alertSlot, 'warn', {
          title: 'No sabemos si has entrado',
          message:
            'El servidor respondió ' +
            res.status +
            ' pero sin los datos de sesión esperados. Recarga y mira el panel de seguridad antes de continuar.',
          action: { label: 'Comprobar mi sesión', href: '#/seguridad' },
        });
        return;
      }

      $('login-form').reset();
      clearSlot(alertSlot);
      location.hash = '#/seguridad';
    } catch (err) {
      renderAlert(alertSlot, 'error', {
        title: err && err.network ? 'Sin conexión con el servidor' : 'Error inesperado',
        message: (err && err.message) || 'No se pudo completar el acceso.',
      });
    } finally {
      setBusy(button, false);
    }
  }

  // ---------------------------------------------------------------
  // Registro
  // ---------------------------------------------------------------
  function validateRegister() {
    const email = $('reg-email');
    const password = $('reg-password');
    const name = $('reg-name');
    const terms = $('reg-terms');
    const role = document.querySelector('input[name="role"]:checked');
    let firstBad = null;

    if (!isEmail(email.value)) {
      setFieldError(
        email,
        $('reg-email-error'),
        email.value.trim() ? 'Ese correo no tiene un formato válido (algo@dominio.com).' : 'Escribe tu correo.'
      );
      firstBad = firstBad || email;
    } else {
      setFieldError(email, $('reg-email-error'), '');
    }

    if (!password.value) {
      setFieldError(password, $('reg-password-error'), 'Escribe una contraseña.');
      firstBad = firstBad || password;
    } else if (password.value.length < 8) {
      setFieldError(password, $('reg-password-error'), 'Mínimo 8 caracteres. Con 12 o más es mucho mejor.');
      firstBad = firstBad || password;
    } else {
      setFieldError(password, $('reg-password-error'), '');
    }

    if (!name.value.trim()) {
      setFieldError(name, $('reg-name-error'), 'Escribe el nombre con el que quieres aparecer.');
      firstBad = firstBad || name;
    } else {
      setFieldError(name, $('reg-name-error'), '');
    }

    if (!role) {
      $('reg-role-error').textContent = 'Elige comprador o agente.';
      $('reg-role-error').hidden = false;
      firstBad = firstBad || document.querySelector('input[name="role"]');
    } else {
      $('reg-role-error').textContent = '';
      $('reg-role-error').hidden = true;
    }

    if (!terms.checked) {
      $('reg-terms-error').textContent = 'Tienes que aceptar los términos para crear la cuenta.';
      $('reg-terms-error').hidden = false;
      firstBad = firstBad || terms;
    } else {
      $('reg-terms-error').textContent = '';
      $('reg-terms-error').hidden = true;
    }

    if (firstBad) {
      firstBad.focus();
      return false;
    }
    return true;
  }

  async function onSubmitRegister(event) {
    event.preventDefault();
    const alertSlot = $('register-alert');
    const button = $('register-submit');
    clearSlot(alertSlot);

    if (!validateRegister()) return;

    const email = $('reg-email').value.trim();
    const roleInput = document.querySelector('input[name="role"]:checked');

    setBusy(button, true, 'Creando cuenta…');

    try {
      const res = await api('POST', '/auth/register', {
        email,
        password: $('reg-password').value,
        name: $('reg-name').value.trim(),
        role: roleInput ? roleInput.value : 'buyer',
      });

      if (!res.ok) {
        showApiError(alertSlot, res);
        if (res.status === 409) $('reg-email').focus();
        return;
      }

      if (!res.isJson || !res.data || res.data.ok === false) {
        renderAlert(alertSlot, 'warn', {
          title: 'No sabemos si la cuenta se creó',
          message:
            'El servidor respondió ' +
            res.status +
            ' pero sin confirmación con identificador. No vuelvas a enviar el formulario a ciegas: ' +
            'prueba a entrar con ese correo.',
          action: { label: 'Ir a entrar', href: '#/login' },
        });
        return;
      }

      pendingEmail = email;
      $('register-form').reset();
      updateStrength('');
      $('register-form').hidden = true;
      $('register-switch').hidden = true;
      $('register-done').hidden = false;

      const userId = res.data.user_id || '';
      const idNode = $('register-done-id');
      idNode.textContent = '';
      if (userId) {
        idNode.appendChild(document.createTextNode('Identificador de cuenta: '));
        const code = document.createElement('span');
        code.className = 'mono';
        code.textContent = String(userId);
        idNode.appendChild(code);
        idNode.hidden = false;
      } else {
        idNode.hidden = true;
      }

      $('register-done-text').textContent =
        'Ya puedes entrar. Antes de operar, la cuenta puede pasar por revisión manual.';
      $('register-done').scrollIntoView({ block: 'start', behavior: 'auto' });
    } catch (err) {
      renderAlert(alertSlot, 'error', {
        title: err && err.network ? 'Sin conexión con el servidor' : 'Error inesperado',
        message: (err && err.message) || 'No se pudo crear la cuenta.',
      });
    } finally {
      setBusy(button, false);
    }
  }

  // ---------------------------------------------------------------
  // WebAuthn
  // ---------------------------------------------------------------
  function b64urlToBytes(value) {
    if (typeof value !== 'string' || !value) {
      throw new Error('El servidor envió un valor binario vacío o mal formado.');
    }
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToB64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function serializeAttestation(credential) {
    const response = credential.response || {};
    const payload = {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        attestationObject: bytesToB64url(response.attestationObject),
      },
      clientExtensionResults:
        typeof credential.getClientExtensionResults === 'function'
          ? credential.getClientExtensionResults()
          : {},
    };
    if (credential.authenticatorAttachment) {
      payload.authenticatorAttachment = credential.authenticatorAttachment;
    }
    if (typeof response.getTransports === 'function') {
      payload.response.transports = response.getTransports();
    }
    return payload;
  }

  function webauthnErrorText(err) {
    const name = (err && err.name) || '';
    const message = (err && err.message) || '';
    if (name === 'NotAllowedError') {
      return 'Se canceló o el dispositivo no confirmó la passkey. No se ha creado nada.';
    }
    if (name === 'InvalidStateError') {
      return 'Este dispositivo ya tiene una passkey registrada para esta cuenta. No hace falta crear otra.';
    }
    if (name === 'NotSupportedError') {
      return 'Este dispositivo o navegador no admite el tipo de passkey que pide el servidor.';
    }
    if (name === 'SecurityError') {
      return 'El navegador ha bloqueado WebAuthn por seguridad. Comprueba que la conexión sea HTTPS.';
    }
    if (name === 'AbortError') {
      return 'La operación se interrumpió antes de terminar. No se ha creado nada.';
    }
    if (name === 'ConstraintError') {
      return 'El autenticador no cumple los requisitos que pide el servidor.';
    }
    return 'No se pudo crear la passkey' + (name ? ' (' + name + (message ? ': ' + message : '') + ')' : '') + '.';
  }

  function supportNotice() {
    if (!supportsWebAuthn) {
      return (
        'Este navegador no permite passkeys: no expone WebAuthn. Puedes usar la cuenta con contraseña, ' +
        'pero tendrás menos protección si esa contraseña se filtra.'
      );
    }
    if (!secureContext) {
      return (
        'WebAuthn necesita una conexión segura (HTTPS o localhost). Desde esta dirección el navegador ' +
        'no ofrecerá passkeys.'
      );
    }
    return '';
  }

  async function createPasskey(options) {
    const opts = options || {};
    const msgSlot = opts.msgSlot;
    const button = opts.button;
    const email = opts.email || null;

    clearSlot(msgSlot);

    const notice = supportNotice();
    if (notice) {
      renderAlert(msgSlot, 'warn', { title: 'Passkeys no disponibles aquí', message: notice });
      if (button) button.disabled = true;
      return;
    }

    setBusy(button, true, 'Esperando al dispositivo…');
    let created = false;

    try {
      const optionsRes = await api('POST', '/auth/passkey/options', email ? { email } : {});
      if (!optionsRes.ok || !optionsRes.isJson) {
        if (optionsRes.status === 401 || optionsRes.status === 403) {
          renderAlert(msgSlot, 'info', {
            title: 'La sesión no está abierta',
            message:
              'El servidor no reconoce una sesión para pedir la passkey (HTTP ' + optionsRes.status + ').',
            hint: 'Si acabas de registrarte, entra con tu contraseña y añade la passkey desde el panel de seguridad.',
            action: { label: 'Ir a entrar', href: '#/login' },
          });
          return;
        }
        showApiError(msgSlot, optionsRes);
        return;
      }

      const data = optionsRes.data || {};
      const publicKey = data.publicKey || data.options || data;
      if (!publicKey || !publicKey.challenge || !publicKey.user || !publicKey.user.id) {
        renderAlert(msgSlot, 'error', {
          title: 'Opciones de passkey incompletas',
          message:
            'El servidor no devolvió challenge y user.id en el formato esperado. No se ha creado nada.',
        });
        return;
      }

      const prepared = Object.assign({}, publicKey, {
        challenge: b64urlToBytes(publicKey.challenge),
        user: Object.assign({}, publicKey.user, { id: b64urlToBytes(publicKey.user.id) }),
      });

      if (Array.isArray(publicKey.excludeCredentials)) {
        prepared.excludeCredentials = publicKey.excludeCredentials.map((item) =>
          Object.assign({}, item, { id: b64urlToBytes(item.id) })
        );
      }

      let credential;
      try {
        credential = await navigator.credentials.create({ publicKey: prepared });
      } catch (err) {
        renderAlert(msgSlot, 'error', {
          title: 'Passkey cancelada',
          message: webauthnErrorText(err),
        });
        return;
      }

      if (!credential) {
        renderAlert(msgSlot, 'error', {
          title: 'Sin credencial',
          message: 'El navegador no devolvió ninguna credencial. No se ha creado nada.',
        });
        return;
      }

      const payload = serializeAttestation(credential);
      // El backend puede esperar la credencial dentro de "credential" o en la raíz.
      // Mandamos las dos formas para que acepte cualquiera de las dos sin romper.
      const verifyBody = Object.assign({ credential: payload }, payload);

      const verifyRes = await api('POST', '/auth/passkey/verify', verifyBody);
      if (!verifyRes.ok || (verifyRes.isJson && verifyRes.data && verifyRes.data.ok === false)) {
        showApiError(msgSlot, verifyRes);
        return;
      }

      created = true;
      if (button) {
        button.disabled = true;
        button.removeAttribute('aria-busy');
        button.textContent = 'Passkey creada';
      }
      renderAlert(msgSlot, 'ok', {
        title: 'Passkey creada en este dispositivo',
        message:
          'A partir de ahora este equipo puede verificar quién eres sin depender solo de la contraseña. ' +
          'Puedes revocarla cuando quieras desde el panel de seguridad.',
      });

      if (typeof opts.onSuccess === 'function') await opts.onSuccess();
    } catch (err) {
      renderAlert(msgSlot, 'error', {
        title: err && err.network ? 'Sin conexión con el servidor' : 'No se pudo crear la passkey',
        message: (err && err.message) || 'Error inesperado.',
        hint:
          err && err.network
            ? 'No sabemos si el dispositivo quedó registrado. Comprueba la lista de dispositivos al volver.'
            : '',
      });
    } finally {
      if (!created && button) setBusy(button, false);
    }
  }

  // ---------------------------------------------------------------
  // Panel de seguridad
  // ---------------------------------------------------------------
  function estadoInfo(raw) {
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    const key = value.toLowerCase().replace(/[\s-]/g, '_');

    if (!value) return { label: 'Sin dato', state: 'unknown', raw: false };
    if (['verificada', 'verificado', 'verified'].indexOf(key) !== -1) {
      return { label: 'Verificada', state: 'ok', raw: false };
    }
    if (['en_revision', 'revision', 'review', 'pending', 'pendiente', 'en_proceso'].indexOf(key) !== -1) {
      return { label: 'En revisión', state: 'warn', raw: false };
    }
    if (['bloqueada', 'bloqueado', 'locked', 'blocked', 'suspendida', 'suspended'].indexOf(key) !== -1) {
      return { label: 'Bloqueada', state: 'danger', raw: false };
    }
    return { label: value, state: 'unknown', raw: true };
  }

  function formatDate(value) {
    if (value === null || value === undefined || value === '') return '';
    let date;
    if (typeof value === 'number') {
      date = new Date(value > 1e12 ? value : value * 1000);
    } else {
      date = new Date(value);
    }
    if (Number.isNaN(date.getTime())) return String(value);
    try {
      return new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch (err) {
      return date.toISOString();
    }
  }

  function trustLabel(value) {
    if (value === true) return 'Sí';
    if (value === false) return 'No';
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    return 'No viene en la respuesta';
  }

  function showCuentaUnavailable(text) {
    const loading = $('cuenta-loading');
    loading.textContent = text;
    loading.hidden = false;
    $('cuenta-facts').hidden = true;
    $('cuenta-note').hidden = true;
    setCardBusy('cuenta-card', false);
  }

  function showDevicesUnavailable(text) {
    const loading = $('devices-loading');
    loading.textContent = text;
    loading.hidden = false;
    $('devices-list').hidden = true;
    $('devices-empty').hidden = true;
    $('devices-count').hidden = true;
    setCardBusy('devices-card', false);
  }

  function renderCuenta(user) {
    const notes = [];
    const estadoRaw = user.estado !== undefined ? user.estado : user.status;
    const estado = estadoInfo(estadoRaw);

    $('fact-name').textContent = user.name || user.nombre || 'No viene en la respuesta';
    $('fact-email').textContent = user.email || 'No viene en la respuesta';

    const roleValue = user.role || user.rol;
    $('fact-role').textContent = roleValue
      ? ROLE_LABELS[roleValue] || String(roleValue)
      : 'No viene en la respuesta';

    const idNode = $('fact-id');
    const userId = user.user_id !== undefined ? user.user_id : user.id;
    idNode.textContent = userId !== undefined && userId !== null && userId !== '' ? String(userId) : 'No viene en la respuesta';

    const pill = $('fact-estado');
    pill.textContent = estado.label;
    pill.dataset.state = estado.state;

    const trustRaw = user.device_trust !== undefined ? user.device_trust : user.trust;
    $('fact-device').textContent = trustLabel(trustRaw);

    if (estado.raw) {
      notes.push(
        'El servidor devolvió el estado «' +
          estado.label +
          '», que esta pantalla no reconoce. Se muestra tal cual, sin traducirlo.'
      );
    }
    if (trustRaw === undefined || trustRaw === null) {
      notes.push(
        'La respuesta no incluye «device_trust»: no sabemos si este dispositivo está vinculado con passkey.'
      );
    }

    const note = $('cuenta-note');
    note.textContent = notes.join(' ');
    note.hidden = notes.length === 0;

    $('cuenta-loading').hidden = true;
    $('cuenta-facts').hidden = false;
    setCardBusy('cuenta-card', false);
  }

  function devicesFrom(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return null;
    const keys = ['devices', 'dispositivos', 'items', 'results', 'data', 'lista'];
    for (let i = 0; i < keys.length; i += 1) {
      if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return null;
  }

  function normalizeDevice(item) {
    const d = item && typeof item === 'object' ? item : {};
    return {
      id: d.id !== undefined ? d.id : d.device_id !== undefined ? d.device_id : d.uuid,
      name: d.nombre || d.name || d.label || d.device_name || '',
      createdAt: d.created_at || d.creado || d.vinculado_en || d.created || null,
      lastUsed: d.last_used_at || d.ultimo_uso || d.last_used || d.last_seen || null,
      trust: d.device_trust !== undefined ? d.device_trust : d.trust_level !== undefined ? d.trust_level : d.trusted,
      current: d.current === true || d.is_current === true || d.es_actual === true,
    };
  }

  function makeButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  function deviceNode(device) {
    const li = document.createElement('li');
    li.className = 'device';

    const main = document.createElement('div');
    main.className = 'device__main';

    const name = document.createElement('p');
    name.className = 'device__name';
    name.textContent = device.name || 'Dispositivo sin nombre';
    if (device.current) {
      const badge = document.createElement('span');
      badge.className = 'device__current';
      badge.textContent = 'este dispositivo';
      name.appendChild(badge);
    }
    main.appendChild(name);

    const metaBits = [];
    if (!device.name) metaBits.push('El servidor no dio nombre para este dispositivo.');
    if (device.createdAt) metaBits.push('Vinculado el ' + formatDate(device.createdAt));
    if (device.lastUsed) metaBits.push('Último uso ' + formatDate(device.lastUsed));
    if (device.trust !== undefined) metaBits.push('Confianza: ' + trustLabel(device.trust));

    if (metaBits.length) {
      const meta = document.createElement('p');
      meta.className = 'device__meta';
      metaBits.forEach((bit, index) => {
        if (index) meta.appendChild(document.createTextNode(' · '));
        meta.appendChild(document.createTextNode(bit));
      });
      main.appendChild(meta);
    }

    if (device.id !== undefined && device.id !== null && device.id !== '') {
      const idNode = document.createElement('p');
      idNode.className = 'device__id mono';
      idNode.textContent = 'ID: ' + String(device.id);
      main.appendChild(idNode);
    }

    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'device__actions';

    if (device.id === undefined || device.id === null || device.id === '') {
      const note = document.createElement('p');
      note.className = 'device__confirm';
      note.textContent = 'Sin identificador: no se puede revocar desde aquí.';
      actions.appendChild(note);
    } else {
      const revoke = makeButton('Revocar', 'btn btn--ghost btn--sm');
      revoke.addEventListener('click', () => startRevoke(device, actions, revoke));
      actions.appendChild(revoke);
    }

    li.appendChild(actions);
    return li;
  }

  function startRevoke(device, actions, trigger) {
    actions.textContent = '';

    const question = document.createElement('span');
    question.className = 'device__confirm';
    question.textContent = '¿Revocar?';
    actions.appendChild(question);

    const confirm = makeButton('Sí, revocar', 'btn btn--danger btn--sm');
    const cancel = makeButton('Cancelar', 'btn btn--ghost btn--sm');
    actions.appendChild(confirm);
    actions.appendChild(cancel);

    cancel.addEventListener('click', () => {
      actions.textContent = '';
      actions.appendChild(trigger);
      trigger.focus();
    });

    confirm.addEventListener('click', () => revokeDevice(device, confirm, cancel));
  }

  async function revokeDevice(device, confirmButton, cancelButton) {
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    confirmButton.textContent = 'Revocando…';

    const result = await safeApi(
      'POST',
      '/auth/devices/' + encodeURIComponent(String(device.id)) + '/revoke'
    );

    if (result.error) {
      renderAlert($('security-alert'), 'error', {
        title: 'Sin conexión con el servidor',
        message: result.error.message,
        hint: 'No sabemos si el dispositivo se revocó. Pulsa «Actualizar» antes de dar nada por hecho.',
      });
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      confirmButton.textContent = 'Sí, revocar';
      return;
    }

    if (!result.res.ok) {
      showApiError($('security-alert'), result.res);
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      confirmButton.textContent = 'Sí, revocar';
      return;
    }

    const refreshed = await loadSecurity();
    if (refreshed) {
      renderAlert($('security-alert'), 'ok', {
        title: 'Dispositivo revocado',
        message:
          'Ese equipo ya no puede usar su passkey para entrar. Si tenía una sesión abierta, puede seguir ' +
          'hasta que caduque: si sospechas que alguien está dentro, cambia la contraseña.',
      });
    } else {
      renderAlert($('security-alert'), 'warn', {
        title: 'Dispositivo revocado, pero el panel no se recargó',
        message: 'El servidor confirmó la revocación. Lo que ves en la lista puede estar desactualizado.',
        hint: 'Pulsa «Actualizar» para comprobar el estado real.',
      });
    }
  }

  function renderDevices(list) {
    const ul = $('devices-list');
    ul.textContent = '';
    $('devices-loading').hidden = true;
    $('devices-empty').hidden = true;

    if (!list.length) {
      ul.hidden = true;
      $('devices-empty').hidden = false;
      $('devices-count').hidden = true;
      setCardBusy('devices-card', false);
      return;
    }

    list.forEach((item) => {
      ul.appendChild(deviceNode(normalizeDevice(item)));
    });
    ul.hidden = false;

    const count = $('devices-count');
    count.textContent = list.length + (list.length === 1 ? ' dispositivo' : ' dispositivos');
    count.hidden = false;
    setCardBusy('devices-card', false);
  }

  async function loadSecurity() {
    if (loadingSecurity) return;
    loadingSecurity = true;

    try {
      clearSlot($('security-alert'));
      setCardBusy('cuenta-card', true);
      setCardBusy('devices-card', true);

      $('cuenta-facts').hidden = true;
      $('cuenta-note').hidden = true;
      $('cuenta-loading').hidden = false;
      $('cuenta-loading').textContent = 'Cargando…';
      $('devices-list').hidden = true;
      $('devices-list').textContent = '';
      $('devices-empty').hidden = true;
      $('devices-count').hidden = true;
      $('devices-loading').hidden = false;
      $('devices-loading').textContent = 'Cargando…';

      if (!hasServer) {
        const message =
          'Esta página está abierta como archivo local, así que no hay sesión que consultar. ' +
          'Ábrela desde la web (en /auth/) para ver el panel.';
        renderAlert($('security-alert'), 'error', { title: 'Sin servidor', message });
        showCuentaUnavailable('Sin servidor: no hay estado de cuenta que mostrar.');
        showDevicesUnavailable('Sin servidor: no hay dispositivos que mostrar.');
        return;
      }

      const me = await safeApi('GET', '/auth/me');

      if (me.error) {
        renderAlert($('security-alert'), 'error', {
          title: 'Sin conexión con el servidor',
          message: me.error.message,
          hint: 'No mostramos datos de ejemplo: sin respuesta, el panel se queda vacío.',
        });
        showCuentaUnavailable('No hemos podido cargar la cuenta: el servidor no responde.');
        showDevicesUnavailable('No hemos podido cargar los dispositivos: el servidor no responde.');
        return;
      }

      const meRes = me.res;

      if (meRes.status === 401 || meRes.status === 403) {
        renderAlert($('security-alert'), 'info', {
          title: 'No hay sesión activa',
          message: 'El servidor no reconoce ninguna sesión en este navegador (HTTP ' + meRes.status + ').',
          hint: 'Entra con tu correo y contraseña para ver el estado de la cuenta y sus dispositivos.',
          action: { label: 'Ir a entrar', href: '#/login' },
        });
        showCuentaUnavailable('Sin sesión: no hay estado de cuenta que mostrar.');
        showDevicesUnavailable('Sin sesión: no hay dispositivos que mostrar.');
        return;
      }

      if (!meRes.ok || !meRes.isJson || !meRes.data) {
        const info = describeApiError(meRes);
        renderAlert($('security-alert'), 'error', info);
        showCuentaUnavailable(
          'No hemos podido cargar tu cuenta (' + meRes.status + '). No mostramos datos de ejemplo.'
        );
        showDevicesUnavailable('No hemos podido cargar los dispositivos (' + meRes.status + ').');
        return;
      }

      const user = meRes.data.user && typeof meRes.data.user === 'object' ? meRes.data.user : meRes.data;
      renderCuenta(user);

      const devices = await safeApi('GET', '/auth/devices');

      if (devices.error) {
        showDevicesUnavailable('No hemos podido cargar los dispositivos: ' + devices.error.message);
        return;
      }

      if (!devices.res.ok || !devices.res.isJson) {
        const info = describeApiError(devices.res);
        showDevicesUnavailable(
          'No hemos podido cargar los dispositivos (HTTP ' +
            devices.res.status +
            '). ' +
            (info.message || '')
        );
        return;
      }

      const list = devicesFrom(devices.res.data);
      if (list === null) {
        showDevicesUnavailable(
          'El servidor respondió sin una lista de dispositivos. No interpretamos la respuesta.'
        );
        return;
      }

      renderDevices(list);
      return true;
    } finally {
      loadingSecurity = false;
    }
  }

  function resetSecurityData() {
    $('cuenta-facts').hidden = true;
    $('cuenta-loading').hidden = false;
    $('cuenta-loading').textContent = 'Cargando…';
    $('cuenta-note').hidden = true;
    $('devices-list').textContent = '';
    $('devices-list').hidden = true;
    $('devices-empty').hidden = true;
    $('devices-count').hidden = true;
    $('devices-loading').hidden = false;
    $('devices-loading').textContent = 'Cargando…';
    setCardBusy('cuenta-card', false);
    setCardBusy('devices-card', false);
  }

  async function onLogout() {
    const button = $('logout-btn');
    const alertSlot = $('security-alert');
    clearSlot(alertSlot);
    setBusy(button, true, 'Saliendo…');

    try {
      const res = await api('POST', '/auth/logout');
      if (!res.ok && res.status !== 401) {
        showApiError(alertSlot, res);
        return;
      }
      resetSecurityData();
      location.hash = '#/login';
      renderAlert($('login-alert'), 'info', {
        title: 'Sesión cerrada',
        message: 'Puedes volver a entrar cuando quieras.',
      });
    } catch (err) {
      renderAlert(alertSlot, 'error', {
        title: err && err.network ? 'Sin conexión con el servidor' : 'No se pudo cerrar la sesión',
        message: (err && err.message) || 'Error inesperado.',
        hint: 'No sabemos si la sesión sigue abierta. Recarga la página para comprobarlo.',
      });
    } finally {
      setBusy(button, false);
    }
  }

  // ---------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------
  function setupPasswordToggles() {
    document.querySelectorAll('[data-toggle-password]').forEach((button) => {
      const input = $(button.dataset.togglePassword);
      if (!input) return;
      button.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.setAttribute('aria-pressed', show ? 'true' : 'false');
        button.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
        input.focus({ preventScroll: true });
      });
    });
  }

  function init() {
    if (!hasServer) {
      const note = $('offline-note');
      note.hidden = false;
    }

    setupPasswordToggles();

    const passwordInput = $('reg-password');
    if (passwordInput) {
      passwordInput.addEventListener('input', () => updateStrength(passwordInput.value));
      updateStrength(passwordInput.value);
    }

    // quitar el error de un campo en cuanto el valor deja de ser el problemático
    const clearOnInput = (inputId, errorId, isValid) => {
      const input = $(inputId);
      const error = $(errorId);
      if (!input || !error) return;
      input.addEventListener('input', () => {
        if (!error.hidden && isValid(input.value)) setFieldError(input, error, '');
      });
    };
    const nonEmpty = (value) => !!String(value || '').trim();
    clearOnInput('login-email', 'login-email-error', isEmail);
    clearOnInput('login-password', 'login-password-error', nonEmpty);
    clearOnInput('reg-email', 'reg-email-error', isEmail);
    clearOnInput('reg-password', 'reg-password-error', (value) => String(value || '').length >= 8);
    clearOnInput('reg-name', 'reg-name-error', nonEmpty);

    $('reg-terms').addEventListener('change', () => {
      if ($('reg-terms').checked) $('reg-terms-error').hidden = true;
    });

    $('login-form').addEventListener('submit', onSubmitLogin);
    $('register-form').addEventListener('submit', onSubmitRegister);

    // passkey: invitación tras el registro
    $('passkey-create-btn').addEventListener('click', () => {
      createPasskey({
        email: pendingEmail,
        button: $('passkey-create-btn'),
        msgSlot: $('passkey-invite-msg'),
        onSuccess: () => {
          const skip = $('passkey-skip-btn');
          if (skip) skip.hidden = true;
        },
      });
    });

    $('passkey-skip-btn').addEventListener('click', () => {
      $('passkey-invite').hidden = true;
    });

    // passkey: panel
    $('passkey-panel-btn').addEventListener('click', () => {
      createPasskey({
        button: $('passkey-panel-btn'),
        msgSlot: $('passkey-panel-msg'),
        onSuccess: () => loadSecurity(),
      });
    });

    // aviso de soporte de passkeys
    const notice = supportNotice();
    [['passkey-support-invite', 'passkey-create-btn'], ['passkey-support-panel', 'passkey-panel-btn']].forEach(
      (pair) => {
        const note = $(pair[0]);
        const button = $(pair[1]);
        if (!notice) return;
        note.textContent = notice;
        note.hidden = false;
        if (button) {
          button.disabled = true;
          button.setAttribute('aria-describedby', pair[0]);
        }
      }
    );

    // panel
    $('refresh-btn').addEventListener('click', async () => {
      const button = $('refresh-btn');
      setBusy(button, true, 'Actualizando…');
      try {
        await loadSecurity();
      } catch (err) {
        renderAlert($('security-alert'), 'error', {
          title: 'Error inesperado al actualizar',
          message: (err && err.message) || 'No se pudo actualizar el panel.',
        });
      } finally {
        setBusy(button, false);
      }
    });

    $('logout-btn').addEventListener('click', onLogout);

    window.addEventListener('hashchange', () => onRoute(false));
    onRoute(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
