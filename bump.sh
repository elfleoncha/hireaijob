#!/usr/bin/env bash
# Sube la versión de CSS/JS en las páginas para saltarse la caché del CDN.
#   ./bump.sh && pm2 restart agentpay
set -e
cd "$(dirname "$0")"
VER="$(date +%Y%m%d%H%M%S)"
python3 - "$VER" <<'PY'
import pathlib, re, sys
ver = sys.argv[1]
for p in ["web/landing/index.html","web/auth/index.html","web/panel/index.html"]:
    f = pathlib.Path(p)
    if not f.exists(): continue
    s = f.read_text()
    s = re.sub(r'(href|src)="(/(?:styles\.css|app\.js|brand/brand\.css|brand/i18n\.js|brand/copy\.js|brand/guide\.css))(?:\?v=[^"]*)?"',
               r'\1="\2?v=%s"' % ver, s)
    f.write_text(s)
print("assets versionados:", ver)
PY
