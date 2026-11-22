'use strict';

const logger = require('../logger');

let shuttingDown = false;
let cancelCurrentRun = null;

function isShuttingDown() {
	return shuttingDown;
}

function setRunCanceller(fn) {
	cancelCurrentRun = fn;
}

// Operator "drain": stop picking up jobs and exit once the current one is done (unlike a signal, does not cancel it).
function drain() {
	shuttingDown = true;
}

function installSignalHandlers() {
	const handler = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.warn('SIGTERM/SIGINT received, graceful shutdown started');
		if (cancelCurrentRun) {
			cancelCurrentRun();
		}
	};

	process.on('SIGTERM', handler);
	process.on('SIGINT', handler);
}

module.exports = {
	installSignalHandlers,
	isShuttingDown,
	setRunCanceller,
	drain,
};
