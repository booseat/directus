import type SmsGateway from '../sms/gateway.js';
import type { Accountability, SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import type { AbstractServiceOptions } from '../types/services.js';
import getSmsSender from '../sms/sms-sender.js';
import { useEnv } from '../env.js';
import logger from '../logger.js';
import { SettingsService } from './settings.js';

const env = useEnv();

export class SmsService {
	schema: SchemaOverview;
	accountability: Accountability | null;
	knex: Knex;
	smsSender: SmsGateway;

	constructor(opts: AbstractServiceOptions) {
		this.schema = opts.schema;
		this.accountability = opts.accountability || null;
		this.knex = opts?.knex || getDatabase();
		this.smsSender = getSmsSender();

		if (env['SMS_VERIFY_SETUP']) {
			this.smsSender.verify().catch((error) => {
				if (error) {
					logger.warn(`Sms connection failed:`);
					logger.warn(error);
				}
			});
		}
	}

	async send(recipients: string[], message: string): Promise<void> {
		const settingsService = new SettingsService({
			knex: this.knex,
			schema: this.schema,
		});

		const project = await settingsService.readSingleton({
			fields: ['project_name'],
		});

		try {
			const response = await this.smsSender.send(project['project_name'], recipients, message);
			logger.debug(response);
		} catch (err: any) {
			logger.warn(`Sms sending failed:`);
			logger.warn(err);
		}
	}
}
