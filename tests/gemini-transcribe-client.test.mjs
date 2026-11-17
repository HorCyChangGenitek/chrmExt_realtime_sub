import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

const source = await readFile(new URL("../offscreen/gemini-transcribe-client.js", import.meta.url), "utf8");
const { GeminiTranscribeClient } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function capture(config = {}) {
    const events = [];
    const client = new GeminiTranscribeClient(config, { onTranscript: event => events.push(event) });
    return {
        client,
        events,
        send(content) { client.handleServerMessage({ serverContent: content }); },
        interim(text) { this.send({ interimInputTranscription: { text, languageCode: "en" } }); },
        final(text) { this.send({ inputTranscription: { text, languageCode: "en" } }); },
        finals() { return events.filter(event => event.isFinal).map(event => event.text); }
    };
}

const letters = text => text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, "");
const noSpaces = text => text.replace(/\s/gu, "");

test("punctuation, case and spacing revisions do not replay the committed sentence", () => {
    const c = capture();
    const sentence = "Your spine is in a position of flexion.";
    const tail = "Our bodies will adapt to these positions over time";
    c.interim(`${sentence} ${tail}`);
    assert.equal(c.finals()[0], sentence);
    c.final(`YOUR  spine is in a position of flexion, ${tail}.`);
    assert.equal(letters(c.finals().join(" ")), letters(`${sentence} ${tail}`));
    assert.equal(c.client.interimText, "");
});

test("a distant Chinese period cannot bypass the character cap", () => {
    const c = capture();
    const text = "這是一段沒有空格而且持續說話的中文內容".repeat(20) + "。";
    c.final(text);
    assert.ok(c.finals().length > 1);
    assert.ok(c.finals().every(text => text.length <= 100));
    assert.equal(c.finals().join(""), text);
});

test("short final sentences are submitted separately", () => {
    const c = capture();
    const sentences = ["Stop.", "Go.", "Wait.", "Run.", "Look.", "Sit.", "Stand.", "Rest."];
    c.final(sentences.join(" "));
    assert.deepEqual(c.finals(), sentences);
});

test("short interim sentences are committed while the last four words stay editable", () => {
    const c = capture();
    c.interim("Stop. Go. Wait. Run. Look. Sit. Stand. Rest.");
    assert.deepEqual(c.finals(), ["Stop.", "Go.", "Wait.", "Run."]);
    assert.equal(c.client.interimText, "Look. Sit. Stand. Rest.");
    assert.equal(c.events.at(-1).text, c.client.interimText);
    assert.equal(c.events.at(-1).isFinal, false);
    c.send({ turnComplete: true });
    assert.deepEqual(c.finals(), ["Stop.", "Go.", "Wait.", "Run.", "Look.", "Sit.", "Stand.", "Rest."]);
});

for (const mode of ["interim", "final"]) {
    test(`${mode} long English respects both word and character caps without losing words`, () => {
        const c = capture();
        const text = Array.from({ length: 80 }, (_, i) => `longword${i}`).join(" ");
        c[mode](text);
        if (mode === "interim") {
            assert.ok(c.client.interimText.split(/\s/u).length >= 4);
            c.final(text);
        }
        assert.ok(c.finals().every(text => text.length <= 100 && text.split(/\s/u).length <= 16));
        assert.equal(c.finals().join(" "), text);
    });
}

test("growing cumulative Chinese updates and a revised final do not duplicate or lose text", () => {
    const c = capture();
    const text = "這是一段沒有空格而且持續說話的中文內容".repeat(16) + "。";
    for (let end = 30; end < text.length; end += 27) c.interim(text.slice(0, end));
    c.final(text);
    c.final(text);
    assert.equal(c.finals().join(""), text);
    assert.ok(c.finals().every(text => text.length <= 100));
});

test("word cap commits sixteen short words and retains four editable words", () => {
    const c = capture();
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`);
    c.interim(words.join(" "));
    assert.deepEqual(c.finals(), [words.slice(0, 16).join(" ")]);
    assert.equal(c.client.interimText, words.slice(16).join(" "));
    c.final(words.join(" "));
    assert.equal(c.finals().join(" "), words.join(" "));
});

test("session rotation splits the pending tail before reconnecting", async () => {
    const c = capture();
    const text = "等待提交的中文尾段".repeat(30);
    c.client.interimText = text;
    let connections = 0;
    c.client.connect = async () => { connections += 1; };
    await c.client.rotateSession();
    assert.equal(connections, 1);
    assert.equal(c.finals().join(""), text);
    assert.ok(c.finals().every(text => text.length <= 100));
    assert.equal(c.client.interimText, "");
});

test("repeated emitted phrases remain in the history used for cumulative matching", () => {
    const c = capture();
    const sentence = "This same sentence is spoken twice.";
    const text = `${sentence} ${sentence} And now we continue with fresh words`;
    c.interim(text);
    c.final(`${text}.`);
    assert.equal(letters(c.finals().join(" ")), letters(text));
    assert.deepEqual(c.finals().slice(0, 2), [sentence, sentence]);
});

test("a final that removes an uncommitted tail does not flush stale words on turn completion", () => {
    const c = capture();
    const sentence = "This is the correct complete sentence.";
    c.interim(`${sentence} these four words disappear`);
    assert.equal(c.client.interimText, "these four words disappear");
    c.send({ inputTranscription: { text: sentence }, turnComplete: true });
    assert.deepEqual(c.finals(), [sentence]);
    assert.equal(c.client.committedText, "");
});

test("simultaneous final and new interim preserve the new editable tail", () => {
    const c = capture();
    const sentence = "This is the first complete sentence.";
    c.send({ inputTranscription: { text: sentence }, interimInputTranscription: { text: `${sentence} New words keep coming` } });
    assert.deepEqual(c.finals(), [sentence]);
    assert.equal(c.client.interimText, "New words keep coming");
    c.send({ turnComplete: true });
    assert.deepEqual(c.finals(), [sentence, "New words keep coming"]);
});

test("decimal points and common abbreviations stay within their sentence", () => {
    const c = capture();
    c.final("Dr. Smith paid 3.5 dollars. Then he left.");
    assert.deepEqual(c.finals(), ["Dr. Smith paid 3.5 dollars.", "Then he left."]);
});

test("quoted sentence ends keep their closing quote", () => {
    const c = capture();
    c.final("He said “Stop.” Then he left.");
    assert.deepEqual(c.finals(), ["He said “Stop.”", "Then he left."]);
});

test("a long token split at the character cap still matches the cumulative final", () => {
    const c = capture();
    const text = "abcdefghijk".repeat(40);
    c.interim(text);
    c.final(text);
    assert.ok(c.finals().every(text => text.length <= 100));
    assert.equal(c.finals().join(""), text);
});

test("hard character splits preserve supplementary Unicode characters", () => {
    const c = capture();
    const text = "甲" + "𠮷".repeat(120) + "。";
    c.final(text);
    assert.equal(c.finals().join(""), text);
    assert.ok(c.finals().every(text => text.length <= 100 && text.isWellFormed()));
});

test("mixed Chinese and English retain all text across forced splits", () => {
    const c = capture();
    const text = "正在測試 Gemini transcription 與中文字幕的切段功能 ".repeat(12);
    c.interim(text);
    c.final(text);
    assert.equal(noSpaces(c.finals().join("")), noSpaces(text));
    assert.ok(c.finals().every(text => text.length <= 100));
});
