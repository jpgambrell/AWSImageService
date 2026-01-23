# AWS Image Service - Postman Collection

This directory contains Postman collections and environments for testing the AWS Image Service API.

## Files

- **AWS-Image-Service-Auth.postman_collection.json** - Authentication endpoints collection
- **AWS-Image-Service-Images.postman_collection.json** - Image upload, download, and management endpoints
- **AWS-Image-Service-Analysis.postman_collection.json** - AI analysis results endpoints
- **AWS-Image-Service.postman_environment.json** - Shared environment variables for all APIs

## Quick Start

**Typical Workflow:**
1. Import all three collections into Postman
2. **Auth**: Sign up a test user → Sign in to get tokens
3. **Images**: Upload an image → Wait 5-30 seconds for AI processing
4. **Analysis**: Get results → View AI-generated description, keywords, and OCR text
5. **Images**: Download or delete the image

## Getting Started

### 1. Import into Postman

#### Option A: Import Collections Only
1. Open Postman
2. Click **Import** button (top left)
3. Select all three collection files:
   - `AWS-Image-Service-Auth.postman_collection.json`
   - `AWS-Image-Service-Images.postman_collection.json`
   - `AWS-Image-Service-Analysis.postman_collection.json`
4. The collections include default variables that will work immediately

#### Option B: Import All Files (Recommended)
1. Open Postman
2. Click **Import** button
3. Select all four files:
   - `AWS-Image-Service-Auth.postman_collection.json`
   - `AWS-Image-Service-Images.postman_collection.json`
   - `AWS-Image-Service-Analysis.postman_collection.json`
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
| `last_image_id` | Auto-filled after image upload | - |
| `last_analysis_id` | Auto-filled from analysis list | - |

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

### 4. Test the Images & Analysis Flow

#### Complete Workflow (Upload → List → View → Analyze → Delete)

**Prerequisites:** Sign in first to get your ID token!

1. **Upload Image** - Upload an image for AI analysis
   - Request: `POST /api/upload`
   - Body: Select an image file (JPEG, PNG, GIF, or WebP, max 10MB)
   - Updates: `last_image_id` variable
   - The image is stored in S3 and queued for AI analysis

2. **List Images** - View all your uploaded images
   - Request: `GET /api/images`
   - Returns: Array of image metadata sorted by upload date
   - Shows: filename, size, upload timestamp, status

3. **Get Image Info** - View metadata for a specific image
   - Request: `GET /api/images/{imageId}/info`
   - Uses: `last_image_id` from upload
   - Returns: Detailed image metadata

4. **Download Image** - Get the image file
   - Request: `GET /api/images/{imageId}`
   - Uses: `last_image_id` from upload
   - Returns: 302 redirect to presigned S3 URL (valid 1 hour)
   - Tip: In Postman, the image will download automatically if "Follow redirects" is enabled

5. **Wait for Analysis** - AI analysis takes 5-30 seconds
   - The analysis happens asynchronously via SQS → Lambda → Bedrock
   - Wait a moment before checking results

6. **Delete Image** - Permanently remove image and all data
   - Request: `DELETE /api/images/{imageId}`
   - Uses: `last_image_id` from upload
   - Removes: S3 file, metadata, and analysis results
   - ⚠️ This action cannot be undone!

### 5. Test the Analysis Collection

The Analysis collection provides specialized endpoints for working with AI analysis results.

#### Basic Analysis Workflow

1. **List All Analysis** - View all your analysis results
   - Request: `GET /api/analysis`
   - Returns: Array of all analysis results sorted by date
   - Shows status: `pending`, `processing`, `completed`, or `failed`

2. **Get Specific Analysis** - View analysis for one image
   - Request: `GET /api/analysis/{imageId}`
   - Uses: `last_image_id` variable
   - Returns: Full analysis with description, keywords, detected text

3. **Get Analysis (Custom ID)** - Use a specific image ID
   - Same endpoint, but with path variable you can customize
   - Useful when checking a specific image

4. **Poll Until Complete** - Automatically retry until analysis finishes
   - Special request that uses Postman's `setNextRequest()`
   - Automatically checks every 5 seconds
   - Stops when status is `completed` or `failed`
   - Maximum 20 retries (100 seconds)
   - Perfect for waiting on slow analysis jobs

#### Analysis Response Fields

When `status === "completed"`:
- **description**: 2-4 sentence AI-generated description
- **keywords**: Array of 5 relevant keywords/tags
- **detectedText**: Array of OCR text (signs, labels, addresses, etc.)
- **analyzedAt**: ISO timestamp of completion

#### Polling Strategy

