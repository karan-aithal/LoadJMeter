'use strict';

jest.mock('axios');
jest.mock('../src/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
process.env.STATUS_RETRY_MS = '1';

const axios = require('axios');
const { updateRunStatus } = require('../src/control-api-client');

describe('updateRunStatus', () => {
	beforeEach(() => axios.patch.mockReset());

	it("'ok' on success", async () => {
		axios.patch.mockResolvedValue({});
		expect(await updateRunStatus('j', { status: 'running', epoch: 1 })).toBe('ok');
		expect(axios.patch).toHaveBeenCalledWith(expect.stringContaining('/tests/j/status'), { status: 'running', epoch: 1 }, expect.any(Object));
	});

	it("'fenced' on 409, immediately (no retry)", async () => {
		axios.patch.mockRejectedValue(Object.assign(new Error('c'), { response: { status: 409 } }));
		expect(await updateRunStatus('j', { status: 'completed', epoch: 1 })).toBe('fenced');
		expect(axios.patch).toHaveBeenCalledTimes(1);
	});

	it("'error' after 3 tries when control-api is unreachable (partition)", async () => {
		axios.patch.mockRejectedValue(new Error('ETIMEDOUT'));
		expect(await updateRunStatus('j', { status: 'completed', epoch: 1 })).toBe('error');
		expect(axios.patch).toHaveBeenCalledTimes(3);
	});

	it('retries a transient failure and then succeeds', async () => {
		axios.patch.mockRejectedValueOnce(new Error('blip')).mockResolvedValue({});
		expect(await updateRunStatus('j', { status: 'completed', epoch: 1 })).toBe('ok');
	});

	it('a 409 on a later try is still fenced, not an error', async () => {
		axios.patch.mockRejectedValueOnce(new Error('blip')).mockRejectedValue(Object.assign(new Error('c'), { response: { status: 409 } }));
		expect(await updateRunStatus('j', { status: 'completed', epoch: 1 })).toBe('fenced');
	});
});
