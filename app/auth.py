"""Accounts, sessions and abuse blocking.

Idea de fondo: un baneo por IP no sirve (móvil, CGNAT, VPN). Lo que de verdad
estorba a un estafador reincidente es una **credencial ligada al dispositivo**
(passkey) que se puede revocar, más reputación y una cola de revisión manual.

Lo que hay aquí:
  - contraseñas con scrypt (n=2^15) y comparación en tiempo constante;
  - sesiones con token aleatorio: en la base sólo vive su sha256, en cookie
    HttpOnly + SameSite=Lax (+ Secure si hay https);
  - dispositivo firmado con HMAC: si se revoca el dispositivo, no vuelve a entrar
    aunque cambie de IP o de correo desde ese mismo navegador;
  - listas de bloqueo por usuario, correo (hash), IP (con CIDR) y dispositivo;
  - limitador de intentos por (ip, email) y por IP;
  - passkeys (WebAuthn) para vincular hardware de verdad;
  - todo lo sensible se registra en `auth_events` (append-only).
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from . import db, security

RP_ID = os.environ.get("AGENTPAY_RP_ID", "hireaijob.com")
RP_NOMBRE = os.environ.get("AGENTPAY_RP_NAME", "HireAIJob")
ORIGEN = os.environ.get("AGENTPAY_ORIGIN", "https://hireaijob.com")
COOKIE_SESION = "haij_s"
COOKIE_DISPOSITIVO = "haij_d"
COOKIE_CSRF = "haij_c"
MAX_INTENTOS = int(os.environ.get("AGENTPAY_LOGIN_INTENTOS", 6))
VENTANA_INTENTOS = 600
SAL = os.environ.get("AGENTPAY_SAL", "cambia-esta-sal-de-desarrollo")

router = APIRouter(prefix="/auth", tags=["auth"])

DESECHABLES = {
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
    "temp-mail.org", "yopmail.com", "sharklasers.com", "getnada.com", "trashmail.com",
    "maildrop.cc", "dispostable.com", "throwawaymail.com", "mailnesia.com",
}
EMAIL_OK = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[a-z]{2,}$", re.I)


# ------------------------------------------------------------------ utilidades
def _h(texto: str) -> str:
    return hashlib.sha256((SAL + texto).encode()).hexdigest()


def _scrypt(password: str, sal: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=sal, n=2 ** 15, r=8, p=1, dklen=32,
                          maxmem=96 * 1024 * 1024).hex()


def hash_password(password: str) -> str:
    sal = secrets.token_bytes(16)
    return f"scrypt${sal.hex()}${_scrypt(password, sal)}"


def verificar_password(password: str, guardado: str) -> bool:
    try:
        _, sal_hex, esperado = guardado.split("$")
        return hmac.compare_digest(_scrypt(password, bytes.fromhex(sal_hex)), esperado)
    except Exception:
        return False


def firmar_dispositivo(did: str) -> str:
    return did + "." + hmac.new(SAL.encode(), did.encode(), hashlib.sha256).hexdigest()[:24]


def leer_dispositivo(valor: str | None) -> str | None:
    if not valor or "." not in valor:
        return None
    did, firma = valor.rsplit(".", 1)
    bueno = hmac.new(SAL.encode(), did.encode(), hashlib.sha256).hexdigest()[:24]
    return did if hmac.compare_digest(firma, bueno) else None


def _ip(request: Request) -> str:
    return security._ip(request)


def _evento(uid: str | None, kind: str, detalle: str = ""):
    with db.conn() as c:
        c.execute("INSERT INTO auth_events (user_id,kind,detail,ip,ts) VALUES (?,?,?,?,?)",
                  (uid, kind, detalle[:400], "", int(time.time())))


def init():
    with db.conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, email_hash TEXT NOT NULL,
              name TEXT NOT NULL, role TEXT NOT NULL, pass_hash TEXT NOT NULL,
              estado TEXT NOT NULL DEFAULT 'activa',
              creado INTEGER NOT NULL, ultimo_ip TEXT, riesgo INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, creada INTEGER NOT NULL,
              visto INTEGER NOT NULL, ip TEXT, ua_hash TEXT, revocada INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS devices (
              id TEXT PRIMARY KEY, user_id TEXT NOT NULL, etiqueta TEXT, cred_id TEXT,
              pubkey TEXT, creado INTEGER NOT NULL, revocado INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS bans (
              id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, valor TEXT NOT NULL,
              motivo TEXT NOT NULL, ts INTEGER NOT NULL, expira INTEGER
            );
            CREATE TABLE IF NOT EXISTS intentos (
              clave TEXT NOT NULL, ts INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT NOT NULL,
              detail TEXT, ip TEXT, ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS bans_valor ON bans(kind, valor);
            """
        )


