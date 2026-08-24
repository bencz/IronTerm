// Bootstraps the page: wires the toolbar controls to the Terminal
// orchestrator, builds the WebSocket URL, hooks AID buttons, and
// loads/persists named connection profiles in localStorage.

import { Terminal } from './Terminal.js';
import { Profiles } from '../../shared/src/ui/Profiles.js';
import { aidFromName } from './proto/Constants.js';
import { buildWebSocketUrl } from '../../shared/src/net/WebSocketUrl.js';

function main () {
    const $ = (id) => document.getElementById(id);

    const canvas      = $('terminal');
    const statusEl    = $('status');
    const portEl      = $('port');
    const bridgeEl    = $('bridge');
    const modelEl     = $('model');
    const codePageEl  = $('codePage');
    const connectBtn  = $('connect');
    const disconnectBtn = $('disconnect');
    const ruleToggleBtn = $('ruleToggle');

    const oiaEls = {
        conn:   $('oiaConn'),
        sys:    $('oiaSys'),
        lock:   $('oiaLock'),
        insert: $('oiaInsert'),
        alarm:  $('oiaAlarm'),
        xfer:   $('oiaXfer'),
        model:  $('oiaModel'),
        cursor: $('oiaCursor'),
    };
    const nvtEl = $('nvt');

    const updateButtons = (state) => {
        connectBtn.disabled = state === 'connecting' || state === 'connected';
        disconnectBtn.disabled = state === 'disconnected' || state === 'error';
    };
    const terminal = new Terminal({ canvas, statusEl, oiaEls, nvtEl,
        codePage: codePageEl.value, onConnectionState: updateButtons });
    // Expose for devtools so you can poke at `terminal.indFile`,
    // `terminal.screen`, etc. when debugging a flaky session.
    window.terminal = terminal;

    new Profiles(
        { select: $('profiles'), saveBtn: $('profileSave'), deleteBtn: $('profileDelete') },
        { bridge: bridgeEl, port: portEl, model: modelEl, codePage: codePageEl },
        { storageKey: 'ironterm.tn3270.profiles' },
    );

    modelEl.addEventListener('change', () => {
        terminal.setModel(parseInt(modelEl.value, 10));
    });
    codePageEl.addEventListener('change', () => {
        terminal.setCodePage(codePageEl.value);
    });

    connectBtn.addEventListener('click', () => {
        let url;
        try {
            url = buildWebSocketUrl(bridgeEl.value, portEl.value);
        } catch (err) {
            terminal.setStatus(`error: ${err.message}`, 'error');
            return;
        }
        terminal.setModel(parseInt(modelEl.value, 10));
        terminal.connect({ url });
    });

    disconnectBtn.addEventListener('click', async () => {
        await terminal.disconnect();
    });

    ruleToggleBtn.addEventListener('click', () => {
        const on = !ruleToggleBtn.classList.contains('active');
        ruleToggleBtn.classList.toggle('active', on);
        terminal.renderer.setRuleEnabled(on);
    });

    document.getElementById('downloadBtn').addEventListener('click', () => {
        terminal.requestDownload();
    });
    document.getElementById('uploadBtn').addEventListener('click', () => {
        terminal.pickUploadFile();
    });

    document.querySelectorAll('.aid-bar button[data-aid]').forEach(btn => {
        btn.addEventListener('click', () => {
            const code = aidFromName(btn.dataset.aid);
            if (code !== null) terminal.sendAid(code);
        });
    });
}

if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', main);
else
    main();
