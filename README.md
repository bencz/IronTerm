# IronTerm

Browser-side IBM 3270 terminal. No backend, no server-side code, no
runtime build step — just static files served over HTTP. The 3270
datastream and TN3270E telnet negotiation are implemented in plain
JavaScript modules running in the page; the page connects to the
mainframe through any websockify-style TCP↔WebSocket relay.

## Quick start

You need three things: this repo, a static HTTP server, and a
WebSocket-to-TCP bridge that forwards binary frames to your mainframe.

### 1. Serve the static files

```sh
cd public
python3 -m http.server 8080
# → open http://localhost:8080/tn3270/
```

Any static server works; nothing in the project requires a build step.

### 2. Run a TCP↔WebSocket bridge

[websockify](https://github.com/novnc/websockify) is the simplest
option. To expose a Hercules MVS turnkey listening on `localhost:3270`:

```sh
websockify --binary 6080 localhost:3270
```

For multi-target routing, websockify also supports a token file or you
can put an nginx in front. The terminal sends `binary` as the WebSocket
subprotocol; websockify accepts it by default.

**Or skip running your own bridge** — a public test instance of
[tk5-hercules](https://github.com/bencz/tk5-hercules) (Hercules MVS 3.8j
Turnkey 5) is up at:

```
wss://tk5.bencz.cc:6080
```

Drop that URL into the bridge field and connect — no setup needed.
TLS is terminated at the bridge, so the page works fine when served
over HTTPS. For testing only; don't use real credentials.

### 3. Configure the page

In the toolbar, set the bridge URL — for example one of:

```
ws://localhost:6080/                            (single backend)
wss://tk5.bencz.cc:6080/                        (public test server)
wss://relay.example.com/tcp?port={port}         ({port} is substituted)
```

Pick the model (3278-2 default), press **Connect**, and the OIA at the
bottom turns green.

## What works

**Telnet / TN3270E (RFC 2355):**

- BINARY, EOR, TERMINAL-TYPE option negotiation (RFC 1041)
- TN3270E DEVICE-TYPE / FUNCTIONS subnegotiation
  (BIND-IMAGE, RESPONSES, SYSREQ)
- 5-byte data-stream header on inbound and outbound records
- Outbound sequence numbers are unique and monotonically increasing
  (RFC 2355 §3.2)
- Dispatch by data-type — only `3270-DATA` is fed to the parser;
  `BIND-IMAGE` / `UNBIND` / `NVT-DATA` / `SSCP-LU-DATA` are accepted
  and ignored.
- ALWAYS-RESPONSE / ERROR-RESPONSE handled correctly:
  positive `RESPONSE` on success, negative `RESPONSE` (with sense byte)
  when the parser rejects a record, both echoing the host's seq.
- IAC NOP keepalive after 120 s idle.

**3270 datastream:**

- Commands: `W`, `EW`, `EWA`, `EAU`, `WSF`, `RB`, `RM`, `RMA`
  (both EBCDIC- and CCW-encoded forms accepted)
- Orders: `SBA`, `SF`, `SFE`, `SA`, `MF`, `IC`, `PT`, `RA`, `EUA`, `GE`
- WCC bits: `RESET-MDT`, `RESTORE-KEYBOARD`, `SOUND-ALARM`,
  `RESET-PARTITION`, `START-PRINTER`
- 12-bit and 14-bit buffer addresses (auto-detected on input,
  always 12-bit on output)
- Cyclic field model — fields that wrap around the end of the buffer
- Field MDT tracking; modified-field replies use `f.start + 1`
- Validation attributes (mandatory-fill / mandatory-entry) — terminal
  refuses the AID and parks the cursor on the offending field, just
  like a physical 3278.
- Set Reply Mode SF (0x09) is honoured — Read Buffer responses adapt
  to field / extended-field / character mode with the requested
  attribute list.

**Query Reply (sent in response to Read Partition Query):**

Summary, Usable Area, Character Sets, Color, Highlight, Reply Modes,
Implicit Partition.

**File transfer — IND$FILE:**

- **Download** (host → browser): user types `IND$FILE GET dataset` on
  TSO/CMS; the terminal collects the WSF data records (rectype 0x47,
  subtype 0x04), acknowledges each with the running buffer number,
  and on CLOSE triggers a browser download with the dataset name.
- **Upload** (browser → host): click **Upload…** in the toolbar,
  pick a local file, then run `IND$FILE PUT dataset` on TSO. The
  queued bytes are streamed back in 2 KB chunks in response to the
  host's 0x46 0x11 requests, terminated with an EOF error record.
- Works for both `FT:DATA` (binary/ASCII files) and `FT:MSG` (host
  status messages, surfaced as a flash status).
- Compressed mode (`IND$FILE GET ... COMP`) is detected and refused
  with a clear message — use the default uncompressed transfer.

**Models supported:**

| Model | Rows × Cols | TerminalType      |
|-------|-------------|-------------------|
| 2     | 24 × 80     | `IBM-3278-2-E`    |
| 3     | 32 × 80     | `IBM-3278-3-E`    |
| 4     | 43 × 80     | `IBM-3278-4-E`    |
| 5     | 27 × 132    | `IBM-3278-5-E`    |

**UI:**

- Canvas-rendered display with extended color (3279-class palette),
  highlighting (underscore, reverse video, intensify)
- OIA status bar — connection LED, keyboard lock, insert mode, alarm
  flash, terminal type, cursor R/C
- Insert-mode toggle (Insert key) with overflow alarm
- Mouse selection, copy / paste / select-all (⌘/Ctrl+C/V/A)
- Rule cross-hair (toggle in toolbar)
- NVT overlay for ASCII banners before BINARY is negotiated
- Connection profiles persisted in `localStorage`


## Encoding

Two EBCDIC code pages ship today, switchable from the toolbar dropdown
and persisted per connection profile:

- **CP037** — US English EBCDIC. Default. Used by classic z/OS, Hercules
  turnkey, pub400 (IBM i), and most legacy mainframe shops.
- **CP1047** — Latin-1 Open Systems EBCDIC. The line-feed byte sits at
  0x15 instead of 0x25, plus a few special-character swaps (`¢`/`[`,
  `!`/`]`, `¬`/`^`, etc.). Used by USS / z/OS Unix and many modern
  hosts that interoperate with ASCII tooling.

Switching mid-session re-renders existing cells through the new table
immediately, no reconnect needed. Adding another code page is a 10-line
change — drop its delta map into `DELTAS` in `src/proto/Ebcdic.js`.


## Browser compatibility

Targets evergreen browsers (Chrome / Edge / Firefox / Safari). Uses
ES modules, private class fields (`#name`), `Uint8Array`, Web
Audio (for the alarm beep) and `localStorage` (for profiles).
No transpilation, no bundler.

For `wss://` with a self-signed certificate you have to visit
`https://<bridge-host>:<port>/` once and accept the cert; the browser
won't surface a TLS prompt during a WebSocket handshake.


## What's not implemented

This is the realistic gap list. Everything here is fixable; nothing
blocks day-to-day TSO / CICS use as far as I've tested.

- **Other EBCDIC code pages** (CP500, CP297, CP285, …) — straightforward
  to add (delta maps in `Ebcdic.js`); CP037 + CP1047 ship today
- **DBCS / SO/SI** (Asian double-byte)
