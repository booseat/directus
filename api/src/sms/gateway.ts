export default interface SmsGateway {
	/**
	 * Send message to recipients
	 * @param sender The sender for the message
	 * @param recipients The phone numbers that will receive the message
	 * @param message The message to send to phone numbers
	 */
	send(sender: string, recipients: string[], message: string): Promise<true>;

	/**
	 * Check if sms setup is properly configured.
	 */
	verify(): Promise<true>;
}
