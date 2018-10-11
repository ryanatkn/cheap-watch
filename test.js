const CheapWatch = require('.');

const assert = require('assert');
const child_process = require('child_process');
const fs = require('fs');
const util = require('util');

const exec = util.promisify(child_process.exec);
const mkdir = util.promisify(fs.mkdir);
const rename = util.promisify(fs.rename);
const unlink = util.promisify(fs.unlink);
const writeFile = util.promisify(fs.writeFile);

const rmdir =
	process.platform === 'win32'
		? path =>
				exec(`rmdir /s /q ${path.replace(/\//g, '\\')} 2> nul`).catch(() => {})
		: path => exec('rm -rf ' + path);

const sleep = (ms = 1000) => new Promise(res => setTimeout(res, ms));

function getEvents(watch) {
	const events = new Set();
	watch.on('+', ({ path, stats, isNew }) => {
		const event = `${isNew ? 'new' : 'updated'} ${
			stats.isFile() ? 'file' : ''
		}${stats.isDirectory() ? 'directory' : ''} ${path}`;
		if (events.has(event)) {
			throw new Error(`Duplicate event: ${event}`);
		}
		events.add(event);
	});
	watch.on('-', ({ path, stats }) => {
		const event = `deleted ${stats.isFile() ? 'file' : ''}${
			stats.isDirectory() ? 'directory' : ''
		} ${path}`;
		if (events.has(event)) {
			throw new Error(`Duplicate event: ${event}`);
		}
		events.add(event);
	});
	return events;
}

(async () => {
	process.chdir(__dirname);
	await rmdir('test');
	await mkdir('test');
	process.chdir('test');

	console.log('running tests ...');

	const watch = new CheapWatch({ dir: process.cwd() });
	const events = getEvents(watch);

	await writeFile('foo', '');
	await mkdir('bar');
	await writeFile('bar/baz', '');
	await watch.init();
	assert.equal(watch.paths.size, 3);
	assert.ok(watch.paths.get('foo').isFile());
	assert.ok(watch.paths.get('bar').isDirectory());
	assert.ok(watch.paths.get('bar/baz').isFile());

	await writeFile('foo', '');
	await sleep();
	assert.ok(events.has('updated file foo'));
	events.clear();

	await writeFile('bar/qux', '');
	await sleep();
	assert.ok(events.has('new file bar/qux'));
	assert.ok(events.has('updated directory bar'));
	events.clear();

	await rmdir('bar');
	await sleep();
	assert.ok(events.has('deleted directory bar'));
	assert.ok(events.has('deleted file bar/baz'));
	assert.ok(events.has('deleted file bar/qux'));
	events.clear();

	await unlink('foo');
	await sleep();
	assert.ok(events.has('deleted file foo'));
	events.clear();

	await Promise.all([writeFile('foo', ''), writeFile('bar', '')]);
	await sleep();
	assert.ok(events.has('new file foo'));
	assert.ok(events.has('new file bar'));
	events.clear();

	watch.close();

	await writeFile('foo', '');
	await sleep();
	assert.equal(events.size, 0);

	const watch2 = new CheapWatch({
		dir: process.cwd(),
		filter: ({ path, stats }) =>
			(stats.isFile() && !path.includes('skip-file')) ||
			(stats.isDirectory() && !path.includes('skip-directory')),
	});
	const events2 = getEvents(watch2);

	await watch2.init();

	await writeFile('skip-file', '');
	await sleep();
	assert.equal(events2.size, 0);

	await writeFile('foo', '');
	await sleep();
	assert.ok(events2.has('updated file foo'));
	events2.clear();

	await mkdir('skip-directory');
	await sleep();
	assert.equal(events2.size, 0);

	await writeFile('skip-directory/foo', '');
	await sleep();
	assert.equal(events2.size, 0);

	await mkdir('included-directory');
	await sleep();
	assert.ok(events2.has('new directory included-directory'));
	await writeFile('included-directory/foo', '');
	await sleep();
	events2.clear();

	await rename('included-directory/foo', 'included-directory/foo-2');
	await sleep();
	assert.ok(events2.has('deleted file included-directory/foo'));
	assert.ok(events2.has('new file included-directory/foo-2'));
	assert.ok(events2.has('updated directory included-directory'));
	events2.clear();

	await rename('included-directory', 'included-directory-2');
	await sleep();
	assert.ok(events2.has('deleted directory included-directory'));
	assert.ok(events2.has('deleted file included-directory/foo-2'));
	assert.ok(events2.has('new directory included-directory-2'));
	assert.ok(events2.has('new file included-directory-2/foo-2'));
	events2.clear();

	watch2.close();

	console.log('tests successful!');

	process.chdir(__dirname);
	await rmdir('test');
})().catch(({ stack }) => {
	console.error(stack);
	process.exit(1);
});
