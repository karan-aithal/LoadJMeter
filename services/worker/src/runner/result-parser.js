'use strict';

function parseK6Result(result, { fleetSaturated = false } = {}) {
	const output = `${result.stdout || ''}\n${result.stderr || ''}`;

	if (result.signal === 'SIGTERM') {
		return {
			verdict: 'INCONCLUSIVE',
			status: 'failed',
			errorMessage: 'k6 run interrupted by SIGTERM',
		};
	}

	if (result.code === 0) {
		return {
			verdict: 'PASS',
			status: 'completed',
			errorMessage: null,
		};
	}

	if (fleetSaturated) {
		return {
			verdict: 'INCONCLUSIVE',
			status: 'completed',
			errorMessage: 'Fleet saturation detected (>80% CPU). Result inconclusive.',
		};
	}

	const firstErrorLine = output
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line.length > 0 && /ERRO|error|threshold/i.test(line));

	return {
		verdict: 'FAIL',
		status: 'failed',
		errorMessage: firstErrorLine || `k6 exited with code ${result.code}`,
	};
}

module.exports = { parseK6Result };
