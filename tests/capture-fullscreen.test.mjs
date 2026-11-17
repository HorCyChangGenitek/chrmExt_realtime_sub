import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = await readFile(new URL('../background/capture-fullscreen.js', import.meta.url), 'utf8');
const { createCaptureFullscreen } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let captured = 7;
let win;
let stored;
let updates;
const api = {
    storage: { session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { Object.assign(stored, value); },
        async remove(key) { delete stored[key]; }
    } },
    windows: {
        async get() { return { ...win }; },
        async update(id, value) { updates.push(value); Object.assign(win, value); }
    }
};
const tab = { id: 7, windowId: 1, active: true };
function reset(state = 'maximized') {
    win = { state, left: 20, top: 30, width: 900, height: 700 };
    stored = {}; updates = []; captured = 7;
    return createCaptureFullscreen(api, () => captured);
}
let controller = reset();
await controller.change({ ...tab, id: 8 }, true);
await controller.change({ ...tab, active: false }, true);
assert.equal(updates.length, 0);
await controller.change(tab, true);
assert.equal(win.state, 'fullscreen');
await controller.change(tab, true);
assert.equal(updates.length, 1);
// Recreate controller to simulate service-worker suspension.
controller = createCaptureFullscreen(api, () => captured);
await controller.change(tab, false);
assert.equal(win.state, 'maximized');
controller = reset('normal');
await Promise.all([controller.change(tab, true), controller.change(tab, false)]);
assert.equal(win.state, 'normal');
assert.deepEqual(updates.at(-1), { left: 20, top: 30, width: 900, height: 700 });
controller = reset('fullscreen');
await controller.change(tab, true);
await controller.stop();
assert.equal(updates.length, 0, 'Preserve existing F11 fullscreen');
controller = reset();
await controller.change(tab, true);
captured = null;
await controller.stop();
assert.equal(win.state, 'maximized');
controller = reset();
await controller.change(tab, true);
win.state = 'normal';
await controller.stop();
assert.equal(updates.length, 1, 'Do not override a manual window change');
console.log('PASS: captured-tab isolation, enter/exit, duplicate events, worker restart, rapid transitions, bounds restoration, F11 preservation, stop cleanup, manual changes');
