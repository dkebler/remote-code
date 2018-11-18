const EventEmitter = require('events')
const stream = require('stream')
const config = require('config')
const Watcher = require('./lib/watcher')
const Ssh = require('./lib/ssh')
const Sync = require('./lib/sync')

const devNull = new stream.Writable()
devNull._write = () => null

class RemoteCode {
	constructor(opts = {}) {
		// Note: config.get returns immutable object so need to clone to change things
		this.options = opts.host ? opts : Object.assign({}, config.get('options'))
		// Set defaults
		this.options.ssh.keepaliveInterval = opts.ssh.keepaliveInterval || 500
		this.options.ssh.readyTimeout = opts.ssh.readyTimeout || 2000
		this.options.ssh.port = opts.ssh.port || 22
		this.options.source = opts.source || '.'
		this.options.install = opts.install || 'yarn'
		this.options.install = opts.registry ? `${this.options.install} --registry ${opts.registry}` : this.options.install
		this.options.start = opts.start || 'nodemon .'
		if (!(opts.ssh.keyfilePath || opts.ssh.password)) {
			this.options.ssh.agent = process.env[opts.ssh.agent] || process.env.SSH_AUTH_SOCK || process.env.SSH_AGENT_SOCK
			if (!this.options.ssh.agent) {
				return new Error('no ssh authentification method provided')
			}
		}
		this.emitter = new EventEmitter()
		this.ssh = {
			liveReload: new Ssh()
		}
		this.verbose = opts.verbose || false
		this.stdout = opts.stdout instanceof stream.Writable ? opts.stdout : new stream.Writable()
		this.stderr = opts.stderr instanceof stream.Writable ? opts.stderr : new stream.Writable()
		this.watcher = new Watcher(this.options)
		this.sync = new Sync(this.options)
			.addStdOutStream(this.stdout)
			.addStdErrStream(this.stderr)

		return this
	}

	syncCode() {
		this.emitter.emit('sync')
		return this.sync.execute()
	}

	_getStdOut() {
		if (this.verbose) {
			return this.stdout
		}
		return devNull
	}

	_getStdErr() {
		if (this.verbose) {
			return this.stderr
		}
		return devNull
	}

	watch() {
		this.watcher.start()
		const watchEmitter = this.watcher.getEventEmitter()
		watchEmitter.on('sync', () => {
			this.syncCode()
		})
		watchEmitter.on('install', () => {
			return this.install()
				.then(() => {
					this.ssh.liveReload.send('rs')
				})
		})
		return this.emitter
	}

	start() {
		this.emitter.emit('start')
		const sshSettings = this.options.ssh
		return Promise.all([this.syncCode(), this.watch()])
			.then(() => this.install())
			.then(() => this.ssh.liveReload.connect(sshSettings))
			.then(() => {
				this.emitter.emit('nodemon', 'start')
				this.ssh.liveReload.send(`cd ${this.options.target} && ${this.options.start}`)
			})
			.catch(this._abort.bind(this))
	}

	// execute a single command and then resolve
	execute(cmd, stdout, stderr) {
		this.emitter.emit('exec', cmd)
		const ssh = new Ssh()
		const result = ssh.exec(this.options.ssh, cmd, stdout, stderr)
		return result
	}

	install() {
		this.emitter.emit('install', 'triggered')
		if (!this.installInProgress) {
			this.emitter.emit('install', 'started')
			this.installInProgress = true
			console.log('starting install', this.options.install)
			// TODO: Need to set a timeout on this process in case it hangs
			return this.execute(`cd ${this.options.target} && ${this.options.install}`, this._getStdOut(), this._getStdErr())
				.then(res => {
					this.emitter.emit('install', 'ended', res)
					this.installInProgress = false
					return res
				})
		}
		return Promise.resolve()
	}

	close() {
		this.emitter.emit('close')
		return Promise.all([this.watcher.close(),
			this.ssh.liveReload.close()])
	}

	_abort(err) {
		this.emitter.emit('error', err)
	}
}

module.exports = RemoteCode
