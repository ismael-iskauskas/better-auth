import { APIError } from "better-call";
import { z } from "zod";
import { createAuthEndpoint } from "../../../api/call";
import { verifyTwoFactorMiddleware } from "../verify-middleware";
import type {
	TwoFactorProvider,
	TwoFactorTable,
	UserWithTwoFactor,
} from "../types";
import { TWO_FACTOR_ERROR_CODES } from "../error-code";
import { generateRandomString } from "../../../crypto";

export interface OTPOptions {
	/**
	 * How long the opt will be valid for in
	 * minutes
	 *
	 * @default "3 mins"
	 */
	period?: number;
	/**
	 * Number of digits for the OTP code
	 *
	 * @default 6
	 */
	digits?: number;
	/**
	 * Send the otp to the user
	 *
	 * @param user - The user to send the otp to
	 * @param otp - The otp to send
	 * @param request - The request object
	 * @returns void | Promise<void>
	 */
	sendOTP?: (
		/**
		 * The user to send the otp to
		 * @type UserWithTwoFactor
		 * @default UserWithTwoFactors
		 */
		data: {
			user: UserWithTwoFactor;
			otp: string;
		},
		/**
		 * The request object
		 */
		request?: Request,
	) => Promise<void> | void;
}

/**
 * The otp adapter is created from the totp adapter.
 */
export const otp2fa = (options?: OTPOptions) => {
	const opts = {
		...options,
		digits: options?.digits || 6,
		period: (options?.period || 3) * 60 * 1000,
	};
	const twoFactorTable = "twoFactor";
	/**
	 * Generate OTP and send it to the user.
	 */
	const send2FaOTP = createAuthEndpoint(
		"/two-factor/send-otp",
		{
			method: "POST",
			body: z
				.object({
					/**
					 * if true, the device will be trusted
					 * for 30 days. It'll be refreshed on
					 * every sign in request within this time.
					 */
					trustDevice: z.boolean().optional(),
				})
				.optional(),
			use: [verifyTwoFactorMiddleware],
			metadata: {
				openapi: {
					summary: "Send two factor OTP",
					description: "Send two factor OTP to the user",
					responses: {
						200: {
							description: "Successful response",
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: {
											status: {
												type: "boolean",
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async (ctx) => {
			if (!options || !options.sendOTP) {
				ctx.context.logger.error(
					"send otp isn't configured. Please configure the send otp function on otp options.",
				);
				throw new APIError("BAD_REQUEST", {
					message: "otp isn't configured",
				});
			}
			const user = ctx.context.session.user as UserWithTwoFactor;
			const twoFactor = await ctx.context.adapter.findOne<TwoFactorTable>({
				model: twoFactorTable,
				where: [
					{
						field: "userId",
						value: user.id,
					},
				],
			});
			if (!twoFactor) {
				throw new APIError("BAD_REQUEST", {
					message: TWO_FACTOR_ERROR_CODES.OTP_NOT_ENABLED,
				});
			}
			const code = generateRandomString(opts.digits, "0-9");
			await ctx.context.internalAdapter.createVerificationValue({
				value: code,
				identifier: `2fa-otp-${user.id}`,
				expiresAt: new Date(Date.now() + opts.period),
			});
			await options.sendOTP({ user, otp: code }, ctx.request);
			return ctx.json({ status: true });
		},
	);

	const verifyOTP = createAuthEndpoint(
		"/two-factor/verify-otp",
		{
			method: "POST",
			body: z.object({
				code: z.string({
					description: "The otp code to verify",
				}),
				/**
				 * if true, the device will be trusted
				 * for 30 days. It'll be refreshed on
				 * every sign in request within this time.
				 */
				trustDevice: z.boolean().optional(),
			}),
			use: [verifyTwoFactorMiddleware],
			metadata: {
				openapi: {
					summary: "Verify two factor OTP",
					description: "Verify two factor OTP",
					responses: {
						200: {
							description: "Success",
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: {
											status: {
												type: "boolean",
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async (ctx) => {
			const user = ctx.context.session.user;
			if (!user.twoFactorEnabled) {
				throw new APIError("BAD_REQUEST", {
					message: "two factor isn't enabled",
				});
			}
			const twoFactor = await ctx.context.adapter.findOne<TwoFactorTable>({
				model: twoFactorTable,
				where: [
					{
						field: "userId",
						value: user.id,
					},
				],
			});
			if (!twoFactor) {
				throw new APIError("BAD_REQUEST", {
					message: TWO_FACTOR_ERROR_CODES.OTP_NOT_ENABLED,
				});
			}
			const toCheckOtp =
				await ctx.context.internalAdapter.findVerificationValue(
					`2fa-otp-${user.id}`,
				);
			if (!toCheckOtp || toCheckOtp.expiresAt < new Date()) {
				throw new APIError("BAD_REQUEST", {
					message: TWO_FACTOR_ERROR_CODES.OTP_HAS_EXPIRED,
				});
			}
			if (toCheckOtp.value === ctx.body.code) {
				return ctx.context.valid(ctx);
			} else {
				return ctx.context.invalid();
			}
		},
	);
	return {
		id: "otp",
		endpoints: {
			sendTwoFactorOTP: send2FaOTP,
			verifyTwoFactorOTP: verifyOTP,
		},
	} satisfies TwoFactorProvider;
};
