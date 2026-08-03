import re, pathlib, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
src = pathlib.Path("kept-prototype.html").read_text()
src = re.sub(r'^<title>.*?</title>\s*', '', src, count=1, flags=re.S)

head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Kept</title>
<meta name="description" content="Turn the money you choose not to spend into your future.">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#F3F1EA" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E1114" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Kept">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<style>html,body{background:#F3F1EA}@media(prefers-color-scheme:dark){html,body{background:#0E1114}}</style>
</head>
<body>
'''
tail = '''
<script>
if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('sw.js').catch(function(){});});}
</script>
</body>
</html>
'''
pathlib.Path("pwa/index.html").write_text(head + src + tail)

manifest = '''{
  "name": "Kept",
  "short_name": "Kept",
  "description": "Turn the money you choose not to spend into your future.",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#F3F1EA",
  "theme_color": "#F3F1EA",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}'''
pathlib.Path("pwa/manifest.webmanifest").write_text(manifest)

# Network-first service worker: always fresh when online, cache only as offline fallback.
# Bump CACHE_VER on any change that must invalidate old caches.
CACHE_VER = "kept-v3"
sw = '''const C="%s";
const A=["./","index.html","manifest.webmanifest","icon-180.png","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(A)).catch(()=>{}));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()));});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  e.respondWith(
    fetch(e.request).then(res=>{
      const cp=res.clone(); caches.open(C).then(c=>c.put(e.request,cp)).catch(()=>{});
      return res;
    }).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html")))
  );
});
''' % CACHE_VER
pathlib.Path("pwa/sw.js").write_text(sw)
print("built:", sorted(p.name for p in pathlib.Path("pwa").iterdir() if p.is_file()))
