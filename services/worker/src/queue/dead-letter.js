'use strict';

const { moveToDeadLetter } = require('./redis-consumer');

// Atomically move the job we hold from jobs:processing to the dead-letter queue. `job` is the payload as popped
// (needed to find the entry); the dead-lettered copy carries the final attempt and the reason.
async function deadLetterJob(job, attempt, reason) {
	return moveToDeadLetter(job, {
		...job,
		attempt,
		deadLetterReason: reason,
		deadLetteredAt: new Date().toISOString(),
	});
}

module.exports = { deadLetterJob };
