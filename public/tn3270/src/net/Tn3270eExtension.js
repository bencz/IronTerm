// TN3270 / TN3270E-specific telnet behaviour, plugged into the shared
// TelnetCore. Owns:
//
//   • The TN3270E sub-option byte (0x28) and its SB DEVICE-TYPE /
//     FUNCTIONS dance (RFC 2355 §3.2).
//   • The 5-byte data-stream header that wraps every record once
//     TN3270E is active (data-type, request-flag, response-flag, seq).
//   • The positive / negative response records that the host expects
//     after it asks for one (RFC 2355 §5.4).
//
// All raw byte I/O still goes through TelnetCore; this class just maps
// host protocol semantics to its hooks.

import { Telnet } from '../../../shared/src/proto/TelnetConstants.js';
import { asciiDecode } from '../../../shared/src/net/TelnetCore.js';
import { TelnetOption, Tn3270e, TnHeader } from '../proto/Constants.js';

export class Tn3270eExtension {
    constructor () {
        this.core = null;

        // Sub-option byte advertised by the host as DO 0x28.
        this.OPTION = TelnetOption.TN3270E;

        // Per-record outbound sequence number (RFC 2355 §10.4: first zero,
        // range 0..32767, then restart at zero).
        this.outboundSeq = 0;

        // Negotiated state mirrored into core.state so listeners only
        // need to look in one place.
        this.tn3270e    = false;
        this.deviceType = '';
        this.functions  = [];
        this.optionAgreed = false;
        this.deviceNegotiated = false;
        this.supportedFunctions = Object.freeze([Tn3270e.FN_RESPONSES]);
    }

    attach (core) {
        this.core = core;
        core.state.tn3270e    = false;
        core.state.deviceType = '';
        core.state.functions  = [];
    }

    isKnownOption (opt) {
        return opt === this.OPTION;
    }

    onOptionEnabled (opt, direction) {
        if (opt === this.OPTION && direction === 'local') {
            this.optionAgreed = true;
            this.core.setImpliedBidirectionalOption(TelnetOption.BINARY, true);
            this.core.setImpliedBidirectionalOption(TelnetOption.EOR, true);
            this.core.setState({ tn3270e: false, tn3270eNegotiating: true });
        }
    }
    onOptionDisabled (opt, direction) {
        if (opt === this.OPTION) {
            if (direction === 'local') this.optionAgreed = false;
            if (direction === 'local') {
                this.core.setImpliedBidirectionalOption(TelnetOption.BINARY, false);
                this.core.setImpliedBidirectionalOption(TelnetOption.EOR, false);
            }
            this.tn3270e = false;
            this.deviceNegotiated = false;
            this.functions = [];
            this.core.setState({ tn3270e: false, tn3270eNegotiating: false,
                                 deviceType: '', functions: [] });
        }
    }

    /** Returns the bytes to prepend onto an outbound record. While
     *  TN3270E is off (plain TN3270) we add nothing - same record goes
     *  out as a bare datastream. */
    wrapOutbound (record) {
        if (!this.tn3270e) return record;

        const seq = this.outboundSeq;
        this.outboundSeq = (this.outboundSeq + 1) & 0x7FFF;
        const out = new Uint8Array(TnHeader.LENGTH + record.length);
        out[0] = TnHeader.TYPE_3270_DATA;
        out[1] = 0x00;                        // request-flag
        out[2] = 0x00;                        // response-flag (NO_RESPONSE)
        out[3] = (seq >> 8) & 0xFF;
        out[4] =  seq       & 0xFF;
        out.set(record, TnHeader.LENGTH);
        return out;
    }

    /** Strip the 5-byte header (if any) and attach per-record metadata.
     *  Returns null to drop records the upper layer can't render
     *  (BIND-IMAGE / UNBIND / NVT / SSCP-LU reach us once BIND-IMAGE is
     *  in the FUNCTIONS list; we don't implement SNA bind state). */
    unwrapInbound (bytes) {
        if (!this.tn3270e) {
            // Plain TN3270 (no header) - feed everything to the 3270 layer.
            return { payload: bytes, meta: { dataType: TnHeader.TYPE_3270_DATA, seq: 0, responseFlag: 0 } };
        }

        if (bytes.length < TnHeader.LENGTH) return null;
        const dataType     = bytes[0];
        const requestFlag  = bytes[1];   void requestFlag;
        const responseFlag = bytes[2];
        const seq          = (bytes[3] << 8) | bytes[4];
        const payload      = bytes.subarray(TnHeader.LENGTH);

        if (dataType !== TnHeader.TYPE_3270_DATA) return null;
        return { payload, meta: { dataType, seq, responseFlag } };
    }

    // ---- subnegotiation -----------------------------------------------

