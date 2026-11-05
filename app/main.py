"""HireAIJob — escrow for work between agents (and humans), paid in USDC.

Flow:
  buyer creates job -> funds (USDC) -> agent accepts -> delivers ->
  automatic validators -> dispute window -> release to the agent
  (minus fee) or refund to the buyer.

Money is recorded in a double-entry ledger: escrow / fees / agent / buyer.
On-chain settlement (USDC on Base) is a separate, explicit step: the intent is
recorded here and, once signed, the payment is marked as settled.
"""
from __future__ import annotations

import hashlib
import re
import json
import os
import pathlib
import secrets
import time
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import auth, chain, db, discovery, security, seo, validators

app = FastAPI(title="HireAIJob API", version="0.1", docs_url="/api/docs",
              redoc_url="/api/redoc", openapi_url="/api/openapi.json")


@app.middleware("http")
async def blindaje(request: Request, call_next):
    ip = security._ip(request)
    ruta = request.url.path
    tope = security.RPM if request.method in ("GET", "HEAD") else security.RPM_ESCRITURA
    if not security.limite_ok(ip, tope):
        return JSONResponse({"detail": "too many requests, wait a minute"}, status_code=429)
    largo = request.headers.get("content-length")
    if largo and int(largo) > security.MAX_BODY:
        return JSONResponse({"detail": "body too large"}, status_code=413)
    cuerpo = b""
    if request.method in ("POST", "PUT", "PATCH"):
        cuerpo = await request.body()          # ya limitado por content-length
        if len(cuerpo) > security.MAX_BODY:
            return JSONResponse({"detail": "body too large"}, status_code=413)
        request._body = cuerpo
    respuesta = await call_next(request)
    for k, v in security.CABECERAS.items():
        respuesta.headers.setdefault(k, v)
    tipo = respuesta.headers.get("content-type", "")
    if tipo.startswith("text/html"):
        respuesta.headers.setdefault("Content-Security-Policy", security.CSP)
        respuesta.headers["cache-control"] = "no-store, must-revalidate"
    elif any(tipo.startswith(t) for t in ("text/css", "text/javascript", "image/svg",
                                          "application/javascript")):
        respuesta.headers.setdefault("cache-control", "public, max-age=600, must-revalidate")
    if request.method in ("POST", "PUT", "PATCH") and respuesta.status_code < 400:
        clave = request.headers.get("idempotency-key")
        if clave and len(clave) <= 200:
            try:
                security.guardar_idempotencia(clave, ruta, security.hash_cuerpo(cuerpo),
                                              {"status": respuesta.status_code})
            except Exception:
                pass
    return respuesta

# Comisión de plataforma: 10 % con mínimo y techo (en micro-USDC, 1 USDC = 1_000_000)
FEE_BPS = 1000
FEE_MIN = 500_000          # 0,50 USDC
FEE_MAX = 50_000_000       # 50 USDC
DISPUTA_SEG = int(os.environ.get("AGENTPAY_DISPUTA", 72 * 3600))
VALIDAR_MIN = 0.85

ESTADOS = ("created", "funded", "accepted", "delivered", "validating",
           "released", "refunded", "disputed", "cancelled")


@app.on_event("startup")
def _init():
    db.init()


db.init()  # idempotente: también cubre TestClient y arranques raros


# ----------------------------------------------------------------- modelas
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def limpio(t: str) -> str:
    return CONTROL.sub("", t).strip()


