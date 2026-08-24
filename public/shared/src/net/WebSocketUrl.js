// Validation and normalisation for user-supplied websockify endpoints.
// Keeping this outside both page bootstraps guarantees identical security
// rules for TN3270 and TN5250.

export function buildWebSocketUrl (raw, port, options = {}) {
    const source = String(raw ?? '').trim();
    if (!source) throw new TypeError('bridge URL is required');

    let text = source;
    if (source.includes('{port}')) {
        const number = Number(port);
        if (!Number.isInteger(number) || number < 1 || number > 65535)
            throw new RangeError('port must be an integer from 1 to 65535');
        text = source.replaceAll('{port}', String(number));
    }

    let url;
    try { url = new URL(text); }
    catch { throw new TypeError('bridge URL is invalid'); }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
        throw new TypeError('bridge URL must use ws:// or wss://');
    if (url.username || url.password)
        throw new TypeError('credentials are not allowed in the bridge URL');
    if (url.hash)
        throw new TypeError('bridge URL cannot contain a fragment');

    const pageProtocol = options.pageProtocol ?? globalThis.location?.protocol ?? '';
    if (pageProtocol === 'https:' && url.protocol !== 'wss:')
        throw new TypeError('an HTTPS page requires a secure wss:// bridge');
    if (options.hasSensitiveCredentials && url.protocol !== 'wss:')
        throw new TypeError('bypass-signon credentials require a secure wss:// bridge');

    return url.href;
}
