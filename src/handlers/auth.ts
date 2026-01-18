/**
 * Auth Lambda Handler
 * 
 * This Lambda handles all authentication endpoints:
 * - POST /api/auth/signup - Register new user (auto-confirmed)
 * - POST /api/auth/signin - Authenticate user
 * - POST /api/auth/refresh - Refresh access token
 * - POST /api/auth/forgot-password - Initiate password reset
 * - POST /api/auth/confirm-forgot-password - Complete password reset
 * - GET /api/auth/me - Get current user profile (protected)
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  GetUserCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  ApiResponse,
  SignUpRequest,
  SignInRequest,
  ConfirmSignUpRequest,
  RefreshTokenRequest,
  ForgotPasswordRequest,
  ConfirmForgotPasswordRequest,
  AuthTokens,
  User,
  JwtClaims,
} from '../types';

// Initialize Cognito client
const cognitoClient = new CognitoIdentityProviderClient({});

// Environment variables
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

/**
 * Lambda Handler
 * Routes requests based on path
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const { path, httpMethod } = event;

  console.log(JSON.stringify({
    level: 'info',
    message: 'Auth request received',
    action: 'auth_start',
    path,
    httpMethod,
  }));

  try {
    // Route the request based on path
    if (path === '/api/auth/signup' && httpMethod === 'POST') {
      return signup(event);
    }

    if (path === '/api/auth/signin' && httpMethod === 'POST') {
      return signin(event);
    }

    if (path === '/api/auth/refresh' && httpMethod === 'POST') {
      return refresh(event);
    }

    if (path === '/api/auth/forgot-password' && httpMethod === 'POST') {
      return forgotPassword(event);
    }

    if (path === '/api/auth/confirm-forgot-password' && httpMethod === 'POST') {
      return confirmForgotPassword(event);
    }

    if (path === '/api/auth/me' && httpMethod === 'GET') {
      return getMe(event);
    }

    return errorResponse(404, 'Route not found');

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'Auth failed',
      action: 'auth_error',
      path,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));

    // Handle specific Cognito errors
    if (error instanceof Error) {
      if (error.name === 'UsernameExistsException') {
        return errorResponse(409, 'An account with this email already exists');
      }
      if (error.name === 'NotAuthorizedException') {
        return errorResponse(401, 'Invalid email or password');
      }
      if (error.name === 'UserNotFoundException') {
        return errorResponse(404, 'User not found');
      }
      if (error.name === 'CodeMismatchException') {
        return errorResponse(400, 'Invalid confirmation code');
      }
      if (error.name === 'ExpiredCodeException') {
        return errorResponse(400, 'Confirmation code has expired');
      }
      if (error.name === 'InvalidPasswordException') {
        return errorResponse(400, 'Password does not meet requirements');
      }
      if (error.name === 'InvalidParameterException') {
        return errorResponse(400, error.message);
      }
    }

    return errorResponse(500, 'Authentication failed');
  }
}

/**
 * Sign up a new user
 * POST /api/auth/signup
 */
