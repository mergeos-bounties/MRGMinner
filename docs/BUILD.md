# MRGMinner — Build Guide

This document covers building MRGMinner from source and packaging it as a Windows
standalone executable, portable zip, or Electron desktop app.

---

## Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| [Node.js](https://nodejs.org/) | >= 18.17 (22 recommended) | Runtime and build toolchain |
| npm | ships with Node | Dependency management |
| [Docker](https://www.docker.com/products/docker-desktop/) | latest | Task sandbox (IDE/Electron only) |
| [Git](https://git-scm.com/) | any | Clone the repository |
| [pkg](https://github.com/yao-pkg/pkg) | @yao-pkg/pkg ^6.20.0 | Cross-compile to standalone .exe |

Docker is optional for CLI-only usage but required for IDE/Electron task execution.

---

## Quick start

```bash
git clone https://github.com/mergeos-bounties/MRGMinner.git
cd MRGMinner
npm ci
npm test
node ./bin/mrgminner.js version
```

---

## Build commands

### Standalone Windows executable

Compile the Node.js source into a single Windows x64 binary via `pkg`:

```bash
npm run build:exe
```

This wraps `pkg . --targets node22-win-x64 --compress GZip --output dist/MRGMinner-Windows-x64.exe`.

Artifacts in `dist/`:

| File | Description |
|------|-------------|
| `MRGMinner-Windows-x64.exe` | Standalone executable (no Node.js required) |

### Portable zip

Create a portable `.zip` containing the exe plus checksum and build metadata:

```bash
npm run build:portable
```

This runs `build:exe` first, then executes `scripts/package-portable.js` which
calls `Compress-Archive` (PowerShell) on the three files.

Artifacts in `dist/`:

| File | Description |
|------|-------------|
| `MRGMinner-Windows-x64.exe` | Standalone executable |
| `MRGMinner-Windows-x64.exe.sha256` | SHA-256 checksum |
| `MRGMinner-Windows-x64.build.json` | Build metadata (commit, run ID, release URLs) |
| `MRGMinner-Windows-x64.zip` | Portable package containing all three above |

### Electron desktop app

Build the Electron-based desktop app for Windows or Linux:

```bash
npm run build:electron:win      # Windows portable .exe
npm run build:electron:linux    # Linux AppImage + tar.gz
npm run build:electron          # Build for current platform
```

Electron artifacts are written to `dist/electron/`.

---

## Artifact summary

| Workflow | Build command | Output directory | Key artifacts |
|----------|--------------|-----------------|---------------|
| CLI standalone exe | `npm run build:exe` | `dist/` | `.exe` |
| CLI portable zip | `npm run build:portable` | `dist/` | `.exe` + `.sha256` + `.build.json` + `.zip` |
| Electron Windows | `npm run build:electron:win` | `dist/electron/` | `-windows-x64-portable.exe` + `.sha256` |
| Electron Linux | `npm run build:electron:linux` | `dist/electron/` | `.AppImage` + `.tar.gz` + `.sha256` |

---

## Verification

### Smoke test the executable

```powershell
.\dist\MRGMinner-Windows-x64.exe --help
.\dist\MRGMinner-Windows-x64.exe version
.\dist\MRGMinner-Windows-x64.exe version --json
```

### Verify checksum

```powershell
Get-FileHash -Path .\dist\MRGMinner-Windows-x64.exe -Algorithm SHA256
Get-Content .\dist\MRGMinner-Windows-x64.exe.sha256
# Compare the two values — they must match.
```

### Run unit tests

```bash
npm test
```

All tests run without network or Docker — safe for CI.

---

## Windows code signing (optional)

To sign the executable so Windows SmartScreen and antivirus tools trust it:

1. Obtain a code signing certificate from a CA (DigiCert, Sectigo, Let's Encrypt
   via S/MIME, or an EV certificate).
2. Install the certificate in your local certificate store.
3. Use `signtool` (Windows SDK) or `osslsigncode` (cross-platform):

```powershell
# Using signtool (Windows SDK)
signtool sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 `
  .\dist\MRGMinner-Windows-x64.exe

# Verify the signature
signtool verify /pa .\dist\MRGMinner-Windows-x64.exe
```

```bash
# Using osslsigncode (cross-platform)
osslsigncode sign -certs my-cert.pem -key my-key.pem `
  -h sha256 -t http://timestamp.digicert.com `
  -in dist/MRGMinner-Windows-x64.exe `
  -out dist/MRGMinner-Windows-x64-signed.exe
```

Sign **after** building and **before** creating the portable zip so the signed
binary is included in the package.

---

## CI/CD

The repository includes three GitHub Actions workflows:

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | Push/PR to `master` | Unit tests on Node 18/20/22 + CLI smoke |
| `mrgminner-windows-exe.yml` | Push to `master`, tag `v*` / `mrgminner-v*`, or workflow_dispatch | Builds exe, checksum, metadata, portable zip; uploads to release |
| `mrgminner-electron-release.yml` | Push to `master`, tag `v*` / `mrgminner-v*` / `mrgminner-electron-v*`, or workflow_dispatch | Builds Electron apps for Windows and Linux; uploads to release |

All workflows run `npm test` before producing artifacts.

---

## Windows build notes

- The `build:portable` script uses PowerShell's `Compress-Archive` and requires
  Windows to run. On Linux/macOS the exe build step (`build:exe`) works, but the
  zip packaging step will fail.
- `pkg` cross-compiles Node.js bytecode — the resulting `.exe` does not require
  a separate Node.js runtime on the target machine.
- The GitHub Actions Windows exe workflow runs on `windows-latest` and produces
  the full set of artifacts.
