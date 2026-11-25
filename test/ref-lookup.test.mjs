// Forgiving refs (D52): the spellings weak models send for a ref, and a control's name sent in place of its ref.
import assert from "node:assert/strict";
import test from "node:test";
import { cleanRef, matchByName, REF_RE } from "../src/bridge/ref-lookup.ts";

test("a ref in any spelling a model sends is the ref", () => {
	for (const s of ["e12", "@e12", "ref=e12", "[ref=e12]", "ref: e12", "E12", " e12, ", '"e12"', "#e12", "(e12)"]) assert.equal(cleanRef(s), "e12", s);
	assert.equal(cleanRef("f1a2be7"), "f1a2be7");
	assert.equal(cleanRef("[ref=f1a2be7]"), "f1a2be7");
	for (const s of ["Save", "the Email field", "e12 button", "elephant"]) {
		assert.equal(cleanRef(s), s.trim(), s);
		assert.ok(!REF_RE.test(cleanRef(s)), s);
	}
});

const page = [
	{ ref: "e1", role: "heading", name: "Save your work" },
	{ ref: "e2", role: "button", name: "Save" },
	{ ref: "e3", role: "textbox", name: "Email" },
	{ ref: "e4", role: "label", name: "Email" },
	{ ref: "e5", role: "link", name: "Help" },
	{ ref: "e6", role: "button", name: "Help" },
	{ ref: "e7", role: "button", name: "Remove" },
	{ ref: "e8", role: "button", name: "Remove" },
	{ ref: "e9", role: "checkbox", name: "Remember me" },
];
const refs = (q) => matchByName(page, q).map((n) => n.ref);

test("a name finds the one control that has it, and a control wins over text that only describes the page", () => {
	assert.deepEqual(refs("Save"), ["e2"]);
	assert.deepEqual(refs("save"), ["e2"]);
	assert.deepEqual(refs("Email"), ["e3"]);
	assert.deepEqual(refs("the Email field"), ["e3"]);
	assert.deepEqual(refs("Remember me checkbox"), ["e9"]);
	assert.deepEqual(refs("Remember"), ["e9"]);
});

test("a role word picks between controls with the same name, and two left are both returned for the refusal", () => {
	assert.deepEqual(refs("Help"), ["e5", "e6"]);
	assert.deepEqual(refs("Help link"), ["e5"]);
	assert.deepEqual(refs("Help button"), ["e6"]);
	assert.deepEqual(refs("Remove"), ["e7", "e8"]);
	assert.deepEqual(refs("Checkout"), []);
	assert.deepEqual(refs(""), []);
});

test("only an exact name is exact: a whole-word match is a guess the bridge asks about", async () => {
	const { lookUpName } = await import("../src/bridge/ref-lookup.ts");
	const acct = [
		{ ref: "e1", role: "heading", name: "Delete" },
		{ ref: "e2", role: "button", name: "Delete account" },
	];
	assert.deepEqual(lookUpName(acct, "Delete"), { hits: [acct[1]], exact: false });
	assert.equal(lookUpName(page, "Save").exact, true);
	assert.equal(lookUpName(page, "the Email field").exact, true);
	assert.equal(lookUpName(page, "Remember").exact, false);
});
