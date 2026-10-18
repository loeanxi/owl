import { writeFileSync } from "node:fs";

// Vitest's JSON reporter omits unhandled errors and errors on nested suites.
export default class TestKnownReporter {
	onTestRunEnd(testModules, unhandledErrors, reason) {
		const suiteErrors = testModules.flatMap((module) =>
			[module, ...module.children.allSuites()].flatMap((suite) => suite.errors().map((error) => error.message)),
		);
		writeFileSync(
			process.env.OWL_TEST_KNOWN_METADATA,
			JSON.stringify({ unhandledErrors: unhandledErrors.length, suiteErrors, reason }),
		);
	}
}
