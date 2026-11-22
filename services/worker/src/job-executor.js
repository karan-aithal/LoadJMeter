'use strict';

// Runs one popped job. Dependencies are injected so the ownership rules below can be unit-tested with fakes.
//
// Ownership: this execution's epoch is its attempt number. Every write/heartbeat carries it; the control-api rejects
// it (409) once the reaper or a newer attempt has taken the job, and we then walk away without touching the DB or
// Redis again. We only ack/re-queue/dead-letter in Redis after the DB accepted our final write.
function createExecutor({
	workerId, maxRetries, metrics, logger,
	updateRunStatus, runK6, startHeartbeat, parseK6Result, setRunCanceller,
	queue, // { ackJob, requeueJob, deadLetterJob }
	now = Date.now,
}) {
	const limit = () => (typeof maxRetries === 'function' ? maxRetries() : maxRetries); // function = live setting
	const getNextAttempt = (job) => (Number.isInteger(job.attempt) ? job.attempt : 0) + 1;

	return async function executeJob(job) {
		const startedAtMs = now();
		const attempt = getNextAttempt(job);
		const epoch = attempt;
		metrics.setCurrentJob(true);
		// first attempt only: retries/reaped jobs keep the original createdAt, so their "wait" would include earlier runs
		if (attempt === 1) metrics.observeQueueWait((startedAtMs - Date.parse(job.createdAt)) / 1000);

		const claim = await updateRunStatus(job.id, {
			status: 'running',
			workerId,
			startedAt: new Date().toISOString(),
			errorMessage: null,
			epoch,
		});
		if (claim === 'fenced') { // cancelled/finished/re-owned while queued: don't run it
			metrics.setCurrentJob(false);
			logger.warn('job skipped: not owner at start', { jobId: job.id, attempt });
			return;
		}

		let lostOwnership = false;
		const run = runK6(job.config || {});
		setRunCanceller(run.cancel);
		const stopHeartbeat = startHeartbeat(job.id, workerId, epoch, {
			onFailure: () => metrics.recordHeartbeatFailure(),
			onFenced: () => { lostOwnership = true; run.cancel(); },
		});

		const result = await run.done;
		stopHeartbeat();
		setRunCanceller(null);

		if (lostOwnership) {
			metrics.setCurrentJob(false);
			logger.warn('ownership lost, result discarded', { jobId: job.id, attempt });
			return;
		}

		const parsed = parseK6Result(result, { fleetSaturated: metrics.wasSaturatedSince(startedAtMs) });
		const done = (outcome) => {
			metrics.recordOutcome(outcome);
			metrics.observeJob({ outcome, durationSec: (now() - startedAtMs) / 1000 });
			metrics.setCurrentJob(false);
		};
		// Not 'ok' = leave the entry in jobs:processing: the reaper requeues it if we are really gone, and a
		// fenced worker's copy was already moved. Acking here would lose the job.
		const abandon = (why, r) => {
			metrics.setCurrentJob(false);
			logger.warn(why, { jobId: job.id, attempt, writeResult: r });
		};

		if (parsed.status === 'completed') {
			const r = await updateRunStatus(job.id, {
				status: 'completed',
				verdict: parsed.verdict,
				completedAt: new Date().toISOString(),
				errorMessage: parsed.errorMessage,
				epoch,
			});
			if (r !== 'ok') return abandon('completion not recorded, job left in processing', r);
			await queue.ackJob(job);
			done(parsed.verdict.toLowerCase());
			logger.info('job completed', { jobId: job.id, attempt });
			return;
		}

		if (attempt >= limit()) {
			const reason = parsed.errorMessage || 'max retries exceeded';
			const r = await updateRunStatus(job.id, {
				status: 'failed',
				verdict: parsed.verdict || 'FAIL',
				completedAt: new Date().toISOString(),
				errorMessage: reason,
				epoch,
			});
			if (r !== 'ok') return abandon('failure not recorded, job left in processing', r);
			// atomic ack + DLQ push. If we die before it, the run is 'failed' with its payload still in processing,
			// which the reaper recognises and dead-letters.
			await queue.deadLetterJob(job, attempt, reason);
			done('failed');
			logger.warn('job moved to dead-letter', { jobId: job.id, attempt });
			return;
		}

		const retryJob = {
			...job,
			attempt,
			lastError: parsed.errorMessage || `failed with exit code ${result.code}`,
		};
		// DB first: it refuses if the run was cancelled/finished/re-owned, so no retry is queued behind a terminal
		// state. epoch+1 fences this execution out; if we die before the Redis step the reaper sees row.epoch >=
		// payload.attempt+2 and finishes the move.
		const r = await updateRunStatus(job.id, {
			status: 'pending',
			verdict: null,
			errorMessage: retryJob.lastError,
			epoch,
			nextEpoch: epoch + 1,
		});
		if (r !== 'ok') return abandon('retry not recorded, job left in processing', r);
		const queued = await queue.requeueJob(job, retryJob);
		done('retry');
		logger.warn(queued ? 'job requeued for retry' : 'retry not queued (already moved by reaper, or run cancelled)',
			{ jobId: job.id, attempt, maxRetries: limit() });
	};
}

module.exports = { createExecutor };
