# IBM i ENPTUI validation suite

This directory contains small, independent DDS applications used to validate
the TN5250 enhanced data stream end to end.  Each sample reports the values
returned by the workstation so rendering and inbound behavior can be checked
separately.

## Test matrix

| Program | Display file | Coverage |
| --- | --- | --- |
| `ITBASICR` | `ITBASICD` | single choice, multiple choice, push buttons, mnemonics, unavailable choices |
| `ITWINDOWR` | `ITWINDOWD` | fixed and program-positioned windows, title, footer, border, subwindow, remove/recreate |
| `ITMOUSER` | `ITMOUSED` | single and two-event programmable mouse definitions, queueing, cursor coordinates |
| `ITSFLSR` | `ITSFLSD` | single-choice subfile and vertical scrollbar |
| `ITSFLMR` | `ITSFLMD` | multiple-choice subfile and vertical scrollbar |
| `ITMENUR` | `ITMENUD` | menu bar, pull-downs, mnemonics, accelerators and cancel AID |
| `ITGRIDR` | `ITGRIDD` | grid box/lines, clear and redraw |
| `ITCOBOLC` | `ITCOBOLD` | ILE COBOL workstation I/O with choices and push buttons |
| `WEBDOWR` | `WEBDOWD` | original Name-A-Day layout, date input, day-name lookup, push buttons and calendar invocation |
| `DATEPOPUPR` | `DATEPOPUPD` | reusable calendar window, date selection, mouse input and month/year navigation |
| `MENUBARR` | `MENUBARD` | application menu bar, pull-down choices and command dispatch |

All object and member names fit the IBM i ten-character name limit.  The
samples are intentionally independent so a failure in one construct does not
prevent the remaining constructs from being exercised.

## Build

Upload the files to matching members in `QDDSSRC`, `QRPGLESRC`, and
`QCBLLESRC`, then run the commands in `build.cl`.  The default target library
in the checked-in build script is `BENCZ1`.

Run a sample with, for example:

```text
CALL BENCZ1/ITBASICR
CALL BENCZ1/ITWINDOWR
CALL BENCZ1/ITSFLSR
CALL BENCZ1/WEBDOWR
CALL BENCZ1/MENUBARR
```

`DATEPOPUPR` is invoked by `WEBDOWR`; it is not normally called directly
because its optional parameters carry the selected date and window position.

Use a 24x80 enhanced color device for the baseline results.

## Live regression runner

With a WebSocket bridge already listening, run the same programs through the
actual IronTerm client without putting credentials in source code or command
arguments:

```sh
export IRONTERM_5250_USER='YOUR_USER'
export IRONTERM_5250_PASSWORD='YOUR_PASSWORD'
npm run test:tn5250:live
```

Optional variables are `IRONTERM_5250_URL` (default
`ws://localhost:6080/`), `IRONTERM_5250_LIBRARY` (default `BENCZ1`),
`IRONTERM_5250_PROGRAM` (run one program), `IRONTERM_5250_CODEPAGE` (default
`CP037`), and `IRONTERM_5250_TIMEOUT` (milliseconds). For example:

```sh
IRONTERM_5250_PROGRAM=ITWINDOWR npm run test:tn5250:live
```

PUB400 jobs commonly use CCSID 273; select `CP1141` in IronTerm (or set
`IRONTERM_5250_CODEPAGE=CP1141` in the live runner) so punctuation such as
vertical bars and backslashes is decoded correctly.

The live runner is stored in `test/live/`. During the normal hermetic
`npm test` suite it detects missing live credentials and exits without opening
a connection; `npm run test:tn5250:live` requires the variables explicitly.
