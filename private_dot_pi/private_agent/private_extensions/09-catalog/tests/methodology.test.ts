import assert from "node:assert/strict";
import test from "node:test";
import { classifyDimensionStability, deriveDimensions, describeMethodologyDrift } from "../aa/methodology.ts";

const drift = (api: string | null, publicVersion: string | null) => ({
	pinned: { api: "4.3", public: "4.3.2" },
	upstream: { api, public: publicVersion },
	changed: api !== "4.3" || publicVersion !== "4.3.2",
	warnings: [] as string[],
});

test("composite index metrics prefer the authenticated API over the public page", () => {
	const dimensions = deriveDimensions(
		{ artificial_analysis_intelligence_index: 55, artificial_analysis_coding_index: 40 },
		{ intelligenceIndex: 90, codingIndex: 90 },
	);
	assert.equal(dimensions.intelligence, 55);
	assert.equal(dimensions.coding, 40);
});

test("a metric the API omits falls back to the public page component", () => {
	const dimensions = deriveDimensions({}, {
		intelligenceIndex: 0.548, lcr: 0.81, ifbench: 0.9, omniscienceAccuracy: 0.3, omniscienceHallucinationRate: 0.4,
	});
	assert.ok(Math.abs((dimensions.intelligence ?? 0) - 54.8) < 1e-9, "percent-scaled page values keep float rounding");
	assert.equal(dimensions.longContext, 81);
	assert.equal(dimensions.instructionFollowing, 90);
	assert.equal(dimensions.knowledge, 30);
	assert.equal(dimensions.faithfulness, 60, "faithfulness is the complement of the hallucination rate");
});

test("tool use is derived from whichever tau components are still published", () => {
	assert.equal(deriveDimensions({ tau_banking: 0.4, gdpval_aa_normalized: 0.2 }, {}).toolUse, 30);
	assert.equal(deriveDimensions({ tau_banking: 0.4, tau2_telecom: 0.2 }, {}).toolUse, 30);
	assert.equal(deriveDimensions({ tau_banking: 0.4 }, {}).toolUse, 40);
	assert.equal(deriveDimensions({ tau2_telecom: 0.2 }, {}).toolUse, 20);
});

test("a metric nobody publishes stays unknown rather than zero", () => {
	const dimensions = deriveDimensions({}, {});
	assert.equal(dimensions.intelligence, null);
	assert.equal(dimensions.coding, null);
	assert.equal(dimensions.toolUse, null);
	assert.equal(dimensions.scientificReasoning, null);
	assert.equal(deriveDimensions({ hle: 0.9, gpqa: 0.8 }, {}).scientificReasoning, null, "a partial research component set is not a score");
});

test("a metric that keeps both ordering and scale survives the methodology move", () => {
	const verdict = classifyDimensionStability([[50, 50], [60, 60], [70, 70], [80, 80.2], [55, 55.1]]);
	assert.equal(verdict.classification, "stable");
	assert.ok(verdict.rankCorrelation !== null && verdict.rankCorrelation > 0.99);
});

test("a rescaled composite is drifted even when its ordering is perfect", () => {
	// The Intelligence Index moved this way in practice: rank correlation 1.00, mean shift 6.1 points.
	const verdict = classifyDimensionStability([[40, 46], [50, 57], [55, 61], [60, 68], [45, 51]]);
	assert.equal(verdict.classification, "drifted");
	assert.ok((verdict.rankCorrelation ?? 0) > 0.99);
	assert.ok(verdict.meanAbsDelta !== null && verdict.meanAbsDelta > 5);
});

test("too few paired observations is indeterminate, never stable", () => {
	const verdict = classifyDimensionStability([[60, 60], [70, 70], [80, 80]]);
	assert.equal(verdict.classification, "indeterminate");
	assert.equal(verdict.rankCorrelation, null);
});

test("a metric that disappeared upstream is reported as gone", () => {
	assert.equal(classifyDimensionStability([]).classification, "gone");
});

test("an unchanged methodology is reported quietly", () => {
	const report = describeMethodologyDrift(drift("4.3", "4.3.2"));
	assert.equal(report.level, "info");
	assert.match(report.text, /methodology unchanged \(pinned public 4\.3\.2, catalog API 4\.3\)/ );
});

test("a moved methodology names both surfaces and the follow-up work", () => {
	const report = describeMethodologyDrift(drift("5", "5.0"));
	assert.equal(report.level, "warning");
	assert.match(report.text, /API index 4\.3 → 5/);
	assert.match(report.text, /public page 4\.3\.2 → 5\.0/);
	assert.match(report.text, /--methodology-diff/);
	assert.match(report.text, /routing-policy\.json/);
});

test("an unreachable upstream never looks like a methodology move", () => {
	const report = describeMethodologyDrift({ ...drift(null, null), warnings: ["Artificial Analysis API request failed"] });
	assert.equal(report.level, "info");
	assert.match(report.text, /methodology check unavailable/);
	assert.doesNotMatch(report.text, /moved/);
});

test("a catalog that publishes no methodology version is unknown, never an all-clear", () => {
	const report = describeMethodologyDrift(drift(null, null));
	assert.equal(report.level, "info");
	assert.match(report.text, /methodology check unavailable/);
	assert.match(report.text, /published no methodology version/);
	assert.doesNotMatch(report.text, /unchanged/);
});
