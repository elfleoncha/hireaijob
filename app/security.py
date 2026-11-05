"""Defensas de borde: tamaño, ritmo, cabeceras, idempotencia y auditoría.

Nada de esto sustituye a los validadores: es la capa que evita que un cliente
(o un agente) te tumbe el servicio, repita un cobro o te meta 40 MB de basura.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import threading
import time
from collections import defaultdict, deque

MAX_BODY = int(os.environ.get("AGENTPAY_MAX_BODY", 1_500_000))   # 1,5 MB
RPM = int(os.environ.get("AGENTPAY_RPM", 120))                   # por IP
RPM_ESCRITURA = int(os.environ.get("AGENTPAY_RPM_WRITE", 30))    # altas y acciones

_ventanas: dict[str, deque] = defaultdict(deque)
_ultima_limpieza = 0.0


def _ip(request) -> str:
    """Client IP behind Cloudflare.

    Cloudflare sets CF-Connecting-IP and appends the real peer to X-Forwarded-For.
    Never trust the first X-Forwarded-For value: a client can send its own header and
    bypass the rate limit. Prefer the header Cloudflare overwrites.
    """
    cf = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf:
        return cf
    real = (request.headers.get("x-real-ip") or "").strip()
    if real:
        return real
    return request.client.host if request.client else "?"


def limite_ok(ip: str, tope: int) -> bool:
    global _ultima_limpieza
    ahora = time.time()
    if ahora - _ultima_limpieza > 60:
        limpiar()
        _ultima_limpieza = ahora
    v = _ventanas[ip]
    while v and ahora - v[0] > 60:
        v.popleft()
    if len(v) >= tope:
        return False
    v.append(ahora)
    return True


def limpiar():
    """Called from the middleware occasionally so it does not grow forever."""
    ahora = time.time()
    for ip in list(_ventanas):
        v = _ventanas[ip]
        while v and ahora - v[0] > 60:
            v.popleft()
        if not v:
            _ventanas.pop(ip, None)


CABECERAS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}

# CSP para las páginas propias (sin inline: los .js van aparte)
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


# --------------------------------------------------------------- idempotencia
_RUTA = os.environ.get("AGENTPAY_IDEMPOTENCIA",
                       str(pathlib.Path(__file__).resolve().parent.parent / "data" / "idempotencia.json"))


def _cargar() -> dict:
    try:
        return json.load(open(_RUTA))
    except Exception:
        return {}


_LOCK = threading.Lock()


def _guardar(d: dict):
    tmp = _RUTA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.chmod(tmp, 0o600)
    os.replace(tmp, _RUTA)


def idempotente(clave: str, ruta: str, cuerpo_hash: str) -> dict | None:
    """Reserva la clave de forma atómica (un solo proceso).

    Devuelve:
      None                     -> es la primera vez, sigue el handler
      {"en_curso": True}       -> otra petición idéntica está en marcha
      {"status": int, "body":} -> respuesta ya guardada, se devuelve tal cual
    Si la clave se reutiliza con otro cuerpo o ruta -> 409.
    """
    with _LOCK:
        d = _cargar()
        hit = d.get(clave)
        ahora = int(time.time())
        if hit and ("status" not in hit or hit.get("ts", 0) < ahora - 86400):
            hit = None   # formato antiguo o caducado
        if hit:
            if hit["ruta"] != ruta or hit["hash"] != cuerpo_hash:
                raise ValueError("Idempotency-Key reused with a different body")
            if hit.get("status", 0) == 0:
                return {"en_curso": True}
            return {"status": hit["status"], "body": hit.get("body")}
        if len(d) > 5000:
            for k in list(d)[:1000]:
                d.pop(k, None)
        d[clave] = {"ruta": ruta, "hash": cuerpo_hash, "status": 0, "body": None,
                    "ts": ahora}
        _guardar(d)
        return None


def guardar_idempotencia(clave: str, ruta: str, cuerpo_hash: str, status: int,
                         body=None):
    with _LOCK:
        d = _cargar()
        d[clave] = {"ruta": ruta, "hash": cuerpo_hash, "status": status, "body": body,
                    "ts": int(time.time())}
        _guardar(d)


def liberar_idempotencia(clave: str):
    with _LOCK:
        d = _cargar()
        d.pop(clave, None)
        _guardar(d)


def hash_cuerpo(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------------- auditoría
def cadena_hash(previo: str, linea: str) -> str:
    return hashlib.sha256((previo + linea).encode()).hexdigest()
