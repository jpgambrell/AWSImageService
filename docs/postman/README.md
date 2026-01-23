# AWS Image Service - Postman Collection

This directory contains Postman collections and environments for testing the AWS Image Service API.

## Files

- **AWS-Image-Service-Auth.postman_collection.json** - Authentication endpoints collection
- **AWS-Image-Service.postman_environment.json** - Environment variables for the API

## Getting Started

### 1. Import into Postman

#### Option A: Import Collection Only
1. Open Postman
2. Click **Import** button (top left)
3. Select the `AWS-Image-Service-Auth.postman_collection.json` file
4. The collection includes default variables that will work immediately

#### Option B: Import Collection + Environment (Recommended)
1. Open Postman
2. Click **Import** button
3. Select both files:
   - `AWS-Image-Service-Auth.postman_collection.json`
   - `AWS-Image-Service.postman_environment.json`
4. Select the "AWS Image Service - Production" environment from the dropdown (top right)

### 2. Configure Variables

Update these variables in the collection or environment:

| Variable | Description | Example |
|----------|-------------|---------|
| `api_url` | Your API Gateway URL | `https://xxxxx.execute-api.us-east-1.amazonaws.com/prod` |
| `test_email` | Email for test user | `test@example.com` |
| `test_password` | Password for test user (min 8 chars, 1 upper, 1 lower, 1 digit) | `TestPassword123` |
| `access_token` | Auto-filled after sign in | - |
| `id_token` | Auto-filled after sign in | - |
| `refresh_token` | Auto-filled after sign in | - |
| `userId` | Auto-filled after sign up | - |

### 3. Test the Authentication Flow

#### Basic Flow (Sign Up → Sign In → Get Profile)

1. **Sign Up** - Create a new user account
   - Request: `POST /api/auth/signup`
   - Updates: `userId` variable
   - ✅ **No email confirmation required** - Users are automatically confirmed via a Pre Sign-up Lambda trigger and can sign in immediately

2. **Sign In** - Authenticate and get tokens
   - Request: `POST /api/auth/signin`
   - Updates: `access_token`, `id_token`, `refresh_token` variables
   - Tokens are automatically saved and used in subsequent requests

3. **Get User Profile** - Test protected endpoint
   - Request: `GET /api/auth/me`
   - Uses: `id_token` (NOT access_token - see note below)
   - Returns: User profile information

#### Token Refresh Flow

4. **Refresh Token** - Get new access token
   - Request: `POST /api/auth/refresh`
   - Uses: `refresh_token` from sign in
   - Updates: `access_token` and `id_token`
   - Note: Refresh token remains the same (reuse it)

#### Password Reset Flow

5. **Forgot Password** - Request password reset
   - Request: `POST /api/auth/forgot-password`
   - Sends confirmation code to email

6. **Confirm Forgot Password** - Complete password reset
   - Request: `POST /api/auth/confirm-forgot-password`
   - Use code from email
   - Set new password

## Available Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/signup` | Register new user (auto-confirmed) | No |
| POST | `/api/auth/signin` | Authenticate and get tokens | No |
| GET | `/api/auth/me` | Get current user profile | Yes (ID token) |
| POST | `/api/auth/refresh` | Refresh access/ID tokens | No |
| POST | `/api/auth/forgot-password` | Initiate password reset | No |
| POST | `/api/auth/confirm-forgot-password` | Complete password reset | No |

> **Note**: The `/api/auth/confirm` endpoint has been removed since email confirmation is no longer required.

## Collection Features

### Automatic Token Management

The collection includes test scripts that automatically:
- Save tokens after sign in
- Update tokens after refresh
- Save user ID after sign up
- Use Bearer token authentication for protected endpoints

### ⚠️ IMPORTANT: Use ID Token for Protected Endpoints

API Gateway Cognito User Pool authorizers require the **ID token** (not the access token) for authentication.

| Token | Purpose |
|-------|---------|
| **Access Token** | For accessing your own APIs that validate tokens themselves |
| **ID Token** | For API Gateway Cognito authorizers (contains user claims) |
| **Refresh Token** | For getting new access/ID tokens (30 day validity) |

The "Get User Profile" request uses `{{id_token}}` for this reason. If you get a 401 error on protected endpoints, make sure you're using the ID token.

### Test Scripts

Each request includes test scripts that:
- Validate response status codes
- Check for required fields in responses
- Log important information to console
- Save variables for subsequent requests

### Request Descriptions

Each request includes detailed descriptions explaining:
- What the endpoint does
- Required parameters
- Response format
- Special notes and requirements

## Troubleshooting

### 401 Unauthorized on Protected Endpoints
- Make sure you've signed in first to get tokens
- ⚠️ **Use the ID token, not the access token** for API Gateway protected endpoints
- Check that the `id_token` variable is set (not `access_token`)
- ID tokens expire after 1 hour - use the refresh endpoint or sign in again

### 409 Conflict on Sign Up
- User already exists with that email
- Use a different email or delete the user in Cognito console

### 400 Bad Request on Sign Up
- Check password requirements:
  - Minimum 8 characters
  - At least one uppercase letter
  - At least one lowercase letter
  - At least one digit

### 502 Bad Gateway
- This typically indicates a Lambda error
- Check CloudWatch logs for the `image-service-auth` Lambda function
- Common causes: missing environment variables, permission issues

### Invalid API URL
- Update the `api_url` variable with your actual API Gateway URL
- Find your API URL in the AWS CloudFormation outputs or API Gateway console

## API Gateway URL

Your current API URL is:
```
https://0p19v2252j.execute-api.us-east-1.amazonaws.com/prod
```

## Environment Variables Reference

### Input Variables (Configure These)
- `api_url` - API Gateway base URL
- `test_email` - Test user email
- `test_password` - Test user password

### Auto-Populated Variables (Set by Scripts)
- `access_token` - JWT access token (1 hour validity)
- `id_token` - JWT ID token with user claims (use this for protected endpoints)
- `refresh_token` - Token to refresh access/ID tokens (30 days validity)
- `userId` - Cognito user sub (unique identifier)

## Architecture Notes

### Authentication Flow
1. User signs up → Pre Sign-up Lambda trigger auto-confirms user
2. User signs in → Cognito returns access token, ID token, and refresh token
3. User calls protected endpoint → API Gateway validates ID token via Cognito authorizer
4. Lambda receives user claims from authorizer in `event.requestContext.authorizer.claims`

### Error Handling
The API returns standard HTTP status codes with JSON error responses:
- `400` - Bad Request (validation errors, invalid parameters)
- `401` - Unauthorized (invalid credentials, expired token)
- `404` - Not Found (user not found, route not found)
- `409` - Conflict (user already exists)
- `500` - Internal Server Error

## Additional Resources

- [Swagger Documentation](../swagger/auth.yaml) - Full OpenAPI specification
- [AWS CloudWatch Dashboard](https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ImageService-MainDashboard) - Monitor API metrics
- [Cognito User Pool Console](https://console.aws.amazon.com/cognito/users) - Manage users

## Support

For issues or questions:
1. Check CloudWatch logs for detailed error messages (`/aws/lambda/image-service-auth`)
2. Review the Swagger documentation for endpoint specifications
3. Verify Cognito User Pool configuration in AWS Console
4. Check the CloudWatch Dashboard for API metrics and errors

