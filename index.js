const EventEmitter = require('events');
const stream = require('stream');
const Watcher = require('./lib/watcher');
const Ssh = require('./lib/ssh');
const Sync = require('./lib/sync');

const devNull = new stream.Writable();

class RemoteCode {
	constructor(opts = {}) {
		this.options = opts;
		this.emitter = new EventEmitter();
		this.ssh = {
			liveReload: new Ssh()
		};
		this.verbose = true;
		this.stdout = opts.stdout instanceof stream.Writable ? opts.stdout : new stream.Writable();
		this.stderr = opts.stderr instanceof stream.Writable ? opts.stderr : new stream.Writable();
		this.watcher = new Watcher(opts);
		this.sync = new Sync(opts)
			.addStdOutStream(this.stdout)
			.addStdErrStream(this.stderr);

		return this;
	}

	syncCode() {
		this.emitter.emit('sync');
		return this.sync.execute();
	}

	_getStdOut() {
		if (this.verbose) {
			return this.stdout;
		}
		return devNull;
	}

	_getStdErr() {
		if (this.verbose) {
			return this.stderr;
		}
		return devNull;
	}

	watch() {
		this.watcher.start();
		const emitter = this.watcher.getEventEmitter();
		emitter.on('sync', () => {
			this.syncCode();
		});
		emitter.on('install', () => {
			return this.install()
			.then(() => {
				// this.ssh.liveReload.send('rs');
				//console.log('RESTARTERING')
			});
		});
		return this.emitter;
	}

	start() {
		this.emitter.emit('start');
		const sshSettings = this.options.ssh;
		return Promise.all([this.ssh.liveReload.connect(sshSettings),
			this.syncCode(), this.watch()])
			.then(() => this.install())
			.then(() => {
				this.ssh.liveReload.send(`cd ${this.options.target} && nodemon .`);
			})
			.catch(console.log.bind(console));
	}

	// execute a single command and then resolve
	execute(cmd, stdout, stderr) {
		this.emitter.emit('exec', cmd);
		const ssh = new Ssh();
		return ssh.exec(this.options.ssh, cmd, stdout, stderr);
	}

	install() {
		this.emitter.emit('install', 'triggered');
		if (!this.installInProgress) {
			this.emitter.emit('install', 'started');
			this.installInProgress = true;
			return this.execute(`cd ${this.options.target} && yarn`, this._getStdOut(), this._getStdErr())
			.then(res => {
				this.emitter.emit('install', 'ended', res);
				this.installInProgress = false;
				// console.log(res);
				return res;
			});
		}
		return Promise.resolve();
	}

	close() {
		this.emitter.emit('close');
		return Promise.all([this.watcher.close(),
			this.ssh.liveReload.close()]);
	}
}

module.exports = RemoteCode;
