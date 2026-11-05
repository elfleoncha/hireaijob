"""Despliega AgentPayEscrow en una red real (por defecto Base Sepolia).

    AGENTPAY_FEE_WALLET=0xTuDireccion python3 deploy.py

Lee la clave del validador de `.validator.key` (600) y el USDC de
`AGENTPAY_USDC` (por defecto, USDC oficial de Base Sepolia).
Escribe el resultado en `.deployed.json` y muestra lo que hay que poner en el env.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

from eth_account import Account
from web3 import Web3

RAIZ = pathlib.Path(__file__).parent
RPC = os.environ.get("AGENTPAY_RPC", "https://sepolia.base.org")
USDC = os.environ.get("AGENTPAY_USDC", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")  # Base Sepolia
FEE = os.environ.get("AGENTPAY_FEE_WALLET", "")


def main() -> int:
    clave = (RAIZ / ".validator.key").read_text().strip()
    acct = Account.from_key(clave)
    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 60}))
    if not w3.is_connected():
        print("no puedo conectar con", RPC)
        return 1
    saldo = w3.from_wei(w3.eth.get_balance(acct.address), "ether")
    print(f"red {RPC} | chainId {w3.eth.chain_id}")
    print(f"validador {acct.address} | saldo {saldo} ETH")
    if not FEE:
        print("falta AGENTPAY_FEE_WALLET (dirección que cobra la comisión)")
        return 1
    if not Web3.is_address(FEE):
        print("AGENTPAY_FEE_WALLET no es una dirección válida")
        return 1
    if saldo == 0:
        print("sin ETH para gas: manda test ETH del faucet a esa dirección")
        return 1

    abi = json.loads((RAIZ / "build" / "AgentPayEscrow.json").read_text())
    contrato = w3.eth.contract(abi=abi["abi"], bytecode=abi["bytecode"])
    nonce = w3.eth.get_transaction_count(acct.address)
    tx = contrato.constructor(Web3.to_checksum_address(USDC), acct.address,
                              Web3.to_checksum_address(FEE)).build_transaction({
        "from": acct.address, "nonce": nonce, "chainId": w3.eth.chain_id,
        "gas": 2_500_000, "maxFeePerGas": w3.to_wei(0.2, "gwei"),
        "maxPriorityFeePerGas": w3.to_wei(0.01, "gwei"),
    })
    firmada = acct.sign_transaction(tx)
    h = w3.eth.send_raw_transaction(firmada.raw_transaction)
    print("tx:", h.hex())
    rec = w3.eth.wait_for_transaction_receipt(h, timeout=180)
    print("contrato:", rec.contractAddress, "| gas usado:", rec.gasUsed)
    datos = {"red": RPC, "chainId": w3.eth.chain_id, "escrow": rec.contractAddress,
             "usdc": USDC, "validador": acct.address, "fee_wallet": FEE,
             "tx": h.hex()}
    (RAIZ / ".deployed.json").write_text(json.dumps(datos, indent=1))
    print("\npon esto en el entorno:")
    for k, v in (("AGENTPAY_RPC", RPC), ("AGENTPAY_USDC", USDC),
                 ("AGENTPAY_ESCROW", rec.contractAddress), ("AGENTPAY_FEE_WALLET", FEE),
                 ("AGENTPAY_VALIDATOR_KEY", "<contenido de .validator.key>"),
                 ("AGENTPAY_ONCHAIN", "1")):
        print(f"  {k}={v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