**Option A: Manual Polling**
1. Upload image
2. Wait 10 seconds
3. Get analysis - if still `processing`, wait and retry

**Option B: Automatic Polling** (Use request #4)
1. Upload image
2. Run "Poll Until Analysis Complete"
3. Postman automatically retries every 5 seconds
4. Check console for real-time updates

#### Admin Features

If your user is in the `admin` Cognito group:
- **List All Users' Images**: `GET /api/images?userId=<user-id>` or omit userId to see all
- **View Any Image**: Access any user's images by imageId
- **Delete Any Image**: Remove any image regardless of ownership
- **View All Analysis**: `GET /api/analysis?userId=<user-id>` or omit userId to see all

## Available Endpoints

### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/signup` | Register new user (auto-confirmed) | No |
| POST | `/api/auth/signin` | Authenticate and get tokens | No |
| GET | `/api/auth/me` | Get current user profile | Yes (ID token) |
| POST | `/api/auth/refresh` | Refresh access/ID tokens | No |
| POST | `/api/auth/forgot-password` | Initiate password reset | No |
| POST | `/api/auth/confirm-forgot-password` | Complete password reset | No |

> **Note**: The `/api/auth/confirm` endpoint has been removed since email confirmation is no longer required.

### Image Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/upload` | Upload image for AI analysis | Yes (ID token) |
| GET | `/api/images` | List all images for user | Yes (ID token) |
| GET | `/api/images/{imageId}` | Download image (302 redirect to S3) | Yes (ID token) |
| GET | `/api/images/{imageId}/info` | Get image metadata | Yes (ID token) |
| DELETE | `/api/images/{imageId}` | Delete image and all associated data | Yes (ID token) |

### Analysis Endpoints

See the **AWS Image Service - Analysis** collection for specialized analysis testing.

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/api/analysis` | List all AI analysis results | Yes (ID token) |
| GET | `/api/analysis/{imageId}` | Get analysis for specific image | Yes (ID token) |

**Analysis Collection Features:**
- ✅ Enhanced test scripts with formatted console output
- ✅ Automatic polling request that waits for completion
- ✅ Status validation and retry logic
- ✅ Custom image ID parameter support

### Utility Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `/health` | Health check | No |

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

### 400 Bad Request on Image Upload
- Check file type: Only JPEG, PNG, GIF, and WebP are supported
- Check file size: Maximum 10MB
- Make sure the form field is named `image` or `file`
- Ensure you're using `multipart/form-data` content type

### 403 Forbidden on Image/Analysis Access
- You can only access your own images (unless you're an admin)
- Verify you're signed in with the correct account
- Check that the image ID exists and belongs to you

### 404 Not Found on Image/Analysis
- Verify the image ID is correct (check `last_image_id` variable)
- The image may have been deleted
- You may not have permission to access this image

### Analysis Status is "pending" or "processing"
- AI analysis is asynchronous and takes 5-30 seconds
- Wait a moment and retry the GET analysis request
- Check CloudWatch logs for `image-service-analysis` Lambda if it stays pending for >1 minute

### Analysis Status is "failed"
- Check CloudWatch logs for `image-service-analysis` Lambda for error details
- Common causes: Bedrock permissions, invalid image format, Bedrock quota exceeded
- Verify Bedrock is enabled in your AWS region

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
- `last_image_id` - Most recently uploaded image ID (used in image requests)
- `last_analysis_id` - Most recently viewed analysis image ID (used in analysis requests)

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

- [Swagger Documentation - Auth](../swagger/auth.yaml) - Authentication API specification
- [Swagger Documentation - Images](../swagger/images.yaml) - Images & Analysis API specification
- [Swagger Documentation - Health](../swagger/health.yaml) - Health check API specification
- [AWS CloudWatch Dashboard](https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=ImageService-MainDashboard) - Monitor API metrics
- [Cognito User Pool Console](https://console.aws.amazon.com/cognito/users) - Manage users
- [S3 Bucket Console](https://console.aws.amazon.com/s3/) - View uploaded images
- [DynamoDB Tables](https://console.aws.amazon.com/dynamodbv2/home?region=us-east-1#tables) - View image metadata and analysis results

## Support

For issues or questions:
1. Check CloudWatch logs for detailed error messages:
   - Auth: `/aws/lambda/image-service-auth`
   - Upload: `/aws/lambda/image-service-upload`
   - Analysis: `/aws/lambda/image-service-analysis`
   - Query: `/aws/lambda/image-service-query`
2. Review the Swagger documentation for endpoint specifications
3. Verify Cognito User Pool configuration in AWS Console
4. Check the CloudWatch Dashboard for API metrics and errors
5. Verify S3 bucket and DynamoDB tables exist and have proper permissions

