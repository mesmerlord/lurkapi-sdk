"""openapi.json -> src/lurkapi/_operations.pyi: each endpoint as a method with keyword parameters, for editors only.
Run at release: python scripts/generate.py [--from <file or url>] [--out <file>]. Calls never need its output.
It stops on anything it doesn't understand, so a new kind of parameter fails a test, not a release."""

from __future__ import annotations

import json
import keyword
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

TYPES = {"string": "str", "integer": "int", "number": "float", "boolean": "bool"}


def hint(schema: Dict[str, Any]) -> str:
    """A query parameter's type. A true/false enum takes a bool: the client sends it as text."""
    values = schema.get("enum")
    if values is not None:
        return "bool" if sorted(map(str, values)) == ["false", "true"] else f"Literal[{', '.join(json.dumps(v) for v in values)}]"
    if schema.get("type") not in TYPES:
        raise ValueError(f"generate: unknown parameter type in {json.dumps(schema)[:200]}")
    return TYPES[schema["type"]]


def text(value: Any) -> str:
    return " ".join(str(value or "").split()).replace("\\", "\\\\").replace('"""', "'''")


def generate(spec: Dict[str, Any], source: str) -> str:
    """The whole stub. Raises when the spec breaks what the clients assume (see PLAN.md)."""
    platforms: Dict[str, List[str]] = {}
    seen = set()
    for path, item in spec["paths"].items():
        if list(item) != ["get"]:
            raise ValueError(f"generate: {path} isn't GET only ({', '.join(item)})")
        if "{" in path:
            raise ValueError(f"generate: {path} has a path parameter")
        op = item["get"]
        name = str(op.get("operationId"))
        if not re.fullmatch(r"[a-z0-9]+(_[a-z0-9]+)+", name) or name in seen:
            raise ValueError(f"generate: {path} has a missing, misshapen or repeated operationId ({name})")
        seen.add(name)
        platform, method = name.split("_", 1)

        args, lines, loose = [], [], False
        for p in sorted(op.get("parameters", []), key=lambda p: not p.get("required")):
            if p.get("in") != "query":
                raise ValueError(f"generate: {name}.{p.get('name')} isn't a query parameter")
            if not p["name"].isidentifier() or keyword.iskeyword(p["name"]):
                loose = True  # can't be a keyword: it goes in the dict, get(name, {"from": ...})
            else:
                kind = hint(p.get("schema", {}))
                args.append(f"{p['name']}: {kind}" if p.get("required") else f"{p['name']}: {kind} | None = None")
            lines.append(f"        {p['name']}: {text(p.get('description'))}")
        if loose:
            args.append("**more: Any")
        description = str(op.get("description", ""))
        cost = re.search(r"Cost: [^\n]+", description)
        about = [text(op.get("summary")) + ".", text(description.split("\n\n")[0]), cost.group(0) if cost else "", (op.get("externalDocs") or {}).get("url", "")]
        doc = " ".join(filter(None, about)) + ("\n\n" + "\n".join(lines) + "\n        " if lines else "")
        signature = ", ".join(["self", *(["*"] if args and args != ["**more: Any"] else []), *args])
        body = f'    def {method}({signature}) -> dict[str, Any]:\n        """{doc}"""\n'
        platforms.setdefault(platform, []).append(body)

    out = [f"# Generated from {source}: {len(seen)} operations. Don't edit; run scripts/generate.py.\n", "from typing import Any, Literal\n"]
    for platform, methods in platforms.items():
        out.append(f"class _{platform.capitalize()}:\n" + "\n".join(methods))
    out.append("class Operations:\n" + "".join(f"    {platform}: _{platform.capitalize()}\n" for platform in platforms))
    return "\n".join(out)


if __name__ == "__main__":
    arg = lambda name: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None  # noqa: E731
    source = arg("--from") or "https://api.lurkapi.com/openapi.json"
    out = Path(arg("--out") or Path(__file__).resolve().parent.parent / "src/lurkapi/_operations.pyi")
    if re.match(r"https?:", source):
        request = urllib.request.Request(source, headers={"user-agent": "lurkapi-python-generate"})
        raw = urllib.request.urlopen(request, timeout=60).read().decode()
    else:
        raw = Path(source).read_text()
    code = generate(json.loads(raw), source)
    compile(code, str(out), "exec")
    out.write_text(code)
    print(f"{out}: {len(code) // 1024} KB")
