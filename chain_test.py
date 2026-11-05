"""Prueba del contrato de escrow en una cadena EVM local (sin red, sin dinero).

    python3 chain_test.py

Compila AgentPayEscrow + MockUSDC, despliega en eth-tester y simula el ciclo:
fondear (el comprador aprueba y deposita), liberar (el validador firma) y
reembolsar. Comprueba los saldos finales y que un tercero no puede liberar.
"""
from __future__ import annotations

import json
import pathlib
import sys

import solcx
from eth_tester.exceptions import TransactionFailed
from web3 import EthereumTesterProvider, Web3

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "build"
SOLC = "0.8.24"


def compilar(nombre: str, archivo: str) -> tuple[list, str]:
    src = (ROOT / "contracts" / archivo).read_text()
    entrada = {
        "language": "Solidity",
        "sources": {archivo: {"content": src}},
        "settings": {"optimizer": {"enabled": True, "runs": 200},
                     "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}}},
    }
    salida = solcx.compile_standard(entrada, solc_version=SOLC)
    c = salida["contracts"][archivo][nombre]
    OUT.mkdir(exist_ok=True)
    (OUT / f"{nombre}.json").write_text(json.dumps(
        {"abi": c["abi"], "bytecode": c["evm"]["bytecode"]["object"]}, indent=1))
    return c["abi"], "0x" + c["evm"]["bytecode"]["object"]


def main():
    if SOLC not in [str(v) for v in solcx.get_installed_solc_versions()]:
        solcx.install_solc(SOLC)

    w3 = Web3(EthereumTesterProvider())
    buyer, agent, validator, fee_wallet, curioso = w3.eth.accounts[:5]

    abi_usdc, bin_usdc = compilar("MockUSDC", "MockUSDC.sol")
    abi_esc, bin_esc = compilar("AgentPayEscrow", "AgentPayEscrow.sol")

    usdc = w3.eth.contract(abi=abi_usdc, bytecode=bin_usdc)
    tx = usdc.constructor().transact({"from": buyer})
    usdc = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress,
                           abi=abi_usdc)

    esc = w3.eth.contract(abi=abi_esc, bytecode=bin_esc)
    tx = esc.constructor(usdc.address, validator, fee_wallet).transact({"from": buyer})
    esc = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress,
                          abi=abi_esc)

    def usdc_de(addr):
        return usdc.functions.balanceOf(addr).call() / 1e6

    print("contratos:", usdc.address, esc.address)
    usdc.functions.mint(buyer, 100_000_000).transact({"from": buyer})  # 100 USDC
    print("comprador tiene", usdc_de(buyer), "USDC")

    job = b"\x11" * 32
    plazo = w3.eth.get_block("latest").timestamp + 3600

    # 1) fondear
    usdc.functions.approve(esc.address, 40_000_000).transact({"from": buyer})
    esc.functions.fund(job, 40_000_000, plazo).transact({"from": buyer})
    print("en escrow:", usdc_de(esc.address), "USDC | comprador:", usdc_de(buyer))
    assert usdc_de(esc.address) == 40.0

    # 1b) el validador asigna el agente cuando acepta
    esc.functions.assignAgent(job, agent).transact({"from": validator})

    # 2) un curioso no puede liberar
    try:
        esc.functions.release(job).transact({"from": curioso})
        print("FALLO: un tercero pudo liberar")
        return 1
    except TransactionFailed:
        print("ok: un tercero no puede liberar")

    # 3) el validador libera
    print("comisión calculada:", esc.functions.comision(40_000_000).call() / 1e6, "USDC")
    esc.functions.release(job).transact({"from": validator})
    print("agente:", usdc_de(agent), "| fees:", usdc_de(fee_wallet),
          "| escrow:", usdc_de(esc.address))
    assert usdc_de(agent) == 36.0 and usdc_de(fee_wallet) == 4.0

    # 4) reembolso tras el plazo
    job2 = b"\x22" * 32
    usdc.functions.approve(esc.address, 20_000_000).transact({"from": buyer})
    esc.functions.fund(job2, 20_000_000, plazo).transact({"from": buyer})
    esc.functions.assignAgent(job2, agent).transact({"from": validator})
    antes = usdc_de(buyer)
    try:
        esc.functions.refund(job2).transact({"from": buyer})
        print("FALLO: reembolsó antes del plazo")
        return 1
    except TransactionFailed:
        print("ok: no se reembolsa antes del plazo")
    w3.provider.ethereum_tester.time_travel(plazo + 1)
    esc.functions.refund(job2).transact({"from": buyer})
    print("reembolsado, comprador recupera:", usdc_de(buyer) - antes, "USDC")
    assert usdc_de(buyer) - antes == 20.0

    print("\ntodo correcto: escrow, comisión 10 %, permisos y reembolso")
    return 0


if __name__ == "__main__":
    sys.exit(main())
