import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import arrify from 'arrify';
import chunkd from 'chunkd';
import commonPathPrefix from 'common-path-prefix';
import Emittery from 'emittery';
import ms from 'ms';
import pMap from 'p-map';
import tempDir from 'temp-dir';

import fork from './fork.js';
import * as globs from './globs.js';
import isCi from './is-ci.js';
import {getApplicableLineNumbers} from './line-numbers.js';
import {setCappedTimeout} from './now-and-timers.cjs';
import {observeWorkerProcess} from './plugin-support/shared-workers.js';
import RunStatus from './run-status.js';
import scheduler from './scheduler.js';
import serializeError from './serialize-error.js';

function normalizeRequireOption(require) {
	return arrify(require).map(name => {
		if (typeof name === 'string') {
			return arrify(name);
		}

		return name;
	});
}

function getFilePathPrefix(files) {
	if (files.length === 1) {
		// Get the correct prefix up to the basename.
		return commonPathPrefix([files[0], path.dirname(files[0])]);
	}

	return commonPathPrefix(files);
}

class TimeoutTrigger {
	constructor(fn, waitMs = 0) {
		this.fn = fn.bind(null);
		this.ignoreUntil = 0;
		this.waitMs = waitMs;
		this.timer = undefined;
	}

	debounce() {
		if (this.timer === undefined) {
			this.timer = setCappedTimeout(() => this.trigger(), this.waitMs);
		} else {
			this.timer.refresh();
		}
	}

	discard() {
		// N.B. this.timer is not cleared so if debounce() is called after it will
		// not run again.
		clearTimeout(this.timer);
	}

	ignoreFor(periodMs) {
		this.ignoreUntil = Math.max(this.ignoreUntil, Date.now() + periodMs);
	}

	trigger() {
		if (Date.now() >= this.ignoreUntil) {
			this.fn();
		}
	}
}

export default class Api extends Emittery {
	constructor(options) {
		super();

		this.options = {match: [], moduleTypes: {}, ...options};
		this.options.require = normalizeRequireOption(this.options.require);

		this._cacheDir = null;
		this._interruptHandler = () => {};

		if (options.ranFromCli) {
			process.on('SIGINT', () => this._interruptHandler());
		}
	}

