import * as proto from '../shared/proto.js';
import * as convert from './convert.js';

const EventEmitter = require('events'),
	http = require('http'),
	WebSocketServer = require('ws').Server,
	cookie = require('cookie'),
	rollup = require('rollup'),
	alias = require('rollup-plugin-alias'),
	MAX_UINT32 = Math.pow(2, 32) - 1;

let clientSource = null;
function generateClientSource() {
	if (clientSource !== null && process.env.NODE_ENV === 'production') return Promise.resolve(clientSource);
	else {
		let plugins = [
			alias({
				'<@convert@>': './../client/convert.js'
			})
		];
		if (process.env.NODE_ENV !== 'production') {
			const eslint = require('rollup-plugin-eslint');
			plugins.push(eslint());
		}
		return new Promise((resolve, reject) => {
			rollup.rollup({
				entry: __dirname + '/client/master_connection.js',
				plugins
			}).then(bundle => {
				clientSource = bundle.generate({
					format: 'iife',
					moduleName: 'MasterConnection'
				});
				resolve(clientSource);
			}).catch(reject);
		});
	}
}

export default class Master extends EventEmitter {
	constructor(server) {
		super();

		function sendSource(res) {
			res.writeHead(200, {'Content-Type': 'application/javascript'});
			generateClientSource().then(source => {
				res.end(source.code);
			}).catch(console.error);
		}

		// fat arrow function needed for lexical scoping
		const wsSrvFactory = (httpSrv, type) => {
			let wsSrv = new WebSocketServer({
				server: httpSrv,
				path: '/enslavism/' + type + 's',
				verifyClient: (info, cb) => {
					let accept = true,
						reason,
						authData = info.req.headers.cookie === undefined ? {} : cookie.parse(info.req.headers.cookie);
					this.emit(type + 'auth', authData, (rejectionReason) => {
						reason = rejectionReason;
						accept = false;
					});

					if (accept === true) cb(true);
					else cb(false, 401, reason);
				}
			});

			wsSrv.currentId = 0;
			wsSrv.wrapMode = false;
			wsSrv.on('error', err => {
				this.emit('error', err);
			});
			wsSrv.on('connection', ws => {
				this.emit(type + 'connection', ws);
			});

			return wsSrv;
		};


		if (typeof server === 'number') {
			this._httpServer = http.createServer((req, res) => {
				if (req.url === '/enslavism/client.js') sendSource(res);
				else {
					res.writeHead(404);
					res.end('404\nNot found');
				}
			});

			this._httpServer.listen(server);
		} else {
			let userDefReqListeners = server.listeners('request');

			server.removeAllListeners('request');

			server.on('request', (req, res) => {
				if (req.url === '/enslavism/client.js') sendSource(res);
				else {
					for (let listener of userDefReqListeners) {
						listener.call(server, req, res);
					}
				}
			});

			this._httpServer = server;
		}


		this._slavesSocket = wsSrvFactory(this._httpServer, 'slave');
		this._clientsSocket = wsSrvFactory(this._httpServer, 'client');


		this._slavesSocket.on('connection', ws => {
			ws.id = this.giveId(this._slavesSocket);

			ws.on('message', msg => {
				msg = convert.bufferToArrayBuffer(msg);

				switch (proto.getSerializator(msg)) {
					case proto.register: {
						ws.userData = proto.register.deserialize(msg);
						let newSlaveBuf = proto.addSlaves.serialize([ws]);
						for (let client of this._clientsSocket.clients) {
							client.send(newSlaveBuf);
						}
						break;
					}
					case proto.answerToClient: {
						let receiver = this.findClient(proto.answerToClient.getDestId(msg));
						if (receiver !== undefined) {
							proto.answerFromSlave.setDestId(msg, ws.id);
							receiver.send(msg);
						}
						break;
					}
					case proto.iceCandidateToClient: {
						let receiver = this.findClient(proto.iceCandidateToClient.getDestId(msg));
						if (receiver !== undefined) {
							proto.iceCandidateFromSlave.setDestId(msg, ws.id);
							receiver.send(msg);
						}
						break;
					}
					case proto.rejectToClient: {
						let receiver = this.findClient(proto.rejectToClient.deserialize(msg));
						if (receiver !== undefined) {
							receiver.send(proto.rejectFromSlave.serialize(ws.id));
						}
						break;
					}

				}
			});
			ws.on('close', () => {
				let removeSlaveBuf = proto.removeSlaves.serialize([ws.id]);
				for (let client of this._clientsSocket.clients) {
					client.send(removeSlaveBuf);
				}
			});
		});

		this._clientsSocket.on('connection', ws => {
			ws.id = this.giveId(this._clientsSocket);

			ws.send(proto.addSlaves.serialize(this._slavesSocket.clients));

			ws.on('message', msg => {
				msg = convert.bufferToArrayBuffer(msg);

				switch (proto.getSerializator(msg)) {
					case proto.offerToSlave: {
						let receiver = this.findSlave(proto.offerFromClient.getDestId(msg));
						if (receiver !== undefined) {
							proto.offerFromClient.setDestId(msg, ws.id);
							receiver.send(msg);
						}
						break;
					}
					case proto.iceCandidateToSlave: {
						let receiver = this.findSlave(proto.iceCandidateToSlave.getDestId(msg));
						if (receiver !== undefined) {
							proto.iceCandidateFromClient.setDestId(msg, ws.id);
							receiver.send(msg);
						}
						break;
					}
				}
			});
		});
	}
	findSlave(id) { // get slave corresponding to this id
		return this._slavesSocket.clients.find(slave => {
			return slave.id === id;
		});
	}
	findClient(id) { // get client corresponding to this id
		return this._clientsSocket.clients.find(client => {
			return client.id === id;
		});
	}
	giveId(wss) {
		if (wss.currentId > MAX_UINT32) {
			wss.currentId = 0;
			wss.wrapMode = true;
		}
		if (wss.wrapMode) {
			// since the maximum size of an array is 2^32 - 1
			// that means that if the server has be able to add an object to wss.clients, there is at least an id available for it
			while (wss.currentId <= MAX_UINT32 && wss.clients.find((client) => {
				return client.id === wss.currentId;
			}) !== undefined) ++wss.currentId;
		}
		return wss.currentId++;
	}
}
