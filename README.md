# MRGMinner

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MergeOS](https://img.shields.io/badge/MergeOS-bounties-5319E7.svg)](https://github.com/mergeos-bounties)

**MRGMinner** (formerly **MergeIDE**) is a VS Code–style workspace bridge for **MergeOS** tasks. It lists funded work, builds an AI task prompt, runs the AI CLI you choose, reserves the worker lane, and submits review evidence — without releasing payout (accept stays with project owner/admin).

**Product:** [mergeos-bounties/MRGMinner](https://github.com/mergeos-bounties/MRGMinner) · Platform: [mergeos.shop](https://mergeos.shop/) · Funded project: **`prj_0428`**

Extracted from the [mergeos](https://github.com/mergeos-bounties/mergeos) monorepo (`MergeIDE/`) into a standalone public product.

![MRGMinner task runner](docs/mrgminner-screenshot.png)

---

## Highlights

| Capability | Description |
| --- | --- |
| **CLI** | `mrgminner` / `mergeide` (alias) — tasks, claim, run, submit |
| **AI presets** | Codex, Claude, or custom CLI with prompt placeholders |
| **VS Code extension** | Same package loads as an extension (MRGMinner command palette titles) |
| **Windows exe** | GitHub Actions packages `MRGMinner-Windows-x64.exe` |
| **Safety** | Never calls task **accept** / payout release |

---

## Quick start

```powershell
cd MRGMinner
npm ci
npm test
node .\bin\mrgminner.js --help
```

Configure against MergeOS:

```powershell
node .\bin\mrgminner.js configure --mergeos-url https://mergeos.shop --provider claude --worker-id github:yourname
node .\bin\mrgminner.js login --email you@example.com --password your-password
node .\bin\mrgminner.js tasks --open
```

Settings default to `%USERPROFILE%\.mergeide\settings.json` (env `MERGEIDE_SETTINGS` / `MRGMINNER_SETTINGS`).

---

## Claim and submit flow

```powershell
node .\bin\mrgminner.js claim prj_public_0001:12
node .\bin\mrgminner.js run prj_public_0001:12
node .\bin\mrgminner.js submit prj_public_0001:12 `
  --pr-url https://github.com/acme/repo/pull/12 `
  --notes "Implementation ready for review."
```

MergeOS records payout only when an owner/admin accepts the task. MRGMinner never uses that route.

---

## Windows executable

Workflow: [`.github/workflows/mrgminner-windows-exe.yml`](.github/workflows/mrgminner-windows-exe.yml)

```powershell
npm run build:exe
.\dist\MRGMinner-Windows-x64.exe --help
```

---

## Environment overrides

```powershell
$env:MERGEOS_URL = "https://mergeos.shop"
$env:MERGEOS_TOKEN = "<token>"
$env:MERGEIDE_AI_PROVIDER = "codex"
$env:MERGEIDE_WORKER_ID = "github:yourname"
```

---

## Development

```powershell
npm ci
npm test
```

---

## MergeOS bounties

Star → claim a bounty issue → PR to **master** → MRG **25–200**.  
See [docs/BOUNTY.md](docs/BOUNTY.md) and [mergeos](https://github.com/mergeos-bounties/mergeos).

---

## License

MIT · MergeOS / ThanhTrucSolutions