	async run({files: selectedFiles = [], filter = [], runtimeOptions = {}, testFileSelector} = {}) { // eslint-disable-line complexity
		let setupOrGlobError;

		const apiOptions = this.options;

		// Each run will have its own status. It can only be created when test files
		// have been found.
		let runStatus;
		// Irrespectively, perform some setup now, before finding test files.

		// Track active forks and manage timeouts.
		const failFast = apiOptions.failFast === true;
		let bailed = false;
		const pendingWorkers = new Set();
		const timedOutWorkerFiles = new Set();
		let timeoutTrigger;
		if (apiOptions.timeout && !apiOptions.debug) {
			const timeout = ms(apiOptions.timeout);

			timeoutTrigger = new TimeoutTrigger(() => {
				// If failFast is active, prevent new test files from running after
				// the current ones are exited.
				if (failFast) {
					bailed = true;
				}

				runStatus.emitStateChange({type: 'timeout', period: timeout});

				for (const worker of pendingWorkers) {
					timedOutWorkerFiles.add(worker.file);
					worker.exit();
				}
			}, timeout);
		} else {
			timeoutTrigger = new TimeoutTrigger(() => {});
		}

		this._interruptHandler = () => {
			if (bailed) {
				// Exiting already
				return;
			}

			// Prevent new test files from running
			bailed = true;

			// Make sure we don't run the timeout handler
			timeoutTrigger.discard();

			runStatus.emitStateChange({type: 'interrupt'});

			for (const worker of pendingWorkers) {
				worker.exit();
			}
		};

		const {providers = []} = this.options;

		let testFiles;
		try {
			testFiles = await globs.findTests({cwd: this.options.projectDir, ...apiOptions.globs});
			if (typeof testFileSelector === 'function') {
				selectedFiles = testFileSelector(testFiles, selectedFiles);
			} else if (selectedFiles.length === 0) {
				selectedFiles = filter.length === 0 ? testFiles : globs.applyTestFileFilter({
					cwd: this.options.projectDir,
					filter: filter.map(({pattern}) => pattern),
					providers,
					testFiles,
				});
			}
		} catch (error) {
			selectedFiles = [];
			setupOrGlobError = error;
		}

		const selectionInsights = {
			filter: selectedFiles.appliedFilters ?? filter,
			ignoredFilterPatternFiles: selectedFiles.ignoredFilterPatternFiles ?? [],
			testFileCount: testFiles.length,
			selectionCount: selectedFiles.length,
		};

		try {
			if (this.options.parallelRuns) {
				const {currentIndex, totalRuns} = this.options.parallelRuns;
				const fileCount = selectedFiles.length;

				// The files must be in the same order across all runs, so sort them.
				const defaultComparator = (a, b) => a.localeCompare(b, [], {numeric: true});
				selectedFiles = selectedFiles.sort(this.options.sortTestFiles ?? defaultComparator);
				selectedFiles = chunkd(selectedFiles, currentIndex, totalRuns);

				const currentFileCount = selectedFiles.length;

				runStatus = new RunStatus(fileCount, {currentFileCount, currentIndex, totalRuns}, selectionInsights);
			} else {
				// If a custom sorter was configured, use it.
				if (this.options.sortTestFiles) {
					selectedFiles = selectedFiles.sort(this.options.sortTestFiles);
				}

				runStatus = new RunStatus(selectedFiles.length, null, selectionInsights);
			}

			selectedFiles = scheduler.failingTestsFirst(selectedFiles, this._getLocalCacheDir(), this.options.cacheEnabled);

			const debugWithoutSpecificFile = Boolean(this.options.debug) && !this.options.debug.active && selectedFiles.length !== 1;

			await this.emit('run', {
				bailWithoutReporting: debugWithoutSpecificFile,
				debug: Boolean(this.options.debug),
				failFastEnabled: failFast,
				filePathPrefix: getFilePathPrefix(selectedFiles),
				files: selectedFiles,
				matching: apiOptions.match.length > 0 || runtimeOptions.interactiveMatchPattern !== undefined,
				previousFailures: runtimeOptions.countPreviousFailures?.() ?? 0,
				firstRun: runtimeOptions.firstRun ?? true,
				status: runStatus,
			});

			if (setupOrGlobError) {
				throw setupOrGlobError;
			}

			// Bail out early if no files were found, or when debugging and there is not a single specific test file to debug.
			if (selectedFiles.length === 0 || debugWithoutSpecificFile) {
				return runStatus;
			}

			runStatus.on('stateChange', record => {
				if (record.testFile && !timedOutWorkerFiles.has(record.testFile) && record.type !== 'worker-stderr' && record.type !== 'worker-stdout') {
					// Debounce the timer whenever there is test-related activity from workers that haven't already timed out.
					timeoutTrigger.debounce();
				}

				if (failFast && (record.type === 'hook-failed' || record.type === 'test-failed' || record.type === 'worker-failed')) {
					// Prevent new test files from running once a test has failed.
					bailed = true;

					// Try to stop currently scheduled tests.
					for (const worker of pendingWorkers) {
						worker.notifyOfPeerFailure();
					}
				}
			});

			const providerStates = [];
			await Promise.all(providers.map(async ({type, main}) => {
				const state = await main.compile({cacheDir: this._createCacheDir(), files: testFiles});
				if (state !== null) {
					providerStates.push({type, state});
				}
			}));

			// Resolve the correct concurrency value. Note that `os.cpus()` can return empty arrays on
			// platforms not officially supported by Node.js. Use 1 as a minimum.
			// See <https://github.com/nodejs/node/issues/38190>.
			let concurrency = Math.max(1, os.cpus().length);
			if (apiOptions.serial) {
				concurrency = 1;
			} else if (apiOptions.concurrency > 0) {
				concurrency = apiOptions.concurrency;
			} else if (isCi) {
				concurrency = 2;
			}

			const deregisteredSharedWorkers = [];

			// Try and run each file, limited by `concurrency`.
			await pMap(selectedFiles, async file => {
				// No new files should be run once a test has timed out or failed,
				// and failFast is enabled.
				if (bailed) {
					return;
				}

				const lineNumbers = getApplicableLineNumbers(globs.normalizeFileForMatching(apiOptions.projectDir, file), filter);
				// Removing `providers` and `sortTestFiles` fields because they cannot be transferred to the worker threads.
				const {providers, sortTestFiles, match, ...forkOptions} = apiOptions;
				const options = {
					...forkOptions,
					providerStates,
					lineNumbers,
					recordNewSnapshots: !isCi,
					match: runtimeOptions.interactiveMatchPattern === undefined ? match : [...match, runtimeOptions.interactiveMatchPattern],
				};

				if (runtimeOptions.updateSnapshots) {
					// Don't use in Object.assign() since it'll override options.updateSnapshots even when false.
					options.updateSnapshots = true;
				}

				const worker = fork(file, options, apiOptions.nodeArguments);
				worker.onStateChange(data => {
					if (data.type === 'test-timeout-configured' && !apiOptions.debug) {
						timeoutTrigger.ignoreFor(data.period);
					}
				});
				runStatus.observeWorker(worker, file, {selectingLines: lineNumbers.length > 0});
				deregisteredSharedWorkers.push(observeWorkerProcess(worker, runStatus));

				pendingWorkers.add(worker);
				worker.promise.then(() => {
					pendingWorkers.delete(worker);
				});
				timeoutTrigger.debounce();

				await worker.promise;
			}, {concurrency, stopOnError: false});

			// Allow shared workers to clean up before the run ends.
			await Promise.all(deregisteredSharedWorkers);
			const files = scheduler.storeFailedTestFiles(runStatus, this.options.cacheEnabled === false ? null : this._createCacheDir());
			if (files) {
				runStatus.emitStateChange({type: 'touched-files', files});
			}
		} catch (error) {
			runStatus.emitStateChange({type: 'internal-error', err: serializeError(error)});
		}

		timeoutTrigger.discard();
		return runStatus.end();
	}

	_getLocalCacheDir() {
		return path.join(this.options.projectDir, 'node_modules', '.cache', 'ava');
	}

	_createCacheDir() {
		if (this._cacheDir) {
			return this._cacheDir;
		}

		const cacheDir = this.options.cacheEnabled === false
			? fs.mkdtempSync(`${tempDir}${path.sep}`)
			: this._getLocalCacheDir();

		// Ensure cacheDir exists
		fs.mkdirSync(cacheDir, {recursive: true});

		this._cacheDir = cacheDir;

		return cacheDir;
	}
}
