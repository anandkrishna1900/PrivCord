#!/usr/bin/env python3
"""Fails if R8 removed or renamed Java code that native libraries in the release APK reach by name.

Native code finds Java in two ways R8 cannot see: `Java_<class>_<method>` exports bound to `native` methods, and class
names it looks up (FindClass). A miss is not a build error; the app aborts or throws at run time instead (WebRTC 150's
org.jni_zero.JniZero crashed every launch this way). Usage: check_native_links.py <app-release.apk> <dexdump>.
"""
import re
import subprocess
import sys
import tempfile
import zipfile


def dex_contents(apk, dexdump):
    classes, natives = set(), set()
    with tempfile.TemporaryDirectory() as d, zipfile.ZipFile(apk) as z:
        for name in z.namelist():
            if not re.fullmatch(r"classes\d*\.dex", name):
                continue
            path = z.extract(name, d)
            cls = meth = None
            out = subprocess.run([dexdump, path], capture_output=True).stdout.decode("latin-1")
            for line in out.splitlines():
                m = re.search(r"Class descriptor\s*:\s*'L(.*);'", line)
                if m:
                    cls = m.group(1)
                    classes.add(cls)
                    continue
                m = re.search(r"name\s*:\s*'(.*)'", line)
                if m:
                    meth = m.group(1)
                elif "access" in line and "NATIVE" in line and cls and meth:
                    natives.add((cls, meth))
    return classes, natives


def demangle(sym):
    """JNI short name (`Java_` stripped, overload suffix removed) -> (class, method)."""
    parts, cur, i = [], "", 0
    while i < len(sym):
        c = sym[i]
        if c == "_":
            nxt = sym[i + 1 : i + 2]
            if nxt == "_" and not sym[i + 2 : i + 3].isdigit():  # overload signature follows
                break
            if nxt in "123":
                cur += {"1": "_", "2": ";", "3": "["}[nxt]
                i += 2
                continue
            if nxt == "0":
                cur += chr(int(sym[i + 2 : i + 6], 16))
                i += 6
                continue
            parts.append(cur)
            cur = ""
            i += 1
            continue
        cur += c
        i += 1
    parts.append(cur)
    return "/".join(parts[:-1]), parts[-1]


def main(apk, dexdump):
    classes, natives = dex_contents(apk, dexdump)
    problems = []
    with tempfile.TemporaryDirectory() as d, zipfile.ZipFile(apk) as z:
        libs = [n for n in z.namelist() if n.startswith("lib/") and n.endswith(".so")]
        for lib in libs:
            path = z.extract(lib, d)
            syms = subprocess.run(["readelf", "-W", "--dyn-syms", path], capture_output=True, text=True).stdout
            for line in syms.splitlines():
                f = line.split()
                if len(f) < 8 or f[6] == "UND" or not f[7].startswith("Java_"):
                    continue
                cls, meth = demangle(f[7].split("@")[0][len("Java_") :])
                # jni_zero's multiplexed natives (class J.N) are an alternate the library's Java side does not use.
                if cls == "J/N" or (cls, meth) in natives:
                    continue
                problems.append(f"{lib}: {f[7]} has no native method {cls.replace('/', '.')}.{meth}")
            text = open(path, "rb").read().decode("latin-1")
            for name in set(re.findall(r"(?:org|com|androidx)[./](?:[a-z0-9_]+[./])+[A-Z][A-Za-z0-9_$]*", text)):
                cls = name.replace(".", "/")
                # Dotted names of nested classes (a.b.Outer.Inner) are a.b.Outer$Inner in the dex.
                candidates = {cls, re.sub(r"/([A-Z][A-Za-z0-9_]*)/([A-Z])", r"/\1$\2", cls)}
                if not candidates & classes:
                    problems.append(f"{lib}: looks up {name}, which is not in the APK")
    for p in sorted(set(problems)):
        print(p)
    print(f"checked {len(natives)} native methods and {len(classes)} classes: {len(set(problems))} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
