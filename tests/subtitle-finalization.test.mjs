import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

const schedulerSource = await readFile(new URL("../offscreen/translation-scheduler.js", import.meta.url), "utf8");
const { TranslationScheduler } = await import(`data:text/javascript;base64,${Buffer.from(schedulerSource).toString("base64")}`);
const overlaySource = await readFile(new URL("../content/subtitle-overlay.js", import.meta.url), "utf8");

// A small DOM fixture exercises the real subtitle methods without a browser.
class Element {
    constructor() {
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.textContent = "";
        const classes = new Set();
        this.classList = {
            contains: name => classes.has(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
        };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    appendChild(child) { this.append(child); }
    replaceChildren() { this.children = []; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(child.className?.split(" ").includes(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector)
        ]);
    }
}

function createOverlay() {
    let now = 10000;
    let nextTimer = 0;
    const timers = new Map();
    const context = {
        document: { getElementById: () => null, createElement: () => new Element() },
        Date: { now: () => now },
        setTimeout(callback, delay) {
            const id = ++nextTimer;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(overlaySource, context);
    class Overlay extends context.LiveSubtitleOverlay {
        createDom() {
            this.panel = new Element();
            this.statusElement = new Element();
            this.completedElement = new Element();
            this.currentElement = new Element();
            this.currentEnglish = new Element();
            this.currentChinese = new Element();
            this.currentElement.append(this.currentEnglish, this.currentChinese);
            this.panel.append(this.completedElement, this.currentElement);
        }
        applySettings() {}
        syncTopLayer() {}
        syncHostHitArea() {}
    }
    return {
        overlay: new Overlay(),
        advance(ms) {
            const until = now + ms;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > until) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].callback();
            }
            now = until;
        }
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function setup(t) {
    const { overlay, advance } = createOverlay();
    const requests = [];
    const translating = [];
    const scheduler = new TranslationScheduler({
        debounceMs: 60000,
        gemmaClient: { translate(text) {
            const pending = deferred();
            requests.push({ text, ...pending });
            return pending.promise;
        } },
        callbacks: {
            onInterimEnglish: text => overlay.setInterimEnglish(text),
            onInterimTranslation: text => overlay.setInterimTranslation(text),
            onFinalEnglish: segment => overlay.addFinalSegment(segment),
            onFinalTranslation: segment => overlay.updateFinalTranslation(segment),
            onTranslating: value => translating.push(value)
        }
    });
    t.after(() => { scheduler.stop(); overlay.clear(); });
    return {
        overlay, advance, scheduler, requests, translating,
        translateCurrent() {
            const state = scheduler.state;
            return scheduler.translateInterim(state.latestInterimText, state.interimSequence, state.interimGeneration, {});
        },
        completed() { return overlay.completedElement.children.map(row => row.children.map(child => child.textContent)); }
    };
}

const first = { id: "a", english: "The first sentence." };
const second = { id: "b", english: "The second sentence." };
const result = text => ({ text, elapsedMs: 10 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a finalized sentence stays visible below until it can move up atomically with the buffered next sentence", async t => {
    const c = setup(t);
    c.overlay.addFinalSegment({ id: "previous", english: "Previous.", chinese: "前一句。", status: "complete" });
    c.advance(1000);
    c.scheduler.handleInterim(first.english);
    c.overlay.setInterimTranslation("第一句的即時翻譯");
    c.scheduler.handleFinal(first);
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    assert.equal(c.overlay.currentChinese.textContent, "第一句的即時翻譯");
    assert.equal(c.overlay.currentElement.style.display, "");
    c.scheduler.handleInterim(second.english);
    c.overlay.setInterimTranslation("第二句的即時翻譯");
    assert.deepEqual(c.completed(), [["Previous.", "前一句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    assert.equal(c.overlay.currentChinese.textContent, "第一句的即時翻譯");
    c.advance(500);
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    c.requests[0].resolve(result("第一句。"));
    await tick();
    assert.deepEqual(c.completed(), [[first.english, "第一句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
    assert.equal(c.overlay.currentChinese.textContent, "第二句的即時翻譯");
    assert.equal(c.overlay.currentElement.style.display, "");
    c.overlay.updateFinalTranslation({ ...first, chinese: "稍後的改寫", status: "complete" });
    assert.deepEqual(c.completed(), [[first.english, "第一句。"]]);
});

test("an exact interim translation is frozen without requesting another translation", async t => {
    const c = setup(t);
    c.scheduler.handleInterim(first.english);
    const pending = c.translateCurrent();
    c.requests[0].resolve(result("已看過的第一句。"));
    await pending;
    c.scheduler.handleFinal({ ...first, english: "The  first sentence." });
    assert.equal(c.requests.length, 1);
    assert.deepEqual(c.completed(), [[first.english, "已看過的第一句。"]]);
    assert.equal(c.translating.at(-1), false);
    c.scheduler.handleInterim(second.english);
    assert.deepEqual(c.completed(), [[first.english, "已看過的第一句。"]]);
});

test("a partial interim translation is not reused for a longer final", async t => {
    const c = setup(t);
    c.scheduler.handleInterim("The first");
    const pending = c.translateCurrent();
    c.requests[0].resolve(result("部分翻譯"));
    await pending;
    c.scheduler.handleFinal(first);
    assert.equal(c.requests[1].text, first.english);
    assert.deepEqual(c.completed(), []);
    c.requests[1].resolve(result("第一句的完整翻譯。"));
    await tick();
    assert.deepEqual(c.completed(), [[first.english, "第一句的完整翻譯。"]]);
});

test("a cached second sentence waits for the first; both get readable display time without skipping", async t => {
    const c = setup(t);
    c.scheduler.handleFinal(first);
    c.scheduler.handleInterim(second.english);
    const pending = c.translateCurrent();
    c.requests[1].resolve(result("第二句。"));
    await pending;
    c.scheduler.handleFinal(second);
    c.scheduler.handleInterim("The third sentence is growing");
    assert.deepEqual(c.completed(), []);
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    c.requests[0].resolve(result("遲到的第一句。"));
    await tick();
    assert.deepEqual(c.completed(), [[first.english, "遲到的第一句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
    assert.equal(c.overlay.currentChinese.textContent, "第二句。");
    c.advance(999);
    assert.deepEqual(c.completed(), [[first.english, "遲到的第一句。"]]);
    c.advance(1);
    assert.deepEqual(c.completed(), [[second.english, "第二句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, "The third sentence is growing");
});

test("an expired interim response cannot change the next sentence or its translation cache", async t => {
    const c = setup(t);
    c.scheduler.handleInterim(first.english);
    const pending = c.translateCurrent();
    c.scheduler.handleFinal(first);
    c.scheduler.handleInterim(second.english);
    c.requests[0].resolve(result("過期的即時翻譯"));
    await pending;
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    assert.equal(c.overlay.currentChinese.textContent, "翻譯中…");
    assert.equal(c.overlay.liveSegment.chinese, "");
    assert.equal(c.scheduler.state.lastInterimTranslation, null);
    c.requests[1].resolve(result("第一句。"));
    await tick();
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
});

test("failed or cleared pending translations do not change the completed row or resurrect cleared subtitles", async t => {
    const c = setup(t);
    c.overlay.addFinalSegment({ id: "previous", english: "Previous.", chinese: "前一句。", status: "complete" });
    c.scheduler.handleFinal(first);
    c.requests[0].reject(new Error("Translation failed"));
    await tick();
    assert.deepEqual(c.completed(), [["Previous.", "前一句。"]]);
    c.scheduler.handleFinal(second);
    c.overlay.clear();
    c.requests[1].resolve(result("清除後才回傳的翻譯"));
    await tick();
    assert.deepEqual(c.completed(), []);
    assert.equal(c.overlay.currentEnglish.textContent, "");
});

test("a sentence remains visible after finalization even when no following speech arrives", async t => {
    const c = setup(t);
    c.scheduler.handleInterim(first.english);
    c.overlay.setInterimTranslation("第一句的即時翻譯");
    c.scheduler.handleFinal(first);
    c.advance(5000);
    assert.deepEqual(c.completed(), []);
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    assert.equal(c.overlay.currentChinese.textContent, "第一句的即時翻譯");
    c.requests[0].resolve(result("第一句。"));
    await tick();
    assert.deepEqual(c.completed(), [[first.english, "第一句。"]]);
    assert.equal(c.overlay.currentElement.style.display, "none");
});

test("several finals arriving together are shown in order instead of disappearing between paints", t => {
    const c = setup(t);
    c.overlay.addFinalSegment({ ...first, status: "translating" });
    c.overlay.addFinalSegment({ ...second, chinese: "第二句。", status: "complete" });
    const third = { id: "c", english: "The third sentence.", chinese: "第三句。", status: "complete" };
    c.overlay.addFinalSegment(third);
    c.overlay.setInterimEnglish("Fourth sentence keeps growing");
    c.overlay.setInterimTranslation("第四句還在更新");
    assert.equal(c.overlay.currentEnglish.textContent, first.english);
    c.overlay.updateFinalTranslation({ ...first, chinese: "第一句。", status: "complete" });
    assert.deepEqual(c.completed(), [[first.english, "第一句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
    c.advance(1000);
    assert.deepEqual(c.completed(), [[second.english, "第二句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, third.english);
    c.advance(1000);
    assert.deepEqual(c.completed(), [[third.english, third.chinese]]);
    assert.equal(c.overlay.currentEnglish.textContent, "Fourth sentence keeps growing");
    assert.equal(c.overlay.currentChinese.textContent, "第四句還在更新");
});

test("clearing subtitles cancels a scheduled handoff", t => {
    const c = setup(t);
    c.overlay.addFinalSegment({ ...first, chinese: "第一句。", status: "complete" });
    c.overlay.addFinalSegment({ ...second, chinese: "第二句。", status: "complete" });
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
    c.overlay.clear();
    c.advance(5000);
    assert.deepEqual(c.completed(), []);
    assert.equal(c.overlay.currentEnglish.textContent, "");
    assert.equal(c.overlay.currentChinese.textContent, "");
    c.overlay.updateFinalTranslation({ ...second, chinese: "遲到的第二句。", status: "complete" });
    assert.deepEqual(c.completed(), []);
});

test("continuous buffered speech does not restart the handoff wait or lose its latest translation", t => {
    const c = setup(t);
    c.overlay.addFinalSegment({ ...first, chinese: "第一句。", status: "complete" });
    c.overlay.addFinalSegment({ ...second, chinese: "第二句。", status: "complete" });
    for (let index = 1; index <= 4; index += 1) {
        c.advance(200);
        c.overlay.setInterimEnglish(`Third sentence update ${index}`);
        c.overlay.setInterimTranslation(`第三句更新 ${index}`);
        assert.deepEqual(c.completed(), [[first.english, "第一句。"]]);
        assert.equal(c.overlay.currentEnglish.textContent, second.english);
    }
    c.advance(200);
    assert.deepEqual(c.completed(), [[second.english, "第二句。"]]);
    assert.equal(c.overlay.currentEnglish.textContent, "Third sentence update 4");
    assert.equal(c.overlay.currentChinese.textContent, "第三句更新 4");
});

test("a failed translation does not block the next sentence", async t => {
    const c = setup(t);
    c.scheduler.handleFinal(first);
    c.scheduler.handleInterim(second.english);
    c.overlay.setInterimTranslation("第二句的即時翻譯");
    c.requests[0].reject(new Error("Translation failed"));
    await tick();
    assert.equal(c.overlay.currentEnglish.textContent, second.english);
    assert.equal(c.overlay.currentChinese.textContent, "第二句的即時翻譯");
    assert.equal(c.overlay.pendingSegments.size, 0);
});
