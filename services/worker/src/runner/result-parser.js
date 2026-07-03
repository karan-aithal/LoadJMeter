'use strict';

function parseK6Result(result) {
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
