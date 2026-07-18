# Bandwidth Share & TrucVPN Pairing

Turn your connection into a **residential exit**. MRGMinner runs a SOCKS5 proxy + HTTP control plane. TrucVPN clients route traffic through your node; you accrue MRG by the gigabyte.

## How it works

```
┌──────────────┐    SOCKS5 / HTTP CONNECT    ┌──────────────────┐
│  TrucVPN     │◄────────────────────────────►│  MRGMinner Share │
│  Client      │                              │  (your node)     │
└──────────────┘                              └──────────────────┘
                                                      │
                                                      ▼
                                              Real internet
                                              (residential exit)
```

The share node runs two servers:
- **SOCKS5** — general TCP proxy on port `controlPort + 10`
- **HTTP control plane** — discovery, health, earnings on `--port` (default 17890)

TrucVPN periodically polls `GET /v1/exits` to discover available regions and routes traffic to the best exit based on weight and latency.

## Quick start

### Start a share node

```powershell
mrgminner share start --region vn --city "Ho Chi Minh" --port 17890
```

Output:
```
# MRGMinner share started (bandwidth → MRG)
exit_id   mrgminner:exit:vn:hcm:abc123def
control   http://127.0.0.1:17890
socks     socks5://127.0.0.1:17900
region    vn      Ho Chi Minh
mrg_per_gb       5
# TrucVPN: trucvpn configure --share-url http://127.0.0.1:17890
#          trucvpn connect --region vn
# Press Ctrl+C to stop and flush session earnings.
```

Keep this terminal running. Press **Ctrl+C** to stop and persist your session earnings.

### Pair with TrucVPN

In a second terminal:

```powershell
trucvpn configure --share-url http://127.0.0.1:17890
trucvpn connect --region vn
```

TrucVPN discovers exits automatically via the control plane and routes traffic through your SOCKS5 proxy.

## Multi-region advertising

A single share node can advertise multiple logical regions:

```powershell
mrgminner share start --regions "vn:Ho Chi Minh:70,sg:Singapore:30" --port 17890
```

Format: `code:city:weight` (weight = traffic share percentage). Each region appears in `/v1/exits` as both SOCKS5 and HTTP CONNECT entries with a stable exit id.

## Check earnings

View your current session and historical earnings:

```powershell
mrgminner share earnings
```

Output:
```
# MRGMinner bandwidth-share earnings
bytes_total      104857600
sessions         3
mrg_per_gb       5
mrg_earned_total 0.5
# Pair with TrucVPN: trucvpn connect --region <code>
```

Use `--json` for structured output:

```powershell
mrgminner share earnings --json
```

### Status (JSON)

```powershell
mrgminner share status
```

Returns a full snapshot including region, uptime, and per-session details.

## Reference

### CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port` | `17890` | HTTP control plane port |
| `--socks-port` | `port + 10` | SOCKS5 proxy port |
| `--host` | `127.0.0.1` | Bind address |
| `--region` | `vn` | Region code (single region mode) |
| `--city` | `Ho Chi Minh` | City name (single region mode) |
| `--regions` | — | Multi-region: `"code:city:weight,code:city:weight"` |
| `--mrg-per-gb` | `5` | MRG reward rate per GB shared |
| `--worker-id` | auto | Custom worker ID for earnings attribution |
| `--advertise-host` | `--host` | Public-facing host in exit listings |
| `--quiet` | off | Suppress 30s heartbeat logs |

### Subcommands

| Command | Description |
| --- | --- |
| `mrgminner share start` | Start a share node (foreground) |
| `mrgminner share status` | Print current earnings as JSON |
| `mrgminner share earnings` | Print human-readable earnings summary |
| `mrgminner share stop` | Note: share runs in foreground — use Ctrl+C |

### Control plane API

| Endpoint | Description |
| --- | --- |
| `GET /v1/health` | Health check with role metadata |
| `GET /v1/exits` | List advertised exits with region, protocol, weight |
| `GET /v1/earnings` | Session stats: bytes, MRG, uptime |
| `POST /v1/claim-mock` | Snapshot earnings into persistent history |

## State & persistence

Earnings persist to `~/.mergeide/share/share-state.json` (or `$MRGMINNER_SHARE_DIR/share-state.json`).

```json
{
  "bytes_in": 52428800,
  "bytes_out": 52428800,
  "sessions": 3,
  "mrg_earned_total": 0.5,
  "mrg_per_gb": 5,
  "history": [
    { "bytes": 10485760, "mrg": 0.05, "timestamp": "2026-07-18T03:00:00Z" }
  ]
}
```

A running marker `share-running.json` tracks the active session for clean shutdown.

## Region codes

Common region codes for `--region` / `--regions`:

| Code | Country |
| --- | --- |
| `vn` | Vietnam |
| `sg` | Singapore |
| `us` | United States |
| `jp` | Japan |
| `kr` | South Korea |
| `de` | Germany |
| `gb` | United Kingdom |
| `fr` | France |
| `au` | Australia |
| `ca` | Canada |

## Troubleshooting

**Port already in use**  
Change the port: `mrgminner share start --port 17891`

**No TrucVPN clients connecting**  
Verify the share URL is reachable: `curl http://127.0.0.1:17890/v1/health`. Check that `--advertise-host` is set to a publicly reachable address if the client is on another machine.

**Earnings not incrementing**  
0 bytes relayed = 0 MRG. Start a bandwidth-heavy task on the client side. Check `mrgminner share status` for real-time bytes.

**Multi-region not working**  
Use the exact format: `--regions "vn:Ho Chi Minh:70,sg:Singapore:30"` (colon-separated fields, comma-separated regions, weights should sum to ~100).
