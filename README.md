# MRGMinner

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-blue.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.3.0-0E8A16.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MRG](https://img.shields.io/badge/token-MRG-5319E7.svg)](https://scan.mergeos.shop)
[![MergeOS](https://img.shields.io/badge/MergeOS-bounties-5319E7.svg)](https://github.com/mergeos-bounties)

**MRGMinner** is the **MergeOS miner / task runner**: discover funded MRG work on the public marketplace and ledger, form **claim-block** clusters (job + review + audit nodes with hash-chain proof), split jobs across the fleet, claim and run tasks with your AI CLI, then submit evidence — without releasing payout (accept stays with owner/admin).

**Product:** [mergeos-bounties/MRGMinner](https://github.com/mergeos-bounties/MRGMinner) · App: [mergeos.shop](https://mergeos.shop/) · Scan: [scan.mergeos.shop](https://scan.mergeos.shop/) · Funded: **`prj_0428`**

---

## Highlights

| Capability | Description |
| --- | --- |
| **Chain discovery** | `token` · `proof` · `market` · `chain` — public APIs, no login required |
| **Work split** | `split` — assign open bounties to job/review/audit roles bound to ledger tip hash |
| **Claim-block MRG** | `block` + `intent` — mrg_eligible cluster when roles online + verified `entry_hash` |
| **Task runner** | `tasks` · `claim` · `run` · `submit` · `next` |
| **Online nodes** | `nodes` · `stats` — agent fleet from protocol + live feed |
| **VS Code extension** | Same package (command palette) |
| **Safety** | Never calls task **accept** / payout release |

---

## Quick start

```powershell
cd MRGMinner
npm ci
npm test
node .\bin\mrgminner.js --help

# Public chain discovery (no login)
node .\bin\mrgminner.js chain
node .\bin\mrgminner.js market
node .\bin\mrgminner.js proof
node .\bin\mrgminner.js split

# Offline demos
node .\bin\mrgminner.js chain --mock
node .\bin\mrgminner.js block --mock
```

Configure + authenticate for claim/run/submit:

```powershell
node .\bin\mrgminner.js configure --mergeos-url https://mergeos.shop --provider claude --worker-id github:yourname
node .\bin\mrgminner.js login --email you@example.com --password your-password
node .\bin\mrgminner.js tasks --open
```

Settings: `%USERPROFILE%\.mergeide\settings.json` (`MERGEIDE_SETTINGS` / `MRGMINNER_SETTINGS`).

---

## MRG blockchain discovery

Public MergeOS endpoints (readable without a worker token):

| Command | Source API | What you get |
| --- | --- | --- |
| `mrgminner token` | `/api/public/token-economy` | Supply, reserves, fees, recent credits |
| `mrgminner proof` | `/api/public/ledger/proof` | Hash-chain root, tip, verified/broken counts |
| `mrgminner market` | `/api/public/marketplace` | Funded projects + open bounties (MRG rewards) |
| `mrgminner chain` | all of the above + agents/feed | Full discovery bundle for explorers/agents |
| `mrgminner split` | market + claim-block + tip hash | Work packs ready to claim |
| `mrgminner intent [task]` | task + block + tip | Claim intent with `intent_hash` binding |

```powershell
mrgminner token --json
mrgminner proof
mrgminner market
mrgminner split
mrgminner intent prj_0428:1 --json
```

Explore on Scan:

- https://scan.mergeos.shop  
- Ledger proof: https://mergeos.shop/api/public/ledger/proof  

---

## Claim-block & work split

```text
online job node  +  online review node  +  online audit node
                    + verified ledger entry_hash
                              ↓
                    claim-block (mrg_eligible)
                              ↓
              split → pack per bounty (pack_hash ↔ tip_hash)
                              ↓
              intent → claim/run/submit (payout still via admin accept)
```

| Role | Agents | Duty |
| --- | --- | --- |
| **job** | coding / frontend / backend | Implement + claim lane |
| **review** | review / design-review / QA | Score PR / evidence |
| **audit** | repo-scan / security | Confirm ledger hash proof |

```powershell
mrgminner nodes --online
mrgminner block
mrgminner split --json
```

---

## Claim / run / submit

```powershell
mrgminner claim <task-id>
mrgminner run <task-id>
mrgminner submit <task-id> --pr-url https://github.com/org/repo/pull/1
```

---

## CLI reference

| Command | Purpose |
| --- | --- |
| `configure` / `login` | Settings + token |
| `tasks` / `prompt` / `run` / `claim` / `submit` / `next` | Task lifecycle |
| `nodes` / `stats` / `block` | Agent fleet + claim-block |
| `token` / `proof` / `market` / `split` / `chain` / `intent` | MRG chain discovery |
| `serve` | n/a — CLI + extension (use MergeOS host APIs) |

---

## Development

```powershell
npm ci
npm test
npm run build:exe   # Windows exe via pkg
```

Windows workflow: [`.github/workflows/mrgminner-windows-exe.yml`](.github/workflows/mrgminner-windows-exe.yml)

---

## MergeOS bounties

Star → claim issue → PR to **master** → MRG **25–200**.  
See [docs/BOUNTY.md](docs/BOUNTY.md) · [mergeos](https://github.com/mergeos-bounties/mergeos).

---

## License

MIT · MergeOS / ThanhTrucSolutions
