import { initClient, type MessageBird } from 'messagebird';
import type SmsGateway from '../gateway.js';

export default class MessagebirdGateway implements SmsGateway {
	private client: MessageBird;

	constructor(token: string) {
		this.client = initClient(token);
	}

	send(sender: string, recipients: string[], message: string): Promise<any> {
		return new Promise((resolve, reject) => {
			this.client.messages.create(
				{
					originator: sender,
					recipients: recipients,
					body: message,
				},
				function (err, response) {
					if (err) reject(err);
					else resolve(response);
				},
			);
		});
	}

	verify(): Promise<true> {
		return new Promise((resolve, reject) => {
			this.client.balance.read(function (err) {
				if (err) reject(err);
				else resolve(true);
			});
		});
	}
}
