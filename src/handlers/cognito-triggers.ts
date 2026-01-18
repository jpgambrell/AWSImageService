/**
 * Cognito Lambda Triggers
 * 
 * Pre Sign-up trigger: Auto-confirms users and their email addresses
 * This eliminates the need for email confirmation during development
 */

import { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';

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