init()


# ------------------------------------------------------------------ bloqueos
def _bans(kind: str, valor: str) -> str | None:
    ahora = int(time.time())
    with db.conn() as c:
        for b in c.execute("SELECT valor, motivo, expira FROM bans WHERE kind=?", (kind,)):
            if b["expira"] and b["expira"] < ahora:
                continue
            if kind == "ip":
                try:
                    if ipaddress.ip_address(valor) in ipaddress.ip_network(b["valor"], strict=False):
                        return b["motivo"]
                except Exception:
                    continue
            elif b["valor"] == valor:
                return b["motivo"]
    return None


def bloqueo_actual(request: Request, email: str | None = None,
                   dispositivo: str | None = None) -> str | None:
    ip = _ip(request)
    for kind, valor in (("ip", ip), ("email", _h(email.lower()) if email else None),
                        ("device", dispositivo)):
        if valor:
            motivo = _bans(kind, valor)
            if motivo:
                return motivo
    return None


def _clave_intentos(ip: str, email: str) -> str:
    return f"{ip}|{_h(email.lower())[:16]}"


def _intentos_ok(ip: str, email: str) -> bool:
    """Only failures are counted: a correct password does not use quota."""
    ahora = int(time.time())
    with db.conn() as c:
        c.execute("DELETE FROM intentos WHERE ts < ?", (ahora - VENTANA_INTENTOS,))
        n = c.execute("SELECT COUNT(*) n FROM intentos WHERE clave=?",
                      (_clave_intentos(ip, email),)).fetchone()["n"]
    return n < MAX_INTENTOS


def _apuntar_fallo(ip: str, email: str):
    with db.conn() as c:
        c.execute("INSERT INTO intentos (clave, ts) VALUES (?,?)",
                  (_clave_intentos(ip, email), int(time.time())))


# ------------------------------------------------------------------ modelos
class Registro(BaseModel):
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=10, max_length=200)
    name: str = Field(min_length=2, max_length=60)
    role: Literal["buyer", "agent"] = "buyer"

    @field_validator("email")
    @classmethod
    def _email(cls, v):
        v = v.strip().lower()
        if not EMAIL_OK.match(v):
            raise ValueError("invalid email")
        if v.split("@", 1)[1] in DESECHABLES:
            raise ValueError("temporary email addresses are not allowed")
        return v


class Acceso(BaseModel):
    email: str = Field(min_length=5, max_length=120)
    password: str = Field(min_length=1, max_length=200)


def _usuario(request: Request) -> dict:
    tok = request.cookies.get(COOKIE_SESION)
    if not tok:
        raise HTTPException(401, "no session")
    th = _h(tok)
    with db.conn() as c:
        row = c.execute(
            "SELECT s.user_id, s.revocada, u.* FROM sessions s JOIN users u ON u.id=s.user_id "
            "WHERE s.token_hash=?", (th,)).fetchone()
        if not row or row["revocada"]:
            raise HTTPException(401, "invalid session")
        if row["estado"] != "activa":
            raise HTTPException(423, f"account {row['estado']}")
        c.execute("UPDATE sessions SET visto=? WHERE token_hash=?", (int(time.time()), th))
    return dict(row)


def _poner_cookies(resp: Response, request: Request, token: str, did: str):
    seguro = request.url.scheme == "https"
    resp.set_cookie(COOKIE_SESION, token, httponly=True, samesite="lax", secure=seguro,
                    max_age=60 * 60 * 24 * 7, path="/")
    resp.set_cookie(COOKIE_DISPOSITIVO, firmar_dispositivo(did), httponly=True, samesite="lax",
                    secure=seguro, max_age=60 * 60 * 24 * 365, path="/")
    # token CSRF legible por JS para cabeceras de escritura
    resp.set_cookie(COOKIE_CSRF, secrets.token_urlsafe(16), httponly=False, samesite="lax",
                    secure=seguro, max_age=60 * 60 * 8, path="/")


