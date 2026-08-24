// RFC 4777 Startup Response Record carried in the extended GDS header.
// GdsHeader removes the 11-byte header used by IBM i, leaving this layout:
//   0..4 fixed response fields, 5..8 response code,
//   9..16 system name, 17..26 assigned device/object name.

const RESPONSE_MESSAGES = Object.freeze({
    I901: 'device has less function than requested',
    I902: 'session successfully started',
    I906: 'automatic sign-on unavailable; sign-on screen will follow',
    I904: 'source system is at an incompatible release',
    '8902': 'requested device is already in use',
    '8937': 'automatic sign-on rejected',
    '8940': 'automatic device configuration failed or is not allowed',
    '0001': 'system error',
    '0002': 'unknown user profile',
    '0003': 'user profile disabled',
    '0004': 'invalid password, passphrase, or token',
    '0005': 'password, passphrase, or token expired',
    '0008': 'next invalid password will revoke the user profile',
});

function textAt (payload, start, length, ebcdic) {
    return ebcdic.decode(payload.subarray(start, start + length))
        .replace(/[\0\s]+$/g, '');
}

export function decodeStartupRecord (payload, ebcdic) {
    if (!(payload instanceof Uint8Array) || payload.length < 27) return null;
    const code = textAt(payload, 5, 4, ebcdic);
    if (!/^[A-Z0-9]{4}$/.test(code)) return null;
    const system = textAt(payload, 9, 8, ebcdic);
    const device = textAt(payload, 17, 10, ebcdic);
    const success = code === 'I901' || code === 'I902' || code === 'I906';
    return {
        code,
        success,
        system,
        device,
        message: RESPONSE_MESSAGES[code] ?? (success ? 'session started' : 'startup rejected'),
        diagnostic: payload.subarray(27).slice(),
    };
}
