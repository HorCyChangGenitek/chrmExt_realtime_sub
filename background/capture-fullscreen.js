// tabCapture confines DOM fullscreen to the tab. Promote only the captured
// tab's fullscreen requests, and remember ownership across worker suspension.
export function createCaptureFullscreen(api, getCapturedTabId) {
    const key = "captureFullscreenWindow";
    let queue = Promise.resolve();
    function enqueue(task) {
        queue = queue.then(task).catch((error) => {
            console.warn("Fullscreen synchronization failed:", error);
        });
        return queue;
    }
    async function restore() {
        const saved = (await api.storage.session.get(key))[key];
        if (!saved) return;
        await api.storage.session.remove(key);
        const win = await api.windows.get(saved.windowId).catch(() => null);
        if (win?.state === "fullscreen") {
            await api.windows.update(saved.windowId, { state: saved.state });
            if (saved.state === "normal") {
                await api.windows.update(saved.windowId, saved.bounds);
            }
        }
    }
    return {
        change(tab, fullscreen) {
            return enqueue(async () => {
                if (!tab || tab.id !== getCapturedTabId()) return;
                if (!fullscreen) {
                    await restore();
                    return;
                }
                if (!tab.active) return;
                const saved = (await api.storage.session.get(key))[key];
                if (saved?.windowId === tab.windowId) return;
                if (saved) await restore();
                const win = await api.windows.get(tab.windowId);
                if (win.state === "fullscreen" || win.state === "minimized") return;
                await api.storage.session.set({ [key]: {
                    windowId: tab.windowId,
                    state: win.state || "normal",
                    bounds: { left: win.left, top: win.top, width: win.width, height: win.height }
                } });
                await api.windows.update(tab.windowId, { state: "fullscreen" });
            });
        },
        stop() { return enqueue(restore); }
    };
}
