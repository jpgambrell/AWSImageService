/**
 * Shared TypeScript types for the AWS Image Service
 * These mirror the data structures from the original KafkaImageService
 */

// ============================================
// USER & AUTHENTICATION
// ============================================

/**
 * User roles for access control
 */
export type UserRole = 'user' | 'admin';

/**
 * Represents a user in the system
 * User data is stored in Cognito, not DynamoDB
 */
export interface User {
  userId: string;           // Cognito sub (unique identifier)
  email: string;
  givenName: string;
  familyName: string;
  role: UserRole;
}

/**
 * JWT claims extracted from Cognito tokens
 * These claims are provided by API Gateway after token validation
 */
export interface JwtClaims {
  sub: string;              // User ID (Cognito sub)
  email: string;
  'cognito:username': string;
  'cognito:groups'?: string[];  // User groups (admin, user)
  given_name?: string;
  family_name?: string;
  email_verified?: boolean;
  iss: string;              // Token issuer
  aud: string;              // Audience (client id)
  token_use: 'id' | 'access';
  auth_time: number;
  exp: number;
  iat: number;
}

/**
 * Sign up request data
 */
export interface SignUpRequest {
  email: string;
  password: string;
  givenName: string;
  familyName: string;
}

/**
 * Sign in request data
 */
export interface SignInRequest {
  email: string;
  password: string;
}

/**
 * Refresh token request data
 */
export interface RefreshTokenRequest {
  refreshToken: string;
}

/**
 * Forgot password request data
 */
export interface ForgotPasswordRequest {
  email: string;
}

/**
 * Confirm forgot password request data
 */
export interface ConfirmForgotPasswordRequest {
  email: string;
  confirmationCode: string;
  newPassword: string;
}

/**
 * Authentication response with tokens
 */
export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
}

// ============================================
// IMAGE METADATA
// ============================================

/**
 * Represents an uploaded image's metadata
 * Stored in DynamoDB 'images' table
 */
export interface ImageMetadata {
  imageId: string;          // UUID - Primary Key in DynamoDB
  userId: string;           // Owner's Cognito sub - for multi-tenancy
  filename: string;         // Stored filename (uuid.ext)
  originalName: string;     // Original upload filename
  mimetype: string;         // MIME type (image/jpeg, etc.)
  size: number;             // File size in bytes
  uploadedAt: string;       // ISO timestamp
  s3Key: string;            // S3 object key for retrieval
  status: 'uploaded' | 'processing' | 'analyzed' | 'failed';
  latitude?: number;        // GPS latitude (optional)
  longitude?: number;       // GPS longitude (optional)
  creationDate?: string;    // When image was taken (optional, ISO 8601)
}

// ============================================
// IMAGE ANALYSIS
// ============================================

/**
 * Represents AI analysis results for an image
 * Stored in DynamoDB 'image_analysis' table
 */
export interface ImageAnalysis {
  imageId: string;          // UUID - Primary Key (same as image)
  userId: string;           // Owner's Cognito sub - for multi-tenancy
  filename: string;         // Image filename
  description: string;      // AI-generated description
  keywords: string[];       // Extracted keywords/tags
  detectedText: string[];   // Text found in image (addresses, signs, etc.)
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;           // Error message if failed
  analyzedAt?: string;      // ISO timestamp when analysis completed
}

// ============================================
// SQS MESSAGE
// ============================================

/**
 * Message sent to SQS when an image is uploaded
 * Triggers the analysis Lambda
 */
export interface ImageUploadMessage {
  imageId: string;
  userId: string;           // Owner's Cognito sub - for multi-tenancy
  filename: string;
  s3Key: string;
  mimetype: string;
  uploadedAt: string;
  correlationId: string;    // For tracing through the system
  latitude?: number;        // GPS latitude (optional)
  longitude?: number;       // GPS longitude (optional)
  creationDate?: string;    // When image was taken (optional, ISO 8601)
}

// ============================================
// API RESPONSES
// ============================================

/**
 * Standard API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

/**
 * Upload response data
 */
export interface UploadResponseData {
  id: string;
  userId: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  uploadedAt: string;
  path: string;             // API path to retrieve the image
  latitude?: number;        // GPS latitude (optional)
  longitude?: number;       // GPS longitude (optional)
  creationDate?: string;    // When image was taken (optional, ISO 8601)
}

// ============================================
// LAMBDA EVENT TYPES
// ============================================

/**
 * Parsed multipart form data from API Gateway
 */
export interface ParsedMultipartData {
  filename: string;
  contentType: string;
  content: Buffer;
  latitude?: number;
  longitude?: number;
  creationDate?: string;
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Allowed image MIME types
 */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png', 
  'image/gif',
  'image/webp'
] as const;

/**
 * Maximum file size (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * File extension mapping
 */
export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
};

