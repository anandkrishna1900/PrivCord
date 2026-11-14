#!/usr/bin/env python3
"""Seeds for the fuzzers from the repository's test vectors: every JSON object and string they contain, so the fuzzers
start from real frames, cards and sealed blobs instead of random bytes. Usage: seed_corpus.py <docs dir> <corpus dir>."""
import hashlib, json, pathlib, sys

docs, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
objects, strings = [], []

def walk(v):
    if isinstance(v, dict):
        objects.append(v)
        for x in v.values():
            walk(x)
    elif isinstance(v, list):
        for x in v:
            walk(x)
    elif isinstance(v, str) and len(v) > 8:
        strings.append(v)
        if v.startswith("{"):
            try:
                walk(json.loads(v))
            except ValueError:
                pass

for f in sorted(docs.glob("*vectors.json")):
    walk(json.loads(f.read_text()))

def put(target, data):
    d = out / target
    d.mkdir(parents=True, exist_ok=True)
    (d / hashlib.sha1(data).hexdigest()).write_bytes(data)

for o in objects:
    j = json.dumps(o, separators=(",", ":")).encode()
    if len(j) < 64_000:
        put("parsers", j)
        for op in (0, 1, 2):
            put("engine_untrusted", bytes([op]) + j)
for s in strings:
    b = s.encode("utf-8", "surrogatepass")
    if len(b) < 64_000:
        put("text_decoders", b)
        put("engine_untrusted", bytes([0]) + b)
# The sync log: one entry per line, "kind body".
sync_seeds = [
    'message {"id":"m1","conv":"c","text":"hi"}\nreact {"target":"m1","by":"u","emoji":"x"}\nedit {"target":"m1","text":"hey"}',
    'read {"conv":"c","upto":{"wall":5,"count":0}}\nsetting {"key":"mute:u","value":true}\ndelete {"target":"m1"}\nhide {"target":"m2"}',
    'poll {"q":"?"}\nmessage {"id":"","conv":"c"}\nreact {"target":"m","by":"u","emoji":7}',
]
for seed in sync_seeds:
    put("sync_log", seed.encode())

print({p.name: len(list(p.iterdir())) for p in out.iterdir()})
