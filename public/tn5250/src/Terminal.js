// High-level orchestrator for a TN5250 session.
//
// Owns the screen buffer + wire layers, translates keyboard / button
// events into AID / read / cursor moves, and drives the GDS framing
// in/out. Parallels the TN3270 Terminal but with 5250-specific
// opcodes and command flow.

import { ScreenBuffer } from './display/ScreenBuffer.js';
import { Renderer } from './ui/Renderer.js';
import { InputController } from './ui/InputController.js';
import { Oia } from './ui/Oia.js';
import { NvtView } from '../../shared/src/ui/NvtView.js';
import { TelnetStream } from './net/TelnetStream.js';
import { WebSocketTransport } from '../../shared/src/net/WebSocketTransport.js';
import { InboundParser } from './proto/InboundParser.js';
import { OutboundBuilder } from './proto/OutboundBuilder.js';
import { decodeStartupRecord } from './proto/StartupRecord.js';
import * as Gds from './proto/GdsHeader.js';
import { Aid, Cmd, Order, Models, Gds as GdsConsts, NegResp } from './proto/Constants.js';

// Map an AID byte back to its PF number, or null when it's not a PF.
function pfNumberFor (aid) {
    if (aid >= Aid.PF1  && aid <= Aid.PF12)  return aid - Aid.PF1  + 1;
    if (aid >= Aid.PF13 && aid <= Aid.PF24)  return aid - Aid.PF13 + 13;
    return null;
}
import { Ebcdic } from '../../shared/src/proto/Ebcdic.js';
import { debugFor, isDebugEnabled } from '../../shared/src/core/debug.js';

const debug = debugFor('tn5250.terminal');

// IBM-5292-2 is the natural default for an ENPTUI-capable client: it's
// the 5250 model that introduced graphics + enhanced UI primitives, so
// our advertised Query Reply (which already lights up the ENPTUI bits)
// matches what the host expects from a 5292-class workstation.
const DEFAULT_MODEL = '5292-2';

