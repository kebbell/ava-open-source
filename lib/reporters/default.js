import os from 'node:os';
import path from 'node:path';
import stream from 'node:stream';
import {fileURLToPath} from 'node:url';

import figures from 'figures';
import indentString from 'indent-string';
import plur from 'plur';
import prettyMs from 'pretty-ms';
import StackUtils from 'stack-utils';

import {chalk} from '../chalk.js';
import codeExcerpt from '../code-excerpt.js';

import beautifyStack from './beautify-stack.js';
import colors from './colors.js';
import formatSerializedError from './format-serialized-error.js';
import improperUsageMessage from './improper-usage-messages.js';
import prefixTitle from './prefix-title.js';

const nodeInternals = StackUtils.nodeInternals();

class LineWriter extends stream.Writable {
	constructor(dest) {
		super();

		this.dest = dest;
		this.columns = dest.columns ?? 80;
		this.lastLineIsEmpty = true;
	}

	_write(chunk, _, callback) {
		this.dest.write(chunk);
		callback();
	}

	writeLine(string, indent = true) {
		if (string) {
			this.write((indent ? indentString(string, 2) : string) + os.EOL);
			this.lastLineIsEmpty = false;
		} else {
			this.write(os.EOL);
			this.lastLineIsEmpty = true;
		}
	}

	write(string) {
		this.lastLineIsEmpty = false;
		super.write(string);
	}

	ensureEmptyLine() {
		if (!this.lastLineIsEmpty) {
			this.writeLine();
		}
	}
}

function manageCorking(stream) {
	return {
		decorateWriter(fn) {
			return function (...args) {
				stream.cork();
				try {
					return fn.apply(this, args);
				} finally {
					stream.uncork();
				}
			};
		},
	};
}

export default class Reporter {
	constructor({
		extensions,
		reportStream,
		stdStream,
		projectDir,
		watching,
		durationThreshold,
	}) {
		this.extensions = extensions;
		this.reportStream = reportStream;
		this.stdStream = stdStream;
		this.watching = watching;
		this.relativeFile = file => {
			if (file.startsWith('file://')) {
				file = fileURLToPath(file);
			}

			return path.relative(projectDir, file);
		};

		const {decorateWriter} = manageCorking(this.reportStream);
		this.consumeStateChange = decorateWriter(this.consumeStateChange);
		this.endRun = decorateWriter(this.endRun);

		this.durationThreshold = durationThreshold ?? 100;
		this.lineWriter = new LineWriter(this.reportStream);

		this.reset();
	}

	reset() {
		if (this.removePreviousListener) {
			this.removePreviousListener();
		}

		this.prefixTitle = (testFile, title) => title;

		this.runningTestFiles = new Map();
		this.filesWithMissingAvaImports = new Set();
		this.filesWithoutDeclaredTests = new Set();
		this.filesWithoutMatchedLineNumbers = new Set();

		this.failures = [];
		this.internalErrors = [];
		this.knownFailures = [];
		this.lineNumberErrors = [];
		this.sharedWorkerErrors = [];
		this.uncaughtExceptions = [];
		this.unhandledRejections = [];

		this.previousFailures = 0;

		this.failFastEnabled = false;
		this.matching = false;

		this.removePreviousListener = null;
		this.stats = null;
	}

	startRun(plan) {
		if (plan.bailWithoutReporting) {
			return;
		}

		this.reset();

		this.failFastEnabled = plan.failFastEnabled;
		this.matching = plan.matching;
		this.previousFailures = plan.previousFailures;
		this.emptyParallelRun = plan.status.emptyParallelRun;
		this.selectionInsights = plan.status.selectionInsights;

		if (this.watching || plan.files.length > 1) {
			this.prefixTitle = (testFile, title) => prefixTitle(this.extensions, plan.filePathPrefix, testFile, title);
		}

		this.removePreviousListener = plan.status.on('stateChange', evt => {
			this.consumeStateChange(evt);
		});

		if (this.watching && !plan.firstRun) {
			this.lineWriter.write(chalk.gray.dim('\u2500'.repeat(this.lineWriter.columns)) + os.EOL);
		}

		this.lineWriter.writeLine();
	}

