"""HireAIJob admin · solo Tailscale, solo lectura.

Se sirve en 100.117.213.81:3212 (nunca en Cloudflare) y pide HTTP Basic.
Muestra agentes, trabajos, mensajes, cadena y estado de PM2 sin exponer claves.
"""
from __future__ import annotations

import html
import json
import os
import pathlib
import secrets
import subprocess

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import chain, db

RAIZ = pathlib.Path(__file__).resolve().parent.parent
AUTH = RAIZ / ".admin-auth"

app = FastAPI(title="HireAIJob admin", docs_url=None, redoc_url=None,
              openapi_url=None)
basic = HTTPBasic()


def _leer_auth() -> dict:
    if not AUTH.exists():
        datos = {"user": "leon", "password": secrets.token_urlsafe(18)}
        AUTH.write_text(json.dumps(datos))
        os.chmod(AUTH, 0o600)
    return json.loads(AUTH.read_text())


_leer_auth()


def auth(cred: HTTPBasicCredentials = Depends(basic)) -> str:
    datos = _leer_auth()
    bien_user = secrets.compare_digest(cred.username, datos["user"])
    bien_pass = secrets.compare_digest(cred.password, datos["password"])
    if not (bien_user and bien_pass):
        raise HTTPException(401, "credenciales incorrectas",
                            headers={"WWW-Authenticate": 'Basic realm="HireAIJob admin"'})
    return cred.username


def e(v) -> str:
    return html.escape(str(v if v is not None else ""), quote=True)


def usdc(micros) -> str:
    try:
        return f"{int(micros) / 1_000_000:,.2f}"
    except Exception:
        return "—"


def consulta(sql: str, args=()) -> list[dict]:
    with db.conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def uno(sql: str, args=()) -> dict | None:
    filas = consulta(sql, args)
    return filas[0] if filas else None


def pm2() -> str:
    try:
        p = subprocess.run(["pm2", "jlist"], capture_output=True, text=True, timeout=15)
        apps = json.loads(p.stdout[p.stdout.find("["):])
        online = sum(1 for a in apps if a.get("pm2_env", {}).get("status") == "online")
        parados = [a.get("name") for a in apps if a.get("pm2_env", {}).get("status") != "online"]
        return f"{online} online" + (f" · parados: {', '.join(parados[:8])}" if parados else "")
    except Exception:
        return "no disponible"


def layout(titulo: str, cuerpo: str, activo: str) -> str:
    enlaces = [("/", "Resumen"), ("/jobs", "Trabajos"), ("/agents", "Agentes"),
               ("/threads", "Mensajes"), ("/system", "Sistema")]
    nav = "".join(
        f'<a href="{u}"{" class=on" if u == activo else ""}>{t}</a>' for u, t in enlaces)
    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>{e(titulo)} · HireAIJob admin</title>
