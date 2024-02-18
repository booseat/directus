import { InvalidCredentialsError, InvalidPayloadError } from '@directus/errors';
import type { Accountability } from '@directus/types';
import argon2 from 'argon2';
import { Router } from 'express';
import Joi from 'joi';
import { performance } from 'perf_hooks';
import { COOKIE_OPTIONS } from '../../constants.js';
import { useEnv } from '../../env.js';
import { respond } from '../../middleware/respond.js';
import { AuthenticationService } from '../../services/authentication.js';
import type { User } from '../../types/index.js';
import asyncHandler from '../../utils/async-handler.js';
import { getIPFromReq } from '../../utils/get-ip-from-req.js';
import { stall } from '../../utils/stall.js';
import { AuthDriver } from '../auth.js';

export class PhoneAuthDriver extends AuthDriver {
	override async getUserID(payload: Record<string, any>): Promise<string> {
		if (!payload['phone_number']) {
			throw new InvalidCredentialsError();
		}

		const user = await this.knex
			.select('id')
			.from('directus_users')
			.whereRaw('?? = ?', ['phone_number', payload['phone_number']])
			.first();

		if (!user) {
			throw new InvalidCredentialsError();
		}

		return user.id;
	}

	override async verify(user: User, password?: string): Promise<void> {
		if (
			!user.sms_one_time_password_expire ||
			user.sms_one_time_password_expire < new Date() ||
			!user.sms_one_time_password ||
			!(await argon2.verify(user.sms_one_time_password, password as string))
		) {
			throw new InvalidCredentialsError();
		} else {
			await this.knex('directus_users')
				.update({
					sms_one_time_password: null,
					sms_one_time_password_expire: null,
				})
				.where({ id: user.id });
		}
	}

	override async login(user: User, payload: Record<string, any>): Promise<void> {
		await this.verify(user, payload['password']);
	}
}

export function createPhoneAuthRouter(provider: string): Router {
	const env = useEnv();

	const router = Router();

	const userLoginSchema = Joi.object({
		phone_number: Joi.string().pattern(new RegExp('^\\+[1-9]\\d{1,14}$')).required(),
		password: Joi.string().required(),
		mode: Joi.string().valid('cookie', 'json'),
		otp: Joi.string(),
	}).unknown();

	router.post(
		'/',
		asyncHandler(async (req, res, next) => {
			const STALL_TIME = env['LOGIN_STALL_TIME'];
			const timeStart = performance.now();

			const accountability: Accountability = {
				ip: getIPFromReq(req),
				role: null,
			};

			const userAgent = req.get('user-agent');
			if (userAgent) accountability.userAgent = userAgent;

			const origin = req.get('origin');
			if (origin) accountability.origin = origin;

			const authenticationService = new AuthenticationService({
				accountability: accountability,
				schema: req.schema,
			});

			const { error } = userLoginSchema.validate(req.body);

			if (error) {
				await stall(STALL_TIME, timeStart);
				throw new InvalidPayloadError({ reason: error.message });
			}

			const mode = req.body.mode || 'json';

			const { accessToken, refreshToken, expires } = await authenticationService.login(
				provider,
				req.body,
				req.body?.otp,
			);

			const payload = {
				data: { access_token: accessToken, expires },
			} as Record<string, Record<string, any>>;

			if (mode === 'json') {
				payload['data']!['refresh_token'] = refreshToken;
			}

			if (mode === 'cookie') {
				res.cookie(env['REFRESH_TOKEN_COOKIE_NAME'], refreshToken, COOKIE_OPTIONS);
			}

			res.locals['payload'] = payload;

			return next();
		}),
		respond,
	);

	return router;
}
