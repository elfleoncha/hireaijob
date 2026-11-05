"""Puente con la cadena: escrow real en una EVM.

Modo local (por defecto): cadena en memoria (eth-tester) con MockUSDC, para
demostrar el ciclo sin red ni dinero. Modo rpc: cualquier nodo (Base, Base
Sepolia) con USDC real, configurando AGENTPAY_RPC, AGENTPAY_USDC y las claves.

Variables:
  AGENTPAY_ONCHAIN=1        activa el escrow on-chain
  AGENTPAY_RPC=<url>        nodo JSON-RPC (si falta, se usa eth-tester local)
  AGENTPAY_USDC=<dir>       dirección del token USDC
  AGENTPAY_VALIDATOR_KEY    clave privada del validador (firma release/refund)
  AGENTPAY_FEE_WALLET       dirección que cobra la comisión
  AGENTPAY_CHAIN_TEST=1     mintea USDC de prueba al comprador (sólo local)
"""
from __future__ import annotations

import json
import os
import pathlib
import threading

BUILD = pathlib.Path(__file__).resolve().parent.parent / "build"
_lock = threading.Lock()
_state: dict = {}


def activo() -> bool:
    return os.environ.get("AGENTPAY_ONCHAIN", "") == "1"


def _w3():
    from web3 import EthereumTesterProvider, Web3
    if "w3" in _state:
        return _state["w3"]
    rpc = os.environ.get("AGENTPAY_RPC")
    if rpc:
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
    else:
        w3 = Web3(EthereumTesterProvider())
    _state["w3"] = w3
    return w3


def _abi(nombre: str):
    return json.loads((BUILD / f"{nombre}.json").read_text())


def _desplegar(w3, abi, bytecode, *args, desde):
    c = w3.eth.contract(abi=abi, bytecode=bytecode)
    tx = c.constructor(*args).transact({"from": desde})
    rec = w3.eth.get_transaction_receipt(tx)
    return w3.eth.contract(address=rec.contractAddress, abi=abi)


def listo() -> dict:
    """Despliega (una vez) y devuelve el estado de la cadena local."""
    with _lock:
        if "escrow" in _state:
            return _estado()
        w3 = _w3()
        cuentas = w3.eth.accounts
        buyer, agent, validator, fee = cuentas[0], cuentas[1], cuentas[2], cuentas[3]
        usdc_dir = os.environ.get("AGENTPAY_USDC")
        if usdc_dir:
            usdc = w3.eth.contract(address=usdc_dir, abi=_abi("MockUSDC")["abi"])
        else:
            usdc = _desplegar(w3, _abi("MockUSDC")["abi"], _abi("MockUSDC")["bytecode"],
                              desde=buyer)
        esc_dir = os.environ.get("AGENTPAY_ESCROW")
        if esc_dir:
            esc = w3.eth.contract(address=esc_dir, abi=_abi("AgentPayEscrow")["abi"])
        else:
            vdir = validator
            clave_v = os.environ.get("AGENTPAY_VALIDATOR_KEY")
            if clave_v:
                vdir = w3.eth.account.from_key(clave_v).address
            esc = _desplegar(w3, _abi("AgentPayEscrow")["abi"],
                             _abi("AgentPayEscrow")["bytecode"],
                             usdc.address, vdir, os.environ.get("AGENTPAY_FEE_WALLET", fee),
                             desde=buyer)
        _state.update(w3=w3, usdc=usdc, escrow=esc, buyer=buyer, agent=agent,
                      validator=validator, fee=fee)
        return _estado()


def _estado() -> dict:
    w3, usdc, esc = _state["w3"], _state["usdc"], _state["escrow"]
    return {
        "cadena": "local" if os.environ.get("AGENTPAY_RPC") is None else os.environ["AGENTPAY_RPC"],
        "usdc": usdc.address,
        "escrow": esc.address,
        "validador": esc.functions.validator().call(),
        "en_escrow_usdc": usdc.functions.balanceOf(esc.address).call() / 1e6,
        "comision_bps": esc.functions.feeBps().call(),
    }


def _job_id(jid: str) -> bytes:
    import hashlib
    return hashlib.sha256(jid.encode()).digest()


def saldo_usdc(addr: str) -> float:
    listo()
    return _state["usdc"].functions.balanceOf(addr).call() / 1e6


def fondear(jid: str, importe_usdc: float, plazo_seg: int = 7 * 24 * 3600) -> dict:
    """El comprador aprueba y deposita en el contrato."""
    listo()
    w3, usdc, esc = _state["w3"], _state["usdc"], _state["escrow"]
    buyer, agent = _state["buyer"], _state["agent"]
    micros = int(round(importe_usdc * 1e6))
    if os.environ.get("AGENTPAY_RPC") is None:      # cadena de pruebas: faucet
        usdc.functions.mint(buyer, micros).transact({"from": buyer})
    usdc.functions.approve(esc.address, micros).transact({"from": buyer})
    plazo = w3.eth.get_block("latest").timestamp + plazo_seg
    tx = esc.functions.fund(_job_id(jid), agent, micros, plazo).transact({"from": buyer})
    return {"tx": tx.hex(), "escrow": _job_id(jid).hex(), "importe_usdc": micros / 1e6,
            "contrato": esc.address, "agente_onchain": agent}


def liberar(jid: str) -> dict:
    listo()
    esc = _state["escrow"]
    tx = esc.functions.release(_job_id(jid)).transact({"from": _state["validator"]})
    return {"tx": tx.hex(), "contrato": esc.address}


def reembolsar(jid: str) -> dict:
    listo()
    esc = _state["escrow"]
    tx = esc.functions.refund(_job_id(jid)).transact({"from": _state["validator"]})
    return {"tx": tx.hex(), "contrato": esc.address}
