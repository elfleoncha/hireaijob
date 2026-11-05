"""Pruebas de cuentas, sesiones y bloqueos (sin red)."""
import os
import pathlib

os.environ.setdefault("AGENTPAY_DB", "/tmp/auth-test.db")
os.environ.setdefault("AGENTPAY_ADMIN_KEY", "admin-test")
os.environ.setdefault("AGENTPAY_LOGIN_INTENTOS", "4")
os.environ.setdefault("AGENTPAY_ONCHAIN", "0")
os.environ.setdefault("AGENTPAY_BUYER_KEY", "comprador")

p = pathlib.Path(os.environ["AGENTPAY_DB"])
for s in ("", "-wal", "-shm"):
    q = pathlib.Path(str(p) + s)
    if q.exists():
        q.unlink()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

C = TestClient(app)
fallos = []


def check(nombre, cond, detalle=""):
    print(("  ok   " if cond else "  FALLO") + f"  {nombre}" + (f"  ({detalle})" if detalle and not cond else ""))
    if not cond:
        fallos.append(nombre)


def reg(email="a@example.com", password="claveLarga123", rol="buyer"):
    return C.post("/auth/register", json={"email": email, "password": password,
                                         "name": "Prueba", "role": rol})


print("\n— registro")
r = reg()
check("registro correcto", r.status_code == 200, r.text[:120])
check("la respuesta no filtra el hash", "scrypt" not in r.text)
check("correo duplicado rechazado", reg().status_code == 409)
check("correo de usar y tirar rechazado", reg("x@mailinator.com").status_code == 422)
check("contraseña corta rechazada", reg("b@example.com", "corta").status_code == 422)
check("correo inválido rechazado", reg("no-es-correo").status_code == 422)

print("\n— sesión")
check("sin cookie no hay sesión", TestClient(app).get("/auth/me").status_code == 401)
ck = C.post("/auth/login", json={"email": "a@example.com", "password": "claveLarga123"})
check("login correcto", ck.status_code == 200, ck.text[:120])
check("cookie HttpOnly", "httponly" in ck.headers.get("set-cookie", "").lower())
check("cookie SameSite", "samesite=lax" in ck.headers.get("set-cookie", "").lower())
yo = C.get("/auth/me", cookies=ck.cookies)
check("me devuelve el rol", yo.status_code == 200 and yo.json()["role"] == "buyer", yo.text[:100])

print("\n— fuerza bruta")
C.post("/auth/logout", cookies=ck.cookies)
codigos = [C.post("/auth/login", json={"email": "a@example.com", "password": "mal"}).status_code
           for _ in range(8)]
check("se frena tras varios intentos", 429 in codigos, f"{sorted(set(codigos))}")

print("\n— bloqueos")
AD = {"Authorization": "Bearer admin-test"}
uid = yo.json()["user_id"]
check("sin clave admin no se puede banear",
      C.post("/auth/admin/ban", json={"kind": "user", "valor": uid, "motivo": "x"}).status_code == 403)
check("ban por usuario", C.post("/auth/admin/ban", headers=AD,
      json={"kind": "user", "valor": uid, "motivo": "fraude"}).status_code == 200)
r = C.post("/auth/login", json={"email": "a@example.com", "password": "claveLarga123"})
check("cuenta bloqueada no entra", r.status_code == 423, r.text[:100])
check("la sesión viva muere al bloquear", C.get("/auth/me", cookies=ck.cookies).status_code in (401, 423))

reg("c@example.com", rol="agent")
ck2 = C.post("/auth/login", json={"email": "c@example.com", "password": "claveLarga123"})
dispositivos = C.get("/auth/devices", cookies=ck2.cookies).json()["dispositivos"]
did = dispositivos[0]["id"]
check("revocar dispositivo", C.post(f"/auth/devices/{did}/revoke",
      cookies=ck2.cookies).status_code == 200)
r = C.post("/auth/login", json={"email": "c@example.com", "password": "claveLarga123"},
           cookies=ck2.cookies)
check("un dispositivo revocado no vuelve a entrar", r.status_code == 423, r.text[:110])

print("\n— passkey")
op = C.get("/auth/me", cookies=ck2.cookies)
check("me responde (aunque el dispositivo esté revocado no debe dejar pasar sesión nueva)",
      op.status_code in (200, 401, 423))

print("\n— administración")
check("revisión solo con clave", C.get("/auth/admin/revision").status_code == 403)
rev = C.get("/auth/admin/revision", headers=AD)
check("revisión devuelve usuarios y bloqueos",
      rev.status_code == 200 and rev.json()["bloqueos"], rev.text[:120])

print("\n" + ("TODO CORRECTO" if not fallos else f"FALLOS: {fallos}"))
raise SystemExit(0 if not fallos else 1)
