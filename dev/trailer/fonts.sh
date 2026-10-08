#!/bin/sh
# Downloads the trailer's fonts (Google Fonts, OFL) into dev/trailer/fonts/ (git-ignored).
set -e
D="$(dirname "$0")/fonts"
mkdir -p "$D"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
curl -sS -A "$UA" "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Special+Elite&family=Cormorant+Garamond:ital,wght@0,400;1,400&display=swap" -o "$D/fonts.css"
# Latin subsets only.
python3 - "$D" <<'PY'
import re, sys, urllib.request, subprocess
d = sys.argv[1]
css = open(f'{d}/fonts.css').read()
for sub, b in re.findall(r'/\* ([a-z\-]+) \*/\s*@font-face \{(.*?)\}', css, re.S):
    if sub != 'latin':
        continue
    fam = re.search(r"font-family: '([^']+)'", b).group(1).replace(' ', '')
    st = re.search(r"font-style: (\w+)", b).group(1)
    url = re.search(r"url\((.*?)\)", b).group(1)
    out = f'{d}/{fam}-{st}.woff2'
    subprocess.run(['curl', '-sS', '-o', out, url], check=True)
    print(out)
PY
