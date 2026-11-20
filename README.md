# LurkAPI clients

The official clients for [LurkAPI](https://lurkapi.com): public social media data as clean JSON from TikTok, Instagram, YouTube, Reddit, X (Twitter), LinkedIn, Facebook, Google and more.

| | Install | |
|---|---|---|
| JavaScript and TypeScript, with a CLI and an MCP launcher | `npm install lurkapi` | [js/](js/README.md) |
| Python | `pip install lurkapi` | [python/](python/README.md) |

```ts
import { LurkAPI } from "lurkapi";
const profile = await new LurkAPI().tiktok.profile({ handle: "nike" });
```

```python
from lurkapi import LurkAPI
profile = LurkAPI().tiktok.profile(handle="nike")
```

Both read `LURKAPI_API_KEY` (free at https://lurkapi.com/login), have no dependencies, and hold no list of endpoints: they read the API's own index, so an endpoint added tomorrow works in the version you installed today. [PLAN.md](PLAN.md) has the design.

## Working on them

```bash
cd js && npm ci && npm run tsc && npm test     # against a stand-in API
cd python && python3 -m unittest discover -s tests
npm run smoke && python3 tests/smoke.py        # the live API, free calls only
```

Types and editor hints are made from the live `openapi.json` when a version is released (`npm run types`, `python3 scripts/generate.py`) and aren't in git. [PUBLISHING.md](PUBLISHING.md) has the release steps.

MIT
