<div align="center">

<img src="./docs/images/codengram-logo.svg" alt="Codengram — map any codebase, export the whole map" width="720">

**Map any source code into a structured, cited map — then export the whole thing.**

Codengram reads a repository and turns it into a **map of the system**: every feature, endpoint, route, background job, authorization check, role, service, and data flow — each grounded to a `file:line` in a frozen snapshot of the source. Explore it in a local UI, or **export the entire mapping** and use it wherever you need to understand the code by feature: security review, static code review, onboarding, architecture docs, or as ready-made context for an AI.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Zero deps](https://img.shields.io/badge/runtime-zero%20native%20deps-c67139.svg)](#)
[![Recon only](https://img.shields.io/badge/scope-recon%20only-7a8a5e.svg)](#recon-only)

</div>

> **Recon only.** Codengram maps *structure and understanding* — who exposes what, which auth checks exist, where data flows, which features share code. It **never** claims a vulnerability, exploit, or severity. What you do with the map is up to you.

---

## Setup

Needs **Node ≥ 22** (uses Node's built-in SQLite — no native build). That's it.

```bash
git clone https://github.com/ghostshift-content/codengram.git && cd codengram
npm install

npm run doctor        # check your environment (Node, SQLite, data dir, port, Claude)
npm run serve         # open the UI  →  http://127.0.0.1:4173
```

`doctor` prints a clear ✓ / ⚠ / ✗ report and tells you how to fix anything that's off. **`serve` and `scan` run this preflight automatically** and refuse to start if something's broken — so problems show up front, never mid-run.

In the UI: paste a **local repository path** → **Recon** → watch it map, then explore **Features → Interfaces → Authorization → Data Flows → Coverage**, and **Ask** questions with cited answers.

Prefer the terminal:

```bash
npm run scan -- /path/to/your/repo     # map a repo → writes a portable bundle
node apps/cli/bin/codengram.js ls      # list mapped projects
```

**Claude** gives you AI-quality feature mapping. Install [Claude Code](https://claude.ai/code) and run `claude` once to log in — Codengram uses your existing subscription and **never handles credentials**.

- **In the UI**, Recon **requires Claude connected** (the button stays disabled, with a fix hint, until it is) so every map is AI-quality.
- **The core engine still runs fully offline** — the CLI (`npm run scan`) maps deterministically with no AI, and `Ask` answers either way (Claude-backed when connected, structure-derived otherwise).

Check your login any time with:

```bash
npm run doctor -- --probe              # also verifies your Claude subscription session
```

---

## What it maps

Every scan produces a graph of the codebase, reconciling **every** inventory item to a terminal state (nothing is silently dropped):

| Layer | What Codengram extracts |
|---|---|
| **Features** | Capabilities clustered from routes, controllers, services — each a 13-section document |
| **Interfaces** | REST routes, GraphQL operations, background jobs — method, path, handler, source |
| **Authorization** | Policies, `before_action`/guards, roles, permissions found in code |
| **Data flows** | Feature → service / integration / data store, with trust-boundary crossings |
| **Coverage** | Per-item reconciliation + a completion gate — honest about what's mapped vs. a gap |

Every claim carries provenance: **snapshot + file + line + confidence + how it was found.**

---

## Export the map

Each scan writes a self-contained bundle you can hand to anything:

```
phase1-maps/
  AI_CONTEXT.md          # a fresh AI session understands the whole codebase, zero prior context
  features/<slug>.md     # per-feature map (identity, entry points, authz, data, files) — all cited
  graph/nodes.jsonl      # the machine-readable graph
  graph/edges.jsonl      # canonical from → to
  consolidated/          # feature index, coverage matrix, completion gate
```

The whole point is to **break a codebase into features** so you — and an AI — can work on **one capability at a time** instead of fighting a giant, unfamiliar repo. Every feature exports as its own cited document, which changes how you work:

- **Security review, feature by feature** *(the main workflow)* — export a single feature's map: its endpoints, authorization checks, data flows, and the exact `file:line`s. Hand **just that one feature** to an AI (or review it yourself) and look for security issues. Because the context is small, scoped, and every claim is grounded to source, the review stays focused and the model doesn't hallucinate across code it's never seen. Walk the features one by one and you've covered the entire app **deliberately** — instead of dumping 100k lines into a prompt and hoping.
- **Work with AI, locally** — drop `AI_CONTEXT.md` + a feature doc into any local model and it understands that slice of the code with **zero prior context** and full citations. No re-reading the repo, no guessing where things live.
- **Many projects in one place** — the exported maps are just files, so you keep them as a **persistent local library** and jump between codebases without relearning each — a second-brain of every project you've mapped, always ready to work with.
- **Static code review & onboarding** — review one capability end-to-end, or hand a new engineer the map instead of "go read the code."

Every claim in every export is cited to `file:line`, so whatever you (or the AI) conclude is always traceable back to the source.

---

## A look inside

| Features — capabilities mapped from source, cited to `file:line` | The map — features, domains, and how they connect |
|:---:|:---:|
| ![Features](./docs/images/codengram-features.png) | ![The map](./docs/images/codengram-brain.png) |
| **Interfaces — REST routes, GraphQL, background jobs** | **Coverage — per-item reconciliation + completion gate** |
| ![Interfaces](./docs/images/codengram-interfaces.png) | ![Coverage](./docs/images/codengram-coverage.png) |

---

## How it works

1. **Freeze** — snapshot the source (content-addressed, immutable) so every citation resolves against exactly what was scanned.
2. **Inventory** — deterministic, per-language extraction of routes, APIs, jobs, services, policies, data stores.
3. **Map** — cluster inventory into features and build a knowledge graph with provenance on every node/edge.
4. **Reconcile & seal** — every item reaches a terminal status; artifacts are validated, then the snapshot is **atomically published**.
5. **Serve & export** — explore in the UI, ask cited questions, or export the portable bundle.

Local-first, runs on your machine, source is read-only — deletion only ever touches Codengram's own `data/`.

<a name="recon-only"></a>
## Recon only

Codengram is a **mapping** tool, not a scanner. It reports what the code *is and does*, never a verdict about whether it's safe. The optional AI path is guarded on both sides to keep it that way — questions and generated text that read like vulnerability findings are refused, so the map stays a map.

## License

MIT.
