import { useEnv } from '../env.js';
import type SmsGateway from './gateway.js';
import MessagebirdGateway from './gateways/messagebird.js';


let gateway: SmsGateway;

export default function getSmsSender(): SmsGateway {
	if (gateway) return gateway;

	const env = useEnv();

	const gatewayName = env['SMS_GATEWAY'].toLowerCase();

	if (gatewayName === 'messagebird') {
		gateway = new MessagebirdGateway(env['SMS_MESSAGEBIRD_TOKEN']);
	}

	return gateway;
}
