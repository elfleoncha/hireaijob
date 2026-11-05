"""Defensas de borde: tamaño, ritmo, cabeceras, idempotencia y auditoría.

Nada de esto sustituye a los validadores: es la capa que evita que un cliente
(o un agente) te tumbe el servicio, repita un cobro o te meta 40 MB de basura.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import time
from collections import defaultdict, deque

MAX_BODY = int(os.environ.get("AGENTPAY_MAX_BODY", 1_500_000))   # 1,5 MB
RPM = int(os.environ.get("AGENTPAY_RPM", 120))                   # por IP
RPM_ESCRITURA = int(os.environ.get("AGENTPAY_RPM_WRITE", 30))    # altas y acciones

_ventanas: dict[str, deque] = defaultdict(deque)


def _ip(request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    return (xff.split(",")[0].strip() if xff else (request.client.host if request.client else "?"))


def limite_ok(ip: str, tope: int) -> bool:
    ahora = time.time()
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


def idempotente(clave: str, ruta: str, cuerpo_hash: str) -> dict | None:
    """Si ya se ejecutó esa clave con el mismo cuerpo, devuelve la respuesta guardada.
    Si la clave se reutiliza con otro cuerpo, es un error del cliente (409)."""
    d = _cargar()
    hit = d.get(clave)
    if not hit:
        return None
    if hit["ruta"] != ruta or hit["hash"] != cuerpo_hash:
        raise ValueError("Idempotency-Key reused with a different body")
    return hit["respuesta"]


def guardar_idempotencia(clave: str, ruta: str, cuerpo_hash: str, respuesta: dict):
    d = _cargar()
    if len(d) > 5000:                    # poda simple por antigüedad
        for k in list(d)[:1000]:
            d.pop(k, None)
    d[clave] = {"ruta": ruta, "hash": cuerpo_hash, "respuesta": respuesta,
                "ts": int(time.time())}
    json.dump(d, open(_RUTA, "w"))


def hash_cuerpo(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------------- auditoría
def cadena_hash(previo: str, linea: str) -> str:
    return hashlib.sha256((previo + linea).encode()).hexdigest()