	consumeStateChange(event) { // eslint-disable-line complexity
		const fileStats = this.stats && event.testFile ? this.stats.byFile.get(event.testFile) : null;

		switch (event.type) { // eslint-disable-line default-case
			case 'hook-failed': {
				this.failures.push(event);
				this.writeTestSummary(event);
				break;
			}

			case 'stats': {
				this.stats = event.stats;
				break;
			}

			case 'test-failed': {
				this.failures.push(event);
				this.writeTestSummary(event);
				break;
			}

			case 'test-passed': {
				if (event.knownFailing) {
					this.knownFailures.push(event);
				}

				this.writeTestSummary(event);
				break;
			}

			case 'timeout': {
				this.lineWriter.writeLine(colors.error(`\n${figures.cross} Timed out while running tests`));
				this.lineWriter.writeLine('');
				this.writePendingTests(event);
				break;
			}

			case 'interrupt': {
				this.lineWriter.writeLine(colors.error(`\n${figures.cross} Exiting due to SIGINT`));
				this.lineWriter.writeLine('');
				this.writePendingTests(event);
				break;
			}

			case 'internal-error': {
				this.internalErrors.push(event);

				if (event.testFile) {
					this.write(colors.error(`${figures.cross} Internal error when running ${this.relativeFile(event.testFile)}`));
				} else {
					this.write(colors.error(`${figures.cross} Internal error`));
				}

				this.writeSerializedError(event.err);
				this.lineWriter.writeLine();

				break;
			}

			case 'line-number-selection-error': {
				this.lineNumberErrors.push(event);

				this.write(colors.information(`${figures.warning} Could not parse ${this.relativeFile(event.testFile)} for line number selection`));
				this.lineWriter.writeLine();
				this.writeSerializedError(event.err);
				break;
			}

			case 'missing-ava-import': {
				this.filesWithMissingAvaImports.add(event.testFile);

				this.write(colors.error(`${figures.cross} No tests found in ${this.relativeFile(event.testFile)}, make sure to import "ava" at the top of your test file`));
				break;
			}

			case 'process-exit': {
				this.write(colors.error(`${figures.cross} Exiting due to process.exit() when running ${this.relativeFile(event.testFile)}`));

				this.lineWriter.writeLine();
				this.lineWriter.writeLine(colors.errorStack(event.stack));
				this.lineWriter.writeLine();

				break;
			}

			case 'hook-finished': {
				if (event.logs.length > 0) {
					this.lineWriter.writeLine(`  ${this.prefixTitle(event.testFile, event.title)}`);
					this.writeLogs(event);
				}

				break;
			}

			case 'selected-test': {
				if (event.skip) {
					this.lineWriter.writeLine(colors.skip(`- [skip] ${this.prefixTitle(event.testFile, event.title)}`));
				} else if (event.todo) {
					this.lineWriter.writeLine(colors.todo(`- [todo] ${this.prefixTitle(event.testFile, event.title)}`));
				}

				break;
			}

			case 'shared-worker-error': {
				this.sharedWorkerErrors.push(event);

				this.lineWriter.ensureEmptyLine();
				this.lineWriter.writeLine(colors.error(`${figures.cross} Error in shared worker`));
				this.lineWriter.writeLine();
				this.writeSerializedError(event.err);

				break;
			}

			case 'uncaught-exception': {
				this.uncaughtExceptions.push(event);

				this.lineWriter.ensureEmptyLine();
				this.lineWriter.writeLine(colors.title(`Uncaught exception in ${this.relativeFile(event.testFile)}`));
				this.lineWriter.writeLine();
				this.writeSerializedError(event.err);

				break;
			}

			case 'unhandled-rejection': {
				this.unhandledRejections.push(event);

				this.lineWriter.ensureEmptyLine();
				this.lineWriter.writeLine(colors.title(`Unhandled rejection in ${this.relativeFile(event.testFile)}`));
				this.lineWriter.writeLine();
				this.writeSerializedError(event.err);

				break;
			}

			case 'worker-failed': {
				if (fileStats.declaredTests === 0) {
					this.filesWithoutDeclaredTests.add(event.testFile);
				}

				if (!this.filesWithMissingAvaImports.has(event.testFile)) {
					if (event.err) {
						this.lineWriter.writeLine(colors.error(`${figures.cross} ${this.relativeFile(event.testFile)} exited due to an error:`));
						this.lineWriter.writeLine();
						this.writeSerializedError(event.err);
					} else if (event.nonZeroExitCode) {
						this.lineWriter.writeLine(colors.error(`${figures.cross} ${this.relativeFile(event.testFile)} exited with a non-zero exit code: ${event.nonZeroExitCode}`));
					} else {
						this.lineWriter.writeLine(colors.error(`${figures.cross} ${this.relativeFile(event.testFile)} exited due to ${event.signal}`));
					}
				}

				break;
			}

			case 'worker-finished': {
				if (!event.forcedExit && !this.filesWithMissingAvaImports.has(event.testFile)) {
					if (fileStats.declaredTests === 0) {
						this.filesWithoutDeclaredTests.add(event.testFile);

						this.write(colors.error(`${figures.cross} No tests found in ${this.relativeFile(event.testFile)}`));
					} else if (fileStats.selectingLines && fileStats.selectedTests === 0) {
						this.filesWithoutMatchedLineNumbers.add(event.testFile);

						this.lineWriter.writeLine(colors.error(`${figures.cross} Line numbers for ${this.relativeFile(event.testFile)} did not match any tests`));
					} else if (!this.failFastEnabled && fileStats.remainingTests > 0) {
						this.lineWriter.writeLine(colors.error(`${figures.cross} ${fileStats.remainingTests} ${plur('test', fileStats.remainingTests)} remaining in ${this.relativeFile(event.testFile)}`));
					}
				}

				break;
			}

			case 'worker-stderr': {
				this.stdStream.write(event.chunk);
				// If the chunk does not end with a linebreak, *forcibly* write one to
				// ensure it remains visible in the TTY.
				// Tests cannot assume their standard output is not interrupted. Indeed
				// we multiplex stdout and stderr into a single stream. However as
				// long as stdStream is different from reportStream users can read
				// their original output by redirecting the streams.
				if (event.chunk.at(-1) !== 0x0A) {
					this.reportStream.write(os.EOL);
				}

				break;
			}

			case 'worker-stdout': {
				this.stdStream.write(event.chunk);
				// If the chunk does not end with a linebreak, *forcibly* write one to
				// ensure it remains visible in the TTY.
				// Tests cannot assume their standard output is not interrupted. Indeed
				// we multiplex stdout and stderr into a single stream. However as
				// long as stdStream is different from reportStream users can read
				// their original output by redirecting the streams.
				if (event.chunk.at(-1) !== 0x0A) {
					this.reportStream.write(os.EOL);
				}
			}
		}
	}

