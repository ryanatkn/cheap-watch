import EventEmitter from 'events';
import { readdir, stat, watch } from 'fs';
import { promisify } from 'util';

const readdirAsync = promisify(readdir);
const statAsync = promisify(stat);

const _dir = Symbol('_dir');
const _filter = Symbol('_filter');
const _watch = Symbol('_watch');
const _debounce = Symbol('_debounce');
const _watchers = Symbol('_watchers');
const _paths = Symbol('_paths');
const _timeouts = Symbol('_timeouts');
const _queue = Symbol('_queue');
const _isProcessing = Symbol('_isProcessing');
const _isInitStarted = Symbol('_isInitStarted');
const _isClosed = Symbol('_isClosed');
const _recurse = Symbol('_recurse');
const _handle = Symbol('_handle');
const _enqueue = Symbol('_enqueue');

export default class CheapWatch extends EventEmitter {
	constructor({ dir, filter, watch = true, debounce = 10 }) {
		if (typeof dir !== 'string') {
			throw new TypeError('dir must be a string');
		}
		if (filter && typeof filter !== 'function') {
			throw new TypeError('filter must be a function');
		}
		if (typeof watch !== 'boolean') {
			throw new TypeError('watch must be a boolean');
		}
		if (typeof debounce !== 'number') {
			throw new TypeError('debounce must be a number');
		}
		super();
		// root directory
		this[_dir] = dir;
		// (optional) function to limit watching to certain directories/files
		this[_filter] = filter;
		// (optional) whether to actually watch for changes, or just report all matching files and their stats
		this[_watch] = watch;
		// (optional) number of milliseconds to use to debounce events from FSWatcher
		this[_debounce] = debounce;
		// paths of all directories -> FSWatcher instances
		this[_watchers] = new Map();
		// paths of all files/dirs -> stats
		this[_paths] = new Map();
		// paths of files/dirs with pending debounced events -> setTimeout timer ids
		this[_timeouts] = new Map();
		// queue of pending FSWatcher events to handle
		this[_queue] = [];
		// whether some FSWatcher event is currently already in the process of being handled
		this[_isProcessing] = false;
		// whether init has been called
		this[_isInitStarted] = false;
		// whether close has been called
		this[_isClosed] = false;
	}

	// recurse directory, get stats, set up FSWatcher instances
	async init() {
		if (this[_isInitStarted]) {
			throw new Error('cannot call init() twice');
		}
		this[_isInitStarted] = true;
		await this[_recurse](this[_dir]);
		this.paths = this[_paths];
	}

	// close all FSWatchers
	close() {
		if (!this.paths) {
			throw new Error('cannot call close() before init() finishes');
		}
		if (this[_isClosed]) {
			throw new Error('cannot call close() twice');
		}
		this[_isClosed] = true;
		for (const watcher of this[_watchers].values()) {
			watcher.close();
		}
	}

	// recurse a given directory
	async [_recurse](full) {
		const path = full.slice(this[_dir].length + 1);
		const stats = await statAsync(full);
		if (path) {
			if (this[_filter] && !await this[_filter]({ path, stats })) {
				return;
			}
			this[_paths].set(path, stats);
		}
		if (stats.isDirectory()) {
			if (this[_watch]) {
				this[_watchers].set(
					path,
					watch(full, this[_handle].bind(this, full)).on('error', () => {}),
				);
			}
			await Promise.all(
				(await readdirAsync(full)).map(sub => this[_recurse](full + '/' + sub)),
			);
		}
	}

	// handle FSWatcher event for given directory
	[_handle](dir, event, file) {
		const full = dir + '/' + file;
		if (this[_timeouts].has(full)) {
			clearTimeout(this[_timeouts].get(full));
		}
		this[_timeouts].set(
			full,
			setTimeout(() => {
				this[_timeouts].delete(full);
				this[_enqueue](full);
			}, this[_debounce]),
		);
	}

	// add an FSWatcher event to the queue, and handle queued events
	async [_enqueue](full) {
		this[_queue].push(full);
		if (this[_isProcessing] || !this[_paths]) {
			return;
		}
		this[_isProcessing] = true;
		while (this[_queue].length) {
			const full = this[_queue].shift();
			const path = full.slice(this[_dir].length + 1);
			const stats = await statAsync(full).catch(() => {});
			if (stats) {
				if (this[_filter] && !await this[_filter]({ path, stats })) {
					continue;
				}
				const isNew = !this.paths.has(path);
				this.paths.set(path, stats);
				if (path) {
					this.emit('+', { path, stats, isNew });
				}
				if (stats.isDirectory() && !this[_watchers].has(path)) {
					// note the new directory
					// start watching it, and report any files in it
					await this[_recurse](full);
					for (const [newPath, stats] of this.paths.entries()) {
						if (newPath.startsWith(path + '/')) {
							this.emit('+', { path: newPath, stats, isNew: true });
						}
					}
				}
			} else if (this.paths.has(path)) {
				// note the deleted file/dir
				const stats = this.paths.get(path);
				this.paths.delete(path);
				this.emit('-', { path, stats });
				if (this[_watchers].has(path)) {
					// stop watching it, and report any files/dirs that were in it
					for (const old of this[_watchers].keys()) {
						if (old === path || old.startsWith(path + '/')) {
							this[_watchers].get(old).close();
							this[_watchers].delete(old);
						}
					}
					for (const old of this.paths.keys()) {
						if (old.startsWith(path + '/')) {
							const stats = this.paths.get(old);
							this.paths.delete(old);
							this.emit('-', { path: old, stats });
						}
					}
				}
			}
		}
		this[_isProcessing] = false;
	}
}
