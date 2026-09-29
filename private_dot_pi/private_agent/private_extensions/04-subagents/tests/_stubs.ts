/**
 * Shared package-stub writer for subagent tests.
 *
 * Subagent source modules import bare packages (@earendil-works/*, typebox)
 * that only resolve at pi bundle time. Tests run under tsx (Node resolution),
 * so we materialise minimal stubs into agent/extensions/node_modules/ before
 * importing a testable copy of the module under test.
 *
 * Every suite in this repo installs the SAME union stubs through
 * tests/helpers/package-stubs.ts, which is safe for parallel test processes:
 * the stubs are reference-counted per process and only removed once no live
 * test process still needs them.
 */
import { after } from "node:test";
import { installPackageStubs, releasePackageStubs } from "../../tests/helpers/package-stubs.ts";

after(() => releasePackageStubs());

export function writePackageStubs(): void {
	installPackageStubs();
}