class Agente(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    specialties: list[str] = Field(min_length=1, max_length=12)
    wallet: str | None = None
    headline: str | None = Field(default=None, max_length=140)
    bio: str | None = Field(default=None, max_length=2000)
    rate_usdc: float | None = Field(default=None, ge=0, le=100000)

    @field_validator("name", "specialties", mode="before")
    @classmethod
    def _limpio(cls, v):
        if isinstance(v, str):
            return limpio(v)
        if isinstance(v, list):
            return [limpio(x) for x in v]
        return v

    @field_validator("wallet")
    @classmethod
    def _wallet(cls, v):
        if v is None or v == "":
            return None
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", v):
            raise ValueError("wallet must be a 0x + 40 hex address")
        return v.lower()

    @field_validator("headline", "bio", mode="before")
    @classmethod
    def _texto_perfil(cls, v):
        return limpio(v) if isinstance(v, str) else v


class Trabajo(BaseModel):
    title: str = Field(min_length=4, max_length=120)
    spec: str = Field(min_length=10, max_length=20000)
    specialties: list[str] = Field(min_length=1, max_length=12)
    amount_usdc: float = Field(gt=0, le=100000)
    deadline_hours: int | None = Field(default=None, ge=1, le=24 * 60)


class Entrega(BaseModel):
    artifact: str = Field(min_length=1, max_length=2_000_000)
    sha256: str | None = None

    @field_validator("artifact")
    @classmethod
    def _sin_binario(cls, v):
        if "\x00" in v:
            raise ValueError("deliverable must not contain null bytes")
        return v


class Perfil(BaseModel):
    """What an agent can publish about itself so it can be contacted."""
    name: str | None = Field(default=None, min_length=2, max_length=60)
    headline: str | None = Field(default=None, max_length=140)
    bio: str | None = Field(default=None, max_length=2000)
    specialties: list[str] | None = Field(default=None, min_length=1, max_length=12)
    wallet: str | None = None
    rate_usdc: float | None = Field(default=None, ge=0, le=100000)
    available: bool | None = None

    @field_validator("name", "headline", "bio", mode="before")
    @classmethod
    def _limpio(cls, v):
        return limpio(v) if isinstance(v, str) else v

    @field_validator("specialties", mode="before")
    @classmethod
    def _lista(cls, v):
        return [limpio(x) for x in v] if isinstance(v, list) else v

    @field_validator("wallet")
    @classmethod
    def _wallet(cls, v):
        if v is None or v == "":
            return None
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", v):
            raise ValueError("wallet must be a 0x + 40 hex address")
        return v.lower()


class NuevoHilo(BaseModel):
    agent_id: str = Field(min_length=3, max_length=80)
    subject: str = Field(min_length=3, max_length=120)
    message: str = Field(min_length=1, max_length=4000)
    job_id: str | None = Field(default=None, max_length=80)

    @field_validator("subject", "message", mode="before")
    @classmethod
    def _limpio(cls, v):
        return limpio(v) if isinstance(v, str) else v


class NuevoMensaje(BaseModel):
    body: str = Field(min_length=1, max_length=4000)

    @field_validator("body", mode="before")
    @classmethod
    def _limpio(cls, v):
        return limpio(v) if isinstance(v, str) else v


# ----------------------------------------------------------------- auth
def agente_actual(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing agent key")
    kh = db.hash_key(authorization.split(" ", 1)[1].strip())
    with db.conn() as c:
        row = c.execute("SELECT * FROM agents WHERE key_hash=?", (kh,)).fetchone()
    if not row:
        raise HTTPException(401, "invalid key")
    return dict(row)


class Comprador(BaseModel):
    """The buyer can be a human or an agent; a shared key is enough here."""
    key: str


def comprador_actual(authorization: str | None = Header(default=None)) -> str:
    buena = os.environ.get("AGENTPAY_BUYER_KEY", "")
    if not authorization or not buena:
        raise HTTPException(401, "missing buyer key")
    if not secrets.compare_digest(authorization.replace("Bearer ", "").strip(), buena):
        raise HTTPException(401, "invalid buyer key")
    return "buyer"


def lector(authorization: str | None = Header(default=None)) -> dict:
    """Identify who reads/writes messages: the buyer or an agent."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing key")
    key = authorization.split(" ", 1)[1].strip()
    buena = os.environ.get("AGENTPAY_BUYER_KEY", "")
    if buena and secrets.compare_digest(key, buena):
        return {"role": "buyer", "agent": None}
    with db.conn() as c:
        row = c.execute("SELECT * FROM agents WHERE key_hash=?", (db.hash_key(key),)).fetchone()
    if not row:
        raise HTTPException(401, "invalid key")
    return {"role": "agent", "agent": dict(row)}


async def ya_hecho(request: Request) -> dict | None:
    """Devuelve la respuesta previa si la Idempotency-Key ya se usó igual."""
    clave = request.headers.get("idempotency-key")
    if not clave:
        return None
    try:
        return security.idempotente(clave, request.url.path,
                                    security.hash_cuerpo(request._body or b""))
    except ValueError:
        raise HTTPException(409, "Idempotency-Key reused with a different body")


def micros(usdc: float) -> int:
    return int(round(usdc * 1_000_000))


def comision(amount: int, stake: int = 0) -> int:
    fee = max(FEE_MIN, min(FEE_MAX, amount * FEE_BPS // 10000))
    if stake >= 10_000_000:       # 10 USDC en fianza: 8 %
        fee = max(FEE_MIN, min(FEE_MAX, amount * 800 // 10000))
    return min(fee, amount // 3)  # nunca más de un tercio


def _job(c, job_id: str) -> dict:
    row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "job not found")
    return dict(row)


def _cambiar(c, job_id: str, estado: str, **campos):
    if estado not in ESTADOS:
        raise ValueError(estado)
    sets = ", ".join(["state=?", "updated_at=?"] + [f"{k}=?" for k in campos])
    vals = [estado, int(time.time())] + list(campos.values()) + [job_id]
    c.execute(f"UPDATE jobs SET {sets} WHERE id=?", vals)
    db.evento(job_id, f"status:{estado}", json.dumps(campos)[:400], c=c)


# ----------------------------------------------------------------- agentes
@app.post("/agents")
def crear_agente(a: Agente):
    key, kh, pref = db.make_key()
    aid = db.new_id("agt")
    now = int(time.time())
    rate = int(round((a.rate_usdc or 0) * 1_000_000))
    with db.conn() as c:
        c.execute(
            "INSERT INTO agents (id,name,specialties,key_hash,key_prefix,wallet,created_at,"
            "headline,bio,rate_micros,available,profile_updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (aid, a.name, json.dumps(a.specialties), kh, pref, a.wallet, now,
             a.headline, a.bio, rate, 1, now),
        )
    db.evento(None, "agent:signup", f"{aid} {a.name}")
    # la clave se enseña UNA vez
    return {"id": aid, "api_key": key, "nota": "save the key: it cannot be recovered"}


@app.get("/agents")
def listar_agentes(q: str | None = None, especialidad: str | None = None,
                   disponible: bool | None = None, orden: str = "reputacion",
                   limite: int = 50, offset: int = 0,
                   specialty: str | None = None, available: bool | None = None,
                   sort: str | None = None, limit: int | None = None):
    # English aliases (preferred); Spanish names kept for backwards compatibility.
    especialidad = especialidad or specialty
    disponible = disponible if disponible is not None else available
    orden = sort or orden
    limite = limit or limite
    """Public directory of self-promoting agents (search and contact)."""
    cond, args = [], []
    if q:
        like = f"%{q.strip()}%"
        cond.append("(name LIKE ? OR IFNULL(headline,'') LIKE ? OR IFNULL(bio,'') LIKE ? "
                    "OR specialties LIKE ?)")
        args += [like, like, like, like]
    if especialidad:
        cond.append("specialties LIKE ?")
        args.append(f"%{especialidad.strip()}%")
    if disponible is not None:
        cond.append("available=?")
        args.append(1 if disponible else 0)
    donde = (" WHERE " + " AND ".join(cond)) if cond else ""
    ordenes = {
        "reputacion": "reputation DESC, jobs_done DESC, created_at DESC",
        "trabajos": "jobs_done DESC, reputation DESC",
        "recientes": "COALESCE(profile_updated_at, created_at) DESC",
        "tarifa": "CASE WHEN rate_micros=0 THEN 1 ELSE 0 END, rate_micros ASC",
    }
    orden_sql = ordenes.get(orden, ordenes["reputacion"])
    with db.conn() as c:
        total = c.execute(f"SELECT COUNT(*) n FROM agents{donde}", args).fetchone()["n"]
        filas = [dict(r) for r in c.execute(
            "SELECT id,name,specialties,wallet,stake_micros,reputation,jobs_done,created_at,"
            "headline,bio,rate_micros,available,profile_updated_at "
            f"FROM agents{donde} ORDER BY {orden_sql} LIMIT ? OFFSET ?",
            args + [max(1, min(limite, 100)), max(0, offset)])]
    for f in filas:
        f["especialidades"] = json.loads(f.pop("specialties"))
        f["stake_usdc"] = f.pop("stake_micros") / 1_000_000
        f["rate_usdc"] = f.pop("rate_micros") / 1_000_000
        f["available"] = bool(f["available"])
    return {"agentes": filas, "total": total}


@app.get("/agents/me")
def mi_agente(agente: dict = Depends(agente_actual)):
    return ver_agente(agente["id"])


@app.get("/agents/{aid}")
def ver_agente(aid: str):
    with db.conn() as c:
        row = c.execute(
            "SELECT id,name,specialties,wallet,stake_micros,reputation,jobs_done,created_at,"
            "headline,bio,rate_micros,available,profile_updated_at "
            "FROM agents WHERE id=?", (aid,)).fetchone()
    if not row:
        raise HTTPException(404, "agent not found")
    d = dict(row)
    d["especialidades"] = json.loads(d.pop("specialties"))
    d["stake_usdc"] = d.pop("stake_micros") / 1_000_000
    d["rate_usdc"] = d.pop("rate_micros") / 1_000_000
    d["available"] = bool(d["available"])
    d["ganado_usdc"] = db.saldo("agent", aid) / 1_000_000
    return d


@app.patch("/agents/{aid}")
def editar_agente(aid: str, p: Perfil, agente: dict = Depends(agente_actual)):
    """The agent edits its own public profile."""
    if agente["id"] != aid:
        raise HTTPException(403, "you can only edit your own profile")
    campos, valores = [], []
    if p.name is not None:
        campos.append("name=?"); valores.append(p.name)
    if p.headline is not None:
        campos.append("headline=?"); valores.append(p.headline)
    if p.bio is not None:
        campos.append("bio=?"); valores.append(p.bio)
    if p.specialties is not None:
        campos.append("specialties=?"); valores.append(json.dumps(p.specialties))
    if p.wallet is not None:
        campos.append("wallet=?"); valores.append(p.wallet)
    if p.rate_usdc is not None:
        campos.append("rate_micros=?"); valores.append(int(round(p.rate_usdc * 1_000_000)))
    if p.available is not None:
        campos.append("available=?"); valores.append(1 if p.available else 0)
    if not campos:
        raise HTTPException(422, "nothing to update")
    campos.append("profile_updated_at=?"); valores.append(int(time.time()))
    with db.conn() as c:
        c.execute(f"UPDATE agents SET {', '.join(campos)} WHERE id=?", valores + [aid])
    db.evento(None, "agent:profile", aid)
    return ver_agente(aid)


@app.get("/agents/{aid}/jobs")
def trabajos_de_agente(aid: str, limite: int = 20, limit: int | None = None):
    limite = limit or limite
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM agents WHERE id=?", (aid,)).fetchone():
            raise HTTPException(404, "agent not found")
        filas = [dict(r) for r in c.execute(
            "SELECT id,title,amount_micros,state,created_at FROM jobs WHERE agent_id=? "
            "ORDER BY created_at DESC LIMIT ?", (aid, max(1, min(limite, 100))))]
    for f in filas:
        f["amount_usdc"] = f.pop("amount_micros") / 1_000_000
    return {"trabajos": filas}


# ----------------------------------------------------------------- mensajes
# Contacto directo: el comprador puede escribir a cualquier agente que se
# publicita (no solo a los que ya tienen un trabajo). Cada hilo es una
# conversación privada entre las dos partes.


def _hilo(c, tid: str) -> dict:
    row = c.execute("SELECT * FROM threads WHERE id=?", (tid,)).fetchone()
    if not row:
        raise HTTPException(404, "conversation not found")
    return dict(row)


def _puede_ver(hilo: dict, quien: dict) -> bool:
    return quien["role"] == "buyer" or hilo["agent_id"] == quien["agent"]["id"]


@app.post("/threads")
def abrir_hilo(d: NuevoHilo, quien: dict = Depends(lector)):
    with db.conn() as c:
        ag = c.execute("SELECT id,name FROM agents WHERE id=?", (d.agent_id,)).fetchone()
        if not ag:
            raise HTTPException(404, "agent not found")
        job_id = None
        if d.job_id:
            job = c.execute("SELECT id,agent_id FROM jobs WHERE id=?", (d.job_id,)).fetchone()
            if not job:
                raise HTTPException(404, "job not found")
            if job["agent_id"] and job["agent_id"] != d.agent_id:
                raise HTTPException(409, "that job does not belong to this agent")
            job_id = job["id"]
        if quien["role"] == "agent" and quien["agent"]["id"] != d.agent_id:
            raise HTTPException(403, "an agent can only write from its own profile")
        now = int(time.time())
        tid = db.new_id("thr")
        c.execute(
            "INSERT INTO threads (id,agent_id,job_id,subject,created_at,updated_at,"
            "buyer_read_ts,agent_read_ts) VALUES (?,?,?,?,?,?,?,?)",
            (tid, d.agent_id, job_id, d.subject, now, now,
             now if quien["role"] == "buyer" else 0,
             now if quien["role"] == "agent" else 0))
        c.execute("INSERT INTO thread_messages (thread_id,sender,body,ts) VALUES (?,?,?,?)",
                  (tid, quien["role"], d.message, now))
    db.evento(job_id, "message:opened", f"{tid} {quien['role']}")
    return {"id": tid, "estado": "abierto"}


@app.get("/threads")
def listar_hilos(quien: dict = Depends(lector)):
    rol = quien["role"]
    col = "agent_read_ts" if rol == "agent" else "buyer_read_ts"
    cond, args = "", []
    if rol == "agent":
        cond = " WHERE t.agent_id=?"
        args = [quien["agent"]["id"]]
    with db.conn() as c:
        filas = [dict(r) for r in c.execute(
            "SELECT t.id,t.agent_id,t.job_id,t.subject,t.created_at,t.updated_at,"
            "a.name AS agent_name,a.headline AS agent_headline,"
            "(SELECT body FROM thread_messages m WHERE m.thread_id=t.id "
            "ORDER BY m.id DESC LIMIT 1) AS last_body,"
            "(SELECT ts FROM thread_messages m WHERE m.thread_id=t.id "
            "ORDER BY m.id DESC LIMIT 1) AS last_ts,"
            "(SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id=t.id "
            f"AND m.sender!=? AND m.ts>t.{col}) AS unread "
            "FROM threads t JOIN agents a ON a.id=t.agent_id" + cond +
            " ORDER BY t.updated_at DESC LIMIT 100", [rol] + args)]
    return {"hilos": filas, "sin_leer": sum(int(f["unread"] or 0) for f in filas)}


@app.get("/threads/unread/count")
def sin_leer(quien: dict = Depends(lector)):
    rol = quien["role"]
    col = "agent_read_ts" if rol == "agent" else "buyer_read_ts"
    cond, args = "", []
    if rol == "agent":
        cond = " AND t.agent_id=?"
        args = [quien["agent"]["id"]]
    with db.conn() as c:
        n = c.execute(
            "SELECT COUNT(*) n FROM thread_messages m JOIN threads t ON t.id=m.thread_id "
            f"WHERE m.sender!=? AND m.ts>t.{col}" + cond, [rol] + args).fetchone()["n"]
    return {"sin_leer": n}


@app.get("/threads/{tid}")
def ver_hilo(tid: str, quien: dict = Depends(lector)):
    rol = quien["role"]
    with db.conn() as c:
        hilo = _hilo(c, tid)
        if not _puede_ver(hilo, quien):
            raise HTTPException(403, "this conversation is not yours")
        col = "agent_read_ts" if rol == "agent" else "buyer_read_ts"
        c.execute(f"UPDATE threads SET {col}=? WHERE id=?", (int(time.time()), tid))
        mensajes = [dict(r) for r in c.execute(
            "SELECT id,sender,body,ts FROM thread_messages WHERE thread_id=? ORDER BY id",
            (tid,))]
        ag = c.execute("SELECT id,name,headline,specialties,available,rate_micros "
                       "FROM agents WHERE id=?", (hilo["agent_id"],)).fetchone()
    agente = dict(ag) if ag else None
    if agente:
        agente["especialidades"] = json.loads(agente.pop("specialties"))
        agente["rate_usdc"] = agente.pop("rate_micros") / 1_000_000
        agente["available"] = bool(agente["available"])
    return {"hilo": hilo, "mensajes": mensajes, "agente": agente, "rol": rol}


@app.post("/threads/{tid}/messages")
def responder(tid: str, d: NuevoMensaje, quien: dict = Depends(lector)):
    rol = quien["role"]
    with db.conn() as c:
        hilo = _hilo(c, tid)
        if not _puede_ver(hilo, quien):
            raise HTTPException(403, "this conversation is not yours")
        now = int(time.time())
        c.execute("INSERT INTO thread_messages (thread_id,sender,body,ts) VALUES (?,?,?,?)",
                  (tid, rol, d.body, now))
        col = "agent_read_ts" if rol == "agent" else "buyer_read_ts"
        c.execute(f"UPDATE threads SET updated_at=?, {col}=? WHERE id=?", (now, now, tid))
    db.evento(hilo["job_id"], "message", f"{tid} {rol}")
    return {"ok": True, "ts": now}


# ----------------------------------------------------------------- trabajos
@app.post("/jobs")
def crear_trabajo(t: Trabajo, _: str = Depends(comprador_actual)):
    jid = db.new_id("job")
    now = int(time.time())
    with db.conn() as c:
        c.execute(
            "INSERT INTO jobs (id,title,spec,specialties,amount_micros,state,buyer_id,"
            "created_at,updated_at,deadline) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (jid, t.title, t.spec, json.dumps(t.specialties), micros(t.amount_usdc), "created",
             "buyer", now, now, now + t.deadline_hours * 3600 if t.deadline_hours else None),
        )
    db.evento(jid, "created", t.title)
    return {"id": jid, "amount_usdc": t.amount_usdc, "estado": "created"}


@app.post("/jobs/{jid}/fund")
def fondear(jid: str, _: str = Depends(comprador_actual)):
    """El comprador deposita. Aquí se simula la transferencia USDC; en producción
    se verifica la tx on-chain antes de asentar el apunte."""
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] != "created":
            raise HTTPException(409, f"cannot fund in status {job['state']}")
        _cambiar(c, jid, "funded")
    db.post(jid, [("buyer", "buyer", -job["amount_micros"], "deposit"),
                  ("escrow", jid, job["amount_micros"], "held in escrow")])
    extra = {}
    if chain.activo():
        try:
            extra["onchain"] = chain.fondear(jid, job["amount_micros"] / 1e6)
            db.evento(jid, "onchain:fund", json.dumps(extra["onchain"])[:400])
        except Exception as e:
            # el apunte contable ya existe: se marca para reconciliar a mano
            db.evento(jid, "onchain:error", repr(e)[:300])
            extra["error_onchain"] = repr(e)[:200]
    return {"id": jid, "estado": "funded", "escrow_usdc": db.saldo("escrow", jid) / 1e6, **extra}


@app.get("/jobs")
def listar(estado: str | None = None, especialidad: str | None = None,
           q: str | None = None, limite: int = 20,
           status: str | None = None, specialty: str | None = None,
           limit: int | None = None):
    # English aliases (preferred); Spanish names kept for backwards compatibility.
    estado = estado or status
    especialidad = especialidad or specialty
    limite = limit or limite
    q = (q or "").strip()[:120]
    consulta = "SELECT id,title,specialties,amount_micros,state,created_at FROM jobs"
    cond, args = [], []
    if estado:
        cond.append("state=?"); args.append(estado)
    if q:
        cond.append("(title LIKE ? OR spec LIKE ? OR specialties LIKE ? OR id LIKE ?)")
        args += [f"%{q}%"] * 4
    consulta += (" WHERE " + " AND ".join(cond)) if cond else ""
    consulta += " ORDER BY created_at DESC LIMIT ?"; args.append(min(limite, 100))
    with db.conn() as c:
        filas = [dict(r) for r in c.execute(consulta, args).fetchall()]
    if especialidad:
        filas = [f for f in filas if especialidad.lower() in f["specialties"].lower()]
    for f in filas:
        f["amount_usdc"] = f.pop("amount_micros") / 1e6
        f["especialidades"] = json.loads(f.pop("specialties"))
    return {"trabajos": filas}


@app.post("/jobs/{jid}/accept")
def aceptar(jid: str, agente: dict = Depends(agente_actual)):
    especialidades = json.loads(agente["specialties"])
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] != "funded":
            raise HTTPException(409, f"not acceptable in status {job['state']}")
        pedidas = json.loads(job["specialties"])
        if not set(map(str.lower, especialidades)) & set(map(str.lower, pedidas)):
            raise HTTPException(403, "the agent does not have the requested specialty")
        _cambiar(c, jid, "accepted", agent_id=agente["id"])
    db.evento(jid, "accepted", agente["id"])
    return {"id": jid, "estado": "accepted", "agente": agente["id"]}


@app.post("/jobs/{jid}/deliver")
def entregar(jid: str, e: Entrega, agente: dict = Depends(agente_actual)):
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] != "accepted":
            raise HTTPException(409, f"cannot deliver in status {job['state']}")
        if job["agent_id"] != agente["id"]:
            raise HTTPException(403, "that job is not yours")
        _cambiar(c, jid, "delivered", artifact=e.artifact, artifact_sha=e.sha256)
    db.evento(jid, "delivered", f"sha={validators.sha(e.artifact)[:16]}")
    return {"id": jid, "estado": "delivered", "sha256": validators.sha(e.artifact)}


@app.post("/jobs/{jid}/validate")
def validar(jid: str, _: str = Depends(comprador_actual)):
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] != "delivered":
            raise HTTPException(409, f"cannot validate in status {job['state']}")
        _cambiar(c, jid, "validating")
    ok, resultados = validators.ejecutar(job["spec"], job["artifact"] or "",
                                         job["artifact_sha"], VALIDAR_MIN)
    with db.conn() as c:
        for r in resultados:
            c.execute("INSERT INTO validations (job_id,validator,passed,score,evidence,ts) "
                      "VALUES (?,?,?,?,?,?)",
                      (jid, r["validator"], int(r["passed"]), r["score"], r["evidence"],
                       int(time.time())))
    db.evento(jid, "validated", json.dumps({"ok": ok, "fallos":
                                           [r["validator"] for r in resultados if not r["passed"]]}))
    if not ok:
        # no se libera: vuelve al agente para que corrija
        with db.conn() as c:
            _cambiar(c, jid, "accepted", rejection=json.dumps(resultados)[:2000])
        return {"id": jid, "ok": False, "resultados": resultados,
                "estado": "accepted", "motivo": "failed the checks: fix it and deliver again"}
    return {"id": jid, "ok": True, "resultados": resultados, "estado": "validating",
            "ventana_disputa_horas": DISPUTA_SEG // 3600}


@app.post("/jobs/{jid}/release")
def liberar(jid: str, _: str = Depends(comprador_actual)):
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] not in ("validating", "disputed"):
            raise HTTPException(409, f"not releasable in status {job['state']}")
        paso = int(time.time()) - (job["updated_at"] or 0)
        if job["state"] == "validating" and paso < DISPUTA_SEG:
            raise HTTPException(409, f"{(DISPUTA_SEG - paso) // 3600} h left in the dispute window")
        fee = comision(job["amount_micros"])
        neto = job["amount_micros"] - fee
        _cambiar(c, jid, "released")
    db.post(jid, [("escrow", jid, -job["amount_micros"], "released"),
                  ("agent", job["agent_id"], neto, "payment to the agent"),
                  ("fees", "platform", fee, "fee")])
    with db.conn() as c:
        c.execute("UPDATE agents SET jobs_done=jobs_done+1, reputation=reputation+1 WHERE id=?",
                  (job["agent_id"],))
    db.evento(jid, "released", f"neto={neto} fee={fee}")
    salida = {"id": jid, "estado": "released", "neto_usdc": neto / 1e6,
              "fee_usdc": fee / 1e6, "liquidacion": "pending signature (USDC on Base)"}
    if chain.activo():
        try:
            salida["onchain"] = chain.liberar(jid)
            salida["liquidacion"] = "settled on-chain"
            db.evento(jid, "onchain:release", json.dumps(salida["onchain"])[:400])
        except Exception as e:
            db.evento(jid, "onchain:error", repr(e)[:300])
            salida["error_onchain"] = repr(e)[:200]
    return salida


@app.post("/jobs/{jid}/dispute")
def disputar(jid: str, motivo: str = "", _: str = Depends(comprador_actual)):
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] not in ("validating", "delivered", "accepted"):
            raise HTTPException(409, f"not disputable in status {job['state']}")
        _cambiar(c, jid, "disputed", rejection=motivo[:500])
    db.evento(jid, "disputed", motivo[:200])
    return {"id": jid, "estado": "disputed", "nota": "manual review by a human validator"}


@app.post("/jobs/{jid}/refund")
def reembolsar(jid: str, _: str = Depends(comprador_actual)):
    with db.conn() as c:
        job = _job(c, jid)
        if job["state"] == "released":
            raise HTTPException(409, "the agent has already been paid")
        if job["state"] not in ("funded", "accepted", "delivered", "validating", "disputed"):
            raise HTTPException(409, f"not refundable in status {job['state']}")
        _cambiar(c, jid, "refunded")
    db.post(jid, [("escrow", jid, -job["amount_micros"], "refunded"),
                  ("buyer", "buyer", job["amount_micros"], "refund")])
    db.evento(jid, "refunded", "")
    salida = {"id": jid, "estado": "refunded"}
    if chain.activo():
        try:
            salida["onchain"] = chain.reembolsar(jid)
        except Exception as e:
            db.evento(jid, "onchain:error", repr(e)[:300])
            salida["error_onchain"] = repr(e)[:200]
    return salida


@app.get("/jobs/{jid}")
def ver_trabajo(jid: str):
    with db.conn() as c:
        job = _job(c, jid)
        val = [dict(r) for r in c.execute(
            "SELECT validator,passed,score,evidence FROM validations WHERE job_id=? ORDER BY id",
            (jid,)).fetchall()]
        ev = [dict(r) for r in c.execute(
            "SELECT kind,detail,ts FROM events WHERE job_id=? ORDER BY id", (jid,)).fetchall()]
    job["amount_usdc"] = job.pop("amount_micros") / 1e6
    job["especialidades"] = json.loads(job.pop("specialties"))
    job.pop("artifact", None)
    job["escrow_usdc"] = db.saldo("escrow", jid) / 1e6
    job["fee_estimada_usdc"] = comision(int(job["amount_usdc"] * 1e6)) / 1e6
    return {"trabajo": job, "validaciones": val, "eventos": ev}


@app.get("/jobs/{jid}/invoice", response_class=HTMLResponse)
def factura(jid: str):
    with db.conn() as c:
        job = _job(c, jid)
    if job["state"] != "released":
        raise HTTPException(409, "only released jobs can be invoiced")
    fee = comision(job["amount_micros"])
    total = job["amount_micros"]
    html = f"""<!doctype html><meta charset="utf-8"><title>Invoice {jid}</title>
<style>body{{font:15px/1.6 system-ui;margin:40px;max-width:640px}}
table{{width:100%;border-collapse:collapse;margin-top:18px}}
td,th{{border-bottom:1px solid #ddd;padding:8px;text-align:left}}
td.n{{text-align:right;font-variant-numeric:tabular-nums}}</style>
<h2>Invoice {jid}</h2>
<p>{job['title']}<br>Agent: {job['agent_id']} · Client: {job['buyer_id']}</p>
<table><tr><th>Item</th><th>Amount</th></tr>
<tr><td>Delivered and validated service</td><td class="n">{total/1e6:.2f} USDC</td></tr>
<tr><td>Platform fee</td><td class="n">{fee/1e6:.2f} USDC</td></tr>
<tr><th>Net to agent</th><th class="n">{(total-fee)/1e6:.2f} USDC</th></tr></table>
<p style="color:#666;font-size:13px">USDC payment. Automatically generated for the
holder's accounting; it is not a tax invoice.</p>"""
    return HTMLResponse(html)


@app.get("/chain")
def estado_cadena():
    if not chain.activo():
        return {"onchain": False, "nota": "set AGENTPAY_ONCHAIN=1"}
    return {"onchain": True, **chain.listo()}


@app.get("/security/invariants")
def invariantes():
    """The ledger must balance job by job. If this fails, something was changed by hand."""
    problemas = []
    with db.conn() as c:
        jobs = [dict(r) for r in c.execute("SELECT id,state,amount_micros,agent_id FROM jobs")]
        for j in jobs:
            suma = c.execute("SELECT COALESCE(SUM(delta_micros),0) s FROM ledger WHERE job_id=?",
                             (j["id"],)).fetchone()["s"]
            if suma != 0:
                problemas.append(f"{j['id']}: entries do not balance ({suma})")
            esc = c.execute("SELECT COALESCE(SUM(delta_micros),0) s FROM ledger "
                            "WHERE job_id=? AND account='escrow'", (j["id"],)).fetchone()["s"]
            if esc < 0:
                problemas.append(f"{j['id']}: negative escrow")
            if j["state"] == "released":
                ag = c.execute("SELECT COALESCE(SUM(delta_micros),0) s FROM ledger "
                               "WHERE job_id=? AND account='agent'", (j["id"],)).fetchone()["s"]
                fee = c.execute("SELECT COALESCE(SUM(delta_micros),0) s FROM ledger "
                                "WHERE job_id=? AND account='fees'", (j["id"],)).fetchone()["s"]
                if ag + fee != j["amount_micros"]:
                    problemas.append(f"{j['id']}: released job does not distribute the amount")
    return {"ok": not problemas, "problemas": problemas,
            "escrow_usdc": db.saldo("escrow") / 1e6, "fees_usdc": db.saldo("fees") / 1e6}


@app.get("/health")
def health():
    return {"ok": True, "escrow_total_usdc": db.saldo("escrow") / 1e6,
            "fees_total_usdc": db.saldo("fees") / 1e6}


app.include_router(auth.router)


# --- descubrimiento por agentes (lo que leen las IA) ------------------------
@app.get("/llms.txt", response_class=PlainTextResponse)
def llms():
    return discovery.llms_txt()


@app.get("/llms-full.txt", response_class=PlainTextResponse)
def llms_full():
    return discovery.llms_full()


@app.get("/.well-known/mcp.json")
def mcp_json():
    return discovery.mcp_json()


@app.get("/.well-known/skill.json")
def skill_json():
    return discovery.skill_json()


@app.get("/skill.md", response_class=PlainTextResponse)
def skill_md():
    ruta = pathlib.Path(__file__).resolve().parent.parent / "skills" / "hireaijob" / "SKILL.md"
    return ruta.read_text(encoding="utf-8")


# --- páginas server-side para buscadores y agentes (sin JS) ----------------
@app.get("/for-agents", response_class=HTMLResponse)
def pagina_para_agentes():
    return seo.para_agentes()


@app.get("/para-agentes", include_in_schema=False)
def redir_para_agentes():
    return RedirectResponse("/for-agents", status_code=301)


@app.get("/faq", response_class=HTMLResponse)
def pagina_faq():
    return seo.faq()


@app.get("/market", response_class=HTMLResponse)
def pagina_trabajos():
    return seo.trabajos()


@app.get("/market/{jid}", response_class=HTMLResponse)
def pagina_trabajo(jid: str):
    return seo.trabajo(jid)


@app.get("/trabajos", include_in_schema=False)
def redir_trabajos():
    return RedirectResponse("/market", status_code=301)


@app.get("/trabajos/{jid}", include_in_schema=False)
def redir_trabajo(jid: str):
    return RedirectResponse(f"/market/{jid}", status_code=301)


@app.get("/docs", include_in_schema=False)
@app.get("/docs/", include_in_schema=False)
def redir_docs():
    return RedirectResponse("/api/docs", status_code=302)


@app.get("/auth-in", include_in_schema=False)
@app.get("/auth-in/", include_in_schema=False)
def redir_auth():
    return RedirectResponse("/panel/", status_code=302)


@app.get("/.well-known/agent.json")
def agent_json():
    return discovery.agent_json()


@app.get("/.well-known/ai-plugin.json")
def ai_plugin():
    return discovery.ai_plugin()


@app.get("/robots.txt", response_class=PlainTextResponse)
def robots():
    return discovery.robots()


@app.get("/sitemap.xml")
def sitemap():
    return Response(content=seo.sitemap(), media_type="application/xml")


# --- páginas (mismo origen, sin CORS) --------------------------------------
RAIZ = pathlib.Path(__file__).resolve().parent.parent
app.mount("/brand", StaticFiles(directory=str(RAIZ / "web" / "shared")), name="brand")

for ruta, carpeta in (("/panel", "panel"), ("/", "landing")):
    app.mount(ruta, StaticFiles(directory=str(RAIZ / "web" / carpeta), html=True),
              name=carpeta)
