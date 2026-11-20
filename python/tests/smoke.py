"""The live API, free calls only: the index, a keyless 401, the stub from the live openapi.json, and with
LURKAPI_API_KEY the free balance call. Run: python3 tests/smoke.py"""

import json
import os
import sys
import urllib.request
from pathlib import Path

here = Path(__file__).resolve().parent
sys.path[:0] = [str(here.parent / "src"), str(here.parent / "scripts")]

from generate import generate  # noqa: E402
from lurkapi import API_URL, LurkAPI, LurkAPIError  # noqa: E402

key = os.environ.pop("LURKAPI_API_KEY", None)
with LurkAPI() as keyless:
    endpoints = keyless.endpoints()
    assert len(endpoints) > 50 and all(e["path"].startswith("/v") for e in endpoints), "the index lists endpoints with a name and a path"
    print(f"PASS the index: {len(endpoints)} endpoints")

    try:
        keyless.account.credit_balance()
        raise AssertionError("a keyless call was answered")
    except LurkAPIError as e:
        assert (e.status, e.code) == (401, "missing_api_key") and e.docs, e
    print("PASS a name resolves through the live index, and a keyless call fails as LurkAPIError 401 missing_api_key")

request = urllib.request.Request(API_URL + "/openapi.json", headers={"user-agent": "lurkapi-python-smoke"})
stub = generate(json.loads(urllib.request.urlopen(request, timeout=60).read()), API_URL)
compile(stub, "_operations.pyi", "exec")
print(f"PASS the stub generates from the live openapi.json ({len(stub) // 1024} KB)")

if not key:
    print("SKIP the balance call: set LURKAPI_API_KEY")
else:
    with LurkAPI(key) as lurk:
        balance = lurk.account.credit_balance()
    assert balance["success"] is True and balance["credits_charged"] == 0, balance
    print("PASS account_credit_balance with the key: free")
