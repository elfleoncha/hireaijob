"""Base de datos y libro mayor de doble entrada.

Todo el dinero vive en cuentas contables; un pago son dos apuntes que suman cero.
Así el escrow es auditable: si las cuentas no cuadran, algo se ha tocado.
"""
import hashlib
import os
import pathlib
import secrets
import sqlite3
import time
from contextlib import contextmanager

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DB = os.environ.get("AGENTPAY_DB", str(RAIZ / "data" / "agentpay.db"))

# Cuentas del sistema
CUENTAS = ("escrow", "fees", "agent", "buyer")


@contextmanager
def conn():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    with conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              specialties TEXT NOT NULL,
              key_hash TEXT NOT NULL,
              key_prefix TEXT NOT NULL,
              wallet TEXT,
              stake_micros INTEGER NOT NULL DEFAULT 0,
              reputation INTEGER NOT NULL DEFAULT 0,
              jobs_done INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              spec TEXT NOT NULL,
              specialties TEXT NOT NULL,
              amount_micros INTEGER NOT NULL,
              state TEXT NOT NULL,
              buyer_id TEXT NOT NULL,
              agent_id TEXT,
              artifact TEXT,
              artifact_sha TEXT,
              rejection TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              deadline INTEGER
            );
            CREATE TABLE IF NOT EXISTS ledger (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              account TEXT NOT NULL,
              party TEXT,
              delta_micros INTEGER NOT NULL,
              memo TEXT,
              ts INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS validations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              validator TEXT NOT NULL,
              passed INTEGER NOT NULL,
              score REAL,
              evidence TEXT,
              ts INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT,
              kind TEXT NOT NULL,
              detail TEXT,
              ts INTEGER NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS ledger_no_delete
            BEFORE DELETE ON ledger
            BEGIN SELECT RAISE(ABORT, 'el libro mayor no se borra'); END;

            CREATE TABLE IF NOT EXISTS threads (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              job_id TEXT,
              subject TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              buyer_read_ts INTEGER NOT NULL DEFAULT 0,
              agent_read_ts INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS thread_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              thread_id TEXT NOT NULL,
              sender TEXT NOT NULL,
              body TEXT NOT NULL,
              ts INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS threads_agent ON threads(agent_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS thread_msgs ON thread_messages(thread_id, id);
            """
        )
        # El perfil público del agente (publicitarse) se añadió después:
        # se migra en caliente para no romper bases de datos ya existentes.
        cols = {r["name"] for r in c.execute("PRAGMA table_info(agents)")}
        for col, ddl in (
            ("headline", "TEXT"),
            ("bio", "TEXT"),
            ("rate_micros", "INTEGER NOT NULL DEFAULT 0"),
            ("available", "INTEGER NOT NULL DEFAULT 1"),
            ("profile_updated_at", "INTEGER"),
        ):
            if col not in cols:
                c.execute(f"ALTER TABLE agents ADD COLUMN {col} {ddl}")


def new_id(pref: str) -> str:
    return f"{pref}_{secrets.token_hex(8)}"


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def make_key() -> tuple[str, str, str]:
    """Devuelve (clave en claro, hash, prefijo para mostrar)."""
    key = "ap_" + secrets.token_urlsafe(32)
    return key, hash_key(key), key[:10]


def post(job_id: str, movimientos: list[tuple[str, str | None, int, str]]):
    """Asienta movimientos (account, party, delta_micros, memo). Deben sumar 0."""
    total = sum(m[2] for m in movimientos)
    if total != 0:
        raise ValueError(f"el asiento no cuadra: {total}")
    with conn() as c:
        for account, party, delta, memo in movimientos:
            c.execute(
                "INSERT INTO ledger (job_id, account, party, delta_micros, memo, ts) "
                "VALUES (?,?,?,?,?,?)",
                (job_id, account, party, delta, memo, int(time.time())),
            )


def saldo(cuenta: str, party: str | None = None) -> int:
    q = "SELECT COALESCE(SUM(delta_micros),0) AS s FROM ledger WHERE account=?"
    args = [cuenta]
    if party is not None:
        q += " AND party=?"
        args.append(party)
    with conn() as c:
        return int(c.execute(q, args).fetchone()["s"])


def evento(job_id: str | None, kind: str, detail: str = "", c: sqlite3.Connection | None = None):
    sql = "INSERT INTO events (job_id, kind, detail, ts) VALUES (?,?,?,?)"
    args = (job_id, kind, detail, int(time.time()))
    if c is not None:          # ya estamos dentro de una transacción
        c.execute(sql, args)
        return
    with conn() as cc:
        cc.execute(sql, args)
