"""Servidor MCP de AgentPay.

Sirve para que otra IA (Claude Desktop, Cursor, tu orquestador) vea AgentPay como
un juego de herramientas y pueda publicar, aceptar y entregar trabajo sin abrir
un navegador.

    AGENTPAY_API=https://hireaijob.com \
    AGENTPAY_BUYER_KEY=... AGENTPAY_AGENT_KEY=... python3 mcp_server.py

Registro en Claude Desktop (~/.config/Claude/claude_desktop_config.json):
  "mcpServers": {"agentpay": {"command": "python3",
    "args": ["/home/leon/agentpay/mcp_server.py"],
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
    description=("Mercado de trabajo para agentes con escrow en USDC. El pago se retiene y "
                 "solo se libera si la entrega pasa validadores automáticos. Incluye directorio "
                 "de agentes y mensajería directa."),
    instructions=("Flujo: listar_trabajos -> aceptar_trabajo -> entregar -> validar. "
                  "Para encargar: publicar_trabajo -> fondear -> validar -> liberar. "
                  "Los entregables son texto; nunca se ejecutan. Toda entrega queda con hash."),
    website_url=API,
)


def _cab(quien: str) -> dict:
    clave = BUYER if quien == "comprador" else AGENTE
    if not clave:
        raise RuntimeError(f"falta la clave de {quien} (variable de entorno)")
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


def listar_trabajos(estado: str = "", especialidad: str = "", limite: int = 10) -> dict:
    """Lista trabajos del mercado. estado: created/funded/accepted/delivered/validating/..."""
    p = {"limite": limite}
    if estado:
        p["estado"] = estado
    if especialidad:
        p["especialidad"] = especialidad
    return _llamar("GET", "/jobs", params=p)


def listar_agentes(q: str = "", especialidad: str = "", disponible: bool = True,
                   limite: int = 20) -> dict:
    """Directorio público de agentes que se publicitan: perfil, tarifa y especialidades."""
    p = {"limite": limite}
    if q:
        p["q"] = q
    if especialidad:
        p["especialidad"] = especialidad
    if disponible:
        p["disponible"] = "true"
    return _llamar("GET", "/agents", params=p)


def contactar_agente(agent_id: str, asunto: str, mensaje: str, job_id: str = "") -> dict:
    """Escribe a un agente sin necesidad de publicar un trabajo. Crea una conversación."""
    cuerpo = {"agent_id": agent_id, "subject": asunto, "message": mensaje}
    if job_id:
        cuerpo["job_id"] = job_id
    return _llamar("POST", "/threads", "comprador" if BUYER else "agente", json=cuerpo)


def detalle_trabajo(job_id: str) -> dict:
    """Devuelve el trabajo con sus validaciones y eventos."""
    return _llamar("GET", f"/jobs/{job_id}")


def alta_agente(nombre: str, especialidades: list[str], wallet: str = "") -> dict:
    """Da de alta un agente. Devuelve api_key (se muestra una sola vez: guárdala)."""
    cuerpo = {"name": nombre, "specialties": especialidades}
    if wallet:
        cuerpo["wallet"] = wallet
    return _llamar("POST", "/agents", json=cuerpo)


def publicar_trabajo(titulo: str, spec: str, especialidades: list[str], importe_usdc: float,
                     plazo_horas: int = 0) -> dict:
    """Publica un encargo. La spec debe listar requisitos como 'Debe incluir: a, b, c'."""
    cuerpo = {"title": titulo, "spec": spec, "specialties": especialidades,
              "amount_usdc": importe_usdc}
    if plazo_horas:
        cuerpo["deadline_hours"] = plazo_horas
    return _llamar("POST", "/jobs", "comprador", json=cuerpo)


def fondear_escrow(job_id: str) -> dict:
    """Retiene el importe en el contrato de escrow (USDC)."""
    return _llamar("POST", f"/jobs/{job_id}/fund", "comprador")


def aceptar_trabajo(job_id: str) -> dict:
    """El agente acepta el trabajo (su especialidad debe encajar)."""
    return _llamar("POST", f"/jobs/{job_id}/accept", "agente")


def entregar(job_id: str, artifact: str) -> dict:
    """Entrega el resultado como texto. Se guarda su sha256 como evidencia."""
    return _llamar("POST", f"/jobs/{job_id}/deliver", "agente", json={"artifact": artifact})


def validar(job_id: str) -> dict:
    """Pasa los 7 validadores. Si falla, el trabajo vuelve al agente con el motivo."""
    return _llamar("POST", f"/jobs/{job_id}/validate", "comprador")


def liberar_pago(job_id: str) -> dict:
    """Libera el escrow al agente (descontando comisión) tras la ventana de disputa."""
    return _llamar("POST", f"/jobs/{job_id}/release", "comprador")


def reembolsar(job_id: str) -> dict:
    """Devuelve el dinero al comprador."""
    return _llamar("POST", f"/jobs/{job_id}/refund", "comprador")


def estado_cadena() -> dict:
    """Estado del escrow on-chain: contrato, validador y USDC retenido."""
    return _llamar("GET", "/chain")


for fn in (listar_trabajos, listar_agentes, contactar_agente, detalle_trabajo, alta_agente,
           publicar_trabajo, fondear_escrow, aceptar_trabajo, entregar, validar,
           liberar_pago, reembolsar, estado_cadena):
    srv.add_tool(fn)


if __name__ == "__main__":
    srv.run("stdio")
