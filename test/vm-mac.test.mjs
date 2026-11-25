// The macOS VM helper's rule that a guest's disk is never lost. vm/mac/check.sh runs the helper, on a Mac.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("vm/mac: only a reset replaces a guest's disk.raw with the ready point", () => {
	const source = readFileSync(new URL("../vm/mac/Sources/local-studio-vm/Guest.swift", import.meta.url), "utf8");
	assert.deepEqual(source.split("func ").filter((f) => f.includes("cloneReplace(readyDisk")).map((f) => /^\w+/.exec(f)[0]), ["reset"]);
});
