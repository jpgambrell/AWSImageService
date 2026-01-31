/**
 * Cognito Lambda Triggers
 * 
 * Pre Sign-up trigger: Auto-confirms users and their email addresses
 * Custom Message trigger: Customizes email templates for forgot password, verification, etc.
 */

import { 
  PreSignUpTriggerEvent, 
  PreSignUpTriggerHandler,
  CustomMessageTriggerEvent,
  CustomMessageTriggerHandler,
} from 'aws-lambda';

/**
 * Pre Sign-up Trigger
 * Automatically confirms user and email address
 */
export const preSignUpHandler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent
): Promise<PreSignUpTriggerEvent> => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'Pre sign-up trigger invoked',
    action: 'pre_signup',
    email: event.request.userAttributes.email,
  }));

  // Auto-confirm the user
  event.response.autoConfirmUser = true;

  // Auto-verify the email (marks email as verified)
  event.response.autoVerifyEmail = true;

  console.log(JSON.stringify({
    level: 'info',
    message: 'User auto-confirmed',
    action: 'pre_signup_complete',
    email: event.request.userAttributes.email,
  }));

  return event;
};

/**
 * Custom Message Trigger
 * Customizes email content for various Cognito events
 */
export const customMessageHandler: CustomMessageTriggerHandler = async (
  event: CustomMessageTriggerEvent
): Promise<CustomMessageTriggerEvent> => {
  const { triggerSource, request } = event;
  const givenName = request.userAttributes.given_name || 'there';
  const code = request.codeParameter;

  console.log(JSON.stringify({
    level: 'info',
    message: 'Custom message trigger invoked',
    action: 'custom_message',
    triggerSource,
    email: request.userAttributes.email,
  }));

  // Forgot Password email
  if (triggerSource === 'CustomMessage_ForgotPassword') {
    event.response.emailSubject = 'Reset your Guidepost Snap password';
    event.response.emailMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a1a2e; margin: 0; font-size: 24px;">Guidepost Snap</h1>
      </div>
      <h2 style="color: #333; margin-bottom: 20px;">Reset your password</h2>
      <p style="color: #666; font-size: 16px; line-height: 1.6;">
        Hi ${givenName},
      </p>
      <p style="color: #666; font-size: 16px; line-height: 1.6;">
        We received a request to reset your password. Use the code below to set a new password:
      </p>
      <div style="background-color: #f0f4f8; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
        <span style="font-size: 32px; font-weight: bold; color: #10b981; letter-spacing: 4px;">${code}</span>
      </div>
      <p style="color: #999; font-size: 14px; line-height: 1.6;">
        This code expires in 1 hour. If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        © 2024 Guidepost Snap. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  // Sign up verification email (if email verification is enabled)
  if (triggerSource === 'CustomMessage_SignUp') {
    event.response.emailSubject = 'Welcome to Guidepost Snap - Verify your email';
    event.response.emailMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a1a2e; margin: 0; font-size: 24px;">Guidepost Snap</h1>
      </div>
      <h2 style="color: #333; margin-bottom: 20px;">Welcome, ${givenName}!</h2>
      <p style="color: #666; font-size: 16px; line-height: 1.6;">
        Thanks for signing up for Guidepost Snap! Please verify your email address using the code below:
      </p>
      <div style="background-color: #f0f4f8; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
        <span style="font-size: 32px; font-weight: bold; color: #10b981; letter-spacing: 4px;">${code}</span>
      </div>
      <p style="color: #999; font-size: 14px; line-height: 1.6;">
        This code expires in 24 hours. If you didn't create an account with Guidepost Snap, you can safely ignore this email.
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        © 2024 Guidepost Snap. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  // Resend verification code
  if (triggerSource === 'CustomMessage_ResendCode') {
    event.response.emailSubject = 'Your Guidepost Snap verification code';
    event.response.emailMessage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #1a1a2e; margin: 0; font-size: 24px;">Guidepost Snap</h1>
      </div>
      <h2 style="color: #333; margin-bottom: 20px;">Your verification code</h2>
      <p style="color: #666; font-size: 16px; line-height: 1.6;">
        Hi ${givenName}, here's your new verification code:
      </p>
      <div style="background-color: #f0f4f8; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
        <span style="font-size: 32px; font-weight: bold; color: #10b981; letter-spacing: 4px;">${code}</span>
      </div>
      <p style="color: #999; font-size: 14px; line-height: 1.6;">
        This code expires in 24 hours.
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        © 2024 Guidepost Snap. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  return event;
};