# ------------------------------------------------------------------ endpoints
@router.post("/register")
def registro(datos: Registro, request: Request, response: Response):
    motivo = bloqueo_actual(request, datos.email)
    if motivo:
        raise HTTPException(423, f"cannot create the account: {motivo}")
    with db.conn() as c:
        n = c.execute("SELECT COUNT(*) n FROM users WHERE ultimo_ip=? AND creado > ?",
                      (_ip(request), int(time.time()) - 86400)).fetchone()["n"]
        if n >= 3:
            _evento(None, "register:blocked", f"ip with {n} accounts in 24 h")
            raise HTTPException(429, "too many accounts from this connection; manual review")
        if c.execute("SELECT 1 FROM users WHERE email=?", (datos.email,)).fetchone():
            raise HTTPException(409, "that email is already registered")
        uid = db.new_id("usr")
        did = db.new_id("dev")
        c.execute(
            "INSERT INTO users (id,email,email_hash,name,role,pass_hash,creado,ultimo_ip) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (uid, datos.email, _h(datos.email), datos.name, datos.role,
             hash_password(datos.password), int(time.time()), _ip(request)))
        c.execute("INSERT INTO devices (id,user_id,etiqueta,creado) VALUES (?,?,?,?)",
                  (did, uid, "first device", int(time.time())))
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions (token_hash,user_id,creada,visto,ip,ua_hash) "
                  "VALUES (?,?,?,?,?,?)",
                  (_h(token), uid, int(time.time()), int(time.time()), _ip(request),
                   _h(request.headers.get("user-agent", ""))[:32]))
    _evento(uid, "register", f"rol={datos.role}")
    _poner_cookies(response, request, token, did)
    return {"ok": True, "user_id": uid, "device_id": did}


@router.post("/login")
def acceso(datos: Acceso, request: Request, response: Response):
    email = datos.email.strip().lower()
    motivo = bloqueo_actual(request, email, leer_dispositivo(request.cookies.get(COOKIE_DISPOSITIVO)))
    if motivo:
        raise HTTPException(423, motivo)
    with db.conn() as c:
        u = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if u and u["estado"] != "activa":
        raise HTTPException(423, f"account {u['estado']}")
    if not _intentos_ok(_ip(request), email):
        _evento(u["id"] if u else None, "login:frenado", email)
        raise HTTPException(429, "too many attempts; wait a few minutes")
    if not u or not verificar_password(datos.password, u["pass_hash"]):
        _apuntar_fallo(_ip(request), email)
        _evento(u["id"] if u else None, "login:fallo", email)
        raise HTTPException(401, "wrong email or password")
    did = leer_dispositivo(request.cookies.get(COOKIE_DISPOSITIVO)) or db.new_id("dev")
    token = secrets.token_urlsafe(32)
    with db.conn() as c:
        c.execute("INSERT INTO sessions (token_hash,user_id,creada,visto,ip,ua_hash) "
                  "VALUES (?,?,?,?,?,?)",
                  (_h(token), u["id"], int(time.time()), int(time.time()), _ip(request),
                   _h(request.headers.get("user-agent", ""))[:32]))
        c.execute("INSERT OR IGNORE INTO devices (id,user_id,etiqueta,creado) VALUES (?,?,?,?)",
                  (did, u["id"], "device", int(time.time())))
        c.execute("UPDATE users SET ultimo_ip=? WHERE id=?", (_ip(request), u["id"]))
    _evento(u["id"], "login:ok", _ip(request))
    _poner_cookies(response, request, token, did)
    return {"ok": True, "rol": u["role"], "nombre": u["name"]}


@router.post("/logout")
def salir(request: Request, response: Response):
    tok = request.cookies.get(COOKIE_SESION)
    if tok:
        with db.conn() as c:
            c.execute("UPDATE sessions SET revocada=1 WHERE token_hash=?", (_h(tok),))
    for n in (COOKIE_SESION, COOKIE_CSRF):
        response.delete_cookie(n, path="/")
    return {"ok": True}


@router.get("/me")
def yo(request: Request):
    u = _usuario(request)
    did = leer_dispositivo(request.cookies.get(COOKIE_DISPOSITIVO))
    confianza = "unknown"
    if did:
        with db.conn() as c:
            d = c.execute("SELECT cred_id, revocado FROM devices WHERE id=?", (did,)).fetchone()
        if d:
            confianza = "passkey" if d["cred_id"] and not d["revocado"] else "device"
    return {"user_id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"],
            "estado": u["estado"], "device_trust": confianza}


@router.get("/devices")
def dispositivos(request: Request):
    u = _usuario(request)
    with db.conn() as c:
        filas = [dict(r) for r in c.execute(
            "SELECT id, etiqueta, creado, cred_id, revocado FROM devices WHERE user_id=? "
            "ORDER BY creado DESC", (u["id"],))]
    for f in filas:
        f["passkey"] = bool(f.pop("cred_id"))
        f["revocado"] = bool(f["revocado"])
    return {"dispositivos": filas}


@router.post("/devices/{did}/revoke")
def revocar(did: str, request: Request):
    u = _usuario(request)
    with db.conn() as c:
        d = c.execute("SELECT * FROM devices WHERE id=? AND user_id=?", (did, u["id"])).fetchone()
        if not d:
            raise HTTPException(404, "device not found")
        c.execute("UPDATE devices SET revocado=1 WHERE id=?", (did,))
        c.execute("INSERT INTO bans (kind,valor,motivo,ts) VALUES ('device',?,?,?)",
                  (did, "device revoked by the user", int(time.time())))
    _evento(u["id"], "device:revocado", did)
    return {"ok": True}