    handleSubnegotiation (opt, data) {
        if (opt !== this.OPTION) return;

        const op    = data[1];
        const subOp = data[2];

        // Host: SEND DEVICE-TYPE → respond with DEVICE-TYPE REQUEST <type>.
        if (op === Tn3270e.SEND && subOp === Tn3270e.DEVICE_TYPE) {
            const name = new TextEncoder().encode(this.core.terminalType);
            const out = new Uint8Array(5 + name.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TN3270E;
            out[p++] = Tn3270e.DEVICE_TYPE;
            out[p++] = Tn3270e.REQUEST;
            out.set(name, p); p += name.length;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.core.send(out);
            return;
        }

        // Host: DEVICE-TYPE IS <name> [0x01 <luname>]
        if (op === Tn3270e.DEVICE_TYPE && subOp === Tn3270e.IS) {
            let sep = -1;
            for (let i = 3; i < data.length; i++)
                if (data[i] === 0x01) { sep = i; break; }
            const end = sep === -1 ? data.length : sep;
            this.deviceType = asciiDecode(data.slice(3, end));
            this.deviceNegotiated = true;
            this.core.setState({ deviceType: this.deviceType });

            // Advertise only functions implemented end-to-end. Claiming
            // BIND-IMAGE or SYSREQ obligates us to implement additional
            // data-types and state transitions, so those remain off.
            const fns = this.supportedFunctions;
            const out = new Uint8Array(5 + fns.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TN3270E;
            out[p++] = Tn3270e.FUNCTIONS;
            out[p++] = Tn3270e.REQUEST;
            for (const f of fns) out[p++] = f;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.core.send(out);
            return;
        }

        // Host: FUNCTIONS REQUEST <list> - host counter-proposed; accept
        // its list verbatim by echoing as IS.
        if (op === Tn3270e.FUNCTIONS && subOp === Tn3270e.REQUEST) {
            const requested = Array.from(data.slice(3));
            const accepted = requested.filter(fn => this.supportedFunctions.includes(fn));
            const exact = accepted.length === requested.length;
            const out = new Uint8Array(5 + accepted.length + 2);
            let p = 0;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SB;
            out[p++] = TelnetOption.TN3270E;
            out[p++] = Tn3270e.FUNCTIONS;
            out[p++] = exact ? Tn3270e.IS : Tn3270e.REQUEST;
            for (const fn of accepted) out[p++] = fn;
            out[p++] = Telnet.IAC; out[p++] = Telnet.SE;
            this.core.send(out);
            if (exact) this.#activate(accepted);
            return;
        }

        // Host: FUNCTIONS IS <list> - agreement; nothing to do but record.
        if (op === Tn3270e.FUNCTIONS && subOp === Tn3270e.IS) {
            const agreed = Array.from(data.slice(3));
            if (agreed.every(fn => this.supportedFunctions.includes(fn)))
                this.#activate(agreed);
            else
                this.core.setState({ tn3270eError: 'server accepted unsupported TN3270E functions' });
            return;
        }

        if (op === Tn3270e.DEVICE_TYPE && subOp === Tn3270e.REJECT) {
            const reasonAt = data.indexOf(Tn3270e.REASON, 3);
            const reason = reasonAt >= 0 ? data[reasonAt + 1] : Tn3270e.REASON;
            this.deviceNegotiated = false;
            this.core.setState({ tn3270e: false, tn3270eNegotiating: false,
                                 tn3270eError: `device type rejected (reason ${reason ?? 'unknown'})` });
            return;
        }
    }

    #activate (functions) {
        if (!this.optionAgreed || !this.deviceNegotiated) return;
        this.functions = [...functions];
        this.tn3270e = true;
        this.outboundSeq = 0;
        this.core.setState({ tn3270e: true, tn3270eNegotiating: false,
                             functions: this.functions, tn3270eError: '' });
    }

    // ---- response records ---------------------------------------------

    /** Echo a successful record with an empty body. Caller picks the
     *  right time (after parsing succeeded) and passes the host's seq. */
    sendPositiveResponse (seq) {
        if (!this.tn3270e || !this.functions.includes(Tn3270e.FN_RESPONSES)) return;
        const out = new Uint8Array(6);
        out[0] = TnHeader.TYPE_RESPONSE;
        out[1] = 0x00;        // POSITIVE
        out[2] = 0x00;
        out[3] = (seq >> 8) & 0xFF;
        out[4] =  seq       & 0xFF;
        out[5] = 0x00;        // successful completion / Device End
        this.core.sendFramedRecord(out);
    }

    /** Reject a record we couldn't process. `senseCode` is one byte -
     *  RFC 2355 §5.4 leaves the values implementation-defined; common
     *  values used by other implementations:
     *    0x10  function not supported / generic input error
     *    0x08  operation check / sequence error
     *  Hosts care more about *whether* a negative response arrives than
     *  the status byte itself; our default is 0x02 (operation check). */
    sendNegativeResponse (seq, senseCode = 0x02) {
        if (!this.tn3270e || !this.functions.includes(Tn3270e.FN_RESPONSES)) return;
        const out = new Uint8Array(6);
        out[0] = TnHeader.TYPE_RESPONSE;
        out[1] = 0x00;
        out[2] = 0x01;        // NEGATIVE
        out[3] = (seq >> 8) & 0xFF;
        out[4] =  seq       & 0xFF;
        out[5] = (senseCode >= 0 && senseCode <= 3) ? senseCode : 0x02;
        this.core.sendFramedRecord(out);
    }
}
