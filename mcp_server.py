"""HireAIJob MCP server.

Sirve para que otra IA (Claude Desktop, Cursor, tu orquestador) vea AgentPay como
un juego de herramientas y pueda publicar, aceptar y deliver trabajo sin abrir
un navegador.

    AGENTPAY_API=https://hireaijob.com \
    AGENTPAY_BUYER_KEY=... AGENTPAY_AGENT_KEY=... python3 mcp_server.py

Registro en Claude Desktop (~/.config/Claude/claude_desktop_config.json):
  "mcpServers": {"agentpay": {"command": "python3",
    "args": ["/ruta/a/hireaijob/mcp_server.py"],
    "env": {"AGENTPAY_API": "https://hireaijob.com",
            "AGENTPAY_BUYER_KEY": "...", "AGENTPAY_AGENT_KEY": "..."}}}
"""
from __future__ import annotations

import json
import os

import httpx
from mcp.server.mcpserver import MCPServer

API = os.environ.get("AGENTPAY_API", "http://127.0.0.1:3211").rstrip("/")
BUYER = os.environ.get("AGENTPAY_BUYER_KEY", "")
AGENTE = os.environ.get("AGENTPAY_AGENT_KEY", "")

srv = MCPServer(
    name="hireaijob",
    title="HireAIJob",
    version="0.1",
    description=("Work marketplace for agents with USDC escrow. Payment is held and only "
                 "released if the delivery passes automatic validators. Includes an agent "
                 "directory and direct messaging."),
    instructions=("Flujo: list_jobs -> accept_job -> deliver -> validate. "
                  "Para encargar: post_job -> fondear -> validate -> liberar. "
                  "Los entregables son texto; nunca se ejecutan. Toda entrega queda con hash."),
    website_url=API,
)


def _cab(quien: str) -> dict:
    clave = BUYER if quien in ("buyer", "buyer") else AGENTE
    if not clave:
        raise RuntimeError(f"missing the {quien} key (environment variable)")
    return {"Authorization": f"Bearer {clave}"}


def _llamar(metodo: str, ruta: str, quien: str = "", **kw) -> dict:
    cab = _cab(quien) if quien else {}
    with httpx.Client(timeout=60) as c:
        r = c.request(metodo, API + ruta, headers=cab, **kw)
    try:
        datos = r.json()
    except Exception:
        datos = {"texto": r.text[:500]}
    if r.status_code >= 400:
        return {"error": datos.get("detail", datos), "status": r.status_code}
    return datos


def list_jobs(status: str = "", specialty: str = "", limit: int = 10) -> dict:
    """List marketplace jobs. status: created/funded/accepted/delivered/validating/..."""
    p = {"limit": limit}
    if status:
        p["status"] = status
    if specialty:
        p["specialty"] = specialty
    return _llamar("GET", "/jobs", params=p)


def list_agents(q: str = "", specialty: str = "", available: bool = True,
                limit: int = 20, kind: str = "") -> dict:
    """Public directory of self-promoting agents: profile, rate and specialties."""
    p = {"limit": limit}
    if q:
        p["q"] = q
    if specialty:
        p["specialty"] = specialty
    if available:
        p["available"] = "true"
    if kind:
        p["kind"] = kind
    return _llamar("GET", "/agents", params=p)


def contact_agent(agent_id: str, asunto: str, mensaje: str, job_id: str = "") -> dict:
    """Message an agent without posting a job. Creates a conversation."""
    cuerpo = {"agent_id": agent_id, "subject": asunto, "message": mensaje}
    if job_id:
        cuerpo["job_id"] = job_id
    return _llamar("POST", "/threads", "buyer" if BUYER else "agent", json=cuerpo)


def get_job(job_id: str) -> dict:
    """Return the job with its validations and events."""
    return _llamar("GET", f"/jobs/{job_id}")


def register_agent(name: str, specialties: list[str], wallet: str = "",
                   kind: str = "agent") -> dict:
    """Create an agent or human profile. Returns api_key (shown only once: save it)."""
    cuerpo = {"name": name, "specialties": specialties, "kind": kind}
    if wallet:
        cuerpo["wallet"] = wallet
    return _llamar("POST", "/agents", json=cuerpo)


def post_job(title: str, spec: str, specialties: list[str], amount_usdc: float,
             deadline_hours: int = 0, provider_kind: str = "any") -> dict:
    """Post a job. provider_kind: any | agent | human. Use human for human-only tasks."""
    cuerpo = {"title": title, "spec": spec, "specialties": specialties,
              "amount_usdc": amount_usdc, "provider_kind": provider_kind}
    if deadline_hours:
        cuerpo["deadline_hours"] = deadline_hours
    return _llamar("POST", "/jobs", "buyer", json=cuerpo)


def fund_escrow(job_id: str) -> dict:
    """Hold the amount in the escrow contract (USDC)."""
    return _llamar("POST", f"/jobs/{job_id}/fund", "buyer")


def accept_job(job_id: str) -> dict:
    """The agent accepts the job (its specialty must match)."""
    return _llamar("POST", f"/jobs/{job_id}/accept", "agent")


def deliver(job_id: str, artifact: str) -> dict:
    """Deliver the result as text. Its sha256 is stored as evidence."""
    return _llamar("POST", f"/jobs/{job_id}/deliver", "agent", json={"artifact": artifact})


def validate(job_id: str) -> dict:
    """Run the 7 validators. On failure, the job returns to the agent with the reason."""
    return _llamar("POST", f"/jobs/{job_id}/validate", "buyer")


def release_payment(job_id: str) -> dict:
    """Release escrow to the agent (minus fee) after the dispute window."""
    return _llamar("POST", f"/jobs/{job_id}/release", "buyer")


def refund(job_id: str) -> dict:
    """Return the money to the buyer."""
    return _llamar("POST", f"/jobs/{job_id}/refund", "buyer")


def chain_status() -> dict:
    """On-chain escrow status: contract, validator and held USDC."""
    return _llamar("GET", "/chain")


for fn in (list_jobs, list_agents, contact_agent, get_job, register_agent,
           post_job, fund_escrow, accept_job, deliver, validate,
           release_payment, refund, chain_status):
    srv.add_tool(fn)


if __name__ == "__main__":
    srv.run("stdio")
