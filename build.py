"""Build the two published forms of DataPro web.

  dist/  the claude.ai artifact: index.html (core.js inlined) + h5plugins/libH5Zblosc.wasm
  docs/  the stand-alone site for GitHub Pages: full HTML document, manifest, service worker, icons

Usage: python build.py [path/to/libH5Zblosc.so]
The plugin comes from the npm package h5wasm-plugins@0.3.0 (plugins/libH5Zblosc.so).
"""
import hashlib
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / 'dist'
DOCS = HERE / 'docs'
PAGES = HERE / 'pages'

page = (HERE / 'app.html').read_text(encoding='utf-8')
INLINE = {'/*__DELAUNATOR__*/': 'vendor/delaunator.min.js', '/*__CORE__*/': 'core.js',
          '/*__MAPPING__*/': 'mapping.js', '/*__CMAPS__*/': 'cmaps.js'}
built = page
for marker, src in INLINE.items():
    assert marker in built, marker
    code = (HERE / src).read_text(encoding='utf-8')
    assert '</script' not in code.lower(), src
    built = built.replace(marker, code)

# --- artifact
DIST.mkdir(exist_ok=True)
(DIST / 'index.html').write_text(built, encoding='utf-8')
# local preview copy: the artifact host adds this head itself
(DIST / 'dev.html').write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" '
                               'content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'
                               + built + '</body></html>', encoding='utf-8')
plugin = DIST / 'h5plugins' / 'libH5Zblosc.wasm'
plugin.parent.mkdir(exist_ok=True)
if len(sys.argv) > 1:
    shutil.copyfile(sys.argv[1], plugin)
if not plugin.exists():
    sys.exit('missing dist/h5plugins/libH5Zblosc.wasm: pass the path to libH5Zblosc.so')

# --- GitHub Pages
site = (PAGES / 'head.html').read_text(encoding='utf-8') + built + '\n</body>\n</html>\n'
icons = PAGES / 'icons'
if not icons.exists():
    sys.exit('missing pages/icons: run python pages/make_icons.py')
DOCS.mkdir(exist_ok=True)
(DOCS / 'index.html').write_text(site, encoding='utf-8')
version = hashlib.sha1(site.encode('utf-8') + plugin.read_bytes()).hexdigest()[:10]
(DOCS / 'sw.js').write_text((PAGES / 'sw.js').read_text(encoding='utf-8').replace('__VERSION__', version), encoding='utf-8')
shutil.copyfile(PAGES / 'manifest.webmanifest', DOCS / 'manifest.webmanifest')
shutil.copytree(icons, DOCS / 'icons', dirs_exist_ok=True)
(DOCS / 'h5plugins').mkdir(exist_ok=True)
shutil.copyfile(plugin, DOCS / 'h5plugins' / 'libH5Zblosc.wasm')
(DOCS / '.nojekyll').write_text('', encoding='utf-8')

print('built', DIST / 'index.html', 'and', DOCS, 'version', version)
