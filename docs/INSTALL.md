# MRGMinner Installation

## Windows

### Portable ZIP (recommended)

Download `MRGMinner-Windows-x64.zip` from the [latest release](https://github.com/mergeos-bounties/MRGMinner/releases/tag/mrgminner-windows-latest).

```powershell
# Extract the zip
Expand-Archive -Path MRGMinner-Windows-x64.zip -DestinationPath C:\tools\mrgminner

# Add to PATH (current session)
$env:Path += ";C:\tools\mrgminner"

# Verify
mrgminner --help
```

To make the PATH change permanent, add `C:\tools\mrgminner` to your user or system PATH via **System Properties → Environment Variables**.

### Standalone EXE

Download `MRGMinner-Windows-x64.exe` from the [latest release](https://github.com/mergeos-bounties/MRGMinner/releases/tag/mrgminner-windows-latest).

```powershell
# Place anywhere and run
.\MRGMinner-Windows-x64.exe --help
```

### Verify integrity

```powershell
# Compare with the published SHA256
Get-FileHash -Path MRGMinner-Windows-x64.exe -Algorithm SHA256
Get-Content -Path MRGMinner-Windows-x64.exe.sha256
```

---

## Build from source

Requires Node.js >= 18.17.

```powershell
git clone https://github.com/mergeos-bounties/MRGMinner.git
cd MRGMinner
npm ci
npm test

# Build standalone exe only
npm run build:exe

# Build exe + portable zip
npm run build:portable
```

Artifacts are written to `dist/`:

| File | Description |
|------|-------------|
| `MRGMinner-Windows-x64.exe` | Standalone executable |
| `MRGMinner-Windows-x64.exe.sha256` | SHA-256 checksum |
| `MRGMinner-Windows-x64.build.json` | Build metadata (commit, run ID, release URLs) |
| `MRGMinner-Windows-x64.zip` | Portable package (exe + checksum + metadata) |

## CI artifacts

Every push to `master` or tag matching `v*` / `mrgminner-v*` triggers the [Windows exe workflow](/.github/workflows/mrgminner-windows-exe.yml), which:

1. Runs tests
2. Builds the standalone EXE via `pkg`
3. Generates checksum and build metadata
4. Creates a portable ZIP containing all three artifacts
5. Uploads all artifacts to the workflow run and attaches them to a release
