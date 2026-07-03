'use strict';

const { parseK6Result } = require('../src/runner/result-parser');

describe('parseK6Result', () => {
	it('returns PASS for exit code 0', () => {
		const parsed = parseK6Result({ code: 0, signal: null, stdout: 'ok', stderr: '' });
		expect(parsed.status).toBe('completed');
		expect(parsed.verdict).toBe('PASS');
		expect(parsed.errorMessage).toBeNull();
	});

	it('returns INCONCLUSIVE when terminated by SIGTERM', () => {
		const parsed = parseK6Result({ code: 1, signal: 'SIGTERM', stdout: '', stderr: '' });
		expect(parsed.status).toBe('failed');
		expect(parsed.verdict).toBe('INCONCLUSIVE');
	});

	it('returns FAIL and extracts meaningful error line', () => {
		const parsed = parseK6Result({
			code: 99,
			signal: null,
			stdout: 'running test',
			stderr: 'ERRO[0010] thresholds on metrics failed',
		});
		expect(parsed.status).toBe('failed');
		expect(parsed.verdict).toBe('FAIL');
		expect(parsed.errorMessage).toMatch(/thresholds/i);
	});
});