async function signup(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<SignUpRequest>(event.body);

  if (!body || !body.email || !body.password || !body.givenName || !body.familyName) {
    return errorResponse(400, 'Email, password, givenName, and familyName are required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Signing up user',
    action: 'signup',
    email: body.email,
  }));

  const command = new SignUpCommand({
    ClientId: USER_POOL_CLIENT_ID,
    Username: body.email,
    Password: body.password,
    UserAttributes: [
      { Name: 'email', Value: body.email },
      { Name: 'given_name', Value: body.givenName },
      { Name: 'family_name', Value: body.familyName },
      { Name: 'custom:role', Value: 'user' }, // Default role
    ],
  });

  const result = await cognitoClient.send(command);

  console.log(JSON.stringify({
    level: 'info',
    message: 'User signed up',
    action: 'signup_complete',
    email: body.email,
    userSub: result.UserSub,
    confirmed: result.UserConfirmed,
  }));

  const response: ApiResponse<{ userId: string; message: string }> = {
    success: true,
    message: 'Account created successfully. You can now sign in.',
    data: {
      userId: result.UserSub!,
      message: 'You can now sign in with your credentials',
    },
  };

  return {
    statusCode: 201,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Sign in an existing user
 * POST /api/auth/signin
 */
async function signin(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<SignInRequest>(event.body);

  if (!body || !body.email || !body.password) {
    return errorResponse(400, 'Email and password are required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Signing in user',
    action: 'signin',
    email: body.email,
  }));

  const command = new InitiateAuthCommand({
    ClientId: USER_POOL_CLIENT_ID,
    AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
    AuthParameters: {
      USERNAME: body.email,
      PASSWORD: body.password,
    },
  });

  const result = await cognitoClient.send(command);

  if (!result.AuthenticationResult) {
    return errorResponse(401, 'Authentication failed');
  }

  const tokens: AuthTokens = {
    accessToken: result.AuthenticationResult.AccessToken!,
    idToken: result.AuthenticationResult.IdToken!,
    refreshToken: result.AuthenticationResult.RefreshToken,
    expiresIn: result.AuthenticationResult.ExpiresIn || 3600,
  };

  console.log(JSON.stringify({
    level: 'info',
    message: 'User signed in',
    action: 'signin_complete',
    email: body.email,
  }));

  const response: ApiResponse<AuthTokens> = {
    success: true,
    message: 'Signed in successfully',
    data: tokens,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Confirm user registration
 * POST /api/auth/confirm
 */
async function confirmSignup(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<ConfirmSignUpRequest>(event.body);

  if (!body || !body.email || !body.confirmationCode) {
    return errorResponse(400, 'Email and confirmationCode are required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Confirming user',
    action: 'confirm_signup',
    email: body.email,
  }));

  const command = new ConfirmSignUpCommand({
    ClientId: USER_POOL_CLIENT_ID,
    Username: body.email,
    ConfirmationCode: body.confirmationCode,
  });

  await cognitoClient.send(command);

  console.log(JSON.stringify({
    level: 'info',
    message: 'User confirmed',
    action: 'confirm_signup_complete',
    email: body.email,
  }));

  const response: ApiResponse<{ message: string }> = {
    success: true,
    message: 'Email confirmed successfully',
    data: {
      message: 'You can now sign in with your email and password',
    },
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Refresh access token
 * POST /api/auth/refresh
 */
async function refresh(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<RefreshTokenRequest>(event.body);

  if (!body || !body.refreshToken) {
    return errorResponse(400, 'refreshToken is required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Refreshing token',
    action: 'refresh_token',
  }));

  const command = new InitiateAuthCommand({
    ClientId: USER_POOL_CLIENT_ID,
    AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
    AuthParameters: {
      REFRESH_TOKEN: body.refreshToken,
    },
  });

  const result = await cognitoClient.send(command);

  if (!result.AuthenticationResult) {
    return errorResponse(401, 'Token refresh failed');
  }

  const tokens: AuthTokens = {
    accessToken: result.AuthenticationResult.AccessToken!,
    idToken: result.AuthenticationResult.IdToken!,
    // Refresh token is not returned on refresh, client should keep existing one
    expiresIn: result.AuthenticationResult.ExpiresIn || 3600,
  };

  console.log(JSON.stringify({
    level: 'info',
    message: 'Token refreshed',
    action: 'refresh_token_complete',
  }));

  const response: ApiResponse<AuthTokens> = {
    success: true,
    message: 'Token refreshed successfully',
    data: tokens,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Initiate password reset
 * POST /api/auth/forgot-password
 */
async function forgotPassword(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<ForgotPasswordRequest>(event.body);

  if (!body || !body.email) {
    return errorResponse(400, 'Email is required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Initiating password reset',
    action: 'forgot_password',
    email: body.email,
  }));

  const command = new ForgotPasswordCommand({
    ClientId: USER_POOL_CLIENT_ID,
    Username: body.email,
  });

  await cognitoClient.send(command);

  console.log(JSON.stringify({
    level: 'info',
    message: 'Password reset initiated',
    action: 'forgot_password_complete',
    email: body.email,
  }));

  const response: ApiResponse<{ message: string }> = {
    success: true,
    message: 'Password reset initiated',
    data: {
      message: 'A confirmation code has been sent to your email',
    },
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Complete password reset
 * POST /api/auth/confirm-forgot-password
 */
async function confirmForgotPassword(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<ConfirmForgotPasswordRequest>(event.body);

  if (!body || !body.email || !body.confirmationCode || !body.newPassword) {
    return errorResponse(400, 'Email, confirmationCode, and newPassword are required');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Confirming password reset',
    action: 'confirm_forgot_password',
    email: body.email,
  }));

  const command = new ConfirmForgotPasswordCommand({
    ClientId: USER_POOL_CLIENT_ID,
    Username: body.email,
    ConfirmationCode: body.confirmationCode,
    Password: body.newPassword,
  });

  await cognitoClient.send(command);

  console.log(JSON.stringify({
    level: 'info',
    message: 'Password reset confirmed',
    action: 'confirm_forgot_password_complete',
    email: body.email,
  }));

  const response: ApiResponse<{ message: string }> = {
    success: true,
    message: 'Password reset successfully',
    data: {
      message: 'You can now sign in with your new password',
    },
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Get current user profile
 * GET /api/auth/me (protected)
 */
async function getMe(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Extract user info from JWT claims (set by API Gateway Cognito authorizer)
  const claims = extractUserClaims(event);

  if (!claims) {
    return errorResponse(401, 'Unauthorized');
  }

  console.log(JSON.stringify({
    level: 'info',
    message: 'Getting user profile',
    action: 'get_me',
    userId: claims.sub,
  }));

  // Determine role from Cognito groups
  const groups = claims['cognito:groups'] || [];
  const role = groups.includes('admin') ? 'admin' : 'user';

  const user: User = {
    userId: claims.sub,
    email: claims.email,
    givenName: claims.given_name || '',
    familyName: claims.family_name || '',
    role: role as 'user' | 'admin',
  };

  const response: ApiResponse<User> = {
    success: true,
    data: user,
  };

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Extract user claims from API Gateway event
 * The Cognito authorizer adds claims to requestContext.authorizer.claims
 */
export function extractUserClaims(event: APIGatewayProxyEvent): JwtClaims | null {
  const claims = event.requestContext?.authorizer?.claims;

  if (!claims || !claims.sub) {
    return null;
  }

  // Parse cognito:groups if it's a string
  let groups: string[] = [];
  if (claims['cognito:groups']) {
    if (Array.isArray(claims['cognito:groups'])) {
      groups = claims['cognito:groups'];
    } else if (typeof claims['cognito:groups'] === 'string') {
      // Groups might be a comma-separated string or JSON array
      try {
        groups = JSON.parse(claims['cognito:groups']);
      } catch {
        groups = claims['cognito:groups'].split(',').map((g: string) => g.trim());
      }
    }
  }

  return {
    sub: claims.sub,
    email: claims.email,
    'cognito:username': claims['cognito:username'],
    'cognito:groups': groups,
    given_name: claims.given_name,
    family_name: claims.family_name,
    email_verified: claims.email_verified === 'true',
    iss: claims.iss,
    aud: claims.aud,
    token_use: claims.token_use,
    auth_time: parseInt(claims.auth_time, 10),
    exp: parseInt(claims.exp, 10),
    iat: parseInt(claims.iat, 10),
  };
}

/**
 * Check if user is admin
 */
export function isAdmin(claims: JwtClaims): boolean {
  const groups = claims['cognito:groups'] || [];
  return groups.includes('admin');
}

/**
 * Parse request body
 */
function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Create error response
 */
function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  const response: ApiResponse<null> = {
    success: false,
    error: message,
  };

  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

/**
 * Standard CORS headers
 */
function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key,X-Amz-Date,X-Amz-Security-Token,Accept,Accept-Encoding',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
}