	writePendingTests(evt) {
		for (const [file, testsInFile] of evt.pendingTests) {
			if (testsInFile.size === 0) {
				this.lineWriter.writeLine(`Failed to exit when running ${this.relativeFile(file)}\n`);
				continue;
			}

			this.lineWriter.writeLine(`${testsInFile.size} tests were pending in ${this.relativeFile(file)}\n`);
			const testTitleToLogs = evt.pendingTestsLogs.get(file);
			for (const title of testsInFile) {
				const logs = testTitleToLogs?.get(title);
				this.lineWriter.writeLine(`${figures.circleDotted} ${this.prefixTitle(file, title)}`);
				this.writeLogs({logs});
			}

			this.lineWriter.writeLine('');
		}
	}

	write(string) {
		this.lineWriter.writeLine(string);
	}

	writeWithCounts(string) {
		if (!this.stats) {
			return this.lineWriter.writeLine(string);
		}

		string ??= '';
		if (string !== '') {
			string += os.EOL;
		}

		let firstLinePostfix = this.watching ? ' ' + chalk.gray.dim('[' + new Date().toLocaleTimeString('en-US', {hour12: false}) + ']') : '';

		if (this.stats.passedTests > 0) {
			string += os.EOL + colors.pass(`${this.stats.passedTests} passed`) + firstLinePostfix;
			firstLinePostfix = '';
		}

		if (this.stats.passedKnownFailingTests > 0) {
			string += os.EOL + colors.error(`${this.stats.passedKnownFailingTests} ${plur('known failure', this.stats.passedKnownFailingTests)}`);
		}

		if (this.stats.failedHooks > 0) {
			string += os.EOL + colors.error(`${this.stats.failedHooks} ${plur('hook', this.stats.failedHooks)} failed`) + firstLinePostfix;
			firstLinePostfix = '';
		}

		if (this.stats.failedTests > 0) {
			string += os.EOL + colors.error(`${this.stats.failedTests} ${plur('test', this.stats.failedTests)} failed`) + firstLinePostfix;
			firstLinePostfix = '';
		}

		if (this.stats.skippedTests > 0) {
			string += os.EOL + colors.skip(`${this.stats.skippedTests} skipped`);
		}

		if (this.stats.todoTests > 0) {
			string += os.EOL + colors.todo(`${this.stats.todoTests} todo`);
		}

		this.lineWriter.writeLine(string);
	}