<style>
*{{box-sizing:border-box}}
body{{margin:0;background:#08090c;color:#f4f6f9;font:15px/1.5 Inter,system-ui,-apple-system,sans-serif}}
a{{color:#5eead4}}
header{{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:16px;
padding:14px 22px;border-bottom:1px solid #232833;background:rgba(8,9,12,.94);backdrop-filter:blur(10px)}}
.brand{{font-weight:800;letter-spacing:-.03em;color:#f4f6f9;text-decoration:none}}
.brand em{{font-style:normal;color:#5eead4}}
nav{{display:flex;gap:4px;flex-wrap:wrap}}
nav a{{padding:6px 11px;border-radius:999px;color:#a8b2c1;font-size:.86rem;font-weight:650;text-decoration:none}}
nav a:hover,nav a.on{{background:rgba(94,234,212,.11);color:#5eead4}}
main{{max-width:1240px;margin:0 auto;padding:26px 22px 60px}}
h1{{font-size:1.6rem;margin:0 0 6px}} h2{{font-size:1.15rem;margin:26px 0 10px}}
p.sub{{color:#7f8a9b;margin:0 0 22px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}}
.card{{padding:14px 16px;border:1px solid #232833;border-radius:12px;background:#101319}}
.card b{{display:block;color:#7f8a9b;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase}}
.card strong{{display:block;font-size:1.35rem;margin-top:4px;font-variant-numeric:tabular-nums}}
.card strong.g{{color:#5eead4}}
table{{width:100%;border-collapse:collapse;font-size:.86rem;background:#101319;border-radius:12px;overflow:hidden}}
th,td{{padding:9px 11px;border-bottom:1px solid #232833;text-align:left;vertical-align:top}}
th{{color:#7f8a9b;font-size:.68rem;letter-spacing:.07em;text-transform:uppercase}}
tr:last-child td{{border-bottom:0}}
td.mono,.mono{{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.78rem;overflow-wrap:anywhere}}
.pill{{display:inline-block;padding:2px 7px;border-radius:999px;border:1px solid #333b49;font-size:.7rem;font-weight:700}}
.state-released{{border-color:#145c36;background:#0c2b1b;color:#86e0a8}}
.state-funded{{border-color:#1e4f87;background:#102a43;color:#a5c9ff}}
.state-accepted{{border-color:#145c4f;background:#0d2b26;color:#8fe3c9}}
.state-disputed{{border-color:#7a271a;background:#3a1111;color:#ffb4ab}}
pre{{margin:8px 0;padding:10px;border:1px solid #232833;border-radius:8px;background:#080a0c;
color:#c6cfdb;font-size:.8rem;white-space:pre-wrap;overflow-wrap:anywhere}}
.back{{display:inline-block;margin-bottom:14px;color:#a8b2c1;text-decoration:none}}
.hint{{color:#7f8a9b;font-size:.82rem}}
</style></head><body>
<header><a class="brand" href="/">Hire<em>AI</em>Job <span style="color:#7f8a9b;font-weight:400;font-size:.8rem">admin</span></a><nav>{nav}</nav></header>
<main>{cuerpo}</main></body></html>"""


@app.get("/", response_class=HTMLResponse)
def inicio(_: str = Depends(auth)):
    estados = consulta("SELECT state, COUNT(*) n, COALESCE(SUM(amount_micros),0) total FROM jobs GROUP BY state")
    agentes = uno("SELECT COUNT(*) n, COALESCE(SUM(jobs_done),0) hechos FROM agents") or {}
    trabajos = uno("SELECT COUNT(*) n FROM jobs") or {}
    mensajes = uno("SELECT COUNT(*) n FROM thread_messages") or {}
    escrow = db.saldo("escrow") / 1e6
    fees = db.saldo("fees") / 1e6
    recientes = consulta("SELECT id,title,state,amount_micros,created_at FROM jobs ORDER BY created_at DESC LIMIT 8")
    recientes_ag = consulta("SELECT id,name,kind,reputation,jobs_done FROM agents ORDER BY created_at DESC LIMIT 8")
    cadena = "—"
    try:
        d = chain.listo()
        cadena = f"{d.get('cadena')} · escrow {d.get('en_escrow_usdc', 0)} USDC"
    except Exception as ex:
        cadena = f"no disponible ({str(ex)[:60]})"
    tarjetas = f"""
    <div class="grid">
      <div class="card"><b>Trabajos</b><strong>{trabajos.get('n',0)}</strong></div>
      <div class="card"><b>En escrow</b><strong class="g">{usdc(int(escrow*1e6))}</strong></div>
      <div class="card"><b>Comisiones</b><strong>{usdc(int(fees*1e6))}</strong></div>
      <div class="card"><b>Agentes / humanos</b><strong>{agentes.get('n',0)}</strong></div>
      <div class="card"><b>Mensajes</b><strong>{mensajes.get('n',0)}</strong></div>
      <div class="card"><b>Cadena</b><strong style="font-size:.95rem">{e(cadena)}</strong></div>
    </div>"""
    filas = "".join(
        f'<tr><td><a href="/jobs/{e(j["id"])}">{e(j["title"])}</a></td>'
        f'<td><span class="pill state-{e(j["state"])}">{e(j["state"])}</span></td>'
        f'<td>{usdc(j["amount_micros"])} USDC</td><td class="mono">{e(j["id"])}</td></tr>'
        for j in recientes)
    filas_ag = "".join(
        f'<tr><td><a href="/agents/{e(a["id"])}">{e(a["name"])}</a></td><td>{e(a.get("kind"))}</td>'
        f'<td>{a.get("jobs_done",0)}</td><td>{a.get("reputation",0)}</td></tr>' for a in recientes_ag)
    cuerpo = f"""<h1>Resumen</h1><p class="sub">Solo lectura · acceso por Tailscale.</p>
    {tarjetas}
    <h2>Últimos trabajos</h2>
    <table><thead><tr><th>Trabajo</th><th>Estado</th><th>Importe</th><th>ID</th></tr></thead><tbody>{filas or '<tr><td colspan=4 class=hint>Sin trabajos.</td></tr>'}</tbody></table>
    <h2>Últimos perfiles</h2>
    <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Trabajos</th><th>Reputación</th></tr></thead><tbody>{filas_ag or '<tr><td colspan=4 class=hint>Sin agentes.</td></tr>'}</tbody></table>
    <p class="hint">PM2: {e(pm2())}</p>"""
    return HTMLResponse(layout("Resumen", cuerpo, "/"))


@app.get("/jobs", response_class=HTMLResponse)
def trabajos(_: str = Depends(auth)):
    filas = consulta("SELECT id,title,state,provider_kind,amount_micros,agent_id,created_at FROM jobs ORDER BY created_at DESC LIMIT 200")
    trs = "".join(
        f'<tr><td><a href="/jobs/{e(j["id"])}">{e(j["title"])}</a></td>'
        f'<td><span class="pill state-{e(j["state"])}">{e(j["state"])}</span></td>'
        f'<td>{e(j.get("provider_kind","any"))}</td><td>{usdc(j["amount_micros"])} USDC</td>'
        f'<td class="mono">{e(j.get("agent_id") or "—")}</td></tr>' for j in filas)
    cuerpo = f"""<h1>Trabajos</h1><p class="sub">{len(filas)} últimos.</p>
    <table><thead><tr><th>Trabajo</th><th>Estado</th><th>Proveedor</th><th>Importe</th><th>Agente</th></tr></thead>
    <tbody>{trs or '<tr><td colspan=5 class=hint>Sin trabajos.</td></tr>'}</tbody></table>"""
    return HTMLResponse(layout("Trabajos", cuerpo, "/jobs"))


@app.get("/jobs/{jid}", response_class=HTMLResponse)
def trabajo(jid: str, _: str = Depends(auth)):
    j = uno("SELECT * FROM jobs WHERE id=?", (jid,))
    if not j:
        raise HTTPException(404, "job no encontrado")
    val = consulta("SELECT validator,passed,score,evidence,ts FROM validations WHERE job_id=? ORDER BY id LIMIT 100", (jid,))
    ev = consulta("SELECT kind,detail,ts FROM events WHERE job_id=? ORDER BY id DESC LIMIT 100", (jid,))
    vals = "".join(
        f'<tr><td>{e(v["validator"])}</td><td>{"✓" if v["passed"] else "✗"}</td>'
        f'<td>{e(v["score"])}</td><td class="mono">{e(v["evidence"])}</td></tr>' for v in val)
    evs = "".join(f'<tr><td class="mono">{e(x["kind"])}</td><td class="mono">{e(x["detail"])}</td></tr>' for x in ev)
    cuerpo = f"""<a class="back" href="/jobs">← Trabajos</a>
    <h1>{e(j["title"])}</h1><p class="sub">{e(j["id"])} · {e(j["state"])} · {usdc(j["amount_micros"])} USDC</p>
    <div class="grid">
      <div class="card"><b>Comprador</b><strong style="font-size:.9rem">{e(j.get("buyer_id"))}</strong></div>
      <div class="card"><b>Agente</b><strong style="font-size:.9rem">{e(j.get("agent_id") or "—")}</strong></div>
      <div class="card"><b>Tipo</b><strong style="font-size:.9rem">{e(j.get("provider_kind"))}</strong></div>
      <div class="card"><b>Plazo</b><strong style="font-size:.9rem">{e(j.get("deadline") or "sin plazo")}</strong></div>
    </div>
    <h2>Encargo</h2><pre>{e(j.get("spec"))}</pre>
    <h2>Validaciones</h2>
    <table><thead><tr><th>Validador</th><th>Pasa</th><th>Score</th><th>Evidencia</th></tr></thead><tbody>{vals or '<tr><td colspan=4 class=hint>Sin validaciones.</td></tr>'}</tbody></table>
    <h2>Eventos</h2>
    <table><thead><tr><th>Tipo</th><th>Detalle</th></tr></thead><tbody>{evs or '<tr><td colspan=2 class=hint>Sin eventos.</td></tr>'}</tbody></table>"""
    return HTMLResponse(layout("Trabajo", cuerpo, "/jobs"))


@app.get("/agents", response_class=HTMLResponse)
def agentes(_: str = Depends(auth)):
    filas = consulta("SELECT id,name,kind,headline,available,rate_micros,reputation,jobs_done,wallet FROM agents ORDER BY created_at DESC LIMIT 200")
    trs = "".join(
        f'<tr><td><a href="/agents/{e(a["id"])}">{e(a["name"])}</a></td><td>{e(a.get("kind"))}</td>'
        f'<td>{e(a.get("headline") or "—")}</td><td>{usdc(a.get("rate_micros",0))} USDC</td>'
        f'<td>{"sí" if a.get("available") else "no"}</td><td>{a.get("jobs_done",0)}</td></tr>' for a in filas)
    cuerpo = f"""<h1>Agentes y humanos</h1><p class="sub">{len(filas)} perfiles.</p>
    <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Titular</th><th>Tarifa</th><th>Disponible</th><th>Trabajos</th></tr></thead>
    <tbody>{trs or '<tr><td colspan=6 class=hint>Sin perfiles.</td></tr>'}</tbody></table>"""
    return HTMLResponse(layout("Agentes", cuerpo, "/agents"))


@app.get("/agents/{aid}", response_class=HTMLResponse)
def agente(aid: str, _: str = Depends(auth)):
    a = uno("SELECT * FROM agents WHERE id=?", (aid,))
    if not a:
        raise HTTPException(404, "agente no encontrado")
    trabajos = consulta("SELECT id,title,state,amount_micros FROM jobs WHERE agent_id=? ORDER BY created_at DESC LIMIT 50", (aid,))
    trs = "".join(
        f'<tr><td><a href="/jobs/{e(j["id"])}">{e(j["title"])}</a></td><td>{e(j["state"])}</td><td>{usdc(j["amount_micros"])}</td></tr>' for j in trabajos)
    cuerpo = f"""<a class="back" href="/agents">← Agentes</a>
    <h1>{e(a["name"])}</h1><p class="sub">{e(a["id"])} · {e(a.get("kind"))} · {e(a.get("headline") or "sin titular")}</p>
    <div class="grid">
      <div class="card"><b>Wallet</b><strong style="font-size:.8rem">{e(a.get("wallet") or "—")}</strong></div>
      <div class="card"><b>Tarifa</b><strong>{usdc(a.get("rate_micros",0))} USDC</strong></div>
      <div class="card"><b>Trabajos</b><strong>{a.get("jobs_done",0)}</strong></div>
      <div class="card"><b>Reputación</b><strong>{a.get("reputation",0)}</strong></div>
    </div>
    <h2>Bio</h2><pre>{e(a.get("bio") or "—")}</pre>
    <h2>Trabajos</h2><table><thead><tr><th>Trabajo</th><th>Estado</th><th>Importe</th></tr></thead><tbody>{trs or '<tr><td colspan=3 class=hint>Sin trabajos.</td></tr>'}</tbody></table>"""
    return HTMLResponse(layout("Agente", cuerpo, "/agents"))


@app.get("/threads", response_class=HTMLResponse)
def hilos(_: str = Depends(auth)):
    filas = consulta("SELECT t.id,t.subject,t.agent_id,a.name agent_name,t.updated_at FROM threads t LEFT JOIN agents a ON a.id=t.agent_id ORDER BY t.updated_at DESC LIMIT 200")
    trs = "".join(
        f'<tr><td><a href="/threads/{e(t["id"])}">{e(t["subject"])}</a></td><td>{e(t.get("agent_name") or t["agent_id"])}</td><td class="mono">{e(t["id"])}</td></tr>' for t in filas)
    cuerpo = f"""<h1>Mensajes</h1><p class="sub">{len(filas)} conversaciones.</p>
    <table><thead><tr><th>Asunto</th><th>Agente</th><th>ID</th></tr></thead><tbody>{trs or '<tr><td colspan=3 class=hint>Sin conversaciones.</td></tr>'}</tbody></table>"""
    return HTMLResponse(layout("Mensajes", cuerpo, "/threads"))


@app.get("/threads/{tid}", response_class=HTMLResponse)
def hilo(tid: str, _: str = Depends(auth)):
    t = uno("SELECT t.*,a.name agent_name FROM threads t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.id=?", (tid,))
    if not t:
        raise HTTPException(404, "hilo no encontrado")
    msgs = consulta("SELECT sender,body,ts FROM thread_messages WHERE thread_id=? ORDER BY id", (tid,))
    cuerpo = f"""<a class="back" href="/threads">← Mensajes</a>
    <h1>{e(t["subject"])}</h1><p class="sub">{e(t.get("agent_name") or t["agent_id"])} · {e(t["id"])}</p>"""
    for m in msgs:
        cuerpo += f'<div class="card" style="margin:8px 0"><b>{e(m["sender"])}</b><pre style="margin:6px 0 0">{e(m["body"])}</pre></div>'
    return HTMLResponse(layout("Conversación", cuerpo, "/threads"))


@app.get("/system", response_class=HTMLResponse)
def sistema(_: str = Depends(auth)):
    d = {}
    try:
        d = chain.listo()
    except Exception as ex:
        d = {"error": str(ex)[:160]}
    filas = "".join(f"<tr><td>{e(k)}</td><td class=mono>{e(v)}</td></tr>" for k, v in d.items())
    cuerpo = f"""<h1>Sistema</h1><p class="sub">PM2: {e(pm2())}</p>
    <h2>Cadena</h2><table><thead><tr><th>Campo</th><th>Valor</th></tr></thead><tbody>{filas}</tbody></table>
    <h2>Salud</h2><div class="grid">
      <div class="card"><b>Escrow</b><strong>{usdc(int(db.saldo("escrow")))}</strong></div>
      <div class="card"><b>Fees</b><strong>{usdc(int(db.saldo("fees")))}</strong></div>
      <div class="card"><b>Disco</b><strong>—</strong></div>
    </div>
    <p class="hint">Solo lectura. Las acciones de dinero siguen en la API pública protegida por claves.</p>"""
    return HTMLResponse(layout("Sistema", cuerpo, "/system"))


@app.get("/health", response_class=PlainTextResponse)
def health():
    return "ok"
