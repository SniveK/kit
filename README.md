# @kleos/kit

Code that more than one Kleos app needs, kept in one place so it is written, tested and fixed once. It ships as
TypeScript source: Bun, Vite and esbuild compile it inside the consuming app, so there is no build step and no registry.

## What is in it

| Import | What it is |
|---|---|
| [`@kleos/kit/doku`](src/doku) | Dependency-free DOKU payment gateway client: Checkout, check status, notification verification |

A file belongs here when two apps would otherwise carry the same code, or code that differs only by a value that can
be a parameter (credentials, a URL, a storage key). Business rules, pricing and anything holding credentials stay in
the app. This repository is public; never commit secrets or customer data.

## Using it in an app

```sh
bun add https://github.com/SniveK/kit/archive/refs/tags/v0.1.0.tar.gz
```

The tarball URL is pinned to a tag and `bun.lock` records its integrity hash, so installs need no token, no git binary
and no registry, including in Docker, Railway, Coolify and Vercel builds. To move to a newer version, install the newer
tag's URL.

```ts
import { createDokuClient } from '@kleos/kit/doku'
```

When moving an app onto the kit, turn its old file into a one-line re-export instead of rewriting every import:

```ts
// apps/api/src/lib/doku.ts
export * from '@kleos/kit/doku'
```

## Changing it

```sh
bun install
bun test src
bun run typecheck
```

Change the kit, bump `version` in `package.json`, tag a release (`git tag v0.2.0 && git push origin v0.2.0`), then bump
the tarball URL in each app that needs the change. Apps pin their own version, so a kit change never lands in an app
until that app updates and its own tests pass.

To try an unreleased change in an app without tagging, point the dependency at the local checkout (`bun add ../kit`)
and switch back to a tag URL before committing.

New areas go in `src/<area>/` with an `index.ts`, plus an entry in `exports` in `package.json`. Runtime dependencies
an area needs go in `peerDependencies`, marked optional in `peerDependenciesMeta`, so apps that don't import that area
never install them.
