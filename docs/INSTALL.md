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

# Open the local MergeIDE workspace
mergeide ide --workspace .
```

To make the PATH change permanent, add `C:\tools\mrgminner` to your user or system PATH via **System Properties → Environment Variables**.

### Standalone EXE

Download `MRGMinner-Windows-x64.exe` from the [latest release](https://github.com/mergeos-bounties/MRGMinner/releases/tag/mrgminner-windows-latest).

```powershell
# Place anywhere and run
.\MRGMinner-Windows-x64.exe --help
.\MRGMinner-Windows-x64.exe ide --workspace .
```

### Electron desktop app

The Electron app runs MRGMinner as a normal desktop window. On Windows, download the `MRGMinner-*-windows-x64-portable.exe` asset from the `mrgminner-electron-latest` release and run it directly. On Linux, download either the `.AppImage` or `.tar.gz` asset.

Task execution in the IDE/Electron app uses two runtimes: the AI CLI runs on the host machine, while safe MRGMinner/verification commands run in Docker with the source mounted at `/workspace`. Install and login to Codex, Claude, Grok, or your custom AI CLI on Windows/Linux. The default Docker image is `node:22-bookworm-slim`; set `MRGMINNER_SANDBOX_IMAGE` to change the task runtime image.

After opening the desktop app, use `Local test tasks > Welcome AI runtime test` to confirm your host AI CLI can write to the Docker-mounted workspace, then press **Check pass**.

### Verify integrity

```powershell
# Compare with the published SHA256
Get-FileHash -Path MRGMinner-Windows-x64.exe -Algorithm SHA256
Get-Content -Path MRGMinner-Windows-x64.exe.sha256
```

---

## Build from source

Requires Node.js >= 18.17. Docker is also required for IDE/Electron task execution.

```powershell
git clone https://github.com/mergeos-bounties/MRGMinner.git
cd MRGMinner
npm ci
npm test
docker version
node .\bin\mergeide.js ide --workspace .
npm run electron -- --workspace .

# Build standalone exe only
npm run build:exe

# Build exe + portable zip
npm run build:portable

# Build Electron desktop apps
npm run build:electron:win
npm run build:electron:linux
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