# ------------------------------------------------------------------ passkeys
@router.post("/passkey/options")
def passkey_opciones(request: Request):
    import webauthn
    u = _usuario(request)
    opciones = webauthn.generate_registration_options(
        rp_id=RP_ID, rp_name=RP_NOMBRE, user_name=u["email"],
        user_id=u["id"].encode(), user_display_name=u["name"])
    request.session = None  # sin estado: el reto vuelve firmado por el cliente
    with db.conn() as c:
        c.execute("INSERT INTO auth_events (user_id,kind,detail,ip,ts) VALUES (?,?,?,?,?)",
                  (u["id"], "passkey:opciones", json.dumps({"challenge": opciones.challenge.hex()})[:400],
                   _ip(request), int(time.time())))
    import base64
    datos = json.loads(webauthn.options_to_json(opciones))
    datos["_challenge_b64"] = base64.b64encode(opciones.challenge).decode()
    return datos


@router.post("/passkey/verify")
async def passkey_verificar(request: Request):
    """Verify passkey creation and bind it to the current device."""
    import base64
    import webauthn
    from webauthn.helpers import parse_registration_credential_json
    u = _usuario(request)
    cuerpo = await request.json()
    credencial = parse_registration_credential_json(json.dumps(cuerpo.get("credential", {})))
    reto = base64.b64decode(cuerpo.get("challenge_b64", ""))
    try:
        verificado = webauthn.verify_registration_response(
            credential=credencial, expected_challenge=reto,
            expected_origin=ORIGEN, expected_rp_id=RP_ID)
    except Exception as e:
        raise HTTPException(400, f"invalid passkey: {str(e)[:120]}")
    did = leer_dispositivo(request.cookies.get(COOKIE_DISPOSITIVO))
    with db.conn() as c:
        if did:
            c.execute("UPDATE devices SET cred_id=?, pubkey=? WHERE id=?",
                      (base64.b64encode(verificado.credential_id).decode(),
                       base64.b64encode(verificado.credential_public_key).decode(), did))
    _evento(u["id"], "passkey:creada", did or "")
    return {"ok": True}


# ------------------------------------------------------------------ admin
@router.post("/admin/ban")
def banear(datos: dict, request: Request,
           autorizacion: str | None = Header(default=None, alias="Authorization")):
    buena = os.environ.get("AGENTPAY_ADMIN_KEY", "")
    if not buena or not autorizacion or not hmac.compare_digest(
            autorizacion.replace("Bearer ", ""), buena):
        raise HTTPException(403, "admin only")
    kind = datos.get("kind")
    if kind not in ("user", "email", "ip", "device", "wallet"):
        raise HTTPException(422, "kind must be user/email/ip/device/wallet")
    valor = str(datos.get("valor", "")).strip()
    motivo = str(datos.get("motivo", "incumplimiento"))[:200]
    if not valor:
        raise HTTPException(422, "missing value")
    if kind == "email":
        valor = _h(valor.lower())
    if kind == "user":
        with db.conn() as c:
            c.execute("UPDATE users SET estado='bloqueada' WHERE id=?", (valor,))
            c.execute("UPDATE sessions SET revocada=1 WHERE user_id=?", (valor,))
    with db.conn() as c:
        c.execute("INSERT INTO bans (kind,valor,motivo,ts) VALUES (?,?,?,?)",
                  (kind, valor, motivo, int(time.time())))
    _evento(None, f"ban:{kind}", valor)
    return {"ok": True, "kind": kind, "valor": valor}


@router.get("/admin/revision")
def revision(request: Request, autorizacion: str | None = Header(default=None, alias="Authorization")):
    buena = os.environ.get("AGENTPAY_ADMIN_KEY", "")
    if not buena or not autorizacion or not hmac.compare_digest(
            autorizacion.replace("Bearer ", ""), buena):
        raise HTTPException(403, "admin only")
    with db.conn() as c:
        u = [dict(r) for r in c.execute(
            "SELECT id,email,name,role,estado,creado,ultimo_ip,riesgo FROM users "
            "ORDER BY creado DESC LIMIT 50")]
        b = [dict(r) for r in c.execute("SELECT * FROM bans ORDER BY id DESC LIMIT 50")]
        ev = [dict(r) for r in c.execute(
            "SELECT kind,detail,ts FROM auth_events ORDER BY id DESC LIMIT 50")]
    return {"usuarios": u, "bloqueos": b, "eventos": ev}
