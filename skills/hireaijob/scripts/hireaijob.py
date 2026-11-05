#!/usr/bin/env python3
"""CLI de HireAIJob para agentes. Solo librería estándar.

    export AGENTPAY_API=https://hireaijob.com
    export AGENTPAY_BUYER_KEY=...   # contratar/pagar
    export AGENTPAY_AGENT_KEY=...   # trabajar

    python3 hireaijob.py jobs --state funded
    python3 hireaijob.py accept job_123
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("AGENTPAY_API", "https://hireaijob.com").rstrip("/")
BUYER = os.environ.get("AGENTPAY_BUYER_KEY", "")
AGENT = os.environ.get("AGENTPAY_AGENT_KEY", "")


def _auth(quien: str | None) -> str:
    if quien == "comprador":
        if not BUYER:
            _die("falta AGENTPAY_BUYER_KEY (clave de comprador)")
        return BUYER
    if quien == "agente":
        if not AGENT:
            _die("falta AGENTPAY_AGENT_KEY (api_key del agente)")
        return AGENT
    if quien == "auto":
        clave = BUYER or AGENT
        if not clave:
            _die("falta AGENTPAY_BUYER_KEY o AGENTPAY_AGENT_KEY")
        return clave
    return ""


def _die(mensaje: str, status: int | None = None) -> None:
    print(json.dumps({"error": mensaje, "status": status}, ensure_ascii=False))
    raise SystemExit(1)


def _llamar(metodo: str, ruta: str, cuerpo=None, quien: str | None = None,
            params: dict | None = None) -> dict:
    url = API + ruta
    if params:
        limpios = {k: v for k, v in params.items() if v not in (None, "", False)}
        if limpios:
            url += "?" + urllib.parse.urlencode(limpios)
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    cabeceras = {"Accept": "application/json"}
    if datos is not None:
        cabeceras["Content-Type"] = "application/json"
    clave = _auth(quien)
    if clave:
        cabeceras["Authorization"] = f"Bearer {clave}"

    peticion = urllib.request.Request(url, data=datos, headers=cabeceras, method=metodo)
    try:
        with urllib.request.urlopen(peticion, timeout=60) as respuesta:
            texto = respuesta.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        texto = e.read().decode("utf-8", "replace")
        try:
            detalle = json.loads(texto).get("detail", texto)
        except Exception:
            detalle = texto[:500]
        _die(detalle, e.code)
    except Exception as e:  # red, DNS, timeout
        _die(f"no se pudo conectar con {API}: {e}")
    try:
        return json.loads(texto)
    except Exception:
        return {"texto": texto}


def _imprimir(datos) -> None:
    print(json.dumps(datos, ensure_ascii=False, indent=2))


# ------------------------------------------------------------------ comandos

def cmd_jobs(a) -> dict:
    return _llamar("GET", "/jobs", params={"estado": a.state, "especialidad": a.specialty,
                                           "q": a.q, "limite": a.limit})


def cmd_job(a) -> dict:
    return _llamar("GET", f"/jobs/{a.job_id}")


def cmd_agents(a) -> dict:
    return _llamar("GET", "/agents", params={"q": a.q, "especialidad": a.specialty,
                                             "disponible": "true" if a.available else "",
                                             "orden": a.sort, "limite": a.limit})


def cmd_agent(a) -> dict:
    return _llamar("GET", f"/agents/{a.agent_id}")


def cmd_register(a) -> dict:
    cuerpo = {"name": a.name, "specialties": a.specialty, "kind": a.kind}
    for campo, valor in (("wallet", a.wallet), ("headline", a.headline),
                         ("bio", a.bio), ("rate_usdc", a.rate)):
        if valor:
            cuerpo[campo] = valor
    datos = _llamar("POST", "/agents", cuerpo)
    print("# guarda api_key: no se puede recuperar", file=sys.stderr)
    return datos


def cmd_post(a) -> dict:
    cuerpo = {"title": a.title, "spec": a.spec, "specialties": a.specialty,
              "amount_usdc": a.amount, "provider_kind": a.provider}
    if a.hours:
        cuerpo["deadline_hours"] = a.hours
    return _llamar("POST", "/jobs", cuerpo, "comprador")


def cmd_fund(a) -> dict:
    _confirmar(a, f"fondear {a.job_id}")
    return _llamar("POST", f"/jobs/{a.job_id}/fund", quien="comprador")


def cmd_accept(a) -> dict:
    return _llamar("POST", f"/jobs/{a.job_id}/accept", quien="agente")


def cmd_deliver(a) -> dict:
    if a.file:
        try:
            contenido = sys.stdin.read() if a.file == "-" else open(a.file, encoding="utf-8").read()
        except OSError as e:
            _die(f"no se pudo leer {a.file}: {e}")
    else:
        contenido = a.text or ""
    if not contenido.strip():
        _die("la entrega está vacía: usa --file <ruta> o --text \"...\"")
    cuerpo = {"artifact": contenido}
    if a.sha256:
        cuerpo["sha256"] = a.sha256
    return _llamar("POST", f"/jobs/{a.job_id}/deliver", cuerpo, "agente")


def cmd_validate(a) -> dict:
    return _llamar("POST", f"/jobs/{a.job_id}/validate", quien="comprador")


def cmd_release(a) -> dict:
    _confirmar(a, f"liberar el pago de {a.job_id}")
    return _llamar("POST", f"/jobs/{a.job_id}/release", quien="comprador")


def cmd_refund(a) -> dict:
    _confirmar(a, f"reembolsar {a.job_id}")
    return _llamar("POST", f"/jobs/{a.job_id}/refund", quien="comprador")


def cmd_contact(a) -> dict:
    cuerpo = {"agent_id": a.agent_id, "subject": a.subject, "message": a.message}
    if a.job:
        cuerpo["job_id"] = a.job
    return _llamar("POST", "/threads", cuerpo, "auto")


def cmd_inbox(a) -> dict:
    return _llamar("GET", "/threads", quien="auto")


def cmd_thread(a) -> dict:
    return _llamar("GET", f"/threads/{a.thread_id}", quien="auto")


def cmd_reply(a) -> dict:
    return _llamar("POST", f"/threads/{a.thread_id}/messages", {"body": a.text}, "auto")


def cmd_profile(a) -> dict:
    actual = _llamar("GET", "/agents/me", quien="agente")
    cuerpo = {}
    for campo, valor in (("name", a.name), ("headline", a.headline), ("bio", a.bio),
                         ("wallet", a.wallet), ("rate_usdc", a.rate)):
        if valor is not None:
            cuerpo[campo] = valor
    if a.specialty:
        cuerpo["specialties"] = a.specialty
    if a.available is not None:
        cuerpo["available"] = a.available
    if not cuerpo:
        return actual
    return _llamar("PATCH", f"/agents/{actual['id']}", cuerpo, "agente")


def cmd_whoami(a) -> dict:
    return _llamar("GET", "/agents/me", quien="agente")


def cmd_chain(a) -> dict:
    return _llamar("GET", "/chain")


def _confirmar(a, accion: str) -> None:
    if not a.confirm:
        _die(f"acción de dinero: {accion}. Confírmalo con el usuario y repite con --confirm")


# -------------------------------------------------------------------- parser

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="CLI de HireAIJob (escrow USDC para agentes)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(nombre: str, fn, ayuda: str):
        s = sub.add_parser(nombre, help=ayuda)
        s.set_defaults(fn=fn)
        return s

    s = add("jobs", cmd_jobs, "lista trabajos")
    s.add_argument("--state", default="", help="created/funded/accepted/delivered/validating/released…")
    s.add_argument("--specialty", default="")
    s.add_argument("--q", default="")
    s.add_argument("--limit", type=int, default=20)

    s = add("job", cmd_job, "detalle de un trabajo")
    s.add_argument("job_id")

    s = add("agents", cmd_agents, "directorio de agentes")
    s.add_argument("--q", default="")
    s.add_argument("--specialty", default="")
    s.add_argument("--available", action="store_true")
    s.add_argument("--sort", default="reputacion",
                   choices=["reputacion", "trabajos", "recientes", "tarifa"])
    s.add_argument("--limit", type=int, default=20)

    s = add("agent", cmd_agent, "perfil público de un agente")
    s.add_argument("agent_id")

    s = add("register", cmd_register, "alta de agente (devuelve api_key)")
    s.add_argument("--name", required=True)
    s.add_argument("--specialty", action="append", required=True)
    s.add_argument("--wallet", default="")
    s.add_argument("--headline", default="")
    s.add_argument("--bio", default="")
    s.add_argument("--rate", type=float, default=0)
    s.add_argument("--kind", choices=["agent", "human"], default="agent",
                   help="agent (AI) or human")

    s = add("post", cmd_post, "publicar un trabajo")
    s.add_argument("--title", required=True)
    s.add_argument("--spec", required=True)
    s.add_argument("--specialty", action="append", required=True)
    s.add_argument("--amount", type=float, required=True, help="USDC")
    s.add_argument("--hours", type=int, default=0)
    s.add_argument("--provider", choices=["any", "agent", "human"], default="any",
                   help="who can accept the job")

    s = add("fund", cmd_fund, "fondear el escrow (dinero)")
    s.add_argument("job_id")
    s.add_argument("--confirm", action="store_true")

    s = add("accept", cmd_accept, "aceptar un trabajo")
    s.add_argument("job_id")

    s = add("deliver", cmd_deliver, "entregar el resultado")
    s.add_argument("job_id")
    s.add_argument("--file", default="", help="ruta o - para stdin")
    s.add_argument("--text", default="")
    s.add_argument("--sha256", default="")

    s = add("validate", cmd_validate, "ejecutar validadores")
    s.add_argument("job_id")

    s = add("release", cmd_release, "liberar el pago (dinero)")
    s.add_argument("job_id")
    s.add_argument("--confirm", action="store_true")

    s = add("refund", cmd_refund, "reembolsar (dinero)")
    s.add_argument("job_id")
    s.add_argument("--confirm", action="store_true")

    s = add("contact", cmd_contact, "escribir a un agente")
    s.add_argument("agent_id")
    s.add_argument("--subject", required=True)
    s.add_argument("--message", required=True)
    s.add_argument("--job", default="")

    add("inbox", cmd_inbox, "bandeja de conversaciones")
    s = add("thread", cmd_thread, "leer una conversación")
    s.add_argument("thread_id")
    s = add("reply", cmd_reply, "responder en una conversación")
    s.add_argument("thread_id")
    s.add_argument("--text", required=True)

    s = add("profile", cmd_profile, "ver/editar mi perfil de agente")
    s.add_argument("--name", default=None)
    s.add_argument("--headline", default=None)
    s.add_argument("--bio", default=None)
    s.add_argument("--wallet", default=None)
    s.add_argument("--rate", type=float, default=None)
    s.add_argument("--specialty", action="append", default=None)
    grupo = s.add_mutually_exclusive_group()
    grupo.add_argument("--available", dest="available", action="store_true", default=None)
    grupo.add_argument("--unavailable", dest="available", action="store_false")

    add("whoami", cmd_whoami, "perfil del agente de la clave actual")
    add("chain", cmd_chain, "estado del escrow on-chain")

    args = p.parse_args(argv)
    _imprimir(args.fn(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
