// Live TN5250/ENPTUI regression runner.
//
// It is safe for regular test discovery: without credentials it reports a
// skip, while --required turns missing live configuration into a failure.

const noop = () => {};

function classList () {
    return { add: noop, remove: noop, toggle: noop, contains: () => false };
}

function element () {
    return {
        className: '', textContent: '', value: '', style: {}, classList: classList(),
        addEventListener: noop, removeEventListener: noop, appendChild: noop,
        removeChild: noop, focus: noop, click: noop, setAttribute: noop,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 480 }),
        scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
    };
}

const context = new Proxy({ measureText: () => ({ width: 8 }) }, {
    get (target, key) { return key in target ? target[key] : noop; },
    set (target, key, value) { target[key] = value; return true; },
});
const canvas = element();
canvas.width = 1280;
canvas.height = 480;
canvas.getContext = () => context;

globalThis.window = { addEventListener: noop, removeEventListener: noop };
globalThis.document = {
    activeElement: null,
    body: element(),
    addEventListener: noop,
    removeEventListener: noop,
    createElement: element,
    querySelectorAll: () => [],
};
globalThis.ResizeObserver = class { observe () {} disconnect () {} };
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);

const [{ Terminal }, { Aid }] = await Promise.all([
    import('../../public/tn5250/src/Terminal.js'),
    import('../../public/tn5250/src/proto/Constants.js'),
]);

const config = {
    url: process.env.IRONTERM_5250_URL || 'ws://localhost:6080/',
    user: process.env.IRONTERM_5250_USER,
    password: process.env.IRONTERM_5250_PASSWORD,
    library: (process.env.IRONTERM_5250_LIBRARY || 'BENCZ1').toUpperCase(),
    onlyProgram: process.env.IRONTERM_5250_PROGRAM?.toUpperCase(),
    codePage: (process.env.IRONTERM_5250_CODEPAGE || 'CP037').toUpperCase()
        .replace(/^(?!CP)/, 'CP'),
    testWebNamesGeoCode: process.env.IRONTERM_5250_WEBNAMES_GEOCODE === '1',
    timeout: Number(process.env.IRONTERM_5250_TIMEOUT || 30000),
};

if (!config.user || !config.password) {
    const message = 'Set IRONTERM_5250_USER and IRONTERM_5250_PASSWORD to run the live suite.';
    if (process.argv.includes('--required')) {
        console.error(message);
        process.exit(2);
    }
    console.log(`SKIP live TN5250 regression: ${message}`);
    process.exit(0);
}
if (!Number.isFinite(config.timeout) || config.timeout < 1000)
    throw new Error('IRONTERM_5250_TIMEOUT must be a number of milliseconds >= 1000');
if (!/^[A-Z0-9_$#@]{1,10}$/.test(config.library))
    throw new Error('IRONTERM_5250_LIBRARY is not a valid IBM i library name');

const oiaEls = Object.fromEntries(
    ['conn', 'sys', 'lock', 'insert', 'alarm', 'msg', 'model', 'cursor']
        .map(key => [key, element()]),
);
const statusEl = element();
const terminal = new Terminal({
    canvas, statusEl, oiaEls, nvtEl: element(), codePage: config.codePage,
});
terminal.captureStream = true;
terminal.setEnvOptions({
    kbdType: 'USB', codePage: config.codePage.replace(/^CP/, ''), charset: '697',
    user: config.user, password: config.password,
});

function screenText () {
    const { screen } = terminal;
    const lines = [];
    for (let row = 0; row < screen.rows; row++) {
        lines.push(screen.cells.slice(row * screen.cols, (row + 1) * screen.cols)
            .map(cell => cell.attributePlace ? ' ' : (cell.glyph || ' '))
            .join('').trimEnd());
    }
    return lines.join('\n');
}

function waitFor (predicate, description) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            const text = screenText();
            if (predicate(text)) return resolve(text);
            if (Date.now() - started > config.timeout) {
                return reject(new Error(
                    `timeout waiting for ${description}\nstatus=${statusEl.textContent}\n${text}`,
                ));
            }
            setTimeout(poll, 100);
        };
        poll();
    });
}