	writeSerializedError(error) { // eslint-disable-line complexity
		if (error.type === 'aggregate') {
			for (const error_ of error.errors) {
				this.writeSerializedError(error_);
			}

			return;
		}

		if (error.type === 'unknown') {
			this.lineWriter.writeLine(error.formattedError);
			this.lineWriter.writeLine();
			return;
		}

		if (error.type === 'native' && error.name === 'TSError' && error.originalError.diagnosticText) {
			this.lineWriter.writeLine(colors.errorStack(error.originalError.diagnosticText));
			this.lineWriter.writeLine();
			return;
		}

		const hasSource = error.source !== null;
		if (hasSource) {
			const {source} = error;
			this.lineWriter.writeLine(colors.errorSource(`${this.relativeFile(source.file)}:${source.line}`));
			const excerpt = codeExcerpt(source, {maxWidth: this.reportStream.columns - 2});
			if (excerpt) {
				this.lineWriter.writeLine();
				this.lineWriter.writeLine(excerpt);
				this.lineWriter.writeLine();
			}
		}

		let summary = '';
		let printStack = true;
		if (error.type === 'native') {
			const lines = error.stack.split('\n');

			// SyntaxError stacks may begin with the offending code. Write all stack
			// lines up to and including one that begins with SyntaxError.
			if (error.name === 'SyntaxError') {
				for (const line of lines) {
					summary += line + '\n';
					if (line.startsWith('SyntaxError')) {
						break;
					}
				}

				printStack = summary === '';
			} else {
				// Handle multi-line error messages.
				for (let index = 0; index < lines.length; index++) {
					if (/^\s+at/.test(lines[index])) {
						break;
					}

					const next = index + 1;
					const end = next === lines.length || /^\s+at/.test(lines[next]);
					summary += end ? lines[index] : lines[index] + '\n';
				}
			}

			if (summary !== '') {
				this.lineWriter.writeLine(summary.trim());
				this.lineWriter.writeLine();
			}
		}

		if (error.type === 'ava') {
			const {formattedDetails, improperUsage, message} = error;

			const result = formatSerializedError(formattedDetails, message);
			if (result.printMessage) {
				this.lineWriter.writeLine(message);
				this.lineWriter.writeLine();
			}

			if (result.formatted) {
				this.lineWriter.writeLine(result.formatted);
				this.lineWriter.writeLine();
			}

			const usageMessage = improperUsageMessage(improperUsage);
			if (usageMessage) {
				this.lineWriter.writeLine(usageMessage);
				this.lineWriter.writeLine();
			}
		}

		if (printStack) {
			const formattedStack = this.formatErrorStack(error.stack, hasSource);
			if (formattedStack.length > 0) {
				this.lineWriter.writeLine(formattedStack.join('\n'));
				this.lineWriter.writeLine();
			}
		}
	}

	formatErrorStack(stack, hasSource) {
		if (stack === '') {
			return [];
		}

		if (hasSource) {
			return beautifyStack(stack).map(line => {
				if (nodeInternals.some(internal => internal.test(line))) {
					return colors.errorStackInternal(`${figures.pointerSmall} ${line}`);
				}

				return colors.errorStack(`${figures.pointerSmall} ${line}`);
			});
		}

		return [colors.errorStack(stack)];
	}

