# Publishing the clients

`lurkapi` on npm and `lurkapi` on PyPI. Both names were free on 2026-11-20 and are claimed by the first publish. Nothing here stores a token: after the first npm publish, releases go out from GitHub Actions through trusted publishing (OIDC), with provenance.

`sdk/` is the whole content of a public repo, the way `plugin/` is. The workflow at `.github/workflows/release.yml` does nothing in the lurkapi repo; it runs in that one.

## Once

1. **GitHub.** Create the public repo `mesmerlord/lurkapi-sdk`, empty. That name is in `js/package.json` (`repository`, `bugs`) and `python/pyproject.toml` (`Repository`); pick another and change those three lines. npm only attaches provenance from a public repo.

2. **Copy and push.** From the lurkapi repo, with the public repo checked out beside it:
   ```bash
   rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude '*.pyi' --exclude __pycache__ sdk/ ../lurkapi-sdk/
   cd ../lurkapi-sdk && git add -A && git commit -m "lurkapi 0.1.0" && git push
   ```

3. **npm, the first version by hand.** npm sets a trusted publisher on a package's settings page, so the package has to exist first. Sign in with the account that should own it (this machine isn't signed in to npm: `npm whoami` fails), with 2FA on:
   ```bash
   cd ../lurkapi-sdk/js && npm ci
   npm login
   npm publish --access public   # prepack builds dist/ and generates the types from the live openapi.json
   ```
   Then on npmjs.com: **lurkapi → Settings → Trusted Publisher → GitHub Actions**, with organization or user `mesmerlord`, repository `lurkapi-sdk`, workflow filename `release.yml`. Under **Publishing access**, choose "Require two-factor authentication and disallow tokens", so only you by hand and that workflow can publish.

4. **PyPI, nothing by hand.** Sign in at pypi.org with the account that should own it, then **Your account → Publishing → Add a new pending publisher**: PyPI project name `lurkapi`, owner `mesmerlord`, repository `lurkapi-sdk`, workflow `release.yml`, environment `pypi`. The first tag creates the project.

5. **The tag.** In the public repo: `git tag v0.1.0 && git push --tags`. The workflow tests, then publishes to PyPI. Its npm step sees 0.1.0 is already there and skips.

Check both: `npx lurkapi@latest list tiktok` and `pip install lurkapi && python -c "from lurkapi import LurkAPI; print(len(LurkAPI().endpoints()))"`. The npm page should show "Built and signed on GitHub Actions" from the second release on, the PyPI page a "Trusted publisher" file badge from the first.

## Each release

A new or changed endpoint needs no release: the clients read the API's index. Release for a change to the clients themselves, or to refresh the editor hints.

1. In the lurkapi repo, set the version in its three places: `sdk/js/package.json`, `VERSION` in `sdk/js/src/index.ts`, and `sdk/python/src/lurkapi/_version.py`. A test fails if they differ.
2. `npm run tsc && npm run test:sdk && npm run test:site && npm run smoke:sdk`. Commit.
3. Copy `sdk/` over the public repo (the `rsync` above), commit, then `git tag v<version> && git push && git push --tags`.
4. Watch the run under the public repo's Actions tab. It refuses a tag that doesn't match the version, and skips a version a registry already has.

## By hand, if Actions is down

```bash
cd js && npm ci && npm publish --access public
cd ../python && python3 scripts/generate.py && python3 -m pip install build twine && python3 -m build && python3 -m twine upload dist/*
```

`twine` asks for a PyPI API token: make one scoped to the `lurkapi` project, use it once, and delete it.

## What a mistake costs

- npm lets a version be unpublished for 72 hours and never reused. PyPI lets a release be yanked and never reused. A bad release means a new patch version.
- If the live `openapi.json` can't be read or has something the generators don't understand, the release stops before publishing. `shared/__tests__/sdk.test.ts` in the lurkapi repo is there to catch that at the registry change, long before.
