# MRGMinner

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-blue.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-0.4.0-0E8A16.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MRG](https://img.shields.io/badge/token-MRG-5319E7.svg)](https://scan.mergeos.shop)
[![Solana](https://img.shields.io/badge/chain-Solana-9945FF.svg)](https://github.com/mergeos-bounties/mergeos-contracts)
[![MergeOS](https://img.shields.io/badge/MergeOS-bounties-5319E7.svg)](https://github.com/mergeos-bounties)

**MRGMinner** is the MergeOS **miner / task runner**: discover funded **MRG** work on the public marketplace and ledger, form **claim-block** clusters (job + review + audit + hash proof), **split** jobs into packs bound to the ledger tip, build **claim intents** (and optional Solana `ledgerReference`), claim/run/submit with your AI CLI — without releasing payout (accept stays with owner/admin).

**Product:** [mergeos-bounties/MRGMinner](https://github.com/mergeos-bounties/MRGMinner) · App: [mergeos.shop](https://mergeos.shop/) · Scan: [scan.mergeos.shop](https://scan.mergeos.shop/) · Contracts: [mergeos-contracts](https://github.com/mergeos-bounties/mergeos-contracts) · Funded: **`prj_0428`** · [Install guide](docs/INSTALL.md)

---

## Highlights

| Capability | Description |
| --- | --- |
| **Chain discovery** | `token` · `proof` · `verify` · `market` · `chain` · `solana` — public APIs |
| **Correct MRG rewards** | Bounty amounts parsed from titles (`[25 MRG]`) when marketplace scores pollute `reward_cents` |
| **Work split** | `split` — load-balanced packs across online job/review/audit nodes + ledger tip |
| **Claim intents** | `intent` + `claim --with-intent` — `intent_hash` / `pack_hash` / `ledger_reference` |
| **Solana anchors** | `solana` — program id, instruction map (`releasePayout`), bytes32 ledger reference |
| **Local verify** | `verify` — walk `previous_hash` links client-side |
| **Task runner** | `tasks` · `claim` · `run` · `submit` · `next` · `status` |
| **Safety** | Never calls task **accept** / payout release |

---

## Quick start

### Portable download (Windows)

Download `MRGMinner-Windows-x64.zip` from the [latest release](https://github.com/mergeos-bounties/MRGMinner/releases/tag/mrgminner-windows-latest), extract, and run:

```powershell
Expand-Archive -Path MRGMinner-Windows-x64.zip -DestinationPath C:\tools\mrgminner
C:\tools\mrgminner\MRGMinner-Windows-x64.exe --help
```

See [docs/INSTALL.md](docs/INSTALL.md) for detailed install steps.

### From source

```powershell
cd MRGMinner
npm ci
npm test
node .\bin\mrgminner.js --help

# Public chain discovery (no login)
node .\bin\mrgminner.js status
node .\bin\mrgminner.js chain
node .\bin\mrgminner.js market
node .\bin\mrgminner.js split
node .\bin\mrgminner.js verify
node .\bin\mrgminner.js solana

# Offline demos
node .\bin\mrgminner.js chain --mock
node .\bin\mrgminner.js block --mock
```

Configure + authenticate for claim/run/submit:

```powershell
node .\bin\mrgminner.js configure --mergeos-url https://mergeos.shop --provider claude --worker-id github:yourname
node .\bin\mrgminner.js login --email you@example.com --password your-password
node .\bin\mrgminner.js tasks --open
node .\bin\mrgminner.js claim <task-id> --with-intent
```

Settings: `%USERPROFILE%\.mergeide\settings.json` (`MERGEIDE_SETTINGS` / `MRGMINNER_SETTINGS`).

---

## MRG blockchain discovery

Public MergeOS endpoints (readable without a worker token):

| Command | Source | What you get |
| --- | --- | --- |
| `mrgminner token` | `/api/public/token-economy` | Supply, reserves, fees, balances |
| `mrgminner proof` | `/api/public/ledger/proof` | Hash-chain root, tip, server valid/broken |
| `mrgminner verify` | proof entries (client) | Local `previous_hash` walk |
| `mrgminner market` | `/api/public/marketplace` | Funded projects + open bounties (**title MRG**) |
| `mrgminner chain` | all + agents/feed + Solana | Full discovery bundle |
| `mrgminner split` | market + claim-block + tip | Load-balanced work packs |
| `mrgminner intent [task]` | task + pack + tip + Solana | Claim intent + `ledger_reference` |
| `mrgminner solana` | proof-manifest JSON | Program id + Anchor instruction map |
| `mrgminner status` | settings + chain | Worker, provider, fleet, tip readiness |

```powershell
mrgminner token --json
mrgminner proof
mrgminner verify
mrgminner market --project prj_0428
mrgminner split
mrgminner intent prj_0428:1 --json
mrgminner chain --out discovery.json
mrgminner solana
```

Explore:

- https://scan.mergeos.shop  
- Ledger proof: https://mergeos.shop/api/public/ledger/proof  
- Solana manifest: https://mergeos.shop/contracts/solana/mergeos_mrg.proof-manifest.v1.json  

---

## Claim-block, work split & discoverable claim

```text
online job  +  online review  +  online audit  +  verified entry_hash
                         ↓
              claim-block (mrg_eligible)
                         ↓
     split → pack per bounty (pack_hash ↔ tip_hash ↔ ledger_reference)
                         ↓
     intent → claim --with-intent / submit --with-intent
                         ↓
     owner/admin accept  →  optional Solana releasePayout(ledgerReference)
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
mrgminner claim prj_0428:1 --with-intent
```

Packs **rotate** online nodes so work is not stuck on a single agent triple. Each pack carries:

- `pack_hash` — SHA-256 of task + block + tip + role assignment  
- `ledger_tip_hash` / `ledger_reference` — bytes32 anchor for Solana  
- `status` — `ready_to_claim` when block + tip + three roles are present  

---

## Claim / run / submit

```powershell
mrgminner claim <task-id> --with-intent
mrgminner run <task-id>
mrgminner submit <task-id> --pr-url https://github.com/org/repo/pull/1 --with-intent
```

`--with-intent` binds `intent_hash`, `pack_hash`, and ledger tip into agent-action evidence (discoverable on the live feed). **Payout is never released by this tool.**

---

## CLI reference

| Command | Purpose |
| --- | --- |
| `configure` / `login` / `status` | Settings, auth, miner health |
| `tasks` / `prompt` / `run` / `claim` / `submit` / `next` | Task lifecycle |
| `nodes` / `stats` / `block` | Agent fleet + claim-block |
| `token` / `proof` / `verify` / `market` / `split` / `chain` / `intent` / `solana` | MRG chain discovery |

Common flags: `--json` · `--mock` · `--strict` · `--out <file.json>` · `--project <prj_id>` · `--with-intent`

---

## Repository layout

```text
MRGMinner/
  bin/mrgminner.js      # CLI entry
  src/
    api.js              # MergeOS HTTP + public chain clients
    chain.js            # token / proof / market / split / intent / Solana
    nodes.js            # fleet roles + claim-block
    cli.js              # commands
    extension.js        # VS Code bridge
    runner.js / prompt.js / settings.js
  test/
  docs/
```

---

## Development

```powershell
npm ci
npm test
npm run build:exe        # Windows standalone exe via pkg
npm run build:portable   # exe + sha256 + metadata → MRGMinner-Windows-x64.zip
```

Artifacts are written to `dist/`:

| File | Description |
|------|-------------|
| `MRGMinner-Windows-x64.exe` | Standalone executable |
| `MRGMinner-Windows-x64.exe.sha256` | SHA-256 checksum |
| `MRGMinner-Windows-x64.build.json` | Build metadata (commit, run ID, release URLs) |
| `MRGMinner-Windows-x64.zip` | Portable package (exe + checksum + metadata) |

Windows CI: [`.github/workflows/mrgminner-windows-exe.yml`](.github/workflows/mrgminner-windows-exe.yml)

---

## MergeOS bounties

Star → claim issue → PR to **master** → MRG **25–200**.  
See [docs/BOUNTY.md](docs/BOUNTY.md) · [mergeos](https://github.com/mergeos-bounties/mergeos).

---

## License

MIT · MergeOS / ThanhTrucSolutions