	writeLogs(event, surroundLines) {
		if (event.logs?.length > 0) {
			if (surroundLines) {
				this.lineWriter.writeLine();
			}

			for (const log of event.logs) {
				const logLines = indentString(colors.log(log), 4);
				const logLinesWithLeadingFigure = logLines.replace(/^ {4}/, `  ${colors.information(figures.info)} `);
				this.lineWriter.writeLine(logLinesWithLeadingFigure);
			}

			if (surroundLines) {
				this.lineWriter.writeLine();
			}

			return true;
		}

		return false;
	}

	writeTestSummary(event) {
		// Prefix icon indicates matched expectations vs. not.
		// Prefix color indicates passed-as-expected vs. not (fail or unexpected pass).
		// This yields four possibilities, which in the standard configuration render as:
		// * normal test, pass:        <green>✔</green>
		// * normal test, fail:          <red>✘ [fail]</red>
		// * fail-expected test, fail:   <red>✔ [expected fail]</red>
		// * fail-expected test, pass:   <red>✘ [unexpected pass]</red>
		let prefix;
		let suffix;
		if (event.type === 'hook-failed' || event.type === 'test-failed') {
			const type = event.knownFailing ? '[unexpected pass]' : '[fail]';
			prefix = colors.error(`${figures.cross} ${type}:`);
			suffix = chalk.italic(colors.error(event.err.message));
		} else if (event.knownFailing) {
			prefix = colors.error(figures.tick + ' [expected fail]');
		} else {
			prefix = colors.pass(figures.tick);
			if (event.duration > this.durationThreshold) {
				suffix = colors.duration(`(${prettyMs(event.duration)})`);
			}
		}

		const label = this.prefixTitle(event.testFile, event.title);
		this.write(`${prefix} ${label}${suffix ? ' ' + suffix : ''}`);
		this.writeLogs(event);
	}

	writeFailure(event) {
		this.lineWriter.writeLine(colors.title(this.prefixTitle(event.testFile, event.title)));

		if (!event.logs || event.logs.length === 0) {
			this.lineWriter.writeLine();
		}

		this.writeSerializedError(event.err);
	}

