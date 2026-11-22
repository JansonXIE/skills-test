#!/usr/bin/env python3
"""Check project .config files against a cvi_rtt solution's Kconfig tree.

Usage: python3 -I kconfig_check.py <solution_dir> <config>... [--show SYM ...]

For each .config prints:
  - symbols the Kconfig tree does not define (PKG_* ignored: packages/ is absent locally)
  - symbols whose value would change if menuconfig re-saved the file
    (typical cause: a non-visible `int`/`bool` whose Kconfig default wins over .config)
  - the resolved value of any --show symbol
Exit status 1 when any config has unknown or drifting symbols.
"""

import os
import re
import site
import sys

# kconfiglib lives in the user site-packages; -I hides it, so add it explicitly.
sys.path.append(site.getusersitepackages())
import kconfiglib  # noqa: E402

LINE = re.compile(r'^(?:# )?CONFIG_([A-Za-z0-9_]+)(?:=(.*)| is not set)$')


def read_values(path):
    vals = {}
    for raw in open(path, encoding="utf-8", errors="replace"):
        m = LINE.match(raw.rstrip("\n"))
        if m:
            v = m.group(2)
            vals[m.group(1)] = "n" if v is None else v.strip('"')
    return vals


def main():
    args = sys.argv[1:]
    show = []
    if "--show" in args:
        i = args.index("--show")
        show, args = args[i + 1:], args[:i]
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    sol = os.path.abspath(args[0])
    configs = [os.path.abspath(c) for c in args[1:]]
    os.chdir(sol)
    os.environ.setdefault("BSP_DIR", ".")
    os.environ.setdefault("RTT_DIR", "../../..")
    bad = False
    for cfg in configs:
        kconf = kconfiglib.Kconfig("Kconfig", warn=False)
        old = read_values(cfg)
        unknown = sorted(s for s in old if s not in kconf.syms and not s.startswith("PKG_"))
        kconf.load_config(cfg, replace=True)
        drift = []
        for name, v in old.items():
            sym = kconf.syms.get(name)
            if sym is None or name.startswith("PKG_") or sym.type == kconfiglib.UNKNOWN:
                continue
            new = sym.str_value
            if new == "" and sym.type not in (kconfiglib.BOOL, kconfiglib.TRISTATE):
                # dependencies unmet: menuconfig drops the line, not a value change
                continue
            if sym.type in (kconfiglib.BOOL, kconfiglib.TRISTATE):
                new = new or "n"
            if new != v and not (v == "n" and new in ("", "n")):
                drift.append(f"{name}: {v} -> {new}")
        print(f"== {os.path.relpath(cfg, sol)}")
        print(f"   unknown: {unknown or 'none'}")
        print(f"   drift  : {drift or 'none'}")
        for name in show:
            sym = kconf.syms.get(name)
            print(f"   {name} = {sym.str_value if sym else 'UNDEFINED'}")
        bad |= bool(unknown or drift)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
