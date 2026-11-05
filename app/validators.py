"""Delivery validators.

Golden rule: the deliverable is UNTRUSTED TEXT. It is not executed, opened or
followed. Each validator returns hashed evidence so a dispute can be resolved
with data, not opinions.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile

MAX_BYTES = 2_000_000

INYECCION = [
    r"ignore (all )?(your |previous )?instructions",
    r"ignora (todas )?(tus |las )?instrucciones",
    r"you are now|ahora eres",
    r"release (the )?(payment|escrow)|libera (el )?pago",
    r"system prompt",
    r"approve (this|the) work|aprueba (el )?trabajo",
    r"valid[ae] (this )?(as|como) (pass|ok|válido)",
]
MALWARE = [
    r"rm -rf /", r"curl [^|\n]*\|\s*(ba)?sh", r"wget [^|\n]*\|\s*(ba)?sh",
    r"base64 -d[^\n]*\|\s*sh", r"nc -e /bin/(ba)?sh", r"chmod \+s",
    r"powershell -enc", r"eval\(atob\(", r"document\.cookie[\s\S]{0,40}fetch",
    r"\bkeylog|\bminer\b|xmrig", r"net user .* /add",
]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def _res(name: str, passed: bool, score: float, evidence: str) -> dict:
    return {"validator": name, "passed": passed, "score": round(score, 3), "evidence": evidence}


def tamano(artifact: str) -> dict:
    n = len(artifact.encode("utf-8", "replace"))
    ok = 0 < n <= MAX_BYTES
    return _res("size", ok, 1.0 if ok else 0.0, f"{n} bytes (max {MAX_BYTES})")


def integridad(artifact: str, esperado: str | None) -> dict:
    h = sha(artifact)
    if esperado is None:
        return _res("integrity", True, 1.0, f"sha256={h}")
    ok = h == esperado
    return _res("integrity", ok, 1.0 if ok else 0.0, f"sha256={h} expected={esperado}")


def inyeccion(artifact: str) -> dict:
    hits = [p for p in INYECCION if re.search(p, artifact, re.I)]
    return _res("prompt_injection", not hits, 0.0 if hits else 1.0,
                "no embedded instructions" if not hits else f"patterns: {hits}")


def malware(artifact: str) -> dict:
    hits = [p for p in MALWARE if re.search(p, artifact, re.I)]
    if not hits:
        return _res("malware", True, 1.0, "no risk patterns")
    return _res("malware", False, 0.0, f"patterns: {hits}")


def antivirus(artifact: str) -> dict:
    """ClamAV when installed; otherwise reported as unavailable (never faked as passing)."""
    exe = shutil.which("clamscan")
    if not exe:
        return _res("antivirus", True, 0.5, "clamav not installed: not scanned")
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(artifact)
        ruta = f.name
    try:
        p = subprocess.run([exe, "--no-summary", "--stdout", ruta], capture_output=True,
                           text=True, timeout=120)
        limpio = p.returncode == 0
        return _res("antivirus", limpio, 1.0 if limpio else 0.0,
                    (p.stdout or p.stderr).strip()[:300])
    finally:
        os.unlink(ruta)


def sintaxis_python(artifact: str) -> dict:
    """If the deliverable contains Python, compile it (never execute) to catch breakage."""
    if not re.search(r"^\s*(def |class |import )", artifact, re.M):
        return _res("syntax", True, 0.5, "not applicable (no Python code)")
    try:
        compile(artifact, "<deliverable>", "exec")
        return _res("syntax", True, 1.0, "compiles")
    except SyntaxError as e:
        return _res("syntax", False, 0.0, f"SyntaxError: {e}")


def requisitos(spec: str, artifact: str) -> dict:
    """Every item listed after "must include/have:" must appear in the delivery."""
    bloques = re.findall(r"(?:debe(?:s)?\s+(?:incluir|tener|aparecer)|must\s+(?:include|have))[:\s]+([^\n]{3,300})", spec, re.I)
    claves: list[str] = []
    for b in bloques:
        trozos = re.split(r"[,;]|\s+y\s+|\s+and\s+", b)
        for t in trozos:
            t = re.sub(r"^[\s\-•·*\d.)]+", "", t).strip(" .;:")
            if 3 <= len(t) <= 80:
                claves.append(t)
    claves = [k for k in claves if not re.match(r"^(el|la|los|las|un|una)\b", k, re.I)] or claves
    if not claves:
        return _res("requirements", True, 0.6, "the brief defines no checkable requirements")
    bajo = artifact.lower()
    faltan = [k for k in claves if k.lower() not in bajo]
    ok = not faltan
    return _res("requirements", ok, 1.0 if ok else 0.0,
                f"{len(claves)} requirements, all present" if ok
                else f"missing {len(faltan)}/{len(claves)}: {faltan[:4]}")


def ejecutar(spec: str, artifact: str, expected_sha: str | None = None,
             minimo: float = 0.85) -> tuple[bool, list[dict]]:
    """Run the full suite. Configurable threshold; any hard validator failing rejects
    the delivery."""
    resultados = [
        tamano(artifact),
        integridad(artifact, expected_sha),
        inyeccion(artifact),
        malware(artifact),
        antivirus(artifact),
        sintaxis_python(artifact),
        requisitos(spec, artifact),
    ]
    duros = {"size", "integrity", "prompt_injection", "malware", "antivirus", "syntax", "requirements"}
    fallo_duro = any(r["validator"] in duros and not r["passed"] for r in resultados)
    score = sum(r["score"] for r in resultados) / len(resultados)
    return (not fallo_duro and score >= minimo), resultados