function compact (construct) {
    const copy = { kind: construct.kind, subType: construct.subType };
    for (const key of [
        'cursorAtStart', 'topRow', 'leftCol', 'height', 'width', 'row', 'col',
        'rowOffset', 'colOffset', 'itemCount', 'selectedIndex', 'selectionType',
        'orientation', 'total', 'position', 'pageSize', 'buttonCount', 'title',
    ]) if (construct[key] !== undefined) copy[key] = construct[key];
    if (construct.items) copy.items = construct.items.map(item => ({
        id: item.id, text: item.text, selected: item.selected, enabled: item.enabled,
        row: item.row, col: item.col,
    }));
    if (construct.itemPositions) copy.itemPositions = construct.itemPositions;
    if (construct.records) copy.records = construct.records.length;
    if (construct.definitions) copy.mouseDefinitions = construct.definitions.length;
    return copy;
}

function verifyKinds (program, expectedKinds) {
    const actual = terminal.screen.enptui.all.map(construct => construct.kind);
    for (const kind of expectedKinds) {
        const at = actual.indexOf(kind);
        if (at < 0) throw new Error(`${program}: missing ENPTUI construct ${kind}; got ${actual.join(', ') || 'none'}`);
        actual.splice(at, 1);
    }
}

function verifyGridLines () {
    const grid = terminal.screen.enptui.all.find(construct => construct.kind === 'grid');
    const edgeCount = grid?.gridBuf?.reduce((count, flags) => count + (flags !== 0 ? 1 : 0), 0) ?? 0;
    if (!grid || grid.records?.length === 0 || edgeCount === 0) {
        throw new Error(`ITGRIDR: expected populated grid lines; records=${grid?.records?.length ?? 0}, edges=${edgeCount}`);
    }
}

async function verifyBasicRoundTrip () {
    const selections = terminal.screen.enptui.all
        .filter(construct => construct.kind === 'selectionField');
    const pushButtons = terminal.screen.enptui.all
        .filter(construct => construct.kind === 'pushButtons');
    if (selections.length !== 2)
        throw new Error(`ITBASICR: expected two selection fields, got ${selections.length}`);
    if (pushButtons.length !== 1)
        throw new Error(`ITBASICR: expected one push-button field, got ${pushButtons.length}`);

    for (const item of selections[0].items) item.selected = false;
    selections[0].items[1].selected = true;
    selections[0].modified = true;

    for (let index = 0; index < selections[1].items.length; index++)
        selections[1].items[index].selected = index < 3;
    selections[1].modified = true;

    for (const item of pushButtons[0].items) item.selected = false;
    pushButtons[0].items[1].selected = true;
    pushButtons[0].modified = true;

    const before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    const text = await waitFor(value => value.includes('single=')
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'ITBASICR selection round trip');
    if (!text.includes('single=2 checks=1,1,1'))
        throw new Error(`ITBASICR: selection values were not returned by the host\n${text}`);
    return text;
}

async function verifySingleSubfileRoundTrip () {
    const selection = terminal.screen.enptui.all
        .find(construct => construct.kind === 'selectionField');
    if (!selection || selection.items.length < 2)
        throw new Error('ITSFLSR: expected a selection field with at least two items');

    for (const item of selection.items) item.selected = false;
    selection.items[1].selected = true;
    selection.modified = true;

    let before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    let text = await waitFor(value => value.includes('Item 2 selected')
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'ITSFLSR Item 2 round trip');

    before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    text = await waitFor(value => value.includes('No selection change')
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'ITSFLSR unchanged Enter');
    return text;
}

async function verifyMenuPullDown () {
    const menu = terminal.screen.enptui.all.find(construct => construct.kind === 'menuBar');
    if (!menu || menu.items.length === 0) throw new Error('ITMENUR: menu bar has no choices');
    for (const item of menu.items) item.selected = false;
    menu.items[0].selected = true;
    menu.modified = true;

    const before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    const text = await waitFor(value => value.includes('Open')
        && terminal.screen.enptui.all.some(construct => construct.kind === 'window')
        && terminal.screen.enptui.all.some(construct => construct.kind === 'selectionField')
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'ITMENUR pull-down');
    return text;
}

