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


def _real() -> bool:
    return bool(os.environ.get("AGENTPAY_RPC"))


def requiere_wallet() -> bool:
    """On a real network an agent/human must publish a payout wallet."""
    return _real()


def _cuenta(env: str):
    from eth_account import Account
    clave = os.environ.get(env, "").strip()
    if not clave:
        raise RuntimeError(f"missing {env}")
    return Account.from_key(clave)


def _validator_cuenta():
    from eth_account import Account
    clave = os.environ.get("AGENTPAY_VALIDATOR_KEY", "").strip()
    if not clave:
        ruta = BUILD.parent / ".validator.key"
        if ruta.exists():
            clave = ruta.read_text().strip()
    if not clave:
        raise RuntimeError("missing AGENTPAY_VALIDATOR_KEY")
    return Account.from_key(clave)


def _firma(w3, cuenta, fn, gas_extra: float = 1.25) -> str:
    """Firma y envía una transacción EIP-1559 en una red real."""
    nonce = w3.eth.get_transaction_count(cuenta.address)
    try:
        gas = int(fn.estimate_gas({"from": cuenta.address}) * gas_extra) + 10_000
    except Exception:
        gas = 500_000
    base = w3.eth.gas_price
    tx = fn.build_transaction({
        "from": cuenta.address,
        "nonce": nonce,
        "chainId": w3.eth.chain_id,
        "gas": gas,
        "maxFeePerGas": max(base * 2, w3.to_wei(0.001, "gwei")),
        "maxPriorityFeePerGas": w3.to_wei(0.001, "gwei"),
    })
    firmada = cuenta.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(firmada.raw_transaction)
    rec = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    if rec.status != 1:
        raise RuntimeError(f"tx reverted: {h.hex()}")
    return h.hex()


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
        if _real():
            from web3 import Web3
            usdc_dir = os.environ.get("AGENTPAY_USDC")
            esc_dir = os.environ.get("AGENTPAY_ESCROW")
            if not usdc_dir or not esc_dir:
                raise RuntimeError("AGENTPAY_USDC and AGENTPAY_ESCROW are required on a real RPC")
            usdc = w3.eth.contract(address=Web3.to_checksum_address(usdc_dir),
                                   abi=_abi("MockUSDC")["abi"])
            esc = w3.eth.contract(address=Web3.to_checksum_address(esc_dir),
                                  abi=_abi("AgentPayEscrow")["abi"])
            _state.update(w3=w3, usdc=usdc, escrow=esc)
            return _estado()
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
    nombres = {8453: "base", 84532: "base-sepolia", 11155111: "sepolia"}
    chain_id = w3.eth.chain_id
    cadena = "local" if not os.environ.get("AGENTPAY_RPC") else nombres.get(chain_id, f"rpc:{chain_id}")
    return {
        "cadena": cadena,
        "chain_id": chain_id,
        "usdc": usdc.address,
        "escrow": esc.address,
        "validador": esc.functions.validator().call(),
        "fee_wallet": esc.functions.feeWallet().call(),
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
    """El comprador aprueba y deposita en el contrato (agente se asigna al aceptar)."""
    listo()
    w3, usdc, esc = _state["w3"], _state["usdc"], _state["escrow"]
    micros = int(round(importe_usdc * 1e6))
    plazo = w3.eth.get_block("latest").timestamp + plazo_seg
    if _real():
        buyer = _cuenta("AGENTPAY_BUYER_PK")
        saldo = usdc.functions.balanceOf(buyer.address).call()
        if saldo < micros:
            raise RuntimeError(f"buyer USDC balance {saldo / 1e6:.2f} < {micros / 1e6:.2f}")
        _firma(w3, buyer, usdc.functions.approve(esc.address, micros))
        tx = _firma(w3, buyer, esc.functions.fund(_job_id(jid), micros, plazo))
        return {"tx": tx, "escrow": _job_id(jid).hex(), "importe_usdc": micros / 1e6,
                "contrato": esc.address, "comprador": buyer.address}
    buyer = _state["buyer"]
    usdc.functions.mint(buyer, micros).transact({"from": buyer})
    usdc.functions.approve(esc.address, micros).transact({"from": buyer})
    tx = esc.functions.fund(_job_id(jid), micros, plazo).transact({"from": buyer})
    return {"tx": tx.hex(), "escrow": _job_id(jid).hex(), "importe_usdc": micros / 1e6,
            "contrato": esc.address}


def asignar_agente(jid: str, wallet: str | None) -> dict:
    """Asigna on-chain el agente/humano que ha aceptado el trabajo."""
    listo()
    w3, esc = _state["w3"], _state["escrow"]
    if not wallet:
        if _real():
            raise RuntimeError("the agent needs a wallet before accepting on-chain")
        wallet = _state["agent"]
    from web3 import Web3
    destino = Web3.to_checksum_address(wallet)
    if _real():
        tx = _firma(w3, _validator_cuenta(), esc.functions.assignAgent(_job_id(jid), destino))
        return {"tx": tx, "agente": destino}
    tx = esc.functions.assignAgent(_job_id(jid), destino).transact({"from": _state["validator"]})
    return {"tx": tx.hex(), "agente": destino}


def liberar(jid: str) -> dict:
    listo()
    w3, esc = _state["w3"], _state["escrow"]
    if _real():
        tx = _firma(w3, _validator_cuenta(), esc.functions.release(_job_id(jid)))
        return {"tx": tx, "contrato": esc.address}
    tx = esc.functions.release(_job_id(jid)).transact({"from": _state["validator"]})
    return {"tx": tx.hex(), "contrato": esc.address}


def reembolsar(jid: str) -> dict:
    listo()
    w3, esc = _state["w3"], _state["escrow"]
    if _real():
        tx = _firma(w3, _validator_cuenta(), esc.functions.refund(_job_id(jid)))
        return {"tx": tx, "contrato": esc.address}
    tx = esc.functions.refund(_job_id(jid)).transact({"from": _state["validator"]})
    return {"tx": tx.hex(), "contrato": esc.address}
