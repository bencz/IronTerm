// Bootstrap for the TN5250 page: wires toolbar controls to the Terminal
// orchestrator, builds the WebSocket URL, and persists profiles in
// localStorage under a 5250-specific key.

import { Terminal } from './Terminal.js';
import { Profiles } from '../../shared/src/ui/Profiles.js';
import { aidFromName, Models } from './proto/Constants.js';
import { buildWebSocketUrl } from '../../shared/src/net/WebSocketUrl.js';

function main () {
    const $ = (id) => document.getElementById(id);

    const canvas      = $('terminal');
    const statusEl    = $('status');
    const portEl      = $('port');
    const bridgeEl    = $('bridge');
    const modelEl     = $('model');
    const codePageEl  = $('codePage');
    const devnameEl   = $('devname');
    const userEl      = $('user');
    const passwordEl  = $('password');
    const connectBtn  = $('connect');
    const disconnectBtn = $('disconnect');

    const oiaEls = {
        conn:   $('oiaConn'),
        sys:    $('oiaSys'),
        lock:   $('oiaLock'),
        insert: $('oiaInsert'),
        alarm:  $('oiaAlarm'),
        msg:    $('oiaMsg'),
        model:  $('oiaModel'),
        cursor: $('oiaCursor'),
    };
    const nvtEl = $('nvt');

    const updateButtons = (state) => {
        connectBtn.disabled = state === 'connecting' || state === 'connected';
        disconnectBtn.disabled = state === 'disconnected' || state === 'error';
    };
    const terminal = new Terminal({ canvas, statusEl, oiaEls, nvtEl,
        codePage: codePageEl.value, modelKey: modelEl.value,
        onConnectionState: updateButtons });
    window.terminal = terminal;

    new Profiles(
        { select: $('profiles'), saveBtn: $('profileSave'), deleteBtn: $('profileDelete') },
        { bridge: bridgeEl, port: portEl, model: modelEl, codePage: codePageEl,
          devname: devnameEl, user: userEl },
        { storageKey: 'ironterm.tn5250.profiles' },
    );

    modelEl.addEventListener('change', () => {
        terminal.setModel(modelEl.value);
    });
    codePageEl.addEventListener('change', () => {
        terminal.setCodePage(codePageEl.value);
    });

    connectBtn.addEventListener('click', () => {
        const hasPassword = passwordEl.value.length > 0;
        if (hasPassword && !userEl.value.trim()) {
            terminal.setStatus('error: USER is required with a bypass password', 'error');
            return;
        }
        let url;
        try {
            url = buildWebSocketUrl(bridgeEl.value, portEl.value, {
                hasSensitiveCredentials: hasPassword,
            });
        } catch (err) {
            terminal.setStatus(`error: ${err.message}`, 'error');
            return;
        }
        terminal.setModel(modelEl.value);
        // Build the env-options payload for NEW-ENVIRON.
        const envOptions = {
            kbdType:  'USB',
            codePage: codePageEl.value.replace(/^CP/, ''),
            charset:  '697',
        };
        // An empty DEVNAME asks the host to allocate an available device.
        // Inventing a fixed name here makes concurrent sessions collide and
        // can select an existing device that is not varied on.
        if (devnameEl.value.trim())
            envOptions.devName = devnameEl.value.trim().toUpperCase();
        if (userEl.value.trim())     envOptions.user     = userEl.value.trim().toUpperCase();
        if (hasPassword)             envOptions.password = passwordEl.value;
        terminal.setEnvOptions(envOptions);

        terminal.connect({ url });
        passwordEl.value = '';
    });

    disconnectBtn.addEventListener('click', async () => {
        await terminal.disconnect();
    });

    document.querySelectorAll('.aid-bar button[data-aid]').forEach(btn => {
        btn.addEventListener('click', () => {
            const code = aidFromName(btn.dataset.aid);
            if (code !== null) terminal.sendAid(code);
        });
    });
    $('attnBtn')?.addEventListener('click', () => terminal.sendAttention());
    $('sysreqBtn')?.addEventListener('click', () => terminal.sendSystemRequest());

    // Populate model select from the Models table so we stay in sync.
    void Models;
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', main);
else
    main();
