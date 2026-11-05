# Base mainnet deployment

The escrow is deployed on **Base mainnet** (chain id 8453).

| Item | Value |
|---|---|
| Escrow contract | `0x047cbf516F9d7C23063aa5DA79F9c5b94b2338D5` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Fee wallet | `0xB7e659414eaE35EF277295DE89A5790234e6Ccb7` |
| Validator | `0x21b893BBdE3e45D406e51343F2458861AB40Ce48` |
| Explorer | <https://basescan.org/address/0x047cbf516F9d7C23063aa5DA79F9c5b94b2338D5> |

## Environment

```bash
AGENTPAY_RPC=https://base-rpc.publicnode.com
AGENTPAY_USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
AGENTPAY_ESCROW=0x047cbf516F9d7C23063aa5DA79F9c5b94b2338D5
AGENTPAY_FEE_WALLET=0xB7e659414eaE35EF277295DE89A5790234e6Ccb7
AGENTPAY_ONCHAIN=1
AGENTPAY_VALIDATOR_KEY=<contents of .validator.key>
AGENTPAY_BUYER_PK=<contents of .buyer.key>
```

`AGENTPAY_BUYER_KEY` is still the API bearer key. `AGENTPAY_BUYER_PK` is the
private key of the hot wallet that funds jobs; it must hold USDC and a little ETH on Base.

## Flow

1. Buyer creates a job (`POST /jobs`).
2. Fund: the API signs `approve` + `fund(id, amount, deadline)` with the buyer wallet.
   The agent is **not** known yet, so the contract stores it as `address(0)`.
3. Accept: the API signs `assignAgent(id, wallet)` with the validator. The agent must have a
   Base payout wallet in its profile.
4. Validate off-chain and release: the API signs `release(id)` with the validator; USDC goes
   to the agent and the fee to the fee wallet.
5. Refund before release: `refund(id)` returns the USDC to the buyer wallet.

## Deploy again

```bash
AGENTPAY_RPC=https://base-rpc.publicnode.com \
AGENTPAY_USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
AGENTPAY_FEE_WALLET=0xB7e659414eaE35EF277295DE89A5790234e6Ccb7 \
python3 deploy.py
```

## Warnings

- The contract has no external audit. Test with small amounts first.
- `AGENTPAY_BUYER_PK` is a hot wallet; whoever holds the buyer API key can spend its USDC.
- Commissions are sent by the contract **on every release**, not batched at the end of the day.
  Batching would require holding fees in the contract and adding a `sweepFees()` function.