export class Terminal {
    constructor ({ canvas, statusEl, oiaEls, nvtEl, codePage = 'CP037', modelKey = DEFAULT_MODEL,
                   onConnectionState }) {
        this.canvas = canvas;
        this.statusEl = statusEl;
        this.statusRevision = 0;
        this.onConnectionState = onConnectionState ?? (() => {});
        this.disconnectContext = '';

        this.modelKey = modelKey;
        this.codePage = codePage;
        const m = Models[modelKey];
        this.screen   = new ScreenBuffer(m.rows, m.cols, Ebcdic.get(codePage));
        this.screen.configureGeometry({ alternateRows: m.rows, alternateCols: m.cols });
        this.renderer = new Renderer(canvas, this.screen);
        this.parser   = new InboundParser(this.screen, {
            onGeometryChange: () => this.renderer.resize(),
        });
        this.builder  = new OutboundBuilder(this.screen);
        this.pendingResponseOpcode = GdsConsts.Op.PUT_GET_OPERATION;
        this.transport = null;
        this.telnet    = null;
        this.oia       = new Oia(oiaEls);
        this.nvt       = new NvtView(nvtEl, (line) => this.#sendNvt(line));

        // Bypass-signon / environment knobs - filled by main.js from
        // toolbar inputs before connect().
        this.envOptions = {};

        this.input = new InputController({
            canvas,
            renderer: this.renderer,
            screen: this.screen,
            onAid:        (aid) => this.sendAid(aid),
            onType:       (s)   => this.type(s),
            onBackspace:  ()    => { this.screen.backspace(); this.draw(); },
            onDelete:     ()    => { this.screen.deleteChar(); this.draw(); },
            onEraseEof:   ()    => { this.screen.eraseToEndOfField(); this.draw(); },
            onEraseInput: ()    => { this.screen.eraseInput(); this.draw(); },
            onInsert:     ()    => { this.screen.toggleInsertMode(); this.draw(); },
            onTab:        ()    => { this.screen.tab(); this.draw(); },
            onBackTab:    ()    => { this.screen.backTab(); this.draw(); },
            onMoveCursor: (i)   => {
                const moved = this.screen.moveCursorTo(i);
                this.draw();
                return moved;
            },
            onFlash:      (msg) => this.flashStatus(msg),
            onSystemRequest: () => this.sendSystemRequest(),
            onFieldExit:   ()    => this.fieldExit(),
            onFieldPlus:   ()    => this.fieldSignExit(false),
            onFieldMinus:  ()    => this.fieldSignExit(true),
            onNewline:     ()    => { this.screen.newLine(); this.draw(); },
            onDeleteWord:  ()    => { this.screen.deleteWord(); this.draw(); },
            onEraseField:  ()    => { this.screen.eraseField(); this.draw(); },
            onWordTab:     (backwards) => { this.screen.wordTab(backwards); this.draw(); },
            onDup:         ()    => this.insertDup(),
            onFieldMark:   ()    => this.insertFieldMark(),
            onReset:       ()    => this.resetOperatorState(),
        });

        window.addEventListener('resize', () => this.renderer.resize());
        if ('ResizeObserver' in window) {
            new ResizeObserver(() => this.renderer.resize()).observe(canvas);
        }
        this.renderer.resize();
        this.draw();
        this.setStatus('disconnected', 'disconnected');

        // Wire-level capture can include user-entered field data, so it is
        // opt-in through the `tn5250.stream` debug scope. Last 200 records,
        // dump via `terminal.dumpStream()`.
        this.captureStream = isDebugEnabled('tn5250.stream');
        this.streamLog = [];
        this.streamLogMax = 200;
        this.streamStartedAt = 0;
    }

    /** Push one record (in or out) onto the rolling log. */
    #logRecord (dir, opcode, flags, bytes) {
        if (!this.captureStream) return;
        if (this.streamStartedAt === 0) this.streamStartedAt = Date.now();
        const t = Date.now() - this.streamStartedAt;
        this.streamLog.push({
            t, dir, opcode, flags,
            hex: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' '),
            len: bytes.length,
        });
        if (this.streamLog.length > this.streamLogMax)
            this.streamLog.splice(0, this.streamLog.length - this.streamLogMax);
    }

    /** Pretty-print every captured record. Copy the output and send it
     *  back for offline decoding when the rendering looks wrong. */
    dumpStream () {
        if (!this.captureStream)
            return "stream capture is disabled; add 'tn5250.stream' to localStorage['ironterm.debug'], reload, and reconnect";
        if (this.streamLog.length === 0) return '(stream log is empty - reconnect)';
        const lines = [
            `# IronTerm TN5250 stream log - ${this.streamLog.length} records`,
            `# format: [+ms] DIR opcode=NN flags=NNNN len=N : hex bytes`,
            '',
        ];
        for (const r of this.streamLog) {
            const t = String(r.t).padStart(7, ' ');
            const op = r.opcode.toString(16).padStart(2, '0');
            const fl = r.flags.toString(16).padStart(4, '0');
            lines.push(`[+${t}ms] ${r.dir} opcode=0x${op} flags=0x${fl} len=${r.len}`);
            // 32 bytes per line for readability
            const bytes = r.hex.split(' ');
            for (let i = 0; i < bytes.length; i += 32)
                lines.push('   ' + bytes.slice(i, i + 32).join(' '));
        }
        const text = lines.join('\n');
        console.log(text);
        // Also offer a download for big streams (clipboard truncates).
        try {
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ironterm-tn5250-stream-${Date.now()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            debug.log('stream downloaded as .txt file');
        } catch (e) {
            debug.warn('could not trigger download:', e);
        }
        return text;
    }

    // ---- config --------------------------------------------------------

    setModel (key) {
        const m = Models[key];
        if (!m) return;
        this.modelKey = key;
        this.screen.configureGeometry({ alternateRows: m.rows, alternateCols: m.cols });
        this.screen.resize(m.rows, m.cols);
        this.renderer.resize();
        this.draw();
    }
    setCodePage (name) {
        const ebcdic = Ebcdic.get(name);
        this.codePage = ebcdic.name;
        this.screen.setEbcdic(ebcdic);
        this.draw();
    }
    setEnvOptions (opts) { this.envOptions = opts ?? {}; }

    // ---- connection lifecycle ------------------------------------------

    async connect ({ url }) {
        if (this.transport) await this.disconnect();
        this.disconnectContext = '';
        const m = Models[this.modelKey];
        this.screen.configureGeometry({ alternateRows: m.rows, alternateCols: m.cols });
        this.screen.resize(m.rows, m.cols);
        this.renderer.resize();
        this.draw();
        this.setStatus('connecting…', 'connecting');
        this.onConnectionState('connecting');
        this.oia.setConnection('connecting');
        this.oia.setModel('-');
        this.nvt.clear();
        this.nvt.hide();

        const envOptions = this.envOptions;
        this.envOptions = { ...this.envOptions };
        delete this.envOptions.password;
        this.telnet = new TelnetStream({
            send:         (b) => this.transport?.send(b),
            onRecord:     (rec) => this.handleRecord(rec),
            onState:      (s) => this.onTelnetState(s),
            onNvt:        (b) => this.nvt.append(b),
            terminalType: m.terminalType,
            envOptions,
        });

        this.transport = new WebSocketTransport(url, {
            onOpen:  () => {
                this.setStatus('connected', 'connected');
                this.oia.setConnection('connected');
                this.onConnectionState('connected');
            },
            onData:  (b) => this.telnet?.feed(b),
            onClose: (reason) => {
                const context = this.disconnectContext;
                this.setStatus(context
                    ? `disconnected · ${context}`
                    : `disconnected: ${reason}`,
                context ? 'error' : 'disconnected');
                this.oia.setConnection('disconnected');
                this.cleanup();
                this.onConnectionState('disconnected');
            },
            onError: (err) => {
                this.setStatus(`error: ${err}`, 'error');
                this.oia.setConnection('error');
                this.onConnectionState('error');
            },
        });
        try {
            this.transport.open();
        } catch (err) {
            this.setStatus(`error: ${err}`, 'error');
            this.oia.setConnection('error');
            this.cleanup();
            this.onConnectionState('error');
        }
    }

    async disconnect () {
        if (!this.transport) return;
        this.disconnectContext = '';
        this.transport.close();
        this.cleanup();
        this.setStatus('disconnected', 'disconnected');
        this.oia.setConnection('disconnected');
        this.onConnectionState('disconnected');
    }

    cleanup () {
        if (this.telnet) this.telnet.close();
        this.transport = null;
        this.telnet = null;
    }

    onTelnetState (state) {
        if (state.binary) this.nvt.hide();
        if (state.newEnviron) this.oia.setModel('TN5250E');
        else if (state.binary && state.eor) this.oia.setModel('TN5250');
        debug.log('telnet state',
            { binary: state.binary, eor: state.eor, ttype: state.ttype,
              newEnviron: state.newEnviron });
    }

    #sendNvt (text) { this.telnet?.sendNvtText(text); }

    // ---- inbound -------------------------------------------------------

    handleRecord (record) {
        const decoded = Gds.unwrap(record);
        if (!decoded) {
            debug.warn('dropped non-GDS record:',
                Array.from(record.slice(0, 32)).map(b => b.toString(16).padStart(2,'0')).join(' '),
                `(len=${record.length})`);
            this.#logRecord('IN ', 0xFF, 0, record);
            return;
        }
        const { opcode, flags, miscFlags1, payload } = decoded;
        const flags1 = (flags >>> 8) & 0xFF;
        this.#logRecord('IN ', opcode, flags, payload);
        debug.log(`record opcode=0x${opcode.toString(16).padStart(2,'0')} payload=`,
            Array.from(payload.slice(0, 48)).map(b => b.toString(16).padStart(2,'0')).join(' '),
            `(len=${payload.length})`);

        if (flags & GdsConsts.Flag.ERR) {
            const code = payload.length >= 4
                ? (((payload[0] << 24) | (payload[1] << 16)
                    | (payload[2] << 8) | payload[3]) >>> 0)
                : (payload[0] ?? 0);
            const width = payload.length >= 4 ? 8 : 2;
            const hex = code.toString(16).padStart(width, '0');
            this.flashStatus(`host rejected request (0x${hex})`, 'error', 3000);
            debug.warn(`negative response from host: 0x${hex}`);
            return;
        }

        // Startup-confirmation / termination records: miscFlags1 byte
        // (offset 4 of the GDS header) carries 0x40 = termination,
        // 0x80 = startup confirmation, 0x90 = startup + diagnostics.
        // The payload is an SNA session announcement (system + device
        // name), NOT a 5250 command sequence. Trying to dispatch it
        // through #process() would crash on the first non-ESC byte.
        if (miscFlags1 === 0x80 || miscFlags1 === 0x90 || miscFlags1 === 0x40) {
            if (miscFlags1 === 0x40) {
                this.disconnectContext = 'session terminated by host';
                this.setStatus('session terminated by host', 'disconnected');
                this.oia.setSystem('END');
                return;
            }
            const startup = decodeStartupRecord(payload, this.screen.ebcdic);
            this.telnet?.env.clearSensitive();
            if (!startup) {
                debug.warn('malformed RFC 4777 startup response');
                this.disconnectContext = 'unrecognised startup response';
                this.setStatus('connected · unrecognised startup response', 'error');
                return;
            }
            this.oia.setSystem(startup.system || 'SYS');
            if (startup.device) this.oia.setModel(startup.device);
            const target = [startup.system, startup.device].filter(Boolean).join('/');
            const startupStatus = `${startup.success ? 'connected' : 'startup error'} · ${startup.code}`
                + (target ? ` · ${target}` : '')
                + ` · ${startup.message}`;
            this.disconnectContext = startup.success
                ? ''
                : `${startup.code}${target ? ` · ${target}` : ''} · ${startup.message}`;
            this.setStatus(startupStatus,
                startup.success ? 'connected' : 'error');
            return;
        }

        // Opcode-specific dispatch. PUT_GET / INVITE / OUTPUT_ONLY all
        // carry zero-or-more command bytes in the payload; the rest are
        // control opcodes with no body.
        switch (opcode) {
            case GdsConsts.Op.INVITE_OPERATION:
            case GdsConsts.Op.PUT_GET_OPERATION:
                // Both opcodes are an implicit "invite for input" once
                // the embedded WTD finishes drawing - the host expects
                // us to unlock and wait for an AID-bearing reply. This
                // matches the IBM 5250 invite-for-input semantics.
                this.parser.readType = (flags1 & 0x10) === 0
                    ? GdsConsts.Op.READ_IMMEDIATE
                    : (flags1 & 0x08) !== 0
                        ? GdsConsts.Op.READ_MDT_IMMEDIATE_ALT
                        : GdsConsts.Op.READ_MDT_FIELDS;
                if (!this.#processPayload(payload)) return;
                if (!this.parser.readImmediateRequested
                    && !this.parser.readScreenRequested
                    && !this.parser.queryRequested
                    && !this.parser.queryStationStateRequested
                    && !this.parser.saveScreenRequested) {
                    this.parser.readPending = true;
                    this.parser.invited     = true;
                }
                if (this.parser.readPending) this.pendingResponseOpcode = opcode;
                break;
            case GdsConsts.Op.OUTPUT_ONLY:
                // Output-only records may carry a transport prefix before
                // the first command escape. The command stream starts at
                // the first ESC, not necessarily at payload offset zero.
                {
                    const commandStart = payload.indexOf(Order.ESC);
                    if (commandStart < 0
                        || !this.#processPayload(payload.subarray(commandStart))) return;
                }
                if (this.parser.readPending) this.pendingResponseOpcode = opcode;
                break;
            case GdsConsts.Op.SAVE_SCREEN:
                if (this.#isScreenControlPayload(payload, 0x02, true)) {
                    const token = this.parser.saveScreen();
                    this.#sendResponse(GdsConsts.Op.SAVE_SCREEN,
                        this.builder.buildSaveScreenResponse(token));
                    return;
                }
                // This opcode may also carry an ordinary command stream.
                // Only an ESC + Save Screen prefix selects the direct
                // screen-image exchange above.
                if (!payload.length || !this.#processPayload(payload)) return;
                break;
            case GdsConsts.Op.RESTORE_SCREEN:
                {
                    const commandStart = payload.indexOf(Order.ESC);
                    const commandPayload = commandStart < 0
                        ? null
                        : payload.subarray(commandStart);
                    if (!commandPayload
                        || !this.#isScreenControlPayload(commandPayload, 0x12, true)) {
                        this.#sendNegativeResponse(NegResp.REQUEST_ERROR);
                        return;
                    }
                    const rows = this.screen.rows;
                    const cols = this.screen.cols;
                    const token = commandPayload.subarray(2);
                    if (!this.parser.restoreScreen(token.length ? token : null)) {
                        this.#sendNegativeResponse(NegResp.STATE_ERROR);
                        return;
                    }
                    if (rows !== this.screen.rows || cols !== this.screen.cols)
                        this.renderer.resize();
                }
                this.oia.setSystem('SYS');
                this.draw();
                return;
            case GdsConsts.Op.READ_IMMEDIATE:
                // Immediate-read opcode 0x06 returns all input fields
                // only when at least one field has MDT set.
                this.#sendResponse(opcode,
                    this.builder.buildReadResponse({
                        includeAll: this.screen.fields.some(field => field.modified)
                            || this.screen.enptui.all.some(construct => construct.modified),
                        aid: 0x00,
                        sequential: true,
                    }));
                if (!payload.length) return;
                if (!this.#processPayload(payload)) return;
                // The opcode-level read was already answered above. An
                // embedded Read Immediate command is correlation metadata,
                // not a request for a second record.
                this.parser.readImmediateRequested = false;
                break;
            case GdsConsts.Op.READ_MDT_IMMEDIATE_ALT:
                this.#sendResponse(opcode,
                    this.builder.buildReadResponse({ aid: 0x00, preserveNulls: true }));
                if (!payload.length) return;
                if (!this.#processPayload(payload)) return;
                this.parser.readImmediateRequested = false;
                break;
            case GdsConsts.Op.READ_MDT_FIELDS:
                this.parser.readType = GdsConsts.Op.READ_MDT_FIELDS;
                this.parser.readPending = true;
                this.parser.invited = true;
                this.pendingResponseOpcode = opcode;
                if (!payload.length) break;
                if (!this.#processPayload(payload)) return;
                break;
            case GdsConsts.Op.READ_SCREEN:
            case GdsConsts.Op.READ_SCREEN_WITH_EA:
            case GdsConsts.Op.READ_SCREEN_TO_PRINT:
            case GdsConsts.Op.READ_SCREEN_TO_PRINT_WITH_EA:
            case GdsConsts.Op.READ_SCREEN_TO_PRINT_WITH_GRID:
            case GdsConsts.Op.READ_SCREEN_TO_PRINT_WITH_GRID_EA:
                // Empty read-screen opcodes carry no command and therefore
                // require no reply. With an embedded command, defer its
                // requested response to the common post-dispatch path.
                if (!payload.length) return;
                if (!this.#processPayload(payload)) return;
                break;
            case GdsConsts.Op.CANCEL_INVITE:
                this.parser.invited = false;
                this.parser.readPending = false;
                this.#sendOpcode(GdsConsts.Op.CANCEL_INVITE, this.builder.buildCancelInvite());
                return;
            case GdsConsts.Op.MESSAGE_LIGHT_ON:
                this.screen.messageLight = true;
                this.oia.setMessageLight(true);
                break;
            case GdsConsts.Op.MESSAGE_LIGHT_OFF:
                this.screen.messageLight = false;
                this.oia.setMessageLight(false);
                break;
            case GdsConsts.Op.NO_OPERATION:
                break;
            default:
                this.#sendNegativeResponse(NegResp.COMMAND_NOT_VALID);
                return;
        }

        if (this.parser.saveScreenRequested) {
            const request = this.parser.saveScreenRequested;
            this.parser.saveScreenRequested = null;
            this.#sendResponse(opcode, this.builder.buildSaveScreenResponse(
                request.token, { partial: request.partial }));
        }

        // Query → answer with our capability descriptor.
        if (this.parser.queryRequested) {
            this.parser.queryRequested = false;
            // A query reply is correlated to the request by retaining its
            // opcode and setting the workstation response flag.
            this.#sendResponse(opcode,
                this.builder.buildQueryResponse({
                    modelKey: this.modelKey,
                    enhanced: this.modelKey === '5292-2',
                }));
        }

        if (this.parser.queryStationStateRequested) {
            const request = this.parser.queryStationStateRequested;
            this.parser.queryStationStateRequested = null;
            this.#sendResponse(opcode,
                this.builder.buildQueryStationStateResponse(request));
        }

        // Read Screen Immediate / To Print → dump the screen back.
        if (this.parser.readScreenRequested) {
            const readCommand = this.parser.readScreenRequested;
            this.parser.readScreenRequested = false;
            const withGrid = readCommand === Cmd.READ_SCREEN_TO_PRINT_WITH_GRID
                || readCommand === Cmd.READ_SCREEN_TO_PRINT_WITH_GRID_EA;
            const withEa = readCommand === Cmd.READ_SCREEN_WITH_EA
                || readCommand === Cmd.READ_SCREEN_TO_PRINT_WITH_EA
                || readCommand === Cmd.READ_SCREEN_TO_PRINT_WITH_GRID_EA;
            this.#sendResponse(opcode, withGrid
                ? this.builder.buildReadScreenWithGridLines({ extended: withEa })
                : withEa
                    ? this.builder.buildReadScreenWithExtendedAttributes()
                    : this.builder.buildReadScreenResponse());
        }

        if (this.parser.readImmediateRequested) {
            this.parser.readImmediateRequested = false;
            const includeAll = this.parser.readType === Cmd.READ_IMMEDIATE
                && (this.screen.fields.some(field => field.modified)
                    || this.screen.enptui.all.some(construct => construct.modified));
            this.#sendResponse(opcode,
                this.builder.buildReadResponse({
                    aid: 0x00,
                    includeAll,
                    preserveNulls: this.parser.readType === Cmd.READ_MDT_IMMEDIATE_ALT,
                    sequential: this.parser.readType === Cmd.READ_IMMEDIATE,
                }));
        }

        if (this.screen.pendingCursor >= 0) {
            this.screen.cursor = this.screen.pendingCursor;
            this.screen.pendingCursor = -1;
        }
        if (!this.screen.keyboardLocked && this.screen.queuedPointerAid) {
            const queuedAid = this.screen.queuedPointerAid;
            this.screen.queuedPointerAid = null;
            this.sendAid(queuedAid);
            return;
        }
        debug.log(`after record: fields=${this.screen.fields.length} cursor=${this.screen.cursor} readPending=${this.parser.readPending}`);
        this.draw();
    }

    #processPayload (payload) {
        try {
            this.parser.process(payload);
            return true;
        } catch (err) {
            debug.warn('parser error:', err);
            this.parser.clearTransientRequests();
            if (err?.negativeResponse)
                this.#sendNegativeResponse(err.senseCode
                    ?? (err.stateError ? NegResp.STATE_ERROR : NegResp.REQUEST_ERROR));
            return false;
        }
    }

    #isScreenControlPayload (payload, command, allowImage = false) {
        if (payload.length < 2 || payload[0] !== 0x04 || payload[1] !== command)
            return false;
        return allowImage || payload.length === 2;
    }

    #sendNegativeResponse (code) {
        const sense = Number(code) >>> 0;
        this.#sendOpcode(GdsConsts.Op.NO_OPERATION, Uint8Array.of(
            (sense >>> 24) & 0xFF,
            (sense >>> 16) & 0xFF,
            (sense >>> 8) & 0xFF,
            sense & 0xFF,
        ), GdsConsts.Flag.ERR);
    }

    // ---- outbound ------------------------------------------------------

    #sendOpcode (opcode, payload, flags = 0) {
        if (!this.telnet) return;
        this.#logRecord('OUT', opcode, flags, payload);
        const framed = Gds.wrap(payload, opcode, flags);
        this.telnet.sendRecord(framed);
    }

    #sendResponse (opcode, payload, flags = 0) {
        this.#sendOpcode(opcode, payload, flags | GdsConsts.Flag.RESPONSE);
    }

    sendAid (aidByte) {
        if (!this.telnet) return;
        if (this.screen.sysreqMode) {
            if (aidByte === Aid.ENTER) {
                const request = this.screen.systemRequestData();
                this.#sendOpcode(GdsConsts.Op.NO_OPERATION, request, GdsConsts.Flag.SRQ);
                this.screen.endSystemRequest();
                this.oia.setSystem('SYS');
                this.flashStatus('system request sent');
            } else {
                this.screen.endSystemRequest();
                this.screen.alarm = true;
                this.oia.setSystem('SYS');
                this.flashStatus('invalid key during system request', 'error', 1600);
            }
            this.draw();
            return;
        }
        if (aidByte === Aid.HELP && this.screen.errorMode) {
            const errorCode = this.parser.errorCode ?? Uint8Array.of(0, 0);
            this.parser.clearErrorMode();
            this.screen.errorHelpResumeLocked = this.screen.keyboardLocked;
            this.screen.errorHelpMode = true;
            this.#sendOpcode(GdsConsts.Op.NO_OPERATION, errorCode, GdsConsts.Flag.HLP);
            this.screen.keyboardLocked = true;
            this.draw();
            return;
        }
        if (this.screen.keyboardLocked && aidByte !== Aid.HELP) {
            this.screen.alarm = true;
            this.flashStatus('keyboard locked by host', 'error', 1200);
            this.draw();
            return;
        }
        const pf = pfNumberFor(aidByte);
        // Help and Clear bypass field-entry validation. Print and Roll
        // are short-read/navigation AIDs on the wire, but they still run
        // mandatory/FER/self-check validation before leaving the terminal.
        const shortAid = aidByte === Aid.HELP || aidByte === Aid.CLEAR
            || aidByte === Aid.HOME || aidByte === 0x3D;
        const validation = shortAid ? null : this.screen.validateForAid({
            skipMandatoryEntry: pf !== null && this.screen.isSohShortReadPf(pf),
        });
        if (validation) {
            this.screen.cursor = (validation.field.start + 1) % this.screen.size;
            this.screen.alarm = true;
            this.flashStatus(`field requires ${validation.reason}`, 'error', 2000);
            this.draw();
            return;
        }
        debug.log(`sendAid 0x${aidByte.toString(16).padStart(2,'0')} at row=${(this.screen.cursor/this.screen.cols|0)+1} col=${(this.screen.cursor%this.screen.cols)+1}`);
        if (aidByte === Aid.HELP) {
            this.#sendResponse(this.pendingResponseOpcode,
                this.builder.buildAidResponse(aidByte));
            this.screen.keyboardLocked = true;
            this.draw();
            return;
        }
        const readType = this.parser.readType;
        const masterMdt = this.screen.fields.some(field => field.modified)
            || this.screen.enptui.all.some(construct => construct.modified);
        const sequential = readType === GdsConsts.Op.READ_IMMEDIATE
            || readType === Cmd.READ_INPUT_FIELDS || readType === Cmd.READ_IMMEDIATE;
        this.#sendResponse(this.pendingResponseOpcode,
                           this.builder.buildAidResponse(aidByte, {
                             includeAll: sequential && masterMdt,
                             sequential,
                             preserveNulls: readType === GdsConsts.Op.READ_MDT_IMMEDIATE_ALT
                                 || readType === Cmd.READ_MDT_IMMEDIATE_ALT,
                             shortRead: pf !== null && this.screen.isSohShortReadPf(pf),
                         }));
        this.screen.keyboardLocked = true;
        this.parser.readPending = false;
        this.parser.invited = false;
        this.draw();
    }

    clearErrorMode () {
        this.screen.alarm = false;
        this.parser.clearErrorMode();
        this.flashStatus('reset');
        this.draw();
    }

    resetOperatorState () {
        const wasSystemRequest = this.screen.sysreqMode;
        this.input.resetTransientState();
        this.screen.resetOperatorState();
        this.parser.clearErrorMode();
        if (wasSystemRequest) this.oia.setSystem('SYS');
        this.flashStatus('reset');
        this.draw();
    }

    sendAttention () {
        if (!this.telnet) return;
        this.#sendOpcode(GdsConsts.Op.NO_OPERATION, new Uint8Array(0), GdsConsts.Flag.ATN);
    }

    sendSystemRequest () {
        if (!this.telnet) return;
        if (!this.screen.beginSystemRequest()) return;
        this.oia.setSystem('SRQ');
        this.flashStatus('enter system request');
        this.draw();
    }

    type (str) {
        if (this.screen.keyboardLocked) return;
        for (let i = 0; i < str.length; i++) {
            this.screen.typeCharacter(str[i]);
            // Auto Enter is raised at the exact character that fills the
            // field. A paste may contain more text, but none of it belongs
            // to the next host transaction or field.
            if (this.screen.autoEnterRequested) break;
        }
        if (this.screen.autoEnterRequested) {
            this.screen.autoEnterRequested = false;
            this.sendAid(Aid.ENTER);
            return;
        }
        this.draw();
    }

    fieldExit () {
        if (!this.screen.fieldExit()) {
            this.draw();
            return;
        }
        if (this.screen.autoEnterRequested) {
            this.screen.autoEnterRequested = false;
            this.sendAid(Aid.ENTER);
            return;
        }
        this.draw();
    }

    fieldSignExit (negative) {
        if (!this.screen.fieldSignExit(negative)) {
            this.draw();
            return;
        }
        if (this.screen.autoEnterRequested) {
            this.screen.autoEnterRequested = false;
            this.sendAid(Aid.ENTER);
            return;
        }
        this.draw();
    }

    insertDup () {
        this.screen.insertDupOrFieldMark(true);
        if (this.screen.autoEnterRequested) {
            this.screen.autoEnterRequested = false;
            this.sendAid(Aid.ENTER);
            return;
        }
        this.draw();
    }

    insertFieldMark () {
        this.screen.insertDupOrFieldMark(false);
        if (this.screen.autoEnterRequested) {
            this.screen.autoEnterRequested = false;
            this.sendAid(Aid.ENTER);
            return;
        }
        this.draw();
    }

    // ---- housekeeping --------------------------------------------------

    draw () {
        this.renderer.draw();
        this.oia.setLocked(this.screen.keyboardLocked);
        this.oia.setInsert(this.screen.insertMode);
        this.oia.setMessageLight(this.screen.messageLight);
        const r = ((this.screen.cursor / this.screen.cols) | 0) + 1;
        const c =  (this.screen.cursor % this.screen.cols) + 1;
        this.oia.setCursor(r, c);
        if (this.screen.alarm) { this.oia.flashAlarm(); this.screen.alarm = false; }
    }

    setStatus (text, cls) {
        this.statusRevision++;
        this.statusEl.textContent = text;
        this.statusEl.className = cls;
    }
    flashStatus (text, cls = 'connected', ms = 1500) {
        const prev = this.statusEl.textContent;
        const prevCls = this.statusEl.className;
        this.setStatus(text, cls);
        const revision = this.statusRevision;
        setTimeout(() => {
            if (this.statusRevision === revision) this.setStatus(prev, prevCls);
        }, ms);
    }
}