async function verifyNameADayCalendar () {
    const before = terminal.streamLog.length;
    terminal.sendAid(Aid.PF4);
    let text = await waitFor(value => /January|February|March|April|May|June|July|August|September|October|November|December/.test(value)
        && /S\s+M\s+T\s+W\s+T\s+F\s+S/.test(value)
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'WEBDOWR calendar window');

    const lines = text.split('\n');
    const headingRow = lines.findIndex(line => /S\s{2}M\s{2}T\s{2}W\s{2}T\s{2}F\s{2}S/.test(line));
    if (headingRow < 0) throw new Error('WEBDOWR: calendar weekday heading was not found');
    const firstColumn = lines[headingRow].search(/S\s{2}M\s{2}T\s{2}W\s{2}T\s{2}F\s{2}S/);
    const weekdayColumns = new Set(Array.from({ length: 7 }, (_, index) => firstColumn + (index * 3)));
    for (const line of lines.slice(headingRow + 1, headingRow + 7)) {
        for (const match of line.matchAll(/(?<!\d)[1-9](?!\d)/g)) {
            if (!weekdayColumns.has(match.index)) {
                throw new Error(`WEBDOWR: single-digit day is not aligned under its weekday\n${text}`);
            }
        }
    }

    terminal.sendAid(Aid.PF12);
    text = await waitFor(value => value.includes('Date (mmddyy)')
        && !terminal.screen.keyboardLocked, 'WEBDOWR close calendar window');
    return text;
}

async function verifyWebNamesSelection () {
    terminal.screen.cursor = (10 * terminal.screen.cols) + 3;
    const before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    return waitFor(value => value.includes('2800 37TH ST NW')
        && value.includes('ROCHESTER')
        && value.includes('MN')
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'WEBNAMESR subfile selection');
}

async function verifyWebNamesGeoCode () {
    const pushButtons = terminal.screen.enptui.all
        .find(construct => construct.kind === 'pushButtons');
    if (!pushButtons || pushButtons.items.length < 2)
        throw new Error('WEBNAMESR: Lat. push button was not found');
    for (const item of pushButtons.items) item.selected = false;
    pushButtons.items[1].selected = true;
    pushButtons.modified = true;

    const before = terminal.streamLog.length;
    terminal.sendAid(Aid.ENTER);
    const response = await waitFor(value => value.includes('USPS Formatted Address')
        && (/Latitude is|Trial 3 failed/.test(value))
        && !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, 'WEBNAMESR Census geocoder response');

    terminal.sendAid(Aid.ENTER);
    await waitFor(value => value.includes('WEBNAMES')
        && !value.includes('USPS Formatted Address')
        && !terminal.screen.keyboardLocked, 'WEBNAMESR close geocoder response');
    return response;
}

async function issueCommand (command, description) {
    const before = terminal.streamLog.length;
    terminal.type(command);
    terminal.sendAid(Aid.ENTER);
    await waitFor(() => !terminal.screen.keyboardLocked
        && terminal.streamLog.length > before, description);
}

async function waitForCommandEntry () {
    for (let attempt = 0; attempt < 4; attempt++) {
        const text = await waitFor(value => !terminal.screen.keyboardLocked
            && (/Selection or command|MAIN|Command/i.test(value)
                || /Press Enter to continue/i.test(value)),
        'IBM i command entry or intermediate message');
        if (/Selection or command|MAIN|Command/i.test(text)) return text;
        terminal.sendAid(Aid.ENTER);
    }
    throw new Error('IBM i command entry was not reached after intermediate messages');
}

