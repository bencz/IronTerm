// Protocol-aware ENPTUI decoding failure. The 32-bit IBM sense code is
// retained for diagnostics while Terminal.js translates the failure to the
// one-byte TN5250E negative-response category carried on the wire.

export class EnptuiDataStreamError extends Error {
    constructor (message, senseCode) {
        super(message);
        this.name = 'EnptuiDataStreamError';
        this.senseCode = senseCode;
        this.negativeResponse = true;
    }
}

export function enptuiFail (message, senseCode) {
    throw new EnptuiDataStreamError(message, senseCode);
}
