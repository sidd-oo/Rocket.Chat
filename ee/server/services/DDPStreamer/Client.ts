import { EventEmitter } from 'events';

import { v1 as uuidv1 } from 'uuid';
import WebSocket from 'ws';
import { ServiceBroker } from 'moleculer';

import { DDP_EVENTS, WS_ERRORS, WS_ERRORS_MESSAGES, TIMEOUT } from './constants';
import { server, SERVER_ID } from './Server';
import { IPacket } from './types/IPacket';

export class Client extends EventEmitter {
	protected kind = 'default';

	private timeout: NodeJS.Timeout;

	private chain = Promise.resolve();

	public session = uuidv1();

	public subscriptions = new Map();

	public wait = false;

	public uid: string;

	constructor(
		public ws: WebSocket,
		public broker: ServiceBroker,
	) {
		super();

		this.renewTimeout(TIMEOUT / 1000);
		this.ws.on('message', this.handler);
		this.ws.on('close', (...args) => {
			server.emit(DDP_EVENTS.DISCONNECTED, this);
			this.emit('close', ...args);
			this.subscriptions.clear();
			clearTimeout(this.timeout);
		});

		this.setMaxListeners(50);

		this.greeting();

		server.emit(DDP_EVENTS.CONNECTED, this);

		this.ws.on('message', () => this.renewTimeout(TIMEOUT));

		this.once('message', ({ msg }) => {
			if (msg !== DDP_EVENTS.CONNECT) {
				return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR, WS_ERRORS_MESSAGES.CLOSE_PROTOCOL_ERROR);
			}
			return this.send(
				server.serialize({ [DDP_EVENTS.MSG]: DDP_EVENTS.CONNECTED, session: this.session }),
			);
		});

		this.send(SERVER_ID);
	}

	greeting(): void {
		// no greeting by default
	}

	async callMethod(packet: IPacket): Promise<void> {
		this.chain = this.chain.then(() => server.callMethod(this, packet)).catch();
	}

	async callSubscribe(packet: IPacket): Promise<void> {
		this.chain = this.chain.then(() => server.callSubscribe(this, packet)).catch();
	}

	process(action: string, packet: IPacket): void {
		switch (action) {
			case DDP_EVENTS.PING:
				this.pong(packet.id);
				break;
			case DDP_EVENTS.METHOD:
				if (!packet.method) {
					return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR);
				}
				if (!packet.id) {
					return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR);
				}
				this.callMethod(packet);
				break;
			case DDP_EVENTS.SUSBCRIBE:
				if (!packet.name) {
					return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR);
				}
				if (!packet.id) {
					return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR);
				}
				this.callSubscribe(packet);
				break;
			case DDP_EVENTS.UNSUBSCRIBE:
				if (!packet.id) {
					return this.ws.close(WS_ERRORS.CLOSE_PROTOCOL_ERROR);
				}
				const subscription = this.subscriptions.get(packet.id);
				if (!subscription) {
					return;
				}
				subscription.stop();
				break;
		}
	}

	closeTimeout = (): void => {
		this.ws.close(WS_ERRORS.TIMEOUT, WS_ERRORS_MESSAGES.TIMEOUT);
	};

	ping(id?: string): void {
		this.send(server.serialize({ [DDP_EVENTS.MSG]: DDP_EVENTS.PING, ...id && { [DDP_EVENTS.ID]: id } }));
	}

	pong(id?: string): void {
		this.send(server.serialize({ [DDP_EVENTS.MSG]: DDP_EVENTS.PONG, ...id && { [DDP_EVENTS.ID]: id } }));
	}

	handleIdle = (): void => {
		this.ping();
		this.timeout = setTimeout(this.closeTimeout, TIMEOUT);
	};

	renewTimeout(timeout = TIMEOUT): void {
		clearTimeout(this.timeout);
		this.timeout = setTimeout(this.handleIdle, timeout);
	}

	handler = async (payload: string): Promise<void> => {
		try {
			const packet = server.parse(payload);
			this.emit('message', packet);
			if (this.wait) {
				return new Promise((resolve) => this.once(DDP_EVENTS.LOGGED, () => resolve(this.process(packet.msg, packet))));
			}
			this.process(packet.msg, packet);
		} catch (err) {
			return this.ws.close(
				WS_ERRORS.UNSUPPORTED_DATA,
				WS_ERRORS_MESSAGES.UNSUPPORTED_DATA,
			);
		}
	};

	send(payload: string): void {
		return this.ws.send(payload);
	}
}

export class MeteorClient extends Client {
	kind = 'meteor';

	// TODO implement meteor errors
	// a["{\"msg\":\"result\",\"id\":\"12\",\"error\":{\"isClientSafe\":true,\"error\":403,\"reason\":\"User has no password set\",\"message\":\"User has no password set [403]\",\"errorType\":\"Meteor.Error\"}}"]

	greeting(): void {
		return this.ws.send('o');
	}

	send(payload: string): void {
		return this.ws.send(`a${ JSON.stringify([payload]) }`);
	}
}