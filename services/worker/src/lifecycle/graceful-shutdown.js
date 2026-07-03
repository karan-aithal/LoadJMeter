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
};
