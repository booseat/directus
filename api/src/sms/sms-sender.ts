import { useEnv } from '@booseat/directus-env';
import type SmsGateway from './gateway.js';
import MessagebirdGateway from './gateways/messagebird.js';


let gateway: SmsGateway;

export default function getSmsSender(): SmsGateway {
	if (gateway) return gateway;

	const env = useEnv();

	const gatewayName = (env['SMS_GATEWAY'] as string).toLowerCase();

	if (gatewayName === 'messagebird') {
		gateway = new MessagebirdGateway(env['SMS_MESSAGEBIRD_TOKEN'] as string);
	}

	return gateway;
}
