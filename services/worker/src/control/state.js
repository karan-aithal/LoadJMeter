'use strict';

// Shared, mutable runtime state written by control.js and read by the heartbeat / control-api client.
module.exports = {
	settings: {},          // ops:settings hash from Redis (strings); see control-api src/ops/settings.js
	partitionedUntil: 0,   // simulated partition from control-api until this epoch-ms
};
