import { useEnv } from '@booseat/directus-env';
import { ForbiddenError, InvalidPayloadError, RecordNotUniqueError, UnprocessableContentError } from '@directus/errors';
import type { Query } from '@directus/types';
import { getSimpleHash, toArray } from '@directus/utils';
import { FailedValidationError, joiValidationErrorItemToErrorExtensions } from '@booseat/directus-validation';
import Joi from 'joi';
import jwt from 'jsonwebtoken';
import { cloneDeep, isEmpty } from 'lodash-es';
import { performance } from 'perf_hooks';
import getDatabase from '../database/index.js';
import type { AbstractServiceOptions, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import isUrlAllowed from '../utils/is-url-allowed.js';
import { verifyJWT } from '../utils/jwt.js';
import { stall } from '../utils/stall.js';
import { Url } from '../utils/url.js';
import { ItemsService } from './items.js';
import { MailService } from './mail/index.js';
import { SettingsService } from './settings.js';
import { SmsService } from './sms.js';
import { getMilliseconds } from '../utils/get-milliseconds.js';
import { TranslationsService } from './translations.js';
import { generateHash } from '../utils/generate-hash.js';

const env = useEnv();

export class UsersService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_users', options);

		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.schema = options.schema;
	}

	/**
	 * User email has to be unique case-insensitive. This is an additional check to make sure that
	 * the email is unique regardless of casing
	 */
	private async checkUniqueEmails(emails: string[], excludeKey?: PrimaryKey): Promise<void> {
		emails = emails.map((email) => email.toLowerCase());

		const duplicates = emails.filter((value, index, array) => array.indexOf(value) !== index);

		if (duplicates.length) {
			throw new RecordNotUniqueError({
				collection: 'directus_users',
				field: 'email',
			});
		}

		const query = this.knex
			.select('email')
			.from('directus_users')
			.whereRaw(`LOWER(??) IN (${emails.map(() => '?')})`, ['email', ...emails]);

		if (excludeKey) {
			query.whereNot('id', excludeKey);
		}

		const results = await query;

		if (results.length) {
			throw new RecordNotUniqueError({
				collection: 'directus_users',
				field: 'email',
			});
		}
	}

	/**
	 * User phone number has to be unique. This is an additional check to make sure that
	 * the phone number is unique regardless of casing
	 */
	private async checkUniquePhoneNumbers(phoneNumbers: string[], excludeKey?: PrimaryKey): Promise<void> {
		const duplicates = phoneNumbers.filter((value, index, array) => array.indexOf(value) !== index);

		if (duplicates.length) {
			throw new RecordNotUniqueError({
				collection: 'directus_users',
				field: 'phone_number',
			});
		}

		const query = this.knex
			.select('phone_number')
			.from('directus_users')
			.whereRaw(`?? IN (${phoneNumbers.map(() => '?')})`, ['phone_number', ...phoneNumbers]);

		if (excludeKey) {
			query.whereNot('id', excludeKey);
		}

		const results = await query;

		if (results.length) {
			throw new RecordNotUniqueError({
				collection: 'directus_users',
				field: 'phone_number',
			});
		}
	}

	/**
	 * Check if the provided password matches the strictness as configured in
	 * directus_settings.auth_password_policy
	 */
	private async checkPasswordPolicy(passwords: string[]): Promise<void> {
		const settingsService = new SettingsService({
			schema: this.schema,
			knex: this.knex,
		});

		const { auth_password_policy: policyRegExString } = await settingsService.readSingleton({
			fields: ['auth_password_policy'],
		});

		if (!policyRegExString) {
			return;
		}

		const wrapped = policyRegExString.startsWith('/') && policyRegExString.endsWith('/');
		const regex = new RegExp(wrapped ? policyRegExString.slice(1, -1) : policyRegExString);

		for (const password of passwords) {
			if (!regex.test(password)) {
				throw new FailedValidationError(
					joiValidationErrorItemToErrorExtensions({
						message: `Provided password doesn't match password policy`,
						path: ['password'],
						type: 'custom.pattern.base',
						context: {
							value: password,
						},
					}),
				);
			}
		}
	}

	private async checkRemainingAdminExistence(excludeKeys: PrimaryKey[]) {
		// Make sure there's at least one admin user left after this deletion is done
		const otherAdminUsers = await this.knex
			.count('*', { as: 'count' })
			.from('directus_users')
			.whereNotIn('directus_users.id', excludeKeys)
			.andWhere({ 'directus_roles.admin_access': true })
			.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
			.first();

		const otherAdminUsersCount = +(otherAdminUsers?.count || 0);

		if (otherAdminUsersCount === 0) {
			throw new UnprocessableContentError({ reason: `You can't remove the last admin user from the role` });
		}
	}

	/**
	 * Make sure there's at least one active admin user when updating user status
	 */
	private async checkRemainingActiveAdmin(excludeKeys: PrimaryKey[]): Promise<void> {
		const otherAdminUsers = await this.knex
			.count('*', { as: 'count' })
			.from('directus_users')
			.whereNotIn('directus_users.id', excludeKeys)
			.andWhere({ 'directus_roles.admin_access': true })
			.andWhere({ 'directus_users.status': 'active' })
			.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
			.first();

		const otherAdminUsersCount = +(otherAdminUsers?.count || 0);

		if (otherAdminUsersCount === 0) {
			throw new UnprocessableContentError({ reason: `You can't change the active status of the last admin user` });
		}
	}

	/**
	 * Get basic information of user identified by email
	 */
	private async getUserByEmail(
		email: string,
	): Promise<{ id: string; role: string; status: string; password: string; email: string } | undefined> {
		return await this.knex
			.select('id', 'role', 'status', 'password', 'email')
			.from('directus_users')
			.whereRaw(`LOWER(??) = ?`, ['email', email.toLowerCase()])
			.first();
	}

	/**
	 * Get basic information of user identified by phone number
	 */
	private async getUserByPhoneNumber(phoneNumber: string): Promise<{
		id: string;
		role: string;
		status: string;
		password: string;
		email: string;
		phoneNumber: string;
		language: string;
	}> {
		return await this.knex
			.select('id', 'role', 'status', 'password', 'email', 'phone_number', 'language')
			.from('directus_users')
			.whereRaw(`?? = ?`, ['phone_number', phoneNumber])
			.first();
	}

	/**
	 * Create url for inviting users
	 */
	private inviteUrl(email: string, url: string | null): string {
		const payload = { email, scope: 'invite' };

		const token = jwt.sign(payload, env['SECRET'] as string, { expiresIn: '7d', issuer: 'directus' });
		const inviteURL = url ? new Url(url) : new Url(env['PUBLIC_URL'] as string).addPath('admin', 'accept-invite');
		inviteURL.setQuery('token', token);

		return inviteURL.toString();
	}

	/**
	 * Validate array of emails. Intended to be used with create/update users
	 */
	private validateEmail(input: string | string[]) {
		const emails = Array.isArray(input) ? input : [input];

		const schema = Joi.string().email().required();

		for (const email of emails) {
			const { error } = schema.validate(email);

			if (error) {
				throw new FailedValidationError({
					field: 'email',
					type: 'email',
				});
			}
		}
	}

	/**
	 * Validate array of phone numbers. Intended to be used with create/update users
	 */
	private validatePhoneNumber(input: string | string[]) {
		const phoneNumbers = Array.isArray(input) ? input : [input];

		const schema = Joi.string().pattern(new RegExp('^\\+[1-9]\\d{1,14}$')).required();

		for (const phoneNumber of phoneNumbers) {
			const { error } = schema.validate(phoneNumber);

			if (error) {
				throw new FailedValidationError({
					field: 'phone_number',
					type: 'phone',
				});
			}
		}
	}

	/**
	 * Create a new user
	 */
	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		const result = await this.createMany([data], opts);
		return result[0]!;
	}

	/**
	 * Create multiple new users
	 */
	override async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const emails = data['map']((payload) => payload['email']).filter((email) => email);
		const passwords = data['map']((payload) => payload['password']).filter((password) => password);
		const phoneNumbers = data['map']((payload) => payload['phone_number']).filter((phoneNumber) => phoneNumber);

		try {
			if (emails.length) {
				this.validateEmail(emails);
				await this.checkUniqueEmails(emails);
			}

			if (passwords.length) {
				await this.checkPasswordPolicy(passwords);
			}

			if (phoneNumbers.length) {
				this.validatePhoneNumber(phoneNumbers);
				await this.checkUniquePhoneNumbers(phoneNumbers);
			}
		} catch (err: any) {
			(opts || (opts = {})).preMutationError = err;
		}

		return await super.createMany(data, opts);
	}

	/**
	 * Update many users by query
	 */
	override async updateByQuery(query: Query, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		const keys = await this.getKeysByQuery(query);
		return keys.length ? await this.updateMany(keys, data, opts) : [];
	}

	/**
	 * Update a single user by primary key
	 */
	override async updateOne(key: PrimaryKey, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		await this.updateMany([key], data, opts);
		return key;
	}

	override async updateBatch(data: Partial<Item>[], opts: MutationOptions = {}): Promise<PrimaryKey[]> {
		if (!opts.mutationTracker) opts.mutationTracker = this.createMutationTracker();

		const primaryKeyField = this.schema.collections[this.collection]!.primary;

		const keys: PrimaryKey[] = [];

		await this.knex.transaction(async (trx) => {
			const service = new UsersService({
				accountability: this.accountability,
				knex: trx,
				schema: this.schema,
			});

			for (const item of data) {
				if (!item[primaryKeyField]) throw new InvalidPayloadError({ reason: `User in update misses primary key` });
				keys.push(await service.updateOne(item[primaryKeyField]!, item, opts));
			}
		});

		return keys;
	}

	/**
	 * Update many users by primary key
	 */
	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		try {
			if (data['role']) {
				/*
				 * data['role'] has the following cases:
				 * - a string with existing role id
				 * - an object with existing role id for GraphQL mutations
				 * - an object with data for new role
				 */
				const role = data['role']?.id ?? data['role'];

				let newRole;

				if (typeof role === 'string') {
					newRole = await this.knex.select('admin_access').from('directus_roles').where('id', role).first();
				} else {
					newRole = role;
				}

				if (!newRole?.admin_access) {
					await this.checkRemainingAdminExistence(keys);
				}
			}

			if (data['status'] !== undefined && data['status'] !== 'active') {
				await this.checkRemainingActiveAdmin(keys);
			}

			if (data['email']) {
				if (keys.length > 1) {
					throw new RecordNotUniqueError({
						collection: 'directus_users',
						field: 'email',
					});
				}

				this.validateEmail(data['email']);
				await this.checkUniqueEmails([data['email']], keys[0]);
			}

			if (data['phone_number']) {
				if (keys.length > 1) {
					throw new RecordNotUniqueError({
						collection: 'directus_users',
						field: 'phone_number',
					});
				}

				this.validatePhoneNumber(data['phone_number']);
				await this.checkUniquePhoneNumbers([data['phone_number']], keys[0]);
			}

			if (data['password']) {
				await this.checkPasswordPolicy([data['password']]);
			}

			if (data['tfa_secret'] !== undefined) {
				throw new InvalidPayloadError({ reason: `You can't change the "tfa_secret" value manually` });
			}

			if (data['provider'] !== undefined) {
				if (this.accountability && this.accountability.admin !== true) {
					throw new InvalidPayloadError({ reason: `You can't change the "provider" value manually` });
				}

				data['auth_data'] = null;
			}

			if (data['external_identifier'] !== undefined) {
				if (this.accountability && this.accountability.admin !== true) {
					throw new InvalidPayloadError({ reason: `You can't change the "external_identifier" value manually` });
				}

				data['auth_data'] = null;
			}
		} catch (err: any) {
			(opts || (opts = {})).preMutationError = err;
		}

		return await super.updateMany(keys, data, opts);
	}

	/**
	 * Delete a single user by primary key
	 */
	override async deleteOne(key: PrimaryKey, opts?: MutationOptions): Promise<PrimaryKey> {
		await this.deleteMany([key], opts);
		return key;
	}

	/**
	 * Delete multiple users by primary key
	 */
	override async deleteMany(keys: PrimaryKey[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		try {
			await this.checkRemainingAdminExistence(keys);
		} catch (err: any) {
			(opts || (opts = {})).preMutationError = err;
		}

		// Manual constraint, see https://github.com/directus/directus/pull/19912
		await this.knex('directus_notifications').update({ sender: null }).whereIn('sender', keys);
		await this.knex('directus_versions').update({ user_updated: null }).whereIn('user_updated', keys);

		await super.deleteMany(keys, opts);
		return keys;
	}

	override async deleteByQuery(query: Query, opts?: MutationOptions): Promise<PrimaryKey[]> {
		const primaryKeyField = this.schema.collections[this.collection]!.primary;
		const readQuery = cloneDeep(query);
		readQuery.fields = [primaryKeyField];

		// Not authenticated:
		const itemsService = new ItemsService(this.collection, {
			knex: this.knex,
			schema: this.schema,
		});

		const itemsToDelete = await itemsService.readByQuery(readQuery);
		const keys: PrimaryKey[] = itemsToDelete.map((item: Item) => item[primaryKeyField]);

		if (keys.length === 0) return [];

		return await this.deleteMany(keys, opts);
	}

	async inviteUser(email: string | string[], role: string, url: string | null, subject?: string | null): Promise<void> {
		const opts: MutationOptions = {};

		try {
			if (url && isUrlAllowed(url, env['USER_INVITE_URL_ALLOW_LIST'] as string) === false) {
				throw new InvalidPayloadError({ reason: `Url "${url}" can't be used to invite users` });
			}
		} catch (err: any) {
			opts.preMutationError = err;
		}

		const emails = toArray(email);

		const mailService = new MailService({
			schema: this.schema,
			accountability: this.accountability,
		});

		for (const email of emails) {
			// Check if user is known
			const user = await this.getUserByEmail(email);

			// Create user first to verify uniqueness if unknown
			if (isEmpty(user)) {
				await this.createOne({ email, role, status: 'invited' }, opts);

				// For known users update role if changed
			} else if (user.status === 'invited' && user.role !== role) {
				await this.updateOne(user.id, { role }, opts);
			}

			// Send invite for new and already invited users
			if (isEmpty(user) || user.status === 'invited') {
				const subjectLine = subject ?? "You've been invited";

				await mailService.send({
					to: user?.email ?? email,
					subject: subjectLine,
					template: {
						name: 'user-invitation',
						data: {
							url: this.inviteUrl(user?.email ?? email, url),
							email: user?.email ?? email,
						},
					},
				});
			}
		}
	}

	async acceptInvite(token: string, password: string): Promise<void> {
		const { email, scope } = verifyJWT(token, env['SECRET'] as string) as {
			email: string;
			scope: string;
		};

		if (scope !== 'invite') throw new ForbiddenError();

		const user = await this.getUserByEmail(email);

		if (user?.status !== 'invited') {
			throw new InvalidPayloadError({ reason: `Email address ${email} hasn't been invited` });
		}

		// Allow unauthenticated update
		const service = new UsersService({
			knex: this.knex,
			schema: this.schema,
		});

		await service.updateOne(user.id, { password, status: 'active' });
	}

	async requestPasswordReset(email: string, url: string | null, subject?: string | null): Promise<void> {
		const STALL_TIME = 500;
		const timeStart = performance.now();

		const user = await this.getUserByEmail(email);

		if (user?.status !== 'active') {
			await stall(STALL_TIME, timeStart);
			throw new ForbiddenError();
		}

		if (url && isUrlAllowed(url, env['PASSWORD_RESET_URL_ALLOW_LIST'] as string) === false) {
			throw new InvalidPayloadError({ reason: `Url "${url}" can't be used to reset passwords` });
		}

		const mailService = new MailService({
			schema: this.schema,
			knex: this.knex,
			accountability: this.accountability,
		});

		const payload = { email: user.email, scope: 'password-reset', hash: getSimpleHash('' + user.password) };
		const token = jwt.sign(payload, env['SECRET'] as string, { expiresIn: '1d', issuer: 'directus' });

		const acceptURL = url
			? new Url(url).setQuery('token', token).toString()
			: new Url(env['PUBLIC_URL'] as string).addPath('admin', 'reset-password').setQuery('token', token).toString();

		const subjectLine = subject ? subject : 'Password Reset Request';

		await mailService.send({
			to: user.email,
			subject: subjectLine,
			template: {
				name: 'password-reset',
				data: {
					url: acceptURL,
					email: user.email,
				},
			},
		});

		await stall(STALL_TIME, timeStart);
	}

	async resetPassword(token: string, password: string): Promise<void> {
		const { email, scope, hash } = jwt.verify(token, env['SECRET'] as string, { issuer: 'directus' }) as {
			email: string;
			scope: string;
			hash: string;
		};

		if (scope !== 'password-reset' || !hash) throw new ForbiddenError();

		const opts: MutationOptions = {};

		try {
			await this.checkPasswordPolicy([password]);
		} catch (err: any) {
			opts.preMutationError = err;
		}

		const user = await this.getUserByEmail(email);

		if (user?.status !== 'active' || hash !== getSimpleHash('' + user.password)) {
			throw new ForbiddenError();
		}

		// Allow unauthenticated update
		const service = new UsersService({
			knex: this.knex,
			schema: this.schema,
			accountability: {
				...(this.accountability ?? { role: null }),
				admin: true, // We need to skip permissions checks for the update call below
			},
		});

		await service.updateOne(user.id, { password, status: 'active' }, opts);
	}

	async requestOneTimePassword(phoneNumber: string): Promise<void> {
		const smsService = new SmsService({
			schema: this.schema,
			knex: this.knex,
			accountability: this.accountability,
		});

		const translationsService = new TranslationsService({
			accountability: this.accountability,
			schema: this.schema,
		});

		const settingsService = new SettingsService({
			knex: this.knex,
			schema: this.schema,
		});

		let otp = '';

		for (let i = 0; i < 6; i++) {
			otp += Math.floor(Math.random() * 10);
		}

		const user = await this.getUserByPhoneNumber(phoneNumber);

		await this.knex('directus_users')
			.update({
				sms_one_time_password: await generateHash(otp),
				sms_one_time_password_expire: new Date(Date.now() + getMilliseconds(env['SMS_OTP_TTL'], 0)),
			})
			.where({ id: user.id });

		const translation = await translationsService.readyOneByLanguageAndKey(user.language, 'otp_sms');

		const project = await settingsService.readSingleton({
			fields: ['project_name'],
		});

		let otpMessage = `Your ${project['project_name']} verification code is ${otp}`;

		if (translation != null) {
			otpMessage = translation.value.replace('{{otp}}', otp);
			otpMessage = otpMessage.replace('{{projectName}}', project['project_name']);
		}

		smsService.send([phoneNumber], otpMessage);
	}
}