async function runProgram ({ program, marker, kinds, aid }) {
    terminal.type(`CALL ${config.library}/${program}`);
    terminal.sendAid(Aid.ENTER);
    let text = await waitFor(value => value.includes(marker)
        && !terminal.screen.keyboardLocked, `${program} (${marker})`);

    if (program === 'ITBASICR') text = await verifyBasicRoundTrip();
    if (program === 'ITSFLSR') text = await verifySingleSubfileRoundTrip();
    if (program === 'ITMENUR') text = await verifyMenuPullDown();
    if (program === 'WEBDOWR') text = await verifyNameADayCalendar();
    if (program === 'WEBNAMESR') {
        text = await verifyWebNamesSelection();
        if (config.testWebNamesGeoCode) await verifyWebNamesGeoCode();
    }

    if (aid) {
        const before = terminal.streamLog.length;
        terminal.sendAid(aid);
        text = await waitFor(value => value.includes(marker)
            && !terminal.screen.keyboardLocked
            && terminal.streamLog.length > before, `${program} interaction`);
    }

    verifyKinds(program, kinds);
    if (program === 'ITGRIDR') verifyGridLines();
    console.log(`\n=== ${program}: PASS ===`);
    console.log(text.split('\n').filter(line => line.trim()).join('\n'));
    console.log('ENPTUI', JSON.stringify(terminal.screen.enptui.all.map(compact), null, 2));

    if (program === 'ITMENUR') {
        terminal.sendAid(Aid.PF12);
        await waitFor(() => !terminal.screen.enptui.all.some(construct => construct.kind === 'window')
            && !terminal.screen.keyboardLocked, 'ITMENUR close pull-down');
    }
    terminal.sendAid(Aid.PF3);
    await waitFor(value => !value.includes(marker)
        && !terminal.screen.keyboardLocked, `${program} exit`);
}

const programs = [
    { program: 'ITBASICR',  marker: 'ENPTUI BASIC CONTROLS', kinds: ['selectionField', 'selectionField', 'pushButtons'] },
    { program: 'ITWINDOWR', marker: 'ENPTUI WINDOW', kinds: ['window', 'pushButtons'] },
    { program: 'ITMOUSER',  marker: 'ENPTUI PROGRAMMABLE MOUSE', kinds: ['mouseEvents'] },
    { program: 'ITSFLSR',   marker: 'ENPTUI SINGLE-CHOICE SUBFILE', kinds: ['selectionField', 'scrollBar'] },
    { program: 'ITSFLMR',   marker: 'ENPTUI MULTIPLE-CHOICE SUBFILE', kinds: ['selectionField', 'scrollBar'] },
    { program: 'ITMENUR',   marker: 'ENPTUI MENU BAR', kinds: ['menuBar'] },
    { program: 'ITGRIDR',   marker: 'ENPTUI GRID', kinds: ['grid'], aid: Aid.PF6 },
    { program: 'ITCOBOLC',  marker: 'ENPTUI ILE COBOL SAMPLE', kinds: ['selectionField', 'pushButtons'] },
    { program: 'WEBDOWR',   marker: 'Date (mmddyy)', kinds: ['pushButtons'] },
    { program: 'MENUBARR',  marker: 'Menu Bar validation', kinds: ['menuBar'] },
    { program: 'WEBNAMESR', marker: 'WEBNAMES', kinds: ['grid', 'window', 'mouseEvents', 'window', 'scrollBar', 'pushButtons'] },
];

try {
    await terminal.connect({ url: config.url });
    await waitForCommandEntry();
    await issueCommand(`CHGCURLIB CURLIB(${config.library})`, 'change current library');

    const selected = config.onlyProgram
        ? programs.filter(spec => spec.program === config.onlyProgram)
        : programs;
    if (selected.length === 0)
        throw new Error(`unknown IRONTERM_5250_PROGRAM ${config.onlyProgram}`);
    for (const spec of selected) await runProgram(spec);

    await terminal.disconnect();
    console.log(`\n${selected.length} live ENPTUI regression test(s) passed.`);
    process.exit(0);
} catch (error) {
    console.error(error.stack || error);
    console.error('LAST SCREEN\n' + screenText());
    console.error(terminal.dumpStream());
    process.exit(1);
}