	endRun() {// eslint-disable-line complexity
		let firstLinePostfix = this.watching ? ` ${chalk.gray.dim(`[${new Date().toLocaleTimeString('en-US', {hour12: false})}]`)}` : '';

		if (this.emptyParallelRun) {
			this.lineWriter.writeLine('No files tested in this parallel run');
			this.lineWriter.writeLine();
			return;
		}

		if (this.selectionInsights.ignoredFilterPatternFiles.length > 0) {
			this.write(colors.information(`${figures.warning} Paths for additional test files were disregarded:`));
			this.lineWriter.writeLine();
			for (const pattern of this.selectionInsights.ignoredFilterPatternFiles) {
				this.lineWriter.writeLine(chalk.magenta(`* ${pattern}`));
			}

			this.lineWriter.writeLine();
			this.write(colors.information('Files starting with underscores are never treated as test files.'));
			this.write(colors.information('Files handled by @ava/typescript can only be selected if your configuration already selects them.'));
			this.lineWriter.writeLine();
		}

		if (this.selectionInsights.selectionCount === 0) {
			if (this.selectionInsights.testFileCount === 0) {
				this.lineWriter.writeLine(colors.error(`${figures.cross} Couldn’t find any files to test` + firstLinePostfix));
			} else {
				const {testFileCount: count} = this.selectionInsights;
				this.lineWriter.writeLine(colors.error(`${figures.cross} Based on your configuration, ${count} test ${plur('file was', 'files were', count)} found, but did not match the filters:` + firstLinePostfix));
				this.lineWriter.writeLine();
				for (const {pattern} of this.selectionInsights.filter) {
					this.lineWriter.writeLine(colors.error(`* ${pattern}`));
				}
			}

			this.lineWriter.writeLine();
			return;
		}

		if (this.matching && this.stats.selectedTests === 0) {
			this.lineWriter.writeLine(colors.error(`${figures.cross} Couldn’t find any matching tests` + firstLinePostfix));
			this.lineWriter.writeLine();
			return;
		}

		this.lineWriter.writeLine(colors.log(figures.line));
		this.lineWriter.writeLine();

		if (this.failures.length > 0) {
			const lastFailure = this.failures.at(-1);
			for (const event of this.failures) {
				this.writeFailure(event);
				if (event !== lastFailure) {
					this.lineWriter.writeLine();
					this.lineWriter.writeLine();
				}
			}

			this.lineWriter.writeLine(colors.log(figures.line));
			this.lineWriter.writeLine();
		}

		if (this.failFastEnabled && (this.stats.remainingTests > 0 || this.stats.files > this.stats.finishedWorkers)) {
			let remaining = '';
			if (this.stats.remainingTests > 0) {
				remaining += `At least ${this.stats.remainingTests} ${plur('test was', 'tests were', this.stats.remainingTests)} skipped`;
				if (this.stats.files > this.stats.finishedWorkers) {
					remaining += ', as well as ';
				}
			}

			if (this.stats.files > this.stats.finishedWorkers) {
				const skippedFileCount = this.stats.files - this.stats.finishedWorkers;
				remaining += `${skippedFileCount} ${plur('test file', 'test files', skippedFileCount)}`;
				if (this.stats.remainingTests === 0) {
					remaining += ` ${plur('was', 'were', skippedFileCount)} skipped`;
				}
			}

			this.lineWriter.writeLine(colors.information(`\`--fail-fast\` is on. ${remaining}.`));
			this.lineWriter.writeLine();
		}

		if (this.stats.parallelRuns) {
			const {
				currentFileCount,
				currentIndex,
				totalRuns,
			} = this.stats.parallelRuns;
			this.lineWriter.writeLine(colors.information(`Ran ${currentFileCount} test ${plur('file', currentFileCount)} out of ${this.stats.files} for job ${currentIndex + 1} of ${totalRuns}`));
			this.lineWriter.writeLine();
		}

		if (this.stats.failedHooks > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.failedHooks} ${plur('hook', this.stats.failedHooks)} failed`) + firstLinePostfix);
			firstLinePostfix = '';
		}

		if (this.stats.failedTests > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.failedTests} ${plur('test', this.stats.failedTests)} failed`) + firstLinePostfix);
			firstLinePostfix = '';
		}

		if (
			this.stats.failedHooks === 0
			&& this.stats.failedTests === 0
			&& this.stats.passedTests > 0
		) {
			this.lineWriter.writeLine(colors.pass(`${this.stats.passedTests} ${plur('test', this.stats.passedTests)} passed`) + firstLinePostfix,
			);
			firstLinePostfix = '';
		}

		if (this.stats.passedKnownFailingTests > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.passedKnownFailingTests} ${plur('known failure', this.stats.passedKnownFailingTests)}`));
		}

		if (this.stats.skippedTests > 0) {
			this.lineWriter.writeLine(colors.skip(`${this.stats.skippedTests} ${plur('test', this.stats.skippedTests)} skipped`));
		}

		if (this.stats.todoTests > 0) {
			this.lineWriter.writeLine(colors.todo(`${this.stats.todoTests} ${plur('test', this.stats.todoTests)} todo`));
		}

		if (this.stats.unhandledRejections > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.unhandledRejections} unhandled ${plur('rejection', this.stats.unhandledRejections)}`));
		}

		if (this.stats.uncaughtExceptions > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.uncaughtExceptions} uncaught ${plur('exception', this.stats.uncaughtExceptions)}`));
		}

		if (this.stats.timedOutTests > 0) {
			this.lineWriter.writeLine(colors.error(`${this.stats.timedOutTests} ${plur('test', this.stats.timedOutTests)} remained pending after a timeout`));
		}

		if (this.previousFailures > 0) {
			this.lineWriter.writeLine(colors.error(`${this.previousFailures} previous ${plur('failure', this.previousFailures)} in test files that were not rerun`));
		}

		if (this.watching) {
			this.lineWriter.writeLine();
		}
	}
}
